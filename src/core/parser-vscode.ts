/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* VS Code and Copilot CLI session parsing. */

import * as fs from 'fs';
import * as path from 'path';
import { Session } from './types';
import { createSession, detectDevcontainerFromRequests, ParseContext, prefetchCache, stripSingleSession, maybeForceGc, addParseTiming } from './parser-shared';
import { accumulateEditLoc, EditTimelineLike, InitialContentResolver } from './edit-loc-diff';
import { debugCore, warnCore } from './log';
import { canonicalizeReasoningEffort } from './helpers';
import { parseRawRequest, normalizeSessionMode, type RawRequest } from './parser-vscode-request';
import { parseCLIEventsFile, parseCLIEventsFileAsync } from './parser-vscode-cli';
import { parseTranscriptFile } from './parser-vscode-transcripts';
import { parseCLIWorkspaceName, parseWorkspaceName, parseWorkspaceFolderPath, parseCLIWorkspaceFolderPath, readFile, reconstructFromJsonl, stripImageData } from './parser-vscode-files';

export function harnessFromPath(logsDir: string): string {
  if (logsDir.includes('Code - Insiders')) return 'Local Agent (Insiders)';
  // Check .vscode-server-insiders BEFORE .vscode-server — the latter is a
  // substring of the former and would match incorrectly if checked first.
  if (logsDir.includes('.vscode-server-insiders')) return 'Local Agent (Server Insiders)';
  if (logsDir.includes('.vscode-server')) return 'Local Agent (Server)';
  if (logsDir.includes('.copilot')) return 'GitHub Copilot CLI';
  return 'Local Agent';
}

export function findVsCodeDirs(): string[] {
  const dirs: string[] = [];
  const home = process.env.HOME || process.env.USERPROFILE || '';

  const editionFolders = ['Code', 'Code - Insiders'];

  for (const edition of editionFolders) {
    let vsPath: string | undefined;
    if (process.platform === 'darwin') {
      vsPath = path.join(home, 'Library', 'Application Support', edition, 'User', 'workspaceStorage');
    } else if (process.platform === 'win32') {
      vsPath = path.join(process.env.APPDATA || '', edition, 'User', 'workspaceStorage');
    } else {
      vsPath = path.join(home, '.config', edition, 'User', 'workspaceStorage');
    }
    if (vsPath && fs.existsSync(vsPath) && !dirs.includes(vsPath)) dirs.push(vsPath);
  }

  // VS Code Server only runs on the remote host (Linux/macOS), not on Windows directly.
  if (process.platform !== 'win32' && home) {
    const serverEditions = ['.vscode-server', '.vscode-server-insiders'];
    for (const serverDir of serverEditions) {
      const serverPath = path.join(home, serverDir, 'data', 'User', 'workspaceStorage');
      if (fs.existsSync(serverPath) && !dirs.includes(serverPath)) dirs.push(serverPath);
    }
  }

  // Copilot CLI paths
  const cliActive = path.join(home, '.copilot', 'session-state');
  const cliLegacy = path.join(home, '.copilot', 'history-session-state');
  if (fs.existsSync(cliActive)) dirs.push(cliActive);
  if (fs.existsSync(cliLegacy)) dirs.push(cliLegacy);

  return dirs;
}

export function scanVsCodeDirs(logsDirs: string[]): {
  entries: { logsDir: string; dirEntries: fs.Dirent[] }[];
  totalDirs: number;
} {
  const entries: { logsDir: string; dirEntries: fs.Dirent[] }[] = [];
  let totalDirs = 0;

  for (const logsDir of logsDirs) {
    try {
      const all = fs.readdirSync(logsDir, { withFileTypes: true });
      const isCliSessionState = harnessFromPath(logsDir) === 'GitHub Copilot CLI';
      const dirs = all.filter(e =>
        e.isDirectory() &&
        (!isCliSessionState || fs.existsSync(path.join(logsDir, e.name, 'events.jsonl'))),
      );
      totalDirs += dirs.length;
      entries.push({ logsDir, dirEntries: dirs });
    } catch (e) {
      debugCore('parser-vscode', `Cannot read logs dir ${logsDir}`, e);
      continue;
    }
  }

  return { entries, totalDirs };
}

