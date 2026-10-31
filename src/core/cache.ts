/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Disk and in-memory cache for parsed session data.
 *
 * Uses per-workspace-directory fingerprints so that only workspaces whose
 * chatSessions or chatEditingSessions actually changed are re-parsed on
 * restart.  Typically <5 dirs change between restarts, making reload near
 * instant even with thousands of workspace dirs.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Worker } from 'worker_threads';
import { Session, Workspace } from './types';
import { EditLoc, EditLocIndex } from './edit-loc-diff';
import { warnCore } from './log';
import { loadSessionDetails } from './session-image-loader';
import { stripSingleSession } from './parser-shared';
import { getCacheDir } from './cache-paths';
import { isCacheWriteWorkerResult, removeStaleTempFiles, writeCacheFiles, type CacheWritePayload } from './cache-write';
import { runtimeDebug } from './runtime-debug';

export interface ParseResult {
  workspaces: Map<string, Workspace>;
  sessions: Session[];
  editLocIndex: EditLocIndex;
  sessionSourceIndex: Map<string, SessionSource>;
  /** Counts of session files / lines the parser had to skip. Surfaced as a post-load banner so a
   *  partial parse is discoverable. Absent on cold disk-cache restores (no parse ran). */
  parseWarnings?: { skippedFiles: number; skippedLines: number };
}

export interface SessionSource {
  kind: 'vscode-session-file' | 'cli-events' | 'claude-jsonl' | 'codex-jsonl' | 'opencode-storage' | 'opencode-db' | 'xcode-db';
  filePath: string;
  additionalFilePaths?: string[];
  workspaceId: string;
  workspaceName: string;
  workspaceRootPath?: string;
  harness: string;
}

/* ---- Per-directory metadata ---- */

export interface DirMeta {
  chatCount: number;
  chatMaxMtime: number;
  editCount: number;
  editMaxMtime: number;
}

export type DirMetas = Record<string, DirMeta>;

/**
 * Fast directory fingerprint.
 * Uses directory mtime (changes on add/remove) + count of relevant entries.
 * Only counts .json/.jsonl files for chatSessions, directories for editingSessions.
 */
function dirFingerprint(dirPath: string, countDirs = false): { count: number; mtime: number } {
  try {
    const st = fs.statSync(dirPath);
    if (!st.isDirectory()) return { count: 0, mtime: 0 };
    if (!countDirs) {
      const entries = fs.readdirSync(dirPath);
      return {
        count: entries.filter(name => name.endsWith('.json') || name.endsWith('.jsonl')).length,
        mtime: st.mtimeMs,
      };
    }
    const entries = fs.readdirSync(dirPath, { withFileTypes: true })
      .filter(entry => entry.isDirectory());
    let mtime = st.mtimeMs;
    for (const entry of entries) {
      try {
        mtime = Math.max(mtime, fs.statSync(path.join(dirPath, entry.name, 'state.json')).mtimeMs);
      } catch {
        // A partially written editing-session directory may not have state.json yet.
      }
    }
    return { count: entries.length, mtime };
  } catch {
    return { count: 0, mtime: 0 };
  }
}

/**
 * Fast async directory fingerprint.
 * Uses directory mtime (changes on add/remove) + count of relevant entries.
 */
async function dirFingerprintAsync(dirPath: string, countDirs = false): Promise<{ count: number; mtime: number }> {
  try {
    const st = await fs.promises.stat(dirPath);
    if (!st.isDirectory()) return { count: 0, mtime: 0 };
    if (!countDirs) {
      const entries = await fs.promises.readdir(dirPath);
      return {
        count: entries.filter(name => name.endsWith('.json') || name.endsWith('.jsonl')).length,
        mtime: st.mtimeMs,
      };
    }
    const entries = (await fs.promises.readdir(dirPath, { withFileTypes: true }))
      .filter(entry => entry.isDirectory());
    let mtime = st.mtimeMs;
    const BATCH_SIZE = 128;
    for (let i = 0; i < entries.length; i += BATCH_SIZE) {
      const stats = await Promise.allSettled(
        entries.slice(i, i + BATCH_SIZE)
          .map(entry => fs.promises.stat(path.join(dirPath, entry.name, 'state.json'))),
      );
      for (const result of stats) {
        if (result.status === 'fulfilled') mtime = Math.max(mtime, result.value.mtimeMs);
      }
    }
    return { count: entries.length, mtime };
  } catch {
    return { count: 0, mtime: 0 };
  }
}

