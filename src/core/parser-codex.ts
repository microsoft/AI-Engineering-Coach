/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Codex CLI session parser
 *
 * Data layout (macOS):
 *   ~/.codex/sessions/<year>/<month>/<day>/rollout-<timestamp>-<uuid>.jsonl
 *
 * Each .jsonl file is a session. Lines have { type, timestamp, payload }
 *
 * type=session_meta:    payload.id, payload.cwd, payload.cli_version, payload.source, payload.model_provider
 * type=turn_context:    payload.model, payload.effort
 * type=event_msg:       payload.type = user_message|agent_reasoning|function_call|function_call_output|
 *                                      task_started|task_complete|token_count|turn_aborted|error|assistant_message
 * type=response_item:   payload.role, payload.content[]
 */

import * as fs from 'fs';
import * as path from 'path';
import { StringDecoder } from 'string_decoder';
import { ModelUsage, Session, SessionRequest } from './types';
import { assertTrustedPath, createRequest, createSession, detectDevcontainerFromRequests } from './parser-shared';
import { canonicalizeReasoningEffort, extractReasoningEffortFromModelId } from './helpers';

interface CodexLine {
  type: string;
  timestamp?: string;
  payload?: Record<string, unknown>;
}

interface CodexSessionMeta {
  sessionId: string;
  cwd: string;
  source: string;
  model: string;
}

interface CodexContentItem {
  type: string;
  text?: string;
}

interface CodexParseState {
  requests: SessionRequest[];
  firstTs: number | null;
  lastTs: number | null;
  currentUserMessage: string;
  currentAssistantTexts: string[];
  currentToolsUsed: string[];
  currentEditedFiles: string[];
  turnModel: string;
  turnEffort: 'max' | 'high' | 'medium' | 'low' | null;
  turnStartTs: number | null;
  turnCanceled: boolean;
  prevTotalInput: number;
  prevTotalOutput: number;
  curTotalInput: number;
  curTotalOutput: number;
  curTotalCachedInput: number;
  hasTokenData: boolean;
}

