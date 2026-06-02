/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Pi Coding Agent session parser
 *
 * Data layout (macOS / Linux / Windows):
 *   ~/.pi/agent/sessions/--<encoded-cwd>--/<timestamp>_<uuid>.jsonl
 *
 * Where <encoded-cwd> is the working directory with `/` replaced by `-`, and
 * the whole thing wrapped in leading/trailing `--`, e.g.
 *   --Users-alice-Projects-pi-harness--
 *
 * Each .jsonl file is one session. The first line is a SessionHeader:
 *   { type: "session", version, id, timestamp, cwd, parentSession? }
 *
 * Subsequent lines are tree entries that share a base shape:
 *   { type, id, parentId, timestamp }
 * Common entry types: message, model_change, thinking_level_change,
 * compaction, branch_summary, custom, custom_message, label, session_info.
 *
 * `message` entries carry an `AgentMessage` under `message` with a `role`:
 *   user | assistant | toolResult | bashExecution | custom |
 *   branchSummary | compactionSummary
 *
 * The parser folds the linear entry sequence into user→assistant turns,
 * matching the internal SessionRequest shape used by the other harnesses.
 * Unsupported entry types are ignored safely.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ModelUsage, Session, SessionRequest } from './types';
import { assertTrustedPath, createRequest, createSession, detectDevcontainerFromRequests, extractSkillNameFromPath, extractSkillPathsFromText, readFileSafe } from './parser-shared';
import { extractReasoningEffortFromModelId } from './helpers';

/* ---- Raw shapes ---- */

interface PiSessionHeader {
  type: 'session';
  version?: number;
  id?: string;
  timestamp?: string;
  cwd?: string;
  parentSession?: string;
}

interface PiContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  // toolCall
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
}

interface PiUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
}

interface PiMessage {
  role: string;
  content?: string | PiContentBlock[];
  provider?: string;
  model?: string;
  usage?: PiUsage;
  stopReason?: string;
  // toolResult
  toolName?: string;
  isError?: boolean;
  // bashExecution
  command?: string;
  output?: string;
  // custom / custom_message message bodies
  customType?: string;
  // branchSummary / compactionSummary
  summary?: string;
}

interface PiEntry {
  type: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  message?: PiMessage;
  // model_change
  provider?: string;
  modelId?: string;
  // thinking_level_change
  thinkingLevel?: string;
  // compaction / branch_summary
  summary?: string;
  tokensBefore?: number;
}

/** Tool names (lowercase) that write/edit files in Pi. */
const PI_WRITE_TOOLS = new Set([
  'write', 'edit', 'create', 'patch', 'multi_edit', 'apply_patch', 'apply_diff',
]);

/** Tool names (lowercase) that read/reference files in Pi. */
const PI_READ_TOOLS = new Set([
  'read', 'glob', 'grep', 'ls', 'find',
]);