export interface CacheData {
  result: ParseResult;
  dirMetas: DirMetas;
}

/* ---- Paths ---- */

const cacheFilePath = (): string => path.join(getCacheDir(), 'parsed.json');
const cacheMetaPath = (): string => path.join(getCacheDir(), 'meta.json');

const CACHE_VERSION = 22;

/** Refuse to JSON.parse cache files beyond these sizes: a corrupted (or
 *  tampered) cache must degrade to a full re-parse, not OOM the host. */
const MAX_CACHE_FILE_BYTES = 1024 * 1024 * 1024; // 1 GiB
const MAX_CACHE_META_BYTES = 64 * 1024 * 1024; // 64 MiB

interface CacheMetaPayload {
  version: number;
  dirMetas: DirMetas;
}

interface SerializedCachePayload {
  workspaces: Array<[string, Workspace]>;
  sessions: Session[];
  editLocIndex: Array<[string, Array<[string, EditLoc]>]>;
  sessionSourceIndex: Array<[string, SessionSource]>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readCacheMetaPayload(value: unknown): CacheMetaPayload | null {
  if (!isRecord(value) || typeof value.version !== 'number') return null;
  return {
    version: value.version,
    dirMetas: isRecord(value.dirMetas) ? value.dirMetas as DirMetas : {},
  };
}

function readSerializedCachePayload(value: unknown): SerializedCachePayload | null {
  if (!isRecord(value)) return null;
  if (!Array.isArray(value.workspaces) || !Array.isArray(value.sessions) || !Array.isArray(value.editLocIndex)) {
    return null;
  }
  return {
    workspaces: value.workspaces as Array<[string, Workspace]>,
    sessions: value.sessions as Session[],
    editLocIndex: value.editLocIndex as Array<[string, Array<[string, EditLoc]>]>,
    sessionSourceIndex: Array.isArray(value.sessionSourceIndex)
      ? value.sessionSourceIndex as Array<[string, SessionSource]>
      : [],
  };
}

/* ---- In-memory cache ---- */

let memoryCache: CacheData | null = null;

export function getMemoryCache(): CacheData | null {
  return memoryCache;
}

export function setMemoryCache(result: ParseResult, dirMetas: DirMetas): void {
  memoryCache = { result, dirMetas };
}

/* ---- Compute per-workspace-dir fingerprints ---- */

export function computeDirMetas(logsDirs: string[]): DirMetas {
  const metas: DirMetas = {};
  for (const logsDir of logsDirs) {
    // Skip non-VS-Code dirs (Xcode / CLI) – they are always re-parsed
    if (logsDir.includes(path.join('.config', 'github-copilot', 'xcode')) ||
        logsDir.includes(path.join('.copilot', 'session-state')) ||
        logsDir.includes(path.join('.copilot', 'history-session-state'))) continue;
    try {
      const entries = fs.readdirSync(logsDir, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const wsPath = path.join(logsDir, e.name);

        // Use directory-level fingerprints instead of stat-ing every file.
        // A dir's mtime changes when files are added/removed/renamed inside it.
        const chat = dirFingerprint(path.join(wsPath, 'chatSessions'));
        const edit = dirFingerprint(path.join(wsPath, 'chatEditingSessions'), true);

        metas[wsPath] = {
          chatCount: chat.count,
          chatMaxMtime: chat.mtime,
          editCount: edit.count,
          editMaxMtime: edit.mtime,
        };
      }
    } catch { /* cannot read logsDir */ }
  }
  return metas;
}

/**
 * Async version: computes dir metas with concurrent I/O for speed.
 * Processes workspace directories in parallel batches.
 */
export async function computeDirMetasAsync(logsDirs: string[]): Promise<DirMetas> {
  const metas: DirMetas = {};
  const CONCURRENCY = 64;

  // Collect all workspace paths first
  const wsPaths: string[] = [];
  for (const logsDir of logsDirs) {
    if (logsDir.includes(path.join('.config', 'github-copilot', 'xcode')) ||
        logsDir.includes(path.join('.copilot', 'session-state')) ||
        logsDir.includes(path.join('.copilot', 'history-session-state'))) continue;
    try {
      const entries = await fs.promises.readdir(logsDir, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        wsPaths.push(path.join(logsDir, e.name));
      }
    } catch { /* cannot read logsDir */ }
  }

  // Process in parallel batches
  for (let i = 0; i < wsPaths.length; i += CONCURRENCY) {
    const batch = wsPaths.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async wsPath => {
        const [chat, edit] = await Promise.all([
          dirFingerprintAsync(path.join(wsPath, 'chatSessions')),
          dirFingerprintAsync(path.join(wsPath, 'chatEditingSessions'), true),
        ]);
        return { wsPath, chat, edit };
      })
    );
    for (const r of results) {
      if (r.status === 'fulfilled') {
        metas[r.value.wsPath] = {
          chatCount: r.value.chat.count,
          chatMaxMtime: r.value.chat.mtime,
          editCount: r.value.edit.count,
          editMaxMtime: r.value.edit.mtime,
        };
      }
    }
  }
  return metas;
}

