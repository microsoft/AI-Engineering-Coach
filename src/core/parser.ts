/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Parser orchestration and cache-backed entry points. */

import * as path from 'path';
import * as fs from 'fs';
import { Workspace } from './types';
import { ParseContext, prefetchCache, stripSingleSession, maybeForceGc, recordFailedFile, resetParseWarnings, resetParseTiming, getParseTiming } from './parser-shared';
import { getMemoryCache, setMemoryCache, computeDirMetasAsync, loadCacheData, saveCacheData, findStaleDirs, clearCache, stripSessionsForMemory } from './cache';
import type { DirMetas, ParseResult, SessionSource } from './cache';
import { findVsCodeDirs, scanVsCodeDirs, processWorkspaceEntry, processWorkspaceEntryAsync, harnessFromPath } from './parser-vscode';
import { computeSessionTotals, createRunningTotals, type SessionTotals } from './session-totals';
import { findXcodeDirs, parseXcodeDatabases, parseXcodeDatabasesAsync } from './parser-xcode';
import { collectExternalHarnessesAsync, collectExternalHarnessesSync, EXTERNAL_HARNESS_SET } from './parser-harnesses';
import { warnCore } from './log';
import { runtimeDebug } from './runtime-debug';

export type { ParseResult };
export { clearCache };

export interface LoadProgress {
  phase: number;
  detail?: string;
  pct: number;
  sessions?: number;
  /** Running total of AI-generated lines of code discovered so far. */
  linesOfCode?: number;
  /** Running total of tool calls discovered so far. */
  toolCalls?: number;
  /** Running total of images analyzed by the AI (from variableKinds.image). */
  imagesAnalyzed?: number;
  /** Running total of unique files edited by AI. */
  filesEdited?: number;
  /** Running total of requests (turns) discovered so far. */
  requests?: number;
  /** Sent once at the start of phase 2: ordered workspace keys for the loading grid. */
  workspacePlan?: string[];
  /** Sent after each workspace is processed so the loading grid can mark it complete. */
  workspaceDone?: string;
  /** Live runtime telemetry of the parse worker process (issue #106). Lets the loading UI
   *  surface the resource pressure that drives parse load: heap, RSS, file buffers, CPU. */
  telemetry?: ParseTelemetry;
}

/** A live snapshot of the parse worker's resource usage, surfaced on the loading screen. */
export interface ParseTelemetry {
  /** Resident set size (total process memory) in MB. */
  rssMB: number;
  /** V8 heap currently in use, in MB. */
  heapUsedMB: number;
  /** V8 heap ceiling (the `--max-old-space-size` cap) in MB; the OOM threshold. */
  heapLimitMB: number;
  /** Off-heap bytes — external + ArrayBuffers — in MB. This is dominated by the raw
   *  session-file text held in memory while parsing, so it tracks load directly. */
  fileBufMB: number;
  /** Worker CPU utilization since the previous sample, as a percentage (0–100). */
  cpuPct: number;
  /** Count of files that failed to parse entirely so far (read error / no usable content). */
  skippedFiles: number;
  /** Count of malformed lines skipped inside otherwise-readable files so far. */
  skippedLines: number;
}

export type ProgressCallback = (p: LoadProgress) => void;

export const LOAD_PHASES = [
  'Discovering log directories',
  'Checking cache',
  'Parsing session logs',
  'Scanning external harnesses',
  'Preparing analytics',
  'Ready',
] as const;

const PHASE_STARTS = [0, 2, 10, 75, 85, 95];
const PHASE_WIDTHS = [2, 8, 65, 10, 10, 5];

function yieldToLoop(): Promise<void> {
  return new Promise(r => setImmediate(r));
}

function withTimeout<T>(task: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    task,
    new Promise<null>(r => setTimeout(() => r(null), ms)),
  ]);
}

function pct(phase: number, intraPhase: number): number {
  const base = PHASE_STARTS[phase] ?? 95;
  const width = PHASE_WIDTHS[phase] ?? 5;
  return Math.min(100, Math.round(base + width * Math.max(0, Math.min(1, intraPhase))));
}

export function findLogsDirs(): string[] {
  return [...findVsCodeDirs(), ...findXcodeDirs()];
}