interface PiTurnState {
  requests: SessionRequest[];
  firstTs: number | null;
  lastTs: number | null;
  currentUserMessage: string;
  currentUserTs: number | null;
  currentAssistantTexts: string[];
  currentToolsUsed: string[];
  currentEditedFiles: string[];
  currentReferencedFiles: string[];
  currentSkillsUsed: string[];
  turnModel: string;
  /** Last model actually used by any assistant message — survives turn
   *  flushes so session-level modelUsage can be attributed after the final flush. */
  lastModel: string;
  turnPromptTokens: number;
  turnCompletionTokens: number;
  turnCacheRead: number;
  turnCacheWrite: number;
  turnHasTokens: boolean;
  turnCanceled: boolean;
  totalInput: number;
  totalOutput: number;
  totalCacheRead: number;
  totalCacheWrite: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function projectNameFromCwd(cwd: string): string {
  return cwd.replaceAll('\\', '/').replace(/\/+$/, '').split('/').pop() || 'unknown';
}

function tsToMillis(ts: string | undefined): number | null {
  if (!ts) return null;
  const ms = new Date(ts).getTime();
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/** Decode the `--Users-jvanvelu-Projects-foo--` directory name back into a cwd.
 *  Best-effort fallback only — the SessionHeader `cwd` is authoritative when present. */
function decodeProjectDirName(dirName: string): string {
  const trimmed = dirName.replace(/^--/, '').replace(/--$/, '');
  if (!trimmed) return '';
  return '/' + trimmed.replaceAll('-', '/');
}

function contentBlocks(content: string | PiContentBlock[] | undefined): PiContentBlock[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (Array.isArray(content)) return content.filter((c): c is PiContentBlock => isRecord(c) && typeof c.type === 'string');
  return [];
}

function textFromContent(content: string | PiContentBlock[] | undefined): string {
  if (typeof content === 'string') return content;
  return contentBlocks(content)
    .filter(b => b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text as string)
    .join('\n');
}

function createPiState(): PiTurnState {
  return {
    requests: [],
    firstTs: null,
    lastTs: null,
    currentUserMessage: '',
    currentUserTs: null,
    currentAssistantTexts: [],
    currentToolsUsed: [],
    currentEditedFiles: [],
    currentReferencedFiles: [],
    currentSkillsUsed: [],
    turnModel: '',
    lastModel: '',
    turnPromptTokens: 0,
    turnCompletionTokens: 0,
    turnCacheRead: 0,
    turnCacheWrite: 0,
    turnHasTokens: false,
    turnCanceled: false,
    totalInput: 0,
    totalOutput: 0,
    totalCacheRead: 0,
    totalCacheWrite: 0,
  };
}

function updateTimestamps(state: PiTurnState, ts: number | null): void {
  if (!ts) return;
  if (!state.firstTs || ts < state.firstTs) state.firstTs = ts;
  if (!state.lastTs || ts > state.lastTs) state.lastTs = ts;
}

function flushPiTurn(state: PiTurnState, defaultModel: string): void {
  if (!state.currentUserMessage && state.currentAssistantTexts.length === 0
    && state.currentToolsUsed.length === 0 && state.currentEditedFiles.length === 0) {
    return;
  }

  const responseText = state.currentAssistantTexts.join('\n');
  const model = state.turnModel || defaultModel;
  state.requests.push(createRequest({
    requestId: `pi-${state.requests.length}`,
    timestamp: state.currentUserTs,
    messageText: state.currentUserMessage,
    responseText,
    isCanceled: state.turnCanceled,
    agentName: 'Pi',
    agentMode: 'agent',
    modelId: model,
    toolsUsed: state.currentToolsUsed,
    editedFiles: [...new Set(state.currentEditedFiles)],
    referencedFiles: [...new Set(state.currentReferencedFiles)],
    skillsUsed: [...new Set(state.currentSkillsUsed)],
    totalElapsed: state.currentUserTs && state.lastTs ? state.lastTs - state.currentUserTs : null,
    promptTokens: state.turnHasTokens ? state.turnPromptTokens : null,
    completionTokens: state.turnHasTokens ? state.turnCompletionTokens : null,
    cacheReadTokens: state.turnHasTokens && state.turnCacheRead > 0 ? state.turnCacheRead : null,
    cacheWriteTokens: state.turnHasTokens && state.turnCacheWrite > 0 ? state.turnCacheWrite : null,
    reasoningEffort: extractReasoningEffortFromModelId(model),
  }));

  state.currentUserMessage = '';
  state.currentUserTs = null;
  state.currentAssistantTexts = [];
  state.currentToolsUsed = [];
  state.currentEditedFiles = [];
  state.currentReferencedFiles = [];
  state.currentSkillsUsed = [];
  // Clear the explicit per-turn model so the next turn falls back to the
  // current default (meta.model) unless its own assistant message sets one.
  state.turnModel = '';
  state.turnPromptTokens = 0;
  state.turnCompletionTokens = 0;
  state.turnCacheRead = 0;
  state.turnCacheWrite = 0;
  state.turnHasTokens = false;
  state.turnCanceled = false;
}

function filePathFromArgs(args: Record<string, unknown> | undefined): string | null {
  if (!args) return null;
  for (const key of ['path', 'file_path', 'filename', 'filePath']) {
    const v = args[key];
    if (typeof v === 'string' && v) return v;
  }
  return null;
}

function contentFromArgs(args: Record<string, unknown> | undefined): string | null {
  if (!args) return null;
  for (const key of ['content', 'code', 'new_string', 'newText']) {
    const v = args[key];
    if (typeof v === 'string') return v;
  }
  return null;
}

function collectSkillsFromArgs(args: Record<string, unknown> | undefined, state: PiTurnState): void {
  if (!args) return;
  for (const key of ['command', 'cmd', 'script', 'input']) {
    const v = args[key];
    if (typeof v !== 'string') continue;
    for (const skillPath of extractSkillPathsFromText(v)) {
      state.currentReferencedFiles.push(skillPath);
      const name = extractSkillNameFromPath(skillPath);
      if (name) state.currentSkillsUsed.push(name);
    }
  }
}

function handleToolCall(block: PiContentBlock, state: PiTurnState): void {
  const toolName = (block.name || 'unknown').trim();
  state.currentToolsUsed.push(toolName);

  const args = isRecord(block.arguments) ? block.arguments : undefined;
  collectSkillsFromArgs(args, state);

  const toolLower = toolName.toLowerCase();
  const filePath = filePathFromArgs(args);
  if (PI_WRITE_TOOLS.has(toolLower)) {
    if (filePath) {
      state.currentEditedFiles.push(filePath);
      const content = contentFromArgs(args);
      if (content) {
        const ext = filePath.split('.').pop() || 'unknown';
        state.currentAssistantTexts.push(`\n\`\`\`${ext}\n${content}\n\`\`\`\n`);
      }
    }
  } else if (PI_READ_TOOLS.has(toolLower) && filePath) {
    state.currentReferencedFiles.push(filePath);
  }
}

function handleUserMessage(msg: PiMessage, state: PiTurnState, ts: number | null, defaultModel: string): void {
  // A new user message begins a new turn.
  flushPiTurn(state, defaultModel);
  state.currentUserMessage = textFromContent(msg.content);
  state.currentUserTs = ts;
}

function handleAssistantMessage(msg: PiMessage, state: PiTurnState): void {
  for (const block of contentBlocks(msg.content)) {
    if (block.type === 'text' && block.text) {
      state.currentAssistantTexts.push(block.text);
    } else if (block.type === 'toolCall') {
      handleToolCall(block, state);
    }
    // thinking blocks are intentionally not folded into response text.
  }

  if (msg.model) {
    state.turnModel = msg.model;
    state.lastModel = msg.model;
  }
  if (msg.stopReason === 'aborted' || msg.stopReason === 'error') state.turnCanceled = true;

  const usage = msg.usage;
  if (usage) {
    const input = typeof usage.input === 'number' ? usage.input : 0;
    const output = typeof usage.output === 'number' ? usage.output : 0;
    const cacheRead = typeof usage.cacheRead === 'number' ? usage.cacheRead : 0;
    const cacheWrite = typeof usage.cacheWrite === 'number' ? usage.cacheWrite : 0;
    // promptTokens = full input context (uncached input + cache read + cache write)
    // so context-window analysis sees the whole context; cached portions are
    // tracked separately for billing.
    state.turnPromptTokens += input + cacheRead + cacheWrite;
    state.turnCompletionTokens += output;
    state.turnCacheRead += cacheRead;
    state.turnCacheWrite += cacheWrite;
    state.turnHasTokens = true;
    state.totalInput += input;
    state.totalOutput += output;
    state.totalCacheRead += cacheRead;
    state.totalCacheWrite += cacheWrite;
  }
}

function handleMessageEntry(entry: PiEntry, state: PiTurnState, ts: number | null, defaultModel: string): void {
  const msg = entry.message;
  if (!msg || typeof msg.role !== 'string') return;

  switch (msg.role) {
    case 'user':
      handleUserMessage(msg, state, ts, defaultModel);
      return;
    case 'assistant':
      handleAssistantMessage(msg, state);
      return;
    case 'toolResult':
      // Tool result content (file contents, command output) is already
      // attributed via the originating toolCall on the assistant message,
      // so the result body itself is not folded into the turn.
      return;
    case 'bashExecution':
      if (msg.command) {
        state.currentToolsUsed.push('bash');
        for (const skillPath of extractSkillPathsFromText(msg.command)) {
          state.currentReferencedFiles.push(skillPath);
          const name = extractSkillNameFromPath(skillPath);
          if (name) state.currentSkillsUsed.push(name);
        }
      }
      return;
    default:
      // custom / branchSummary / compactionSummary message bodies and any
      // future role are ignored safely (they do not map to a user turn).
      return;
  }
}

function handlePiEntry(entry: PiEntry, state: PiTurnState, meta: { model: string }): void {
  const ts = tsToMillis(entry.timestamp);
  updateTimestamps(state, ts);

  switch (entry.type) {
    case 'message':
      handleMessageEntry(entry, state, ts, meta.model);
      return;
    case 'model_change':
      // Only update the default model for *future* turns. The current turn's
      // model is set from each assistant message's own `model` field, so
      // overwriting state.turnModel here would retroactively relabel the
      // in-flight (not-yet-flushed) turn. Turns without an explicit model fall
      // back to meta.model at flush time.
      if (typeof entry.modelId === 'string' && entry.modelId) meta.model = entry.modelId;
      return;
    // thinking_level_change, compaction, branch_summary, custom,
    // custom_message, label, session_info and any unknown type are ignored.
    default:
      return;
  }
}

function computeModelUsage(state: PiTurnState): Record<string, ModelUsage> | undefined {
  if (state.totalInput <= 0 && state.totalOutput <= 0 && state.totalCacheRead <= 0) return undefined;
  const model = state.lastModel || state.turnModel || 'untracked';
  return {
    [model]: {
      inputTokens: state.totalInput,
      outputTokens: state.totalOutput,
      cacheReadTokens: state.totalCacheRead,
      cacheWriteTokens: state.totalCacheWrite,
    },
  };
}

function parsePiHeader(rawLine: string): PiSessionHeader | null {
  try {
    const parsed: unknown = JSON.parse(rawLine);
    if (!isRecord(parsed) || parsed.type !== 'session') return null;
    return {
      type: 'session',
      version: typeof parsed.version === 'number' ? parsed.version : undefined,
      id: typeof parsed.id === 'string' ? parsed.id : undefined,
      timestamp: typeof parsed.timestamp === 'string' ? parsed.timestamp : undefined,
      cwd: typeof parsed.cwd === 'string' ? parsed.cwd : undefined,
      parentSession: typeof parsed.parentSession === 'string' ? parsed.parentSession : undefined,
    };
  } catch {
    return null;
  }
}

function parsePiEntry(rawLine: string): PiEntry | null {
  try {
    const parsed: unknown = JSON.parse(rawLine);
    if (!isRecord(parsed) || typeof parsed.type !== 'string') return null;
    return parsed as unknown as PiEntry;
  } catch {
    return null;
  }
}

function parsePiSessionFile(filePath: string, fallbackDirName: string): Session | null {
  assertTrustedPath(filePath);
  const content = readFileSafe(filePath);
  if (content == null) return null;

  const lines = content.split('\n').filter(l => l.trim().length > 0);
  if (lines.length === 0) return null;

  const header = parsePiHeader(lines[0]);
  const sessionId = header?.id || path.basename(filePath, '.jsonl');
  const cwd = header?.cwd || decodeProjectDirName(fallbackDirName);

  const state = createPiState();
  const meta = { model: '' };

  // Entries start on the second line. Be defensive: if the first line was not
  // a recognizable header, treat it as an entry too.
  const startIndex = header ? 1 : 0;
  for (let i = startIndex; i < lines.length; i++) {
    const entry = parsePiEntry(lines[i]);
    if (entry) handlePiEntry(entry, state, meta);
  }

  flushPiTurn(state, meta.model);
  if (state.requests.length === 0) return null;

  const wsName = projectNameFromCwd(cwd);
  const wsId = `pi-${wsName}-${sessionId.slice(0, 8)}`;
  const modelUsage = computeModelUsage(state);

  return createSession({
    sessionId,
    workspaceId: wsId,
    workspaceName: wsName,
    location: 'terminal',
    harness: 'Pi Coding Agent',
    creationDate: tsToMillis(header?.timestamp) || state.firstTs,
    lastMessageDate: state.lastTs,
    requests: state.requests,
    modelUsage,
    hasDevcontainer: detectDevcontainerFromRequests(state.requests, cwd),
    workspaceRootPath: cwd || undefined,
  });
}

export function findPiDirs(): string[] {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const dirs: string[] = [];
  const sessionsDir = path.join(home, '.pi', 'agent', 'sessions');
  if (fs.existsSync(sessionsDir)) dirs.push(sessionsDir);
  return dirs;
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

export function parsePiSessions(sessionsDir: string): Session[] {
  const sessions: Session[] = [];
  for (const filePath of findAllJsonlFiles(sessionsDir)) {
    const dirName = path.basename(path.dirname(filePath));
    const session = parsePiSessionFile(filePath, dirName);
    if (session) sessions.push(session);
  }
  return sessions;
}