/* ---- Diff helpers ---- */

function dirMetaMatches(a: DirMeta, b: DirMeta): boolean {
  return a.chatCount === b.chatCount &&
    a.chatMaxMtime === b.chatMaxMtime &&
    a.editCount === b.editCount &&
    a.editMaxMtime === b.editMaxMtime;
}

export function findStaleDirs(
  current: DirMetas,
  cached: DirMetas,
): { stale: Set<string>; removed: Set<string> } {
  const stale = new Set<string>();
  const removed = new Set<string>();

  for (const key of Object.keys(current)) {
    if (!cached[key] || !dirMetaMatches(current[key], cached[key])) {
      stale.add(key);
    }
  }
  for (const key of Object.keys(cached)) {
    if (!current[key]) removed.add(key);
  }
  return { stale, removed };
}

/* ---- Disk cache load / save ---- */

export async function loadCacheData(): Promise<CacheData | null> {
  try {
    const cacheFile = cacheFilePath();
    const cacheMeta = cacheMetaPath();
    if (!fs.existsSync(cacheMeta) || !fs.existsSync(cacheFile)) return null;
    if (fs.statSync(cacheMeta).size > MAX_CACHE_META_BYTES) {
      warnCore('Cache', 'Cache meta file exceeds size limit; ignoring and re-parsing');
      return null;
    }
    const meta = readCacheMetaPayload(JSON.parse(fs.readFileSync(cacheMeta, 'utf-8')) as unknown);
    if (!meta || meta.version !== CACHE_VERSION) return null; // old format – full re-parse

    const cacheSize = (await fs.promises.stat(cacheFile)).size;
    if (cacheSize > MAX_CACHE_FILE_BYTES) {
      warnCore('Cache', `Cache file exceeds size limit (${cacheSize} bytes); ignoring and re-parsing`);
      return null;
    }

    // Read async to avoid blocking the event loop on the 200+ MB cache file
    const rawStr = await fs.promises.readFile(cacheFile, 'utf-8');
    // Yield before the expensive JSON.parse so any pending IPC messages flush
    await new Promise<void>(r => setTimeout(r, 0));
    const raw = readSerializedCachePayload(JSON.parse(rawStr) as unknown);
    if (!raw) return null;
    // Yield after parse to let the event loop breathe
    await new Promise<void>(r => setTimeout(r, 0));
    const workspaces = new Map<string, Workspace>(raw.workspaces);
    const editLocIndex: EditLocIndex = new Map();
    for (const [k, v] of raw.editLocIndex) {
      editLocIndex.set(k, new Map(v));
    }
    const sessionSourceIndex = new Map<string, SessionSource>(raw.sessionSourceIndex);
    return {
      result: { workspaces, sessions: raw.sessions, editLocIndex, sessionSourceIndex },
      dirMetas: meta.dirMetas,
    };
  } catch (e) {
    console.debug('Cache load failed, treating as miss:', e instanceof Error ? e.message : e);
    return null;
  }
}

