/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* VS Code and Copilot CLI session parsing. */

import * as fs from 'fs';
import * as path from 'path';
import { Session, SessionRequest } from './types';
import { createRequest, createSession, detectDevcontainerFromRequests, ParseContext, prefetchCache, stripSingleSession, maybeForceGc, addParseTiming } from './parser-shared';
import { debugCore, warnCore } from './log';
import { canonicalizeReasoningEffort } from './helpers';
import { parseRawRequest, normalizeSessionMode, type RawRequest } from './parser-vscode-request';
import { parseCLIEventsFile, parseCLIEventsFileAsync } from './parser-vscode-cli';
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
      const dirs = all.filter(e => e.isDirectory());
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

function listTranscriptFiles(transcriptDir: string): string[] {
  try {
    return fs.readdirSync(transcriptDir, { withFileTypes: true })
      .filter(e => e.isFile() && e.name.endsWith('.jsonl'))
      .map(e => path.join(transcriptDir, e.name));
  } catch {
    return [];
  }
}

interface TranscriptEvent {
  type: string;
  id?: string;
  timestamp?: string;
  data?: Record<string, unknown>;
}

function parseTranscriptLines(raw: string): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (typeof parsed === 'object' && parsed !== null && typeof (parsed as { type?: unknown }).type === 'string') {
        events.push(parsed as TranscriptEvent);
      }
    } catch {
      // Skip malformed transcript rows; keep the rest of the session.
    }
  }
  return events;
}

function buildToolNameIndex(events: TranscriptEvent[]): Map<string, string> {
  const byCallId = new Map<string, string>();
  for (const ev of events) {
    if (ev.type !== 'tool.execution_start') continue;
    const callId = typeof ev.data?.toolCallId === 'string' ? ev.data.toolCallId : '';
    const toolName = typeof ev.data?.toolName === 'string' ? ev.data.toolName : '';
    if (!callId || !toolName) continue;
    byCallId.set(callId, toolName);
  }
  return byCallId;
}

function collectToolsFromToolRequests(
  toolRequests: unknown,
  toolNameByCallId: Map<string, string>,
  out: string[],
): void {
  if (!Array.isArray(toolRequests)) return;
  for (const req of toolRequests) {
    if (typeof req !== 'object' || req === null) continue;
    const rec = req as { name?: unknown; toolName?: unknown; toolCallId?: unknown };
    const explicit = typeof rec.name === 'string' ? rec.name : (typeof rec.toolName === 'string' ? rec.toolName : '');
    if (explicit) {
      out.push(explicit);
      continue;
    }
    const callId = typeof rec.toolCallId === 'string' ? rec.toolCallId : '';
    if (!callId) continue;
    const fallback = toolNameByCallId.get(callId);
    if (fallback) out.push(fallback);
  }
}

function buildRequestsFromTranscriptEvents(
  events: TranscriptEvent[],
  toolNameByCallId: Map<string, string>,
): SessionRequest[] {
  const requests: SessionRequest[] = [];
  let currentUserMessage: string | null = null;
  let currentUserTs: number | null = null;
  let currentUserMessageId: string | null = null;
  let responseParts: string[] = [];
  let toolsUsed: string[] = [];

  const flushTurn = () => {
    if (currentUserMessage === null) return;
    requests.push(createRequest({
      requestId: currentUserMessageId ?? '',
      timestamp: currentUserTs,
      messageText: currentUserMessage,
      responseText: responseParts.join('').trim(),
      toolsUsed: [...new Set(toolsUsed)],
      agentMode: 'agent',
    }));
    currentUserMessage = null;
    currentUserTs = null;
    currentUserMessageId = null;
    responseParts = [];
    toolsUsed = [];
  };

  for (const ev of events) {
    if (ev.type === 'user.message') {
      flushTurn();
      currentUserMessage = typeof ev.data?.content === 'string' ? ev.data.content : '';
      currentUserTs = ev.timestamp ? new Date(ev.timestamp).getTime() : null;
      currentUserMessageId = ev.id ?? null;
      continue;
    }

    if (currentUserMessage === null) continue;

    if (ev.type === 'assistant.message') {
      const content = typeof ev.data?.content === 'string' ? ev.data.content : '';
      if (content) responseParts.push(content);
      collectToolsFromToolRequests(ev.data?.toolRequests, toolNameByCallId, toolsUsed);
      continue;
    }

    if (ev.type === 'tool.execution_start') {
      const toolName = typeof ev.data?.toolName === 'string' ? ev.data.toolName : '';
      if (toolName) toolsUsed.push(toolName);
    }
  }

  flushTurn();
  return requests;
}