export interface WorkspaceParseProgress {
  wsName: string;
  detail: string;
  completed: number;
  total: number;
}

function resolveWorkspaceName(entryPath: string, wsId: string, isCLI: boolean): string {
  const wsJsonPath = path.join(entryPath, 'workspace.json');
  const wsYamlPath = path.join(entryPath, 'workspace.yaml');
  if (prefetchCache.has(wsJsonPath)) return parseWorkspaceName(wsJsonPath);
  if (isCLI) return fs.existsSync(wsYamlPath) ? parseCLIWorkspaceName(wsYamlPath) : wsId;
  if (fs.existsSync(wsJsonPath)) return parseWorkspaceName(wsJsonPath);
  if (fs.existsSync(wsYamlPath)) return parseCLIWorkspaceName(wsYamlPath);
  return wsId;
}


const INSTRUCTIONS_BYTES_CACHE = new Map<string, number | undefined>();

function detectCustomInstructionsBytes(folderPath: string | null): number | undefined {
  if (!folderPath) return undefined;
  try {
    const target = path.join(folderPath, '.github', 'copilot-instructions.md');
    if (!fs.existsSync(target)) return 0;
    const st = fs.statSync(target);
    return Number.isFinite(st.size) ? st.size : 0;
  } catch {
    return 0;
  }
}

function resolveCustomInstructionsBytes(entryPath: string, isCLI: boolean): number | undefined {
  const cached = INSTRUCTIONS_BYTES_CACHE.get(entryPath);
  if (cached !== undefined || INSTRUCTIONS_BYTES_CACHE.has(entryPath)) return cached;
  let folder: string | null = null;
  try {
    if (isCLI) {
      const wsYaml = path.join(entryPath, 'workspace.yaml');
      if (fs.existsSync(wsYaml)) folder = parseCLIWorkspaceFolderPath(wsYaml);
    } else {
      const wsJson = path.join(entryPath, 'workspace.json');
      if (fs.existsSync(wsJson) || prefetchCache.has(wsJson)) folder = parseWorkspaceFolderPath(wsJson);
    }
  } catch { /* ignore */ }
  const bytes = detectCustomInstructionsBytes(folder);
  INSTRUCTIONS_BYTES_CACHE.set(entryPath, bytes);
  return bytes;
}

function listChatSessionFiles(chatDir: string): string[] {
  try {
    return fs.readdirSync(chatDir, { withFileTypes: true })
      .filter(cf => cf.isFile() && (cf.name.endsWith('.json') || cf.name.endsWith('.jsonl')))
      .map(cf => path.join(chatDir, cf.name));
  } catch {
    return [];
  }
}

function listEditStateFiles(esDir: string): string[] {
  try {
    return fs.readdirSync(esDir, { withFileTypes: true })
      .filter(esEnt => esEnt.isDirectory())
      .map(esEnt => path.join(esDir, esEnt.name, 'state.json'));
  } catch {
    return [];
  }
}

/** `GitHub.copilot-chat/transcripts/*.jsonl` — the session format that replaced `chatSessions`
 *  in newer VS Code / Copilot Chat builds (no `workspace.json` sidecar is written for it). */
function listTranscriptFiles(entryPath: string): string[] {
  return listChatSessionFiles(path.join(entryPath, 'GitHub.copilot-chat', 'transcripts'));
}

/** Picks the most common `workspaceRootPath` among newly parsed sessions and, if the workspace
 *  name is still just the raw storage-folder id (no `workspace.json` found), upgrades the
 *  workspace's display name/path to the derived root so it shows up as a real folder name. */