/** How long the parse worker waits for its cache write before it reports `done` regardless, so a
 *  stalled disk cannot hold the parse result hostage. */
const CACHE_WRITE_FLUSH_TIMEOUT_MS = 30_000;

type CacheWriteOutcome =
  | { ok: true; via: 'worker' | 'in-thread'; bytes: number }
  | { ok: false; via: 'worker' | 'in-thread'; error: string };

/** Cache writes started by this thread that have not settled yet (see flushCacheWrites). */
const pendingWrites = new Set<Promise<boolean>>();

/** Write on cache-write-worker.js, which gets its own copy of the payload, so this thread can
 *  free the large JSON string while the file is still being written. Returns null when the
 *  worker bundle or worker_threads is unavailable (unbundled sources in tests and scripts). */
function startWorkerWrite(payload: CacheWritePayload): Promise<CacheWriteOutcome> | null {
  const script = path.join(__dirname, 'cache-write-worker.js');
  if (!fs.existsSync(script)) return null;
  let worker: Worker;
  try {
    worker = new Worker(script, { workerData: payload });
  } catch {
    return null;
  }
  return new Promise((resolve) => {
    let outcome: CacheWriteOutcome = { ok: false, via: 'worker', error: 'write worker exited without reporting' };
    worker.on('message', (message: unknown) => {
      if (!isCacheWriteWorkerResult(message)) return;
      outcome = message.ok
        ? { ok: true, via: 'worker', bytes: message.bytes }
        : { ok: false, via: 'worker', error: message.error };
    });
    worker.on('error', (error: Error) => {
      outcome = { ok: false, via: 'worker', error: error.message };
    });
    worker.on('exit', () => resolve(outcome));
  });
}

function startCacheWrite(payload: CacheWritePayload): Promise<CacheWriteOutcome> {
  return startWorkerWrite(payload) ?? writeCacheFiles(payload).then(
    (bytes): CacheWriteOutcome => ({ ok: true, via: 'in-thread', bytes }),
    (error: unknown): CacheWriteOutcome => ({ ok: false, via: 'in-thread', error: error instanceof Error ? error.message : String(error) }),
  );
}

/**
 * Persist `result` to the disk cache. Serializes synchronously, so later in-memory changes
 * cannot leak into the snapshot, then writes off-thread (see cache-write.ts for crash safety).
 * Resolves true once both files are committed and false if the write failed; never rejects.
 * The write outlives this call: a worker whose parent terminates it must first await
 * flushCacheWrites(), or the write dies with it.
 */
export function saveCacheData(result: ParseResult, dirMetas: DirMetas): Promise<boolean> {
  const started = Date.now();
  let write: Promise<CacheWriteOutcome>;
  try {
    const dir = getCacheDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Cached transcripts can contain secrets users pasted into chats; keep the
    // dir owner-only (best effort — file modes are a no-op on Windows).
    try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ }
    removeStaleTempFiles(dir);

    const serializable = {
      workspaces: Array.from(result.workspaces.entries()),
      sessions: result.sessions,
      editLocIndex: Array.from(result.editLocIndex.entries()).map(
        ([k, v]) => [k, Array.from(v.entries())]
      ),
      sessionSourceIndex: Array.from(result.sessionSourceIndex.entries()),
    };
    const meta = { version: CACHE_VERSION, dirMetas, savedAt: Date.now() };
    write = startCacheWrite({
      cacheFile: path.join(dir, 'parsed.json'),
      metaFile: path.join(dir, 'meta.json'),
      json: JSON.stringify(serializable),
      metaJson: JSON.stringify(meta),
    });
  } catch (e) {
    warnCore('cache', 'Cache write failed', e);
    return Promise.resolve(false);
  }
  const serializeMs = Date.now() - started;
  const settled = write.then((outcome) => {
    if (outcome.ok) {
      runtimeDebug('cache', 'write-complete',
        `via=${outcome.via} bytes=${outcome.bytes} serializeMs=${serializeMs} totalMs=${Date.now() - started}`);
    } else {
      warnCore('cache', `Cache write failed (${outcome.via})`, outcome.error);
    }
    return outcome.ok;
  });
  pendingWrites.add(settled);
  void settled.then(() => pendingWrites.delete(settled));
  return settled;
}

