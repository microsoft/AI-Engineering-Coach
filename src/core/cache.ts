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
import { Session, Workspace } from './types';
import { warnCore } from './log';
import { parseSessionFile } from './parser-vscode';
import { parseCLIEventsFile } from './parser-vscode-cli';

export interface ParseResult {
  workspaces: Map<string, Workspace>;
  sessions: Session[];
  editLocIndex: Map<string, Map<string, number>>;
  sessionSourceIndex: Map<string, SessionSource>;
}

export interface SessionSource {
  kind: 'vscode-session-file' | 'cli-events';
  filePath: string;
  workspaceId: string;
  workspaceName: string;
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
    const entries = fs.readdirSync(dirPath);
    const count = countDirs
      ? entries.length  // editingSessions: everything is a dir, count all
      : entries.filter(n => n.endsWith('.json') || n.endsWith('.jsonl')).length;
    return { count, mtime: st.mtimeMs };
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
    const entries = await fs.promises.readdir(dirPath);
    const count = countDirs
      ? entries.length
      : entries.filter(n => n.endsWith('.json') || n.endsWith('.jsonl')).length;
    return { count, mtime: st.mtimeMs };
  } catch {
    return { count: 0, mtime: 0 };
  }
}

export interface CacheData {
  result: ParseResult;
  dirMetas: DirMetas;
}

/* ---- Paths ---- */

const CACHE_DIR = path.join(process.env.HOME || process.env.USERPROFILE || '', '.copilot-analytics-cache');
const CACHE_FILE = path.join(CACHE_DIR, 'parsed.json');
const CACHE_META = path.join(CACHE_DIR, 'meta.json');

const CACHE_VERSION = 9;

interface CacheMetaPayload {
  version: number;
  dirMetas: DirMetas;
}

interface SerializedCachePayload {
  workspaces: Array<[string, Workspace]>;
  sessions: Session[];
  editLocIndex: Array<[string, Array<[string, number]>]>;
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
    editLocIndex: value.editLocIndex as Array<[string, Array<[string, number]>]>,
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
    if (!fs.existsSync(CACHE_META) || !fs.existsSync(CACHE_FILE)) return null;
    const meta = readCacheMetaPayload(JSON.parse(fs.readFileSync(CACHE_META, 'utf-8')) as unknown);
    if (!meta || meta.version !== CACHE_VERSION) return null; // old format – full re-parse

    // Read async to avoid blocking the event loop on the 200+ MB cache file
    const rawStr = await fs.promises.readFile(CACHE_FILE, 'utf-8');
    // Yield before the expensive JSON.parse so any pending IPC messages flush
    await new Promise<void>(r => setTimeout(r, 0));
    const raw = readSerializedCachePayload(JSON.parse(rawStr) as unknown);
    if (!raw) return null;
    // Yield after parse to let the event loop breathe
    await new Promise<void>(r => setTimeout(r, 0));
    const workspaces = new Map<string, Workspace>(raw.workspaces);
    const editLocIndex = new Map<string, Map<string, number>>();
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

export function saveCacheData(result: ParseResult, dirMetas: DirMetas): void {
  // Serialize immediately so the snapshot is captured before any in-memory
  // stripping (stripSessionsForMemory) mutates the sessions.  Defer the
  // actual file write to avoid blocking the event loop.
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

    const serializable = {
      workspaces: Array.from(result.workspaces.entries()),
      sessions: result.sessions,
      editLocIndex: Array.from(result.editLocIndex.entries()).map(
        ([k, v]) => [k, Array.from(v.entries())]
      ),
      sessionSourceIndex: Array.from(result.sessionSourceIndex.entries()),
    };
    const meta = { version: CACHE_VERSION, dirMetas, savedAt: Date.now() };
    // JSON.stringify eagerly so we own the data even if sessions are mutated later.
    const json = JSON.stringify(serializable);
    const metaJson = JSON.stringify(meta);

    // Write immediately via worker thread so the large JSON string can be
    // garbage-collected from the main heap once transferred to the worker.
    const fallbackWrite = (): void => {
      fs.writeFile(CACHE_FILE, json, 'utf-8', () => {});
      fs.writeFile(CACHE_META, metaJson, 'utf-8', () => {});
    };

    void import('worker_threads').then(({ Worker }) => {
      try {
        const w = new Worker(path.join(__dirname, 'cache-write-worker.js'), {
          workerData: { json, metaJson, f: CACHE_FILE, m: CACHE_META },
        });
        w.on('error', (e: Error) => console.warn('[cache] worker write error:', e.message));
        w.unref();
      } catch {
        fallbackWrite();
      }
    }).catch(() => {
      fallbackWrite();
    });
  } catch (e) {
    warnCore('cache', 'Cache write failed', e);
  }
}