function upgradeWorkspaceFromSessionRoots(
  workspaces: ParseContext['workspaces'],
  wsId: string,
  wsName: string,
  newSessions: Session[],
): void {
  if (wsName !== wsId) return;
  const counts = new Map<string, number>();
  for (const session of newSessions) {
    const root = session.workspaceRootPath;
    if (root) counts.set(root, (counts.get(root) ?? 0) + 1);
  }
  if (counts.size === 0) return;
  const [bestRoot] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  const name = bestRoot.replaceAll('\\', '/').split('/').pop();
  if (!name) return;
  workspaces.set(wsId, { id: wsId, name, path: bestRoot });
}

function sessionFileExists(filePath: string): boolean {
  return prefetchCache.has(filePath) || fs.existsSync(filePath);
}

type EditState = {
  initialFileContents?: [string, string][];
  timeline?: EditTimelineLike;
};

/**
 * Builds a lazy resolver for a file's session-initial content, reading the content-addressed
 * `contents/<hash>` blob referenced by `initialFileContents` only when first requested.
 */
function makeInitialContentResolver(state: EditState, stateDir: string): InitialContentResolver {
  const hashByUri = new Map<string, string>();
  for (const entry of state.initialFileContents ?? []) {
    const uri = entry?.[0];
    const hash = entry?.[1];
    if (typeof uri === 'string' && typeof hash === 'string') hashByUri.set(uri, hash);
  }
  const cache = new Map<string, string | undefined>();
  return (uri: string): string | undefined => {
    if (cache.has(uri)) return cache.get(uri);
    const hash = hashByUri.get(uri);
    let content: string | undefined;
    if (hash) {
      try {
        content = readFile(path.join(stateDir, 'contents', hash));
      } catch {
        content = undefined;
      }
    }
    cache.set(uri, content);
    return content;
  };
}

/** Parses an edit-state JSON payload and accumulates AI-produced LoC into `editLocIndex`. */
export function parseEditState(raw: string, editLocIndex: ParseContext['editLocIndex'], stateDir: string): void {
  if (!raw.includes('"textEdit"')
      && !raw.includes('"create"')
      && !raw.includes('"delete"')
      && !raw.includes('"rename"')
      && !raw.includes('"notebookEdit"')) return;
  let state: EditState;
  try { state = JSON.parse(raw) as EditState; } catch (e) {
    warnCore('parser-vscode', `Corrupt state payload in ${stateDir}`, e);
    return;
  }
  accumulateEditLoc(state.timeline, editLocIndex, makeInitialContentResolver(state, stateDir));
}

function parseEditStateFile(stateFile: string, editLocIndex: ParseContext['editLocIndex']): void {
  let raw: string;
  try { raw = readFile(stateFile); } catch (e) {
    const code = typeof e === 'object' && e && 'code' in e ? (e as NodeJS.ErrnoException).code : undefined;
    if (code !== 'ENOENT') {
      debugCore('parser-vscode', `Cannot read state file ${stateFile}`, e);
    }
    return;
  }
  parseEditState(raw, editLocIndex, path.dirname(stateFile));
}

function chunkInterval(total: number): number {
  if (total >= 300) return 10;
  if (total >= 120) return 8;
  if (total >= 40) return 5;
  return 1;
}

function shouldReportChunk(index: number, total: number, every: number): boolean {
  return (index + 1) % every === 0 || index === total - 1;
}

function yieldToLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

function initializeWorkspaceEntry(
  logsDir: string,
  wsId: string,
  harness: string,
  workspaces: ParseContext['workspaces'],
): { entryPath: string; wsName: string; isCLI: boolean; customInstructionsBytes: number | undefined } {
  const entryPath = path.join(logsDir, wsId);
  const isCLI = harness === 'GitHub Copilot CLI';
  const wsName = resolveWorkspaceName(entryPath, wsId, isCLI);
  const customInstructionsBytes = resolveCustomInstructionsBytes(entryPath, isCLI);
  workspaces.set(wsId, { id: wsId, name: wsName, path: entryPath });
  return { entryPath, wsName, isCLI, customInstructionsBytes };
}


/**
 * Strip heavy text from sessions appended at or after `startIdx`. Used to free per-workspace
 * full text immediately after each workspace is parsed, capping the cold-parse heap peak (#106).
 */