/**
 * Wait until every cache write started by this thread has settled, for at most `timeoutMs`.
 * Resolves true when they all settled (written or failed) and false on timeout. The parse
 * worker awaits this before posting `done`, because its parent terminates it on `done`.
 */
export async function flushCacheWrites(timeoutMs = CACHE_WRITE_FLUSH_TIMEOUT_MS): Promise<boolean> {
  if (pendingWrites.size === 0) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<boolean>((resolve) => { timer = setTimeout(resolve, timeoutMs, false); });
  try {
    return await Promise.race([Promise.all(pendingWrites).then(() => true), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/* ---- Sidebar stats (lightweight summary persisted to disk) ---- */

export interface SidebarStats {
  harnesses: string[];
  savedAt: number;
}

const sidebarStatsPath = (): string => path.join(getCacheDir(), 'sidebar-stats.json');

export function loadSidebarStats(): SidebarStats | null {
  try {
    const file = sidebarStatsPath();
    if (!fs.existsSync(file)) return null;
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<SidebarStats>;
    // Reject malformed data missing required fields
    if (!Array.isArray(raw.harnesses) || typeof raw.savedAt !== 'number') return null;
    return raw as SidebarStats;
  } catch {
    return null;
  }
}

export function saveSidebarStats(stats: SidebarStats): void {
  try {
    const dir = getCacheDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(sidebarStatsPath(), JSON.stringify(stats), { encoding: 'utf-8', mode: 0o600 });
  } catch {
    // best-effort
  }
}

export function clearCache(): void {
  memoryCache = null;
  try { fs.unlinkSync(cacheFilePath()); } catch (e) {
    console.debug('Cache file removal skipped:', e instanceof Error ? e.message : e);
  }
  try { fs.unlinkSync(cacheMetaPath()); } catch (e) {
    console.debug('Cache meta removal skipped:', e instanceof Error ? e.message : e);
  }
  try { fs.unlinkSync(sidebarStatsPath()); } catch (e) {
    console.debug('Sidebar stats removal skipped:', e instanceof Error ? e.message : e);
  }
}

/* ---- Memory-efficient in-RAM representation ---- */

/**
 * Strip text fields from sessions to reduce in-memory footprint.
 *
 * Delegates to stripSingleSession() (defined in parser-shared) so the same stripping rules
 * apply whether sessions are stripped eagerly during parse (issue #106) or in bulk here.
 *
 * VS Code / CLI sessions are stripped eagerly during parse, so this is idempotent for them.
 * External-harness sessions (Claude/Codex/OpenCode, Xcode) are collected after the main
 * parse loop and are stripped here.
 *
 * Call this after saving the full data to disk cache and before handing
 * sessions to the Analyzer.
 */
export function stripSessionsForMemory(sessions: Session[]): void {
  for (const s of sessions) {
    stripSingleSession(s);
  }
}

/**
 * Load a specific session with full text from the disk cache.
 * Returns null if the cache is unavailable or the session isn't found.
 */
export async function loadSessionFromDisk(sessionId: string): Promise<Session | null> {
  try {
    let source = memoryCache?.result.sessionSourceIndex.get(sessionId);
    if (!source) {
      const cached = await loadCacheData();
      source = cached?.result.sessionSourceIndex.get(sessionId);
    }
    if (!source) return null;

    return await loadSessionDetails(source, sessionId);
  } catch (error) {
    warnCore('cache', `Could not reload session ${sessionId}`, error);
    return null;
  }
}