/* ---- Sidebar stats (lightweight summary persisted to disk) ---- */

export interface SidebarStats {
  harnesses: string[];
  savedAt: number;
}

const SIDEBAR_STATS_FILE = path.join(CACHE_DIR, 'sidebar-stats.json');

export interface TeamModeSyncState {
  lastSnapshotFingerprint: string;
  savedAt: number;
}

const TEAM_MODE_SYNC_STATE_FILE = path.join(CACHE_DIR, 'team-mode-sync.json');

export function loadSidebarStats(): SidebarStats | null {
  try {
    if (!fs.existsSync(SIDEBAR_STATS_FILE)) return null;
    const raw = JSON.parse(fs.readFileSync(SIDEBAR_STATS_FILE, 'utf-8')) as Partial<SidebarStats>;
    // Reject malformed data missing required fields
    if (!Array.isArray(raw.harnesses) || typeof raw.savedAt !== 'number') return null;
    return raw as SidebarStats;
  } catch {
    return null;
  }
}

export function saveSidebarStats(stats: SidebarStats): void {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(SIDEBAR_STATS_FILE, JSON.stringify(stats), 'utf-8');
  } catch {
    // best-effort
  }
}

export function loadTeamModeSyncState(): TeamModeSyncState | null {
  try {
    if (!fs.existsSync(TEAM_MODE_SYNC_STATE_FILE)) return null;
    const raw = JSON.parse(fs.readFileSync(TEAM_MODE_SYNC_STATE_FILE, 'utf-8')) as Partial<TeamModeSyncState>;
    if (typeof raw.lastSnapshotFingerprint !== 'string' || typeof raw.savedAt !== 'number') return null;
    return raw as TeamModeSyncState;
  } catch {
    return null;
  }
}

export function saveTeamModeSyncState(state: TeamModeSyncState): void {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(TEAM_MODE_SYNC_STATE_FILE, JSON.stringify(state), 'utf-8');
  } catch {
    // best-effort
  }
}

export function clearCache(): void {
  memoryCache = null;
  try { fs.unlinkSync(CACHE_FILE); } catch (e) {
    console.debug('Cache file removal skipped:', e instanceof Error ? e.message : e);
  }
  try { fs.unlinkSync(CACHE_META); } catch (e) {
    console.debug('Cache meta removal skipped:', e instanceof Error ? e.message : e);
  }
  try { fs.unlinkSync(SIDEBAR_STATS_FILE); } catch (e) {
    console.debug('Sidebar stats removal skipped:', e instanceof Error ? e.message : e);
  }
}

/* ---- Memory-efficient in-RAM representation ---- */

/**
 * Maximum chars to keep in memory for messageText.
 * Enough for all regex-based classification (work-type, intent, spec-detection,
 * profanity scanning, prompt grading) while saving ~95% of text memory.
 */
const MEMORY_PREVIEW_CHARS = 500;

/**
 * Strip text fields from sessions to reduce in-memory footprint.
 * - messageText is truncated to MEMORY_PREVIEW_CHARS (enough for all analytics).
 * - responseText is cleared entirely (only needed for session detail view, loaded from disk on demand).
 * - todoSnapshot is dropped (only used in session detail).
 *
 * Call this after saving the full data to disk cache and before handing
 * sessions to the Analyzer.
 */
export function stripSessionsForMemory(sessions: Session[]): void {
  for (const s of sessions) {
    for (const r of s.requests) {
      if (r.messageText.length > MEMORY_PREVIEW_CHARS) {
        r.messageText = r.messageText.substring(0, MEMORY_PREVIEW_CHARS);
      }
      r.responseText = '';
      if (r.todoSnapshot) r.todoSnapshot = null;
    }
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

    if (source.kind === 'cli-events') {
      return parseCLIEventsFile(source.filePath, source.workspaceId, source.workspaceName);
    }
    return parseSessionFile(source.filePath, source.workspaceId, source.workspaceName, source.harness);
  } catch {
    return null;
  }
}