function stripSessionsFrom(sessions: Session[], startIdx: number): void {
  for (let i = startIdx; i < sessions.length; i++) stripSingleSession(sessions[i]);
}

export function processWorkspaceEntry(
  logsDir: string,
  wsId: string,
  harness: string,
  ctx: ParseContext,
): string {
  const { workspaces, sessions, editLocIndex, sessionSourceIndex } = ctx;
  const startIdx = sessions.length;
  const { entryPath, wsName, isCLI, customInstructionsBytes } = initializeWorkspaceEntry(logsDir, wsId, harness, workspaces);

  if (isCLI) {
    const eventsFile = path.join(entryPath, 'events.jsonl');
    const cliSession = parseCLIEventsFile(eventsFile, wsId, wsName, customInstructionsBytes, editLocIndex);
    if (cliSession) {
      sessions.push(cliSession);
      sessionSourceIndex.set(cliSession.sessionId, {
        kind: 'cli-events',
        filePath: eventsFile,
        workspaceId: wsId,
        workspaceName: wsName,
        harness,
      });
    }
    stripSessionsFrom(sessions, startIdx);
    return wsName;
  }

  const chatDir = path.join(entryPath, 'chatSessions');
  for (const sessionFile of listChatSessionFiles(chatDir)) {
    const session = parseSessionFile(sessionFile, wsId, wsName, harness, customInstructionsBytes);
    if (session) {
      sessions.push(session);
      sessionSourceIndex.set(session.sessionId, {
        kind: 'vscode-session-file',
        filePath: sessionFile,
        workspaceId: wsId,
        workspaceName: wsName,
        harness,
      });
    }
  }

  const eventsFile = path.join(entryPath, 'events.jsonl');
  if (sessionFileExists(eventsFile)) {
    const cliSession = parseCLIEventsFile(eventsFile, wsId, wsName, customInstructionsBytes, editLocIndex);
    if (cliSession) {
      sessions.push(cliSession);
      sessionSourceIndex.set(cliSession.sessionId, {
        kind: 'cli-events',
        filePath: eventsFile,
        workspaceId: wsId,
        workspaceName: wsName,
        harness,
      });
    }
  }

  const esDir = path.join(entryPath, 'chatEditingSessions');
  for (const stateFile of listEditStateFiles(esDir)) {
    parseEditStateFile(stateFile, editLocIndex);
  }

  const transcriptStartIdx = sessions.length;
  for (const transcriptFile of listTranscriptFiles(entryPath)) {
    const session = parseTranscriptFile(transcriptFile, wsId, wsName, harness, customInstructionsBytes, editLocIndex);
    if (session) {
      sessions.push(session);
      sessionSourceIndex.set(session.sessionId, {
        kind: 'vscode-transcript',
        filePath: transcriptFile,
        workspaceId: wsId,
        workspaceName: wsName,
        harness,
      });
    }
  }
  upgradeWorkspaceFromSessionRoots(workspaces, wsId, wsName, sessions.slice(transcriptStartIdx));

  // Strip the heavy text from sessions added by this workspace immediately, so full-text
  // does not accumulate across every workspace during a cold parse (issue #106).
  stripSessionsFrom(sessions, startIdx);
  return wsName;
}