/** Tool names (lowercase) that actually write/edit files. */
const CODEX_WRITE_TOOLS = new Set([
  'write', 'write_file', 'create_file', 'edit', 'edit_file',
  'apply_diff', 'patch', 'multi_edit', 'create', 'overwrite',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function parseCodexLine(rawLine: string): CodexLine | null {
  try {
    const parsed: unknown = JSON.parse(rawLine);
    if (!isRecord(parsed) || typeof parsed.type !== 'string') return null;
    let timestamp: string | undefined;
    if (typeof parsed.timestamp === 'string') {
      timestamp = parsed.timestamp;
    } else if (typeof parsed.timestamp === 'number') {
      timestamp = new Date(parsed.timestamp).toISOString();
    }
    return {
      type: parsed.type,
      timestamp,
      payload: recordValue(parsed.payload),
    };
  } catch {
    return null;
  }
}

function parseJsonRecord(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function projectNameFromCwd(cwd: string): string {
  return cwd.replaceAll('\\', '/').replace(/\/+$/, '').split('/').pop() || 'unknown';
}

function createCodexState(initialModel: string): CodexParseState {
  return {
    requests: [],
    firstTs: null,
    lastTs: null,
    currentUserMessage: '',
    currentAssistantTexts: [],
    currentToolsUsed: [],
    currentEditedFiles: [],
    turnModel: initialModel,
    turnEffort: null,
    turnStartTs: null,
    turnCanceled: false,
    prevTotalInput: 0,
    prevTotalOutput: 0,
    curTotalInput: 0,
    curTotalOutput: 0,
    curTotalCachedInput: 0,
    hasTokenData: false,
  };
}

function computeModelUsage(state: CodexParseState, model: string): Record<string, ModelUsage> | undefined {
  if (!state.hasTokenData || (state.curTotalInput <= 0 && state.curTotalOutput <= 0)) return undefined;
  const billingModel = state.turnModel || model || 'untracked';
  const uncachedInput = Math.max(0, state.curTotalInput - state.curTotalCachedInput);
  return {
    [billingModel]: {
      inputTokens: uncachedInput,
      outputTokens: state.curTotalOutput,
      cacheReadTokens: state.curTotalCachedInput,
      cacheWriteTokens: 0,
    },
  };
}

function computeEndReason(
  modelUsage: Record<string, ModelUsage> | undefined,
  requests: SessionRequest[],
): 'shutdown' | 'aborted' | 'unknown' {
  if (modelUsage) return 'unknown';
  const everyRequestEmpty = requests.every(request =>
    !request.responseText && request.toolsUsed.length === 0 && request.editedFiles.length === 0,
  );
  return everyRequestEmpty ? 'aborted' : 'unknown';
}

function updateTimestamps(state: CodexParseState, ts: number | null): void {
  if (!ts) return;
  if (!state.firstTs || ts < state.firstTs) state.firstTs = ts;
  if (!state.lastTs || ts > state.lastTs) state.lastTs = ts;
}

function isTurnEmpty(state: CodexParseState): boolean {
  return state.currentAssistantTexts.length === 0
    && state.currentToolsUsed.length === 0
    && state.currentEditedFiles.length === 0
    && !state.turnCanceled
    && state.curTotalInput === state.prevTotalInput
    && state.curTotalOutput === state.prevTotalOutput;
}

function flushCodexTurn(state: CodexParseState, defaultModel: string): void {
  if (!state.currentUserMessage && state.currentAssistantTexts.length === 0) return;

  const responseText = state.currentAssistantTexts.join('\n');
  const reqPromptTokens = state.hasTokenData && state.curTotalInput > state.prevTotalInput
    ? state.curTotalInput - state.prevTotalInput
    : null;
  const reqCompletionTokens = state.hasTokenData && state.curTotalOutput > state.prevTotalOutput
    ? state.curTotalOutput - state.prevTotalOutput
    : null;
  state.prevTotalInput = state.curTotalInput;
  state.prevTotalOutput = state.curTotalOutput;

  state.requests.push(createRequest({
    requestId: `codex-${state.requests.length}`,
    timestamp: state.turnStartTs,
    messageText: state.currentUserMessage,
    responseText,
    isCanceled: state.turnCanceled,
    agentName: 'Codex',
    agentMode: 'agent',
    modelId: state.turnModel || defaultModel,
    toolsUsed: state.currentToolsUsed,
    editedFiles: [...new Set(state.currentEditedFiles)],
    totalElapsed: state.turnStartTs && state.lastTs ? state.lastTs - state.turnStartTs : null,
    promptTokens: reqPromptTokens,
    completionTokens: reqCompletionTokens,
    reasoningEffort: state.turnEffort ?? extractReasoningEffortFromModelId(state.turnModel || defaultModel),
  }));

  state.currentUserMessage = '';
  state.currentAssistantTexts = [];
  state.currentToolsUsed = [];
  state.currentEditedFiles = [];
  state.turnStartTs = null;
  state.turnCanceled = false;
}

function extractContentItems(value: unknown): CodexContentItem[] {
  if (!Array.isArray(value)) return [];
  const items: CodexContentItem[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.type !== 'string') continue;
    items.push({
      type: item.type,
      text: typeof item.text === 'string' ? item.text : undefined,
    });
  }
  return items;
}

function extractFilePath(args: Record<string, unknown> | null | undefined): string | null {
  if (!args) return null;
  if (typeof args.file_path === 'string') return args.file_path;
  if (typeof args.path === 'string') return args.path;
  if (typeof args.filename === 'string') return args.filename;
  return null;
}

function handleUserMessageEvent(payload: Record<string, unknown>, state: CodexParseState, ts: number | null, defaultModel: string): void {
  const newMessage = stringValue(payload.message) || stringValue(payload.text);
  if (state.currentUserMessage && state.currentUserMessage === newMessage && isTurnEmpty(state)) {
    if (state.turnStartTs == null) state.turnStartTs = ts;
    return;
  }

  flushCodexTurn(state, defaultModel);
  state.currentUserMessage = newMessage;
  state.turnStartTs = ts;
}

function handleFunctionCallEvent(payload: Record<string, unknown>, state: CodexParseState): void {
  const toolName = stringValue(payload.name) || 'unknown';
  state.currentToolsUsed.push(toolName);
  if (!CODEX_WRITE_TOOLS.has(toolName.toLowerCase())) return;

  const args = recordValue(payload.arguments);
  const filePath = extractFilePath(args);
  if (filePath) state.currentEditedFiles.push(filePath);
}

function handleAssistantMessageEvent(payload: Record<string, unknown>, state: CodexParseState): void {
  const content = payload.content;
  if (typeof content === 'string') state.currentAssistantTexts.push(content);
}

function handleTokenCountEvent(payload: Record<string, unknown>, state: CodexParseState): void {
  const info = recordValue(payload.info);
  const totalUsage = recordValue(info?.total_token_usage);
  if (!totalUsage) return;

  state.curTotalInput = typeof totalUsage.input_tokens === 'number' ? totalUsage.input_tokens : 0;
  state.curTotalOutput = typeof totalUsage.output_tokens === 'number' ? totalUsage.output_tokens : 0;
  state.curTotalCachedInput = typeof totalUsage.cached_input_tokens === 'number' ? totalUsage.cached_input_tokens : 0;
  state.hasTokenData = true;
}

function handleEventMsg(payload: Record<string, unknown>, state: CodexParseState, ts: number | null, defaultModel: string): void {
  const eventType = stringValue(payload.type);
  if (eventType === 'user_message') {
    handleUserMessageEvent(payload, state, ts, defaultModel);
    return;
  }
  if (eventType === 'agent_reasoning') {
    state.currentAssistantTexts.push(stringValue(payload.text));
    return;
  }
  if (eventType === 'function_call') {
    handleFunctionCallEvent(payload, state);
    return;
  }
  if (eventType === 'assistant_message') {
    handleAssistantMessageEvent(payload, state);
    return;
  }
  if (eventType === 'token_count') {
    handleTokenCountEvent(payload, state);
    return;
  }
  if (eventType === 'turn_aborted') state.turnCanceled = true;
}

function handleTurnContext(payload: Record<string, unknown>, state: CodexParseState): void {
  const model = stringValue(payload.model);
  if (model) state.turnModel = model;
  const effort = payload.effort;
  if (effort !== undefined && effort !== null) {
    state.turnEffort = canonicalizeReasoningEffort(stringValue(effort));
  }
}

function handleUserResponseItem(payload: Record<string, unknown>, state: CodexParseState, ts: number | null, defaultModel: string): void {
  for (const item of extractContentItems(payload.content)) {
    if (item.type !== 'input_text' || !item.text || item.text.startsWith('<')) continue;
    if (!state.currentUserMessage) {
      flushCodexTurn(state, defaultModel);
      state.currentUserMessage = item.text;
      state.turnStartTs = ts;
    }
  }
}

function handleAssistantResponseItem(payload: Record<string, unknown>, state: CodexParseState): void {
  for (const item of extractContentItems(payload.content)) {
    if (item.type === 'output_text' && item.text) state.currentAssistantTexts.push(item.text);
  }
}

function handleFunctionCallResponseItem(payload: Record<string, unknown>, state: CodexParseState): void {
  const toolName = stringValue(payload.name);
  if (!toolName) return;

  state.currentToolsUsed.push(toolName);
  if (!CODEX_WRITE_TOOLS.has(toolName.toLowerCase())) return;

  const args = typeof payload.arguments === 'string'
    ? parseJsonRecord(payload.arguments)
    : recordValue(payload.arguments);
  const filePath = extractFilePath(args);
  if (filePath) state.currentEditedFiles.push(filePath);
}

function handleResponseItem(payload: Record<string, unknown>, state: CodexParseState, ts: number | null, defaultModel: string): void {
  const role = stringValue(payload.role);
  const itemType = stringValue(payload.type);
  if (role === 'user') {
    handleUserResponseItem(payload, state, ts, defaultModel);
    return;
  }
  if (role === 'assistant' && itemType === 'message') {
    handleAssistantResponseItem(payload, state);
    return;
  }
  if (itemType === 'function_call') handleFunctionCallResponseItem(payload, state);
}

function updateSessionMeta(line: CodexLine, meta: CodexSessionMeta): void {
  if (line.type === 'session_meta') {
    const payload = line.payload || {};
    meta.sessionId = stringValue(payload.id) || meta.sessionId;
    meta.cwd = stringValue(payload.cwd) || meta.cwd;
    meta.source = stringValue(payload.source) || meta.source;
  }
  if (line.type === 'turn_context' && !meta.model) {
    meta.model = stringValue(line.payload?.model);
  }
}

function handleCodexLine(line: CodexLine, state: CodexParseState, meta: CodexSessionMeta): void {
  updateSessionMeta(line, meta);
  const ts = line.timestamp ? new Date(line.timestamp).getTime() : null;
  updateTimestamps(state, ts);

  if (line.type === 'event_msg') {
    handleEventMsg(line.payload || {}, state, ts, meta.model);
    return;
  }
  if (line.type === 'turn_context') {
    handleTurnContext(line.payload || {}, state);
    return;
  }
  if (line.type === 'response_item') handleResponseItem(line.payload || {}, state, ts, meta.model);
}

function readCodexJsonlStreaming(filePath: string, onLine: (line: CodexLine) => void): void {
  const fd = fs.openSync(filePath, 'r');
  const decoder = new StringDecoder('utf8');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let remainder = '';

  try {
    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      const text = remainder + decoder.write(buffer.subarray(0, bytesRead));
      let start = 0;
      let nextNewline = text.indexOf('\n', start);
      while (nextNewline !== -1) {
        const rawLine = text.slice(start, nextNewline);
        if (rawLine.trim()) {
          const parsed = parseCodexLine(rawLine);
          if (parsed) onLine(parsed);
        }
        start = nextNewline + 1;
        nextNewline = text.indexOf('\n', start);
      }
      remainder = text.slice(start);
    }

    remainder += decoder.end();
    if (remainder.trim()) {
      const parsed = parseCodexLine(remainder);
      if (parsed) onLine(parsed);
    }
  } finally {
    fs.closeSync(fd);
  }
}

export function findCodexDirs(): string[] {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const dirs: string[] = [];
  for (const name of ['sessions', 'archived_sessions', 'archived-sessions']) {
    const sessionsDir = path.join(home, '.codex', name);
    if (fs.existsSync(sessionsDir)) dirs.push(sessionsDir);
  }
  return dirs;
}

export function parseCodexSessions(sessionsDir: string): Session[] {
  const sessions: Session[] = [];
  const files = findAllJsonlFiles(sessionsDir);

  for (const filePath of files) {
    const session = parseCodexSessionFile(filePath);
    if (session) sessions.push(session);
  }

  return sessions;
}

function findAllJsonlFiles(dir: string): string[] {
  const result: string[] = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        result.push(...findAllJsonlFiles(full));
      } else if (e.isFile() && e.name.endsWith('.jsonl')) {
        result.push(full);
      }
    }
  } catch {
    /* skip unreadable dirs */
  }
  return result;
}