function normalizeSessionId(raw: string | null | undefined): string {
  return (raw ?? '').trim();
}

function unionStringArraysStable(base: string[], incoming: string[]): string[] {
  if (incoming.length === 0) return base;
  const out = [...base];
  const seen = new Set(base);
  for (const item of incoming) {
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function mergeTranscriptIntoSession(base: Session, transcript: Session): void {
  if (base.requests.length === transcript.requests.length) {
    for (let i = 0; i < base.requests.length; i++) {
      base.requests[i].toolsUsed = unionStringArraysStable(base.requests[i].toolsUsed, transcript.requests[i].toolsUsed);
    }
  }
  if (base.creationDate == null && transcript.creationDate != null) {
    base.creationDate = transcript.creationDate;
  }
  if (base.lastMessageDate == null && transcript.lastMessageDate != null) {
    base.lastMessageDate = transcript.lastMessageDate;
  }
}

function addSessionIfNew(
  sessions: Session[],
  byId: Map<string, number>,
  session: Session,
): boolean {
  const id = normalizeSessionId(session.sessionId);
  if (!id || byId.has(id)) return false;
  session.sessionId = id;
  byId.set(id, sessions.length);
  sessions.push(session);
  return true;
}

function addOrMergeTranscriptSession(
  sessions: Session[],
  byId: Map<string, number>,
  transcript: Session,
): boolean {
  const id = normalizeSessionId(transcript.sessionId);
  if (!id) return false;
  const existingIdx = byId.get(id);
  if (existingIdx === undefined) {
    transcript.sessionId = id;
    byId.set(id, sessions.length);
    sessions.push(transcript);
    return true;
  }
  mergeTranscriptIntoSession(sessions[existingIdx], transcript);
  return false;
}

function countLinesAdded(edits: { text?: string }[] | undefined): number {
  let linesAdded = 0;
  for (const edit of (edits || [])) {
    const text = edit.text || '';
    if (text) linesAdded += (text.match(/\n/g) || []).length;
  }
  return linesAdded;
}

function processEditOperation(op: EditStateOperation, editLocIndex: ParseContext['editLocIndex']): void {
  if (op.type !== 'textEdit') return;
  const reqId = op.requestId || '';
  const uri = op.uri?.external || '';
  if (!reqId || !uri) return;
  if (!editLocIndex.has(reqId)) editLocIndex.set(reqId, new Map());
  const fileMap = editLocIndex.get(reqId)!;
  const linesAdded = countLinesAdded(op.edits);
  fileMap.set(uri, (fileMap.get(uri) || 0) + linesAdded);
}

function processEditOperations(operations: EditStateOperation[] | undefined, editLocIndex: ParseContext['editLocIndex']): void {
  for (const op of (operations || [])) {
    processEditOperation(op, editLocIndex);
  }
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
  if (!raw.includes('"textEdit"')) return;
  let state: { timeline?: { operations?: EditStateOperation[] } };
  try { state = JSON.parse(raw) as typeof state; } catch (e) {
    warnCore('parser-vscode', `Corrupt state file ${stateFile}`, e);
    return;
  }
  processEditOperations(state.timeline?.operations, editLocIndex);
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
  const sessionIndexById = new Map<string, number>();

  if (isCLI) {
    const eventsFile = path.join(entryPath, 'events.jsonl');
    const cliSession = parseCLIEventsFile(eventsFile, wsId, wsName, customInstructionsBytes);
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
    if (session && addSessionIfNew(sessions, sessionIndexById, session)) {
      sessionSourceIndex.set(session.sessionId, {
        kind: 'vscode-session-file',
        filePath: sessionFile,
        workspaceId: wsId,
        workspaceName: wsName,
        harness,
      });
    }
  }

  const transcriptDir = path.join(entryPath, 'GitHub.copilot-chat', 'transcripts');
  for (const transcriptFile of listTranscriptFiles(transcriptDir)) {
    const transcriptSession = parseTranscriptFile(transcriptFile, wsId, wsName, harness, customInstructionsBytes);
    if (transcriptSession && addOrMergeTranscriptSession(sessions, sessionIndexById, transcriptSession)) {
      sessionSourceIndex.set(transcriptSession.sessionId, {
        kind: 'vscode-session-file',
        filePath: transcriptFile,
        workspaceId: wsId,
        workspaceName: wsName,
        harness,
      });
    }
  }

  const eventsFile = path.join(entryPath, 'events.jsonl');
  const cliSession = parseCLIEventsFile(eventsFile, wsId, wsName, customInstructionsBytes);
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

  const esDir = path.join(entryPath, 'chatEditingSessions');
  for (const stateFile of listEditStateFiles(esDir)) {
    parseEditStateFile(stateFile, editLocIndex);
  }

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
  const sessionIndexById = new Map<string, number>();

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
  const transcriptFiles = listTranscriptFiles(path.join(entryPath, 'GitHub.copilot-chat', 'transcripts'));
  const editStateFiles = listEditStateFiles(path.join(entryPath, 'chatEditingSessions'));
  const totalUnits = Math.max(1, chatFiles.length + transcriptFiles.length + editStateFiles.length);
  const chatEvery = chunkInterval(chatFiles.length + transcriptFiles.length);
  const editEvery = chunkInterval(editStateFiles.length);
  let completed = 0;

  for (let i = 0; i < chatFiles.length; i++) {
    const tChat = Date.now();
    const session = parseSessionFile(chatFiles[i], wsId, wsName, harness, customInstructionsBytes);
    addParseTiming('chat', Date.now() - tChat);
    if (session) {
      // Strip heavy text the moment a session is parsed so a workspace with many large
      // sessions can't accumulate its full text before the workspace finishes (issue #106).
      stripSingleSession(session);
      if (addSessionIfNew(sessions, sessionIndexById, session)) {
        sessionSourceIndex.set(session.sessionId, {
          kind: 'vscode-session-file',
          filePath: chatFiles[i],
          workspaceId: wsId,
          workspaceName: wsName,
          harness,
        });
      }
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

  for (let i = 0; i < transcriptFiles.length; i++) {
    const transcriptSession = parseTranscriptFile(transcriptFiles[i], wsId, wsName, harness, customInstructionsBytes);
    if (transcriptSession) {
      stripSingleSession(transcriptSession);
      if (addOrMergeTranscriptSession(sessions, sessionIndexById, transcriptSession)) {
        sessionSourceIndex.set(transcriptSession.sessionId, {
          kind: 'vscode-session-file',
          filePath: transcriptFiles[i],
          workspaceId: wsId,
          workspaceName: wsName,
          harness,
        });
      }
    }
    completed++;
    if (shouldReportChunk(chatFiles.length + i, chatFiles.length + transcriptFiles.length, chatEvery)) {
      onProgress?.({
        wsName,
        detail: `transcript ${i + 1}/${transcriptFiles.length}`,
        completed,
        total: totalUnits,
      });
    }
    await yieldToLoop();
    maybeForceGc();
  }

  const eventsFile = path.join(entryPath, 'events.jsonl');
  const tCli = Date.now();
  const cliSession = parseCLIEventsFile(eventsFile, wsId, wsName, customInstructionsBytes);
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

type EditStateOperation = {
  type: string;
  requestId?: string;
  uri?: { external?: string };
  edits?: { text?: string }[];
};

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

/**
 * Parse VS Code Agent Debug transcripts (`GitHub.copilot-chat/transcripts/*.jsonl`)
 * into the same session model used by the rest of the analyzer.
 */
export function parseTranscriptFile(
  filePath: string,
  wsId: string,
  wsName: string,
  harness: string,
  customInstructionsBytes?: number,
): Session | null {
  let raw: string;
  try {
    raw = readFile(filePath);
  } catch (e) {
    debugCore('parser-vscode', `Cannot read transcript file ${filePath}`, e);
    return null;
  }

  const events = parseTranscriptLines(raw);
  if (events.length === 0) return null;

  const sessionStart = events.find(e => e.type === 'session.start');
  const sessionId = normalizeSessionId(
    typeof sessionStart?.data?.sessionId === 'string'
      ? sessionStart.data.sessionId
      : path.basename(filePath, '.jsonl'),
  );
  if (!sessionId) return null;

  const creationDate = sessionStart?.timestamp ? new Date(sessionStart.timestamp).getTime() : null;
  const toolNameByCallId = buildToolNameIndex(events);
  const requests = buildRequestsFromTranscriptEvents(events, toolNameByCallId);
  if (requests.length === 0) return null;

  return createSession({
    sessionId,
    workspaceId: wsId,
    workspaceName: wsName,
    harness,
    location: 'panel',
    creationDate,
    requests,
    customInstructionsBytes,
  });
}