export async function processWorkspaceEntryAsync(
  logsDir: string,
  wsId: string,
  harness: string,
  ctx: ParseContext,
  onProgress?: (progress: WorkspaceParseProgress) => void,
): Promise<string> {
  const { workspaces, sessions, editLocIndex, sessionSourceIndex } = ctx;
  const startIdx = sessions.length;
  const { entryPath, wsName, isCLI, customInstructionsBytes } = initializeWorkspaceEntry(logsDir, wsId, harness, workspaces);

  if (isCLI) {
    const eventsFile = path.join(entryPath, 'events.jsonl');
    // Stream the events file asynchronously with byte progress, so a multi-GB events.jsonl keeps
    // the worker responsive and advances the host progress bar instead of freezing it (issue #106).
    const cliSession = await parseCLIEventsFileAsync(
      eventsFile,
      wsId,
      wsName,
      customInstructionsBytes,
      (bytesRead, totalBytes) => {
        const total = Math.max(1, totalBytes);
        onProgress?.({
          wsName,
          detail: `events.jsonl ${Math.round((bytesRead / total) * 100)}%`,
          completed: bytesRead,
          total,
        });
      },
      editLocIndex,
    );
    if (cliSession) {
      sessions.push(cliSession);
      sessionSourceIndex.set(cliSession.sessionId, {
        kind: 'cli-events',
        filePath: eventsFile,
        workspaceId: wsId,
        workspaceName: wsName,
        harness,
      });
    }
    stripSessionsFrom(sessions, startIdx);
    return wsName;
  }

  const chatFiles = listChatSessionFiles(path.join(entryPath, 'chatSessions'));
  const editStateFiles = listEditStateFiles(path.join(entryPath, 'chatEditingSessions'));
  const transcriptFiles = listTranscriptFiles(entryPath);
  const totalUnits = Math.max(1, chatFiles.length + editStateFiles.length + transcriptFiles.length);
  const chatEvery = chunkInterval(chatFiles.length);
  const editEvery = chunkInterval(editStateFiles.length);
  const transcriptEvery = chunkInterval(transcriptFiles.length);
  let completed = 0;

  for (let i = 0; i < chatFiles.length; i++) {
    const tChat = Date.now();
    const session = parseSessionFile(chatFiles[i], wsId, wsName, harness, customInstructionsBytes);
    addParseTiming('chat', Date.now() - tChat);
    if (session) {
      // Strip heavy text the moment a session is parsed so a workspace with many large
      // sessions can't accumulate its full text before the workspace finishes (issue #106).
      stripSingleSession(session);
      sessions.push(session);
      sessionSourceIndex.set(session.sessionId, {
        kind: 'vscode-session-file',
        filePath: chatFiles[i],
        workspaceId: wsId,
        workspaceName: wsName,
        harness,
      });
    }
    completed++;
    if (shouldReportChunk(i, chatFiles.length, chatEvery)) {
      onProgress?.({
        wsName,
        detail: `chat ${i + 1}/${chatFiles.length}`,
        completed,
        total: totalUnits,
      });
    }
    // Always yield after each file to keep the event loop responsive,
    // especially for workspaces with many large session files.
    await yieldToLoop();
    // Reclaim the file's transient parse garbage (raw text, split arrays, per-line JSON) before
    // the next file, so RSS stays under Electron's ~2GB allocator OOM ceiling (issue #106).
    maybeForceGc();
  }

  const eventsFile = path.join(entryPath, 'events.jsonl');
  if (sessionFileExists(eventsFile)) {
    const tCli = Date.now();
    const cliSession = parseCLIEventsFile(eventsFile, wsId, wsName, customInstructionsBytes, editLocIndex);
    addParseTiming('cli', Date.now() - tCli);
    if (cliSession) {
      stripSingleSession(cliSession);
      sessions.push(cliSession);
      sessionSourceIndex.set(cliSession.sessionId, {
        kind: 'cli-events',
        filePath: eventsFile,
        workspaceId: wsId,
        workspaceName: wsName,
        harness,
      });
    }
  }

  for (let i = 0; i < editStateFiles.length; i++) {
    const tEdit = Date.now();
    parseEditStateFile(editStateFiles[i], editLocIndex);
    addParseTiming('edit', Date.now() - tEdit);
    completed++;
    if (shouldReportChunk(i, editStateFiles.length, editEvery)) {
      onProgress?.({
        wsName,
        detail: `edits ${i + 1}/${editStateFiles.length}`,
        completed,
        total: totalUnits,
      });
    }
    await yieldToLoop();
  }

  const transcriptStartIdx = sessions.length;
  for (let i = 0; i < transcriptFiles.length; i++) {
    const tTranscript = Date.now();
    const session = parseTranscriptFile(transcriptFiles[i], wsId, wsName, harness, customInstructionsBytes, editLocIndex);
    addParseTiming('transcript', Date.now() - tTranscript);
    if (session) {
      stripSingleSession(session);
      sessions.push(session);
      sessionSourceIndex.set(session.sessionId, {
        kind: 'vscode-transcript',
        filePath: transcriptFiles[i],
        workspaceId: wsId,
        workspaceName: wsName,
        harness,
      });
    }
    completed++;
    if (shouldReportChunk(i, transcriptFiles.length, transcriptEvery)) {
      onProgress?.({
        wsName,
        detail: `transcripts ${i + 1}/${transcriptFiles.length}`,
        completed,
        total: totalUnits,
      });
    }
    await yieldToLoop();
  }
  upgradeWorkspaceFromSessionRoots(workspaces, wsId, wsName, sessions.slice(transcriptStartIdx));

  // Strip the heavy text from sessions added by this workspace immediately, so full-text
  // does not accumulate across every workspace during a cold parse (issue #106).
  stripSessionsFrom(sessions, startIdx);
  return wsName;
}