function parseCodexSessionFile(filePath: string): Session | null {
  assertTrustedPath(filePath);
  const meta: CodexSessionMeta = { sessionId: '', cwd: '', source: '', model: '' };
  const state = createCodexState('');
  let parsedLineCount = 0;

  try {
    readCodexJsonlStreaming(filePath, (line) => {
      parsedLineCount++;
      handleCodexLine(line, state, meta);
    });
  } catch {
    return null;
  }

  if (parsedLineCount === 0) return null;
  if (!meta.sessionId) meta.sessionId = path.basename(filePath, '.jsonl');

  const wsName = projectNameFromCwd(meta.cwd);
  const wsId = `codex-${wsName}-${meta.sessionId.slice(0, 8)}`;

  flushCodexTurn(state, meta.model);
  if (state.requests.length === 0) return null;

  const modelUsage = computeModelUsage(state, meta.model);
  const endReason = computeEndReason(modelUsage, state.requests);

  return createSession({
    sessionId: meta.sessionId,
    workspaceId: wsId,
    workspaceName: wsName,
    location: meta.source || 'terminal',
    harness: 'Codex',
    creationDate: state.firstTs,
    lastMessageDate: state.lastTs,
    requests: state.requests,
    modelUsage,
    endReason,
    hasDevcontainer: detectDevcontainerFromRequests(state.requests, meta.cwd),
    workspaceRootPath: meta.cwd || undefined,
  });
}
