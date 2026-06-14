/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* VS Code and Copilot CLI session parsing. */

import * as fs from 'fs';
import * as path from 'path';
import { Session, SessionRequest, ToolConfirmation } from './types';
import { createRequest, createSession, detectDevcontainerFromRequests, extractSkillNameFromPath, ParseContext, prefetchCache } from './parser-shared';
import { debugCore, warnCore } from './log';
import { canonicalizeReasoningEffort, extractReasoningEffortFromModelId } from './helpers';
import { parseCLIEventsFile } from './parser-vscode-cli';
import { parseCLIWorkspaceName, parseWorkspaceName, parseWorkspaceFolderPath, parseCLIWorkspaceFolderPath, readFile, reconstructFromJsonl, stripImageData } from './parser-vscode-files';

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

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


export function processWorkspaceEntry(
  logsDir: string,
  wsId: string,
  harness: string,
  ctx: ParseContext,
): string {
  const { workspaces, sessions, editLocIndex, sessionSourceIndex } = ctx;
  const { entryPath, wsName, isCLI, customInstructionsBytes } = initializeWorkspaceEntry(logsDir, wsId, harness, workspaces);

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
  const { entryPath, wsName, isCLI, customInstructionsBytes } = initializeWorkspaceEntry(logsDir, wsId, harness, workspaces);

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
    return wsName;
  }

  const chatFiles = listChatSessionFiles(path.join(entryPath, 'chatSessions'));
  const editStateFiles = listEditStateFiles(path.join(entryPath, 'chatEditingSessions'));
  const totalUnits = Math.max(1, chatFiles.length + editStateFiles.length);
  const chatEvery = chunkInterval(chatFiles.length);
  const editEvery = chunkInterval(editStateFiles.length);
  let completed = 0;

  for (let i = 0; i < chatFiles.length; i++) {
    const session = parseSessionFile(chatFiles[i], wsId, wsName, harness, customInstructionsBytes);
    if (session) {
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

  for (let i = 0; i < editStateFiles.length; i++) {
    parseEditStateFile(editStateFiles[i], editLocIndex);
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

  return wsName;
}

interface RawRequest {
  requestId?: string;
  timestamp?: number;
  message?: { text?: string } | string;
  response?: unknown[];
  result?: { timings?: { firstProgress?: number; totalElapsed?: number }; metadata?: Record<string, unknown> };
  isCanceled?: boolean;
  agent?: { extensionDisplayName?: string; id?: string } | string;
  modelId?: string;
  slashCommand?: { name?: string } | string;
  variableData?: { variables?: RawVariable[] };
  contentReferences?: RawContentRef[];
  editedFileEvents?: { uri?: { path?: string } }[];
  /** Cumulative completion token count across all agentic rounds (streaming counter). */
  completionTokens?: number;
}

interface RawVariable {
  kind?: string;
  value?: string | { path?: string; external?: string };
}

interface RawContentRef {
  reference?: { external?: string; fsPath?: string };
}

interface ToolInvocationPart {
  kind?: string;
  toolId?: string;
  isConfirmed?: { type?: number; scope?: string };
  toolSpecificData?: {
    kind?: string;
    confirmation?: { commandLine?: string };
    commandLine?: { original?: string };
  };
}

interface ToolCallResult {
  toolCalls?: { name?: string }[];
}

interface ResponsePart {
  value?: string | { value?: string };
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

type TodoToolCall = {
  name?: string;
  arguments?: unknown;
};

type ParsedResultMetadata = {
  resultObj: Record<string, unknown> | null;
  meta: Record<string, unknown>;
  resultIsFinalized: boolean;
};

type TokenInfo = {
  promptTokens: number | null;
  completionTokens: number | null;
};

function extractMessageText(msg: RawRequest['message']): string {
  if (typeof msg === 'string') return msg;
  if (isObj(msg)) return String(msg.text ?? '');
  return '';
}

function extractResponseText(resp: unknown[] | undefined): string {
  if (!Array.isArray(resp)) return '';
  const parts: string[] = [];
  for (const part of resp) {
    const p = part as ResponsePart;
    if (p && typeof p === 'object' && p.value != null) {
      const v = p.value;
      if (typeof v === 'object' && v !== null && 'value' in (v as object)) {
        const inner = (v as Record<string, unknown>).value;
        if (typeof inner === 'string') { parts.push(inner); continue; }
      }
      if (typeof v === 'string') { parts.push(v); continue; }
    }
  }
  return parts.join('\n');
}

function extractAgentInfo(agent: RawRequest['agent']): { agentName: string; agentMode: string } {
  if (!isObj(agent)) return { agentName: '', agentMode: '' };
  return {
    agentName: String(agent.extensionDisplayName || agent.id || ''),
    agentMode: String(agent.id || ''),
  };
}

/**
 * Normalize the session-level inputState.mode.id into a canonical agentMode value.
 * VS Code stores:
 *   - 'agent' for Agent mode
 *   - 'ask' for Ask/Chat mode
 *   - 'edit' for Edit mode
 *   - A full URI path (e.g. '.../Plan.agent.md') for Plan mode and custom agents
 */
function normalizeSessionMode(modeId: string | undefined): string {
  if (!modeId) return '';
  // Built-in modes
  if (modeId === 'agent' || modeId === 'ask' || modeId === 'edit') return modeId;
  // URI-based modes: extract the meaningful name from the path
  const lower = modeId.toLowerCase();
  if (lower.includes('plan')) return 'plan';
  // Other custom agents/chatmodes — use the filename stem
  let decoded: string;
  try { decoded = decodeURIComponent(modeId); } catch { decoded = modeId; }
  const lastSlash = decoded.lastIndexOf('/');
  const filename = lastSlash >= 0 ? decoded.substring(lastSlash + 1) : decoded;
  const stem = filename.replace(/\.(agent|chatmode)\.md$/i, '');
  return stem || modeId;
}

function extractSlashCommand(slashCmd: RawRequest['slashCommand']): string {
  if (isObj(slashCmd) && typeof slashCmd.name === 'string') {
    return slashCmd.name;
  }
  return '';
}

function extractVariableKinds(vdVars: RawVariable[]): Record<string, number> {
  const kinds: Record<string, number> = {};
  for (const v of vdVars) {
    if (typeof v === 'object' && v && v.kind) {
      kinds[v.kind] = (kinds[v.kind] || 0) + 1;
    }
  }
  return kinds;
}

function extractCustomInstructions(contentRefs: RawContentRef[] | undefined): string[] {
  const instructions: string[] = [];
  for (const cr of (contentRefs || [])) {
    if (typeof cr !== 'object' || !cr) continue;
    const ref = cr.reference;
    if (typeof ref !== 'object' || !ref) continue;
    const ext = (ref.external || ref.fsPath || '');
    const lower = ext.toLowerCase();
    if (lower.includes('.instructions.md') || lower.includes('copilot-instructions') || lower.includes('.prompt.md') || lower.includes('agents.md')) {
      const parts = ext.split('/');
      const fname = parts[parts.length - 1] || ext;
      if (fname && !instructions.includes(fname)) instructions.push(fname);
    }
  }
  return instructions;
}

// extractSkillNameFromPath is imported from parser-shared

/** Extract skill names from legacy inline XML in variable values. */
function extractSkillsFromXml(vdVars: RawVariable[], skills: Set<string>): void {
  const skillRe = /<skill>\s*<name>(.*?)<\/name>/g;
  for (const v of vdVars) {
    if (typeof v === 'object' && v && typeof v.value === 'string' && v.value.includes('<skill>')) {
      let sm: RegExpExecArray | null;
      while ((sm = skillRe.exec(v.value)) !== null) {
        const sn = sm[1].trim();
        if (sn && !sn.includes('ai_toolkit')) skills.add(sn);
      }
      skillRe.lastIndex = 0;
    }
  }
}

/** Extract skill names from promptFile variables that point to SKILL.md files. */
function extractSkillsFromPromptFiles(vdVars: RawVariable[], skills: Set<string>): void {
  for (const v of vdVars) {
    if (typeof v !== 'object' || !v || v.kind !== 'promptFile') continue;
    const val = v.value;
    if (typeof val !== 'object' || !val) continue;
    // Try the decoded path first, then the URL-encoded external URI
    const rawPath = val.path || val.external || '';
    const name = extractSkillNameFromPath(rawPath);
    if (name) skills.add(name);
  }
}

/** Extract skill names from read_file tool calls that target SKILL.md files. */
function extractSkillsFromToolCalls(result: RawRequest['result'], skills: Set<string>): void {
  const resultMeta = (typeof result === 'object' && result ? result.metadata : null) || {};
  if (typeof resultMeta !== 'object' || !resultMeta) return;
  const meta = resultMeta;
  for (const key of ['toolCallResults', 'toolCallRounds']) {
    const arr = meta[key];
    if (!Array.isArray(arr)) continue;
    for (const tcr of arr) {
      if (typeof tcr !== 'object' || !tcr) continue;
      const tcrObj = tcr as ToolCallResult;
      const tcData = parseToolCalls(tcrObj.toolCalls);
      for (const tc of tcData) {
        const tool = tc as { name?: string; arguments?: unknown };
        if (!tool || typeof tool !== 'object') continue;
        const toolName = tool.name;
        if (toolName !== 'read_file' && toolName !== 'copilot_readFile' && toolName !== 'readFile') continue;
        let args = tool.arguments;
        if (typeof args === 'string') { try { args = JSON.parse(args); } catch { continue; } }
        if (typeof args !== 'object' || !args) continue;
        const a = args as Record<string, unknown>;
        const filePath = (typeof a.filePath === 'string' ? a.filePath : '')
          || (typeof a.path === 'string' ? a.path : '')
          || (typeof a.uri === 'string' ? a.uri : '');
        const name = extractSkillNameFromPath(filePath);
        if (name) skills.add(name);
      }
    }
  }
}

function extractSkillsUsed(vdVars: RawVariable[], result: RawRequest['result']): string[] {
  const skills = new Set<string>();
  extractSkillsFromXml(vdVars, skills);
  extractSkillsFromPromptFiles(vdVars, skills);
  extractSkillsFromToolCalls(result, skills);
  return [...skills];
}

function parseToolCalls(toolCalls: unknown, onError?: (error: unknown) => void): unknown[] {
  let tcData: unknown = toolCalls || [];
  if (typeof tcData === 'string') {
    try {
      tcData = JSON.parse(tcData);
    } catch (error) {
      onError?.(error);
      tcData = [];
    }
  }
  return Array.isArray(tcData) ? tcData : [];
}

function collectToolNames(tcData: unknown[], tools: string[]): void {
  for (const tc of tcData) {
    const tool = tc as { name?: string };
    if (tool && typeof tool === 'object' && tool.name) {
      tools.push(String(tool.name));
    }
  }
}

function extractToolsUsed(result: RawRequest['result']): string[] {
  const tools: string[] = [];
  const resultMeta = (typeof result === 'object' && result ? result.metadata : null) || {};
  if (typeof resultMeta !== 'object' || !resultMeta) return tools;
  const meta = resultMeta;
  for (const key of ['toolCallResults', 'toolCallRounds']) {
    const arr = meta[key];
    if (!Array.isArray(arr)) continue;
    for (const tcr of arr) {
      if (typeof tcr !== 'object' || !tcr) continue;
      const tcrObj = tcr as ToolCallResult;
      const tcData = parseToolCalls(tcrObj.toolCalls, error => {
        debugCore('parser-vscode', 'Failed to parse toolCalls JSON string', error);
      });
      collectToolNames(tcData, tools);
    }
  }
  return tools;
}

function parseTodoListFromToolCall(tool: TodoToolCall): import('./types').TodoItem[] | null {
  if (!tool || tool.name !== 'manage_todo_list') return null;
  try {
    const args: unknown = typeof tool.arguments === 'string' ? JSON.parse(tool.arguments) : tool.arguments;
    const items = isObj(args) ? args.todoList : undefined;
    if (!Array.isArray(items) || items.length === 0) return null;
    return items.map((it: { id?: number; title?: string; status?: string }) => ({
      id: it.id ?? 0,
      title: String(it.title ?? ''),
      status: it.status === 'in-progress' || it.status === 'completed' ? it.status : 'not-started',
    }));
  } catch {
    return null;
  }
}

function extractTodoSnapshot(result: RawRequest['result']): import('./types').TodoItem[] | null {
  const resultMeta = (typeof result === 'object' && result ? result.metadata : null) || {};
  if (typeof resultMeta !== 'object' || !resultMeta) return null;
  const meta = resultMeta;
  let lastSnapshot: import('./types').TodoItem[] | null = null;
  for (const key of ['toolCallResults', 'toolCallRounds']) {
    const arr = meta[key];
    if (!Array.isArray(arr)) continue;
    for (const tcr of arr) {
      if (typeof tcr !== 'object' || !tcr) continue;
      const tcrObj = tcr as ToolCallResult;
      const tcData = parseToolCalls(tcrObj.toolCalls);
      for (const tc of tcData) {
        const snapshot = parseTodoListFromToolCall(tc as TodoToolCall);
        if (snapshot) lastSnapshot = snapshot;
      }
    }
  }
  return lastSnapshot;
}

function extractEditedFiles(events: RawRequest['editedFileEvents']): string[] {
  const files: string[] = [];
  for (const efe of (events || [])) {
    if (typeof efe === 'object' && efe) {
      const uri = efe.uri || {};
      if (typeof uri === 'object' && uri.path) files.push(uri.path);
    }
  }
  return files;
}

function extractReferencedFiles(vdVars: RawVariable[]): string[] {
  const files: string[] = [];
  for (const v of vdVars) {
    if (typeof v === 'object' && v && (v.kind === 'file' || v.kind === 'directory')) {
      const val = v.value;
      if (typeof val === 'object' && val && (val as { path?: string }).path) {
        files.push((val as { path: string }).path);
      }
    }
  }
  return files;
}

function extractToolConfirmations(resp: unknown[] | undefined): ToolConfirmation[] {
  const confirmations: ToolConfirmation[] = [];
  if (!Array.isArray(resp)) return confirmations;
  for (const part of resp) {
    if (!part || typeof part !== 'object') continue;
    const p = part as ToolInvocationPart;
    if (p.kind !== 'toolInvocationSerialized' || !p.isConfirmed) continue;
    const tsd = p.toolSpecificData;
    const isTerminal = tsd?.kind === 'terminal';
    const confirmed = p.isConfirmed;
    confirmations.push({
      toolId: String(p.toolId || ''),
      confirmationType: confirmed.type ?? 0,
      autoApproveScope: confirmed.scope,
      isTerminal,
      commandLine: isTerminal
        ? String(tsd?.confirmation?.commandLine || tsd?.commandLine?.original || '')
        : undefined,
    });
  }
  return confirmations;
}

function extractRequestText(req: RawRequest): {
  msgText: string;
  resp: RawRequest['response'];
  respText: string;
} {
  const resp = req.response;
  return {
    msgText: extractMessageText(req.message),
    resp,
    respText: extractResponseText(resp),
  };
}

function extractRequestMetadata(req: RawRequest, result: RawRequest['result']): {
  firstProgress: number | null;
  totalElapsed: number | null;
  agentName: string;
  agentMode: string;
  slashCommand: string;
} {
  const timings = (typeof result === 'object' ? result.timings : null) || {};
  const { agentName, agentMode } = extractAgentInfo(req.agent);
  return {
    firstProgress: timings.firstProgress ?? null,
    totalElapsed: timings.totalElapsed ?? null,
    agentName,
    agentMode,
    slashCommand: extractSlashCommand(req.slashCommand),
  };
}

function extractRequestVariables(req: RawRequest, resp: RawRequest['response'], result: RawRequest['result']): {
  variableKinds: Record<string, number>;
  customInstructions: string[];
  skillsUsed: string[];
  toolsUsed: string[];
  editedFiles: string[];
  referencedFiles: string[];
  toolConfirmations: ToolConfirmation[];
} {
  const vd = req.variableData || {};
  const vdVars = (typeof vd === 'object' ? vd.variables : []) || [];
  return {
    variableKinds: extractVariableKinds(vdVars),
    customInstructions: extractCustomInstructions(req.contentReferences),
    skillsUsed: extractSkillsUsed(vdVars, result),
    toolsUsed: extractToolsUsed(result),
    editedFiles: extractEditedFiles(req.editedFileEvents),
    referencedFiles: extractReferencedFiles(vdVars),
    toolConfirmations: extractToolConfirmations(resp),
  };
}

function extractResultMetadata(result: RawRequest['result']): ParsedResultMetadata {
  const resultObj = (typeof result === 'object' && result ? result : null) as Record<string, unknown> | null;
  const resultMeta = resultObj?.metadata;
  const meta = (typeof resultMeta === 'object' && resultMeta ? resultMeta : {}) as Record<string, unknown>;
  return {
    resultObj,
    meta,
    resultIsFinalized: !!resultObj && Object.keys(resultObj).length > 0 && !!resultMeta,
  };
}

function extractTokenInfo(req: RawRequest, parsedResult: ParsedResultMetadata): TokenInfo {
  const { meta, resultIsFinalized } = parsedResult;
  const promptTokens = typeof meta.promptTokens === 'number' ? meta.promptTokens : null;
  const metaOutputTokens = typeof meta.outputTokens === 'number' ? meta.outputTokens : null;
  const topLevelCompletionTokens = resultIsFinalized
    && typeof req.completionTokens === 'number'
    && req.completionTokens > 0
    ? req.completionTokens
    : null;
  return {
    promptTokens,
    completionTokens: topLevelCompletionTokens ?? metaOutputTokens,
  };
}

function computeEndState(
  resultObj: ParsedResultMetadata['resultObj'],
  resultIsFinalized: boolean,
  promptTokens: TokenInfo['promptTokens'],
  completionTokens: TokenInfo['completionTokens'],
  meta: ParsedResultMetadata['meta'],
): 'pending' | 'errored' | 'no-data' | undefined {
  if (!resultObj || Object.keys(resultObj).length === 0) {
    return 'pending';
  }
  if (resultObj.errorDetails) {
    return 'errored';
  }
  if (!resultIsFinalized || promptTokens != null || completionTokens != null) {
    return undefined;
  }
  const hasAgenticMetadata = (
    'toolCallRounds' in meta
    || 'modelMessageId' in meta
    || 'responseId' in meta
    || 'renderedUserMessage' in meta
    || 'codeBlocks' in meta
  );
  return hasAgenticMetadata ? 'no-data' : undefined;
}

function extractCompaction(meta: ParsedResultMetadata['meta']): import('./types').CompactionEvent | null {
  const summaries = meta.summaries;
  if (!Array.isArray(summaries) || summaries.length === 0) return null;
  const s = summaries[0] as Record<string, unknown>;
  if (!s || typeof s.summarizationMode !== 'string') return null;
  return {
    mode: s.summarizationMode === 'simple' ? 'simple' : 'full',
    numRounds: typeof s.numRounds === 'number' ? s.numRounds : 0,
    numRoundsSinceLastSummarization: typeof s.numRoundsSinceLastSummarization === 'number' ? s.numRoundsSinceLastSummarization : 0,
    contextLengthBefore: typeof s.contextLengthBefore === 'number' ? s.contextLengthBefore : 0,
    durationMs: typeof s.durationMs === 'number' ? s.durationMs : 0,
    model: typeof s.model === 'string' ? s.model : '',
    outcome: typeof s.outcome === 'string' ? s.outcome : '',
  };
}

function parseRawRequest(req: RawRequest): SessionRequest {
  const { msgText, resp, respText } = extractRequestText(req);
  const result = req.result || {};
  const { firstProgress, totalElapsed, agentName, agentMode, slashCommand } = extractRequestMetadata(req, result);
  const {
    variableKinds,
    customInstructions,
    skillsUsed,
    toolsUsed,
    editedFiles,
    referencedFiles,
    toolConfirmations,
  } = extractRequestVariables(req, resp, result);

  // Token counts come from two distinct sources (see VS Code chatModel.ts and toolCallingLoop.ts):
  //
  // 1. result.metadata.promptTokens / outputTokens — set by the Copilot extension from the
  //    API response of the FINAL LLM call. These are PER-ROUND values (last round only).
  //    For agentic tasks, metadata.outputTokens is often a dramatic undercount (e.g. just
  //    "Done." = 2 tokens), since it covers only the final round.
  //
  // 2. request.completionTokens — accumulated by VS Code core (ChatResponseModel.setUsage).
  //    This is CUMULATIVE across all agentic rounds: sum of completion_tokens from every
  //    LLM call in the request. Only available in recent VS Code versions (~April 2026+).
  //
  // For billing accuracy: request.completionTokens is the correct total output token count.
  // metadata.promptTokens is the last round's input size (not the sum across all rounds;
  // cumulative input tokens are NOT persisted to session files).
  //
  // When `result` is empty (`{}`), the request never completed (in-flight or abandoned);
  // any top-level `completionTokens` is stale, so we skip it.
  const { resultObj, meta, resultIsFinalized } = extractResultMetadata(result);

  // Per-request finalization state. We surface three non-recoverable
  // categories so the analyzer can exclude them from the coverage
  // denominator:
  //   - `pending`: `result` is empty/missing — the request never finalized
  //     (still in-flight, window closed mid-request, app crashed, etc.).
  //   - `errored`: `result.errorDetails` is present — the request completed
  //     with an error (user-canceled, network failure, length limit, rate
  //     limit, etc.). VS Code never received token usage.
  //   - `no-data`: the request completed successfully and the harness wrote
  //     full agentic metadata (toolCallRounds, responseId, codeBlocks, etc.)
  //     but did NOT record any token fields. Observed for some 2026-04
  //     requests against `copilot/auto` and `copilot/gpt-5.4`. There is no
  //     token data to recover, so don't count these as a parser gap.
  const { promptTokens, completionTokens } = extractTokenInfo(req, { resultObj, meta, resultIsFinalized });
  const endState = computeEndState(resultObj, resultIsFinalized, promptTokens, completionTokens, meta);
  const compaction = extractCompaction(meta);

  return createRequest({
    requestId: req.requestId || '',
    timestamp: req.timestamp ?? null,
    messageText: msgText,
    responseText: respText,
    isCanceled: req.isCanceled || false,
    agentName, agentMode,
    modelId: req.modelId || '',
    toolsUsed, editedFiles, referencedFiles,
    slashCommand, variableKinds, customInstructions, skillsUsed,
    firstProgress,
    totalElapsed,
    toolConfirmations,
    promptTokens,
    completionTokens,
    compaction,
    todoSnapshot: extractTodoSnapshot(result),
    reasoningEffort: extractReasoningEffortFromModelId(req.modelId || ''),
    endState,
  });
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