function partitionDirs(logsDirs: string[]): { vsCodeDirs: string[]; xcodeDirs: string[] } {
  const vsCodeDirs: string[] = [];
  const xcodeDirs: string[] = [];
  for (const d of logsDirs) {
    if (d.includes(path.join('.config', 'github-copilot', 'xcode'))) xcodeDirs.push(d);
    else vsCodeDirs.push(d);
  }
  return { vsCodeDirs, xcodeDirs };
}

const PREFETCH_TIMEOUT_MS = 15_000;
const MAX_PREFETCH_FILES = 600;
// During a cold parse the growing sessions array competes with the prefetch buffer for heap.
// Cap look-ahead lower so prefetch can't add hundreds of MB of file contents on top of the
// session accumulation (issue #106). 100 still gives enough overlap for I/O pipelining.
const COLD_PARSE_MAX_PREFETCH_FILES = 100;
const MAX_PREFETCH_FILE_SIZE = 20 * 1024 * 1024;
// Cap the *total* bytes a single prefetch batch may hold in `prefetchCache`. Capping by file
// count alone is not enough: 100 files at up to 20 MB each is ~2 GB, and the next batch's
// prefetch runs concurrently (double-buffered), so file text alone could approach ~4 GB on top
// of the parse working set and OOM the worker (issue #106). A byte budget bounds the spike
// regardless of how large individual session files are.
const COLD_PARSE_MAX_PREFETCH_BYTES = 64 * 1024 * 1024;
const MAX_PREFETCH_BYTES = 1024 * 1024 * 1024;

async function prefetchBatch(
  workItems: { logsDir: string; wsId: string }[],
  maxFiles: number = MAX_PREFETCH_FILES,
  maxBytes: number = MAX_PREFETCH_BYTES,
): Promise<void> {
  const filePaths: string[] = [];

  await Promise.allSettled(workItems.map(async ({ logsDir, wsId }) => {
    const wsPath = path.join(logsDir, wsId);
    filePaths.push(path.join(wsPath, 'workspace.json'));

    try {
      const chatFiles = await fs.promises.readdir(path.join(wsPath, 'chatSessions'));
      for (const f of chatFiles) {
        if (filePaths.length >= maxFiles) break;
        if (f.endsWith('.json') || f.endsWith('.jsonl')) {
          filePaths.push(path.join(wsPath, 'chatSessions', f));
        }
      }
    } catch { /* no chatSessions dir */ }

    try {
      const editDirs = await fs.promises.readdir(path.join(wsPath, 'chatEditingSessions'));
      for (const d of editDirs) {
        if (filePaths.length >= maxFiles) break;
        filePaths.push(path.join(wsPath, 'chatEditingSessions', d, 'state.json'));
      }
    } catch { /* no editDir */ }
  }));

  if (filePaths.length === 0) return;

  // Stat first so we can enforce a total-byte budget before reading any content into memory.
  const sized = await Promise.all(
    filePaths.map(async fp => {
      const stat = await fs.promises.stat(fp).catch(() => null);
      return { fp, size: stat ? stat.size : -1 };
    }),
  );

  let budget = maxBytes;
  const toRead: string[] = [];
  for (const { fp, size } of sized) {
    if (size < 0 || size > MAX_PREFETCH_FILE_SIZE) continue;
    if (size > budget) continue;
    budget -= size;
    toRead.push(fp);
  }

  if (toRead.length === 0) return;

  const readPromise = Promise.allSettled(
    toRead.map(async fp => {
      const content = await fs.promises.readFile(fp, 'utf-8').catch(() => null);
      if (content !== null) prefetchCache.set(fp, content);
    }),
  );
  await withTimeout(readPromise, PREFETCH_TIMEOUT_MS);
}

const BATCH_SIZE = 32;