interface SessionFileData {
  creationDate?: number;
  lastMessageDate?: number;
  sessionId?: string;
  initialLocation?: string;
  requests?: RawRequest[];
  inputState?: {
    mode?: { id?: string; kind?: string };
    selectedModel?: {
      identifier?: string;
      metadata?: {
        configurationSchema?: {
          properties?: {
            reasoningEffort?: {
              default?: string;
            };
          };
        };
      };
    };
  };
}

export function parseSessionFile(sessionFile: string, wsId: string, wsName: string, harness: string, customInstructionsBytes?: number): Session | null {

  let data: SessionFileData;
  try {
    if (sessionFile.endsWith('.jsonl')) {
      const result = reconstructFromJsonl(sessionFile);
      if (!result) return null;
      data = result as SessionFileData;
    } else {
      data = JSON.parse(stripImageData(readFile(sessionFile))) as SessionFileData;
    }
  } catch (e) {
    debugCore('parser-vscode', `Cannot read/parse session file ${sessionFile}`, e);
    return null;
  }

  const creationTs = data.creationDate ?? null;
  let lastMsgTs = data.lastMessageDate ?? null;
  const requests = (data.requests || []);

  if (lastMsgTs == null && requests.length > 0) {
    lastMsgTs = requests[requests.length - 1].timestamp ?? creationTs;
  }

  // Extract session-level reasoning effort default from the JSONL inputState.
  // This is the configurationSchema default for the selected model at session start.
  const sessionEffortDefault = canonicalizeReasoningEffort(
    data.inputState?.selectedModel?.metadata?.configurationSchema
      ?.properties?.reasoningEffort?.default ?? null
  );

  // Extract session-level mode from inputState.mode.id.
  // VS Code stores the actual mode (agent/ask/edit/plan/custom) here,
  // while per-request agent.id only distinguishes the extension participant.
  const sessionMode = normalizeSessionMode(data.inputState?.mode?.id);

  const parsedRequests = requests.map(r => {
    const req = parseRawRequest(r);
    // Apply session-level effort default when per-request effort is unknown
    if (!req.reasoningEffort && sessionEffortDefault) {
      req.reasoningEffort = sessionEffortDefault;
    }
    // Apply session-level mode as agentMode — it's the definitive source
    // for distinguishing agent/ask/plan/edit/custom modes.
    // When absent, clear the per-request agent.id (a participant identifier
    // like "copilot") so downstream analytics don't misclassify it as a mode.
    req.agentMode = sessionMode;
    return req;
  });
  const hasDevcontainer = detectDevcontainerFromRequests(parsedRequests);

  return createSession({
    sessionId: data.sessionId || path.basename(sessionFile, path.extname(sessionFile)),
    workspaceId: wsId,
    workspaceName: wsName,
    location: data.initialLocation || 'panel',
    harness,
    creationDate: creationTs,
    lastMessageDate: lastMsgTs,
    requests: parsedRequests,
    hasDevcontainer,
    customInstructionsBytes,
  });
}