function toDateStr(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function makeWorkspaceGroupKey(harness: string, wsId: string): string {
  return `${harness}::${wsId}`;
}

function makeWorkspaceProgressKey(workspaceKey: string, wsId: string, order: number, date?: string, size = 0): string {
  return JSON.stringify({ order, date: date ?? null, wsId, workspaceKey, size });
}

async function collectWorkspaceSessionTiles(
  logsDir: string,
  wsId: string,
  fallbackMtime: number,
): Promise<Array<{ mtime: number; size: number; date?: string }>> {
  const tiles: Array<{ mtime: number; size: number; date?: string }> = [];
  const chatDir = path.join(logsDir, wsId, 'chatSessions');

  try {
    const entries = await fs.promises.readdir(chatDir, { withFileTypes: true });
    const files = entries.filter(entry => entry.isFile() && (entry.name.endsWith('.json') || entry.name.endsWith('.jsonl')));
    const stats = await Promise.allSettled(files.map(async entry => {
      const stat = await fs.promises.stat(path.join(chatDir, entry.name));
      return { mtime: stat.mtimeMs, size: stat.size, date: stat.mtimeMs > 0 ? toDateStr(stat.mtimeMs) : undefined };
    }));
    for (const result of stats) {
      if (result.status === 'fulfilled') tiles.push(result.value);
    }
  } catch { /* no chat sessions dir */ }

  if (tiles.length === 0) {
    tiles.push({ mtime: fallbackMtime, size: 0, date: fallbackMtime > 0 ? toDateStr(fallbackMtime) : undefined });
  }

  tiles.sort((a, b) => a.mtime - b.mtime || a.size - b.size);
  return tiles;
}

type ReportProgress = (p: Partial<LoadProgress> & { phase: number }) => void;

type CacheHitResult = { result: ParseResult; dirMetas: DirMetas };

async function reportWorkspaceProgress(
  onProgress: ProgressCallback | undefined,
  progress: { processed: number; totalDirs: number; lastWsName: string; elapsed: number; sessions: number; workspaceKey: string },
  totals: SessionTotals,
): Promise<void> {
  const { processed, totalDirs, lastWsName, elapsed, sessions, workspaceKey } = progress;
  const shouldYield = elapsed > 2000 || processed % 4 === 0 || processed === totalDirs;
  const suffix = elapsed > 2000 ? ` (${(elapsed / 1000).toFixed(1)}s)` : '';
  if (onProgress) {
    onProgress({
      phase: 2,
      detail: `workspace ${processed}/${totalDirs}: ${lastWsName}${suffix}`,
      pct: pct(2, processed / totalDirs),
      sessions,
      linesOfCode: totals.linesOfCode,
      toolCalls: totals.toolCalls,
      imagesAnalyzed: totals.imagesAnalyzed,
      filesEdited: totals.filesEdited,
      requests: totals.requests,
      workspaceDone: workspaceKey,
    });
  }
  if (shouldYield) await yieldToLoop();
}

async function tryMemoryCache(
  currentMetas: DirMetas,
  onProgress: ProgressCallback | undefined,
  report: ReportProgress,
): Promise<CacheHitResult | null> {
  const mem = getMemoryCache();
  if (!mem) return null;

  const { stale, removed } = findStaleDirs(currentMetas, mem.dirMetas);
  if (stale.size !== 0 || removed.size !== 0) return null;

  mem.result.sessions = mem.result.sessions.filter(s => !EXTERNAL_HARNESS_SET.has(s.harness));
  await collectExternalHarnesses(mem.result.workspaces, mem.result.sessions, onProgress);
  report({
    phase: 1, detail: 'Loaded from memory', pct: pct(1, 1),
    sessions: mem.result.sessions.length,
    ...computeSessionTotals(mem.result.sessions),
  });
  return { result: mem.result, dirMetas: currentMetas };
}

async function tryDiskCache(
  currentMetas: DirMetas,
  onProgress: ProgressCallback | undefined,
  report: ReportProgress,
): Promise<CacheHitResult | null> {
  const cached = await loadCacheData();
  if (!cached) return null;

  const { stale, removed } = findStaleDirs(currentMetas, cached.dirMetas);
  if (stale.size !== 0 || removed.size !== 0) return null;

  cached.result.sessions = cached.result.sessions.filter(s => !EXTERNAL_HARNESS_SET.has(s.harness));
  await collectExternalHarnesses(cached.result.workspaces, cached.result.sessions, onProgress);
  setMemoryCache(cached.result, currentMetas);
  report({
    phase: 1, detail: 'Loaded from cache', pct: pct(1, 1),
    sessions: cached.result.sessions.length,
    ...computeSessionTotals(cached.result.sessions),
  });
  return { result: cached.result, dirMetas: currentMetas };
}

interface WorkspaceWorkItem {
  logsDir: string;
  wsId: string;
  harness: string;
  mtime: number;
  workspaceKey: string;
  sessionTiles: Array<{ mtime: number; size: number; date?: string }>;
}

/** Enumerate workspace folders, stat them for dates, and collect their session tiles, sorted chronologically. */
async function buildWorkspaceWorkList(
  entries: { logsDir: string; dirEntries: fs.Dirent[] }[],
): Promise<WorkspaceWorkItem[]> {
  const work: WorkspaceWorkItem[] = [];
  for (const { logsDir, dirEntries } of entries) {
    const harness = harnessFromPath(logsDir);
    for (const d of dirEntries) work.push({ logsDir, wsId: d.name, harness, mtime: 0, workspaceKey: makeWorkspaceGroupKey(harness, d.name), sessionTiles: [] });
  }

  // Stat workspace directories in parallel to get modification dates for the calendar view
  await Promise.allSettled(work.map(async (item) => {
    try {
      const stat = await fs.promises.stat(path.join(item.logsDir, item.wsId));
      item.mtime = stat.mtimeMs;
    } catch { /* leave as 0 */ }
  }));

  await Promise.allSettled(work.map(async (item) => {
    item.sessionTiles = await collectWorkspaceSessionTiles(item.logsDir, item.wsId, item.mtime);
  }));

  // Sort by date so the loading graph fills in chronologically
  work.sort((a, b) => a.mtime - b.mtime);
  return work;
}

/** Flatten the work list into the ordered loading-plan keys consumed by the webview grid. */
function buildWorkspacePlan(work: WorkspaceWorkItem[]): string[] {
  const planItems: string[] = [];
  let planOrder = 0;
  for (const item of work) {
    for (const tile of item.sessionTiles) {
      planItems.push(makeWorkspaceProgressKey(item.workspaceKey, item.wsId, planOrder++, tile.date, tile.size));
    }
  }
  return planItems;
}

async function processWorkspaces(
  entries: { logsDir: string; dirEntries: fs.Dirent[] }[],
  totalDirs: number,
  ctx: ParseContext,
  onProgress?: ProgressCallback,
  isColdParse = true,
): Promise<void> {
  const effectiveMaxPrefetch = isColdParse
    ? Math.min(COLD_PARSE_MAX_PREFETCH_FILES, MAX_PREFETCH_FILES)
    : MAX_PREFETCH_FILES;
  const effectiveMaxPrefetchBytes = isColdParse ? COLD_PARSE_MAX_PREFETCH_BYTES : MAX_PREFETCH_BYTES;
  const tWorkList = Date.now();
  const work = await buildWorkspaceWorkList(entries);
  const workListMs = Date.now() - tWorkList;
  const planItems = buildWorkspacePlan(work);

  // Phase-2 gap attribution (issue #106 follow-up). The cold-parse-breakdown showed the actual
  // file parsing is a small fraction of phase 2; these accumulators reveal where the rest of the
  // wall-clock goes (workspace listing vs prefetch I/O wait vs per-workspace processing).
  let prefetchWaitMs = 0;
  let entryWallMs = 0;

  // Build the workspace-level loading plan in processing order.
  if (onProgress && planItems.length > 0) {
    onProgress({
      phase: 2,
      detail: `Scanning ${totalDirs} workspace folders for sessions`,
      pct: pct(2, 0),
      sessions: ctx.sessions.length,
      workspacePlan: planItems,
    });
    await yieldToLoop();
  }

  let processed = 0;
  let lastLocIndex = 0;
  let strippedUpTo = 0;
  const running = createRunningTotals();

  function foldNewSessions(): void {
    for (; lastLocIndex < ctx.sessions.length; lastLocIndex++) running.add(ctx.sessions[lastLocIndex]);
  }

  try {
    for (let i = 0; i < work.length; i += BATCH_SIZE) {
      const batch = work.slice(i, i + BATCH_SIZE);
      const nextBatch = work.slice(i + BATCH_SIZE, i + BATCH_SIZE * 2);

      if (i === 0) {
        const tPre = Date.now();
        await prefetchBatch(batch, effectiveMaxPrefetch, effectiveMaxPrefetchBytes);
        prefetchWaitMs += Date.now() - tPre;
      }

      const nextPrefetch = nextBatch.length > 0 ? prefetchBatch(nextBatch, effectiveMaxPrefetch, effectiveMaxPrefetchBytes) : Promise.resolve();

      let lastWsName = '';
      for (const { logsDir, wsId, harness, workspaceKey } of batch) {
        const start = Date.now();
        try {
          lastWsName = await processWorkspaceEntryAsync(logsDir, wsId, harness, ctx, (progress) => {
            if (!onProgress) return;
            const totals = running.snapshot();
            onProgress({
              phase: 2,
              detail: `workspace ${processed + 1}/${totalDirs}: ${progress.wsName} — ${progress.detail}`,
              pct: pct(2, (processed + (progress.completed / progress.total)) / totalDirs),
              sessions: ctx.sessions.length,
              linesOfCode: totals.linesOfCode,
              toolCalls: totals.toolCalls,
              imagesAnalyzed: totals.imagesAnalyzed,
              filesEdited: totals.filesEdited,
              requests: totals.requests,
            });
          });
        } catch (e) {
          lastWsName = wsId;
          recordFailedFile('parser', logsDir, e);
        }
        const elapsed = Date.now() - start;
        entryWallMs += elapsed;

        // Incrementally compute stats from newly added sessions
        foldNewSessions();

        // Eagerly strip the heavy text (responseText, oversized messageText) from sessions as
        // soon as their stats are computed, instead of holding every session's full content in
        // heap until the end of the cold parse. With large histories the all-at-once retention
        // pushed the worker's RSS past Electron/Chromium's ~2GB allocator OOM ceiling, which
        // hard-aborts the process (exit 0xE0000008) below the V8 heap limit and bypasses Node's
        // fatal-error diagnostics (issue #106). The disk cache is serialized from the already
        // stripped sessions, so this changes peak memory only — not the parsed result.
        for (let si = strippedUpTo; si < ctx.sessions.length; si++) stripSingleSession(ctx.sessions[si]);
        strippedUpTo = ctx.sessions.length;

        processed++;
        await reportWorkspaceProgress(
          onProgress,
          { processed, totalDirs, lastWsName, elapsed, sessions: ctx.sessions.length, workspaceKey },
          running.snapshot(),
        );
      }

      const tWait = Date.now();
      await nextPrefetch;
      prefetchWaitMs += Date.now() - tWait;
      await yieldToLoop();
      // Backstop: reclaim any transient batch garbage before reading the next batch, keeping RSS
      // under Electron's ~2GB allocator OOM ceiling during large cold parses (issue #106).
      maybeForceGc();
    }
  } finally {
    prefetchCache.clear();
  }
  runtimeDebug('parser', 'phase2-attribution',
    `workspaces=${work.length} workListMs=${workListMs} prefetchWaitMs=${prefetchWaitMs} ` +
    `entryWallMs=${entryWallMs} totalMs=${Date.now() - tWorkList}`);
}

async function collectXcode(
  xcodeDirs: string[],
  workspaces: Map<string, Workspace>,
  sessions: import('./types').Session[],
  onProgress?: ProgressCallback,
): Promise<void> {
  if (xcodeDirs.length === 0) return;
  if (onProgress) onProgress({ phase: 3, detail: 'Xcode', pct: pct(3, 0), sessions: sessions.length });
  await yieldToLoop();
  for (const xcodeBase of xcodeDirs) {
    try {
      for (const s of await parseXcodeDatabasesAsync(xcodeBase)) {
        sessions.push(s);
        if (!workspaces.has(s.workspaceId)) {
          workspaces.set(s.workspaceId, { id: s.workspaceId, name: s.workspaceName, path: xcodeBase });
        }
      }
    } catch (e) {
      warnCore('parser', 'Xcode scan failed', e);
    }
  }
  await yieldToLoop();
}

async function collectExternalHarnesses(
  workspaces: Map<string, Workspace>,
  sessions: import('./types').Session[],
  onProgress?: ProgressCallback,
): Promise<void> {
  await collectExternalHarnessesAsync(workspaces, sessions, {
    onHarnessStart: (name, index, total, sessionCount) => {
      if (onProgress) onProgress({ phase: 3, detail: name, pct: pct(3, index / total), sessions: sessionCount });
    },
    onHarnessDetail: (name, detail, sessionCount) => {
      if (onProgress) onProgress({ phase: 3, detail: `${name} ${detail}`, pct: pct(3, 0.3), sessions: sessionCount });
    },
    onHarnessError: (name, error) => {
      warnCore('parser', `${name} scan failed`, error);
    },
    yieldToLoop,
  });
}

export function parseAllLogs(logsDirs: string[]): ParseResult {
  const workspaces = new Map<string, Workspace>();
  const sessions: import('./types').Session[] = [];
  const editLocIndex = new Map<string, Map<string, number>>();
  const sessionSourceIndex = new Map<string, SessionSource>();
  const ctx: ParseContext = { workspaces, sessions, editLocIndex, sessionSourceIndex, aiLoc: 0 };

  const { vsCodeDirs, xcodeDirs } = partitionDirs(logsDirs);
  const { entries } = scanVsCodeDirs(vsCodeDirs);

  for (const { logsDir, dirEntries } of entries) {
    const harness = harnessFromPath(logsDir);
    for (const d of dirEntries) processWorkspaceEntry(logsDir, d.name, harness, ctx);
  }

  for (const xcodeBase of xcodeDirs) {
    for (const s of parseXcodeDatabases(xcodeBase)) {
      sessions.push(s);
      if (!workspaces.has(s.workspaceId)) {
        workspaces.set(s.workspaceId, { id: s.workspaceId, name: s.workspaceName, path: xcodeBase });
      }
    }
  }

  collectExternalHarnessesSync(workspaces, sessions);

  stripSessionsForMemory(sessions);
  return { workspaces, sessions, editLocIndex, sessionSourceIndex };
}

export async function parseAllLogsAsyncDetailed(
  logsDirs: string[],
  onProgress?: ProgressCallback,
): Promise<{ result: ParseResult; dirMetas: DirMetas }> {

  const report: ReportProgress = (p) => {
    if (onProgress) onProgress({ detail: '', pct: pct(p.phase, 0), sessions: 0, ...p });
  };

  // Clear any warnings from a previous parse in this process (the worker is fresh per run, but
  // the in-process path can be invoked repeatedly).
  resetParseWarnings();
  resetParseTiming();

  // Emit the cold-parse sub-phase attribution once, just before returning, so a single run shows
  // exactly where phase-2 wall-clock went (issue #106 follow-up). Pure measurement.
  const logParseBreakdown = (mode: string): void => {
    const t = getParseTiming();
    runtimeDebug('parser', 'cold-parse-breakdown',
      `mode=${mode} chatMs=${t.chatMs} editMs=${t.editMs} cliMs=${t.cliMs} ` +
      `chatFiles=${t.chatFiles} editFiles=${t.editFiles} forcedGc=${t.forcedGc}`);
  };

  report({ phase: 1, detail: 'Computing directory fingerprints' });
  await yieldToLoop();
  const currentMetas = await computeDirMetasAsync(logsDirs);

  const memoryHit = await tryMemoryCache(currentMetas, onProgress, report);
  if (memoryHit) return memoryHit;

  report({ phase: 1, detail: 'Loading disk cache', pct: pct(1, 0.5) });
  await yieldToLoop();
  const diskHit = await tryDiskCache(currentMetas, onProgress, report);
  if (diskHit) return diskHit;

  const cached = await loadCacheData();
  if (cached) {
    const { stale, removed } = findStaleDirs(currentMetas, cached.dirMetas);

    const affectedWsIds = new Set<string>();
    for (const fullPath of [...stale, ...removed]) affectedWsIds.add(path.basename(fullPath));

    const { workspaces, sessions: cachedSessions, editLocIndex, sessionSourceIndex } = cached.result;
    const staleRequestIds = new Set<string>();
    const freshSessions: import('./types').Session[] = [];
    const freshSessionSourceIndex = new Map<string, SessionSource>();
    for (const s of cachedSessions) {
      if (affectedWsIds.has(s.workspaceId) || EXTERNAL_HARNESS_SET.has(s.harness)) {
        for (const r of s.requests) staleRequestIds.add(r.requestId);
      } else {
        freshSessions.push(s);
        const source = sessionSourceIndex.get(s.sessionId);
        if (source) freshSessionSourceIndex.set(s.sessionId, source);
      }
    }
    for (const wsId of affectedWsIds) workspaces.delete(wsId);
    for (const reqId of staleRequestIds) editLocIndex.delete(reqId);

    const stalePaths = [...stale];
    const staleWork = stalePaths.map((wsPath) => {
      const logsDir = path.dirname(wsPath);
      const wsId = path.basename(wsPath);
      const harness = harnessFromPath(logsDir);
      let date: string | undefined;
      let mtime = 0;
      try {
        mtime = fs.statSync(wsPath).mtimeMs;
        date = toDateStr(mtime);
      } catch { /* ignore */ }
      return { logsDir, wsId, harness, workspaceKey: makeWorkspaceGroupKey(harness, wsId), mtime, date, sessionTiles: [] as Array<{ mtime: number; size: number; date?: string }> };
    });
    await Promise.allSettled(staleWork.map(async item => {
      item.sessionTiles = await collectWorkspaceSessionTiles(item.logsDir, item.wsId, item.mtime);
    }));
    const stalePlan: string[] = [];
    let staleOrder = 0;
    for (const item of staleWork) {
      for (const tile of item.sessionTiles) {
        stalePlan.push(makeWorkspaceProgressKey(item.workspaceKey, item.wsId, staleOrder++, tile.date ?? item.date, tile.size));
      }
    }
    report({
      phase: 2,
      detail: `Updating ${stalePaths.length} changed workspace(s)`,
      pct: pct(2, 0),
      sessions: freshSessions.length,
      ...computeSessionTotals(freshSessions),
      workspacePlan: stalePlan,
    });

    let done = 0;
    for (const { logsDir, wsId, harness, workspaceKey } of staleWork) {
      await processWorkspaceEntryAsync(logsDir, wsId, harness, { workspaces, sessions: freshSessions, editLocIndex, sessionSourceIndex: freshSessionSourceIndex, aiLoc: 0 });
      done++;
      if (done % 20 === 0 || done === stalePaths.length) {
        report({ phase: 2, detail: `${done}/${stalePaths.length}`, pct: pct(2, done / stalePaths.length), sessions: freshSessions.length, workspaceDone: workspaceKey });
        await yieldToLoop();
      } else {
        report({ phase: 2, detail: `${done}/${stalePaths.length}`, pct: pct(2, done / stalePaths.length), sessions: freshSessions.length, workspaceDone: workspaceKey });
      }
    }

    const { xcodeDirs } = partitionDirs(logsDirs);
    await collectXcode(xcodeDirs, workspaces, freshSessions, onProgress);
    await collectExternalHarnesses(workspaces, freshSessions, onProgress);

    const result: ParseResult = { workspaces, sessions: freshSessions, editLocIndex, sessionSourceIndex: freshSessionSourceIndex };
    stripSessionsForMemory(result.sessions);
    setMemoryCache(result, currentMetas);
    saveCacheData(result, currentMetas);
    logParseBreakdown('incremental');
    return { result, dirMetas: currentMetas };
  }

  report({ phase: 2, detail: 'Cold parse', pct: pct(2, 0) });
  const workspaces = new Map<string, Workspace>();
  const sessions: import('./types').Session[] = [];
  const editLocIndex = new Map<string, Map<string, number>>();
  const sessionSourceIndex = new Map<string, SessionSource>();
  const ctx: ParseContext = { workspaces, sessions, editLocIndex, sessionSourceIndex, aiLoc: 0 };

  const { vsCodeDirs, xcodeDirs } = partitionDirs(logsDirs);
  const { entries, totalDirs } = scanVsCodeDirs(vsCodeDirs);

  await processWorkspaces(entries, totalDirs, ctx, onProgress);

  await collectXcode(xcodeDirs, workspaces, sessions, onProgress);
  await collectExternalHarnesses(workspaces, sessions, onProgress);

  const result: ParseResult = { workspaces, sessions, editLocIndex, sessionSourceIndex };
  stripSessionsForMemory(result.sessions);
  setMemoryCache(result, currentMetas);
  saveCacheData(result, currentMetas);
  logParseBreakdown('cold');
  return { result, dirMetas: currentMetas };
}

export async function parseAllLogsAsync(
  logsDirs: string[],
  onProgress?: ProgressCallback,
): Promise<ParseResult> {
  const { result } = await parseAllLogsAsyncDetailed(logsDirs, onProgress);
  return result;
}

/* The out-of-process worker host lives in its own module to isolate the child-process/IPC
 * concern; re-exported here so existing importers of `./parser` keep working. */
export { parseAllLogsViaWorker } from './parser-worker-host';
