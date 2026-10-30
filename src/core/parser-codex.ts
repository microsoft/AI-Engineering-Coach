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
import { ModelUsage, Session, SessionRequest } from './types';
import { assertTrustedPath, createRequest, createSession, detectDevcontainerFromRequests, extractSkillNameFromPath, extractSkillPathsFromText } from './parser-shared';
import { canonicalizeReasoningEffort, extractReasoningEffortFromModelId, isHarnessInjectedContext } from './helpers';
import { EditLocIndex } from './edit-loc-diff';
import {
  FileEditLocMap,
  mergeFileEditLoc,
  mergeRequestEditLoc,
  parseApplyPatch,
  recordContentReplacement,
  recordCreatedContent,
} from './edit-tool-diff';
import { recordedToolFiles, recordedInvestigation, recordedWebDomains } from './curiosity-activity';
import { imageReferencesFromCodex, imageRequestIndex, mergeImageReferences, type ImageReference, type ImageRequestMatch } from './image-data';
import type { SessionSource } from './cache';
import { forEachJsonlLine } from './parser-vscode-files';

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

interface CodexImageScan {
  targetIndex: number;
  currentIndex: number;
  images: ImageReference[];
  found: boolean;
  hasAssistantText: boolean;
  hasTools: boolean;
}

interface CodexParseState {
  requests: SessionRequest[];
  firstTs: number | null;
  lastTs: number | null;
  currentUserMessage: string;
  currentImageCount: number;
  currentImages: ImageReference[];
  hasUserResponseItem: boolean;
  hasUserMessageEvent: boolean;
  imageScan?: CodexImageScan;
  currentAssistantTexts: string[];
  currentToolsUsed: string[];
  investigationDelegations: ('research' | 'explore')[];
  webDomains: string[];
  currentEditedFiles: string[];
  currentReferencedFiles: string[];
  currentSkillsUsed: string[];
  turnModel: string;
  turnEffort: 'max' | 'high' | 'medium' | 'low' | null;
  turnStartTs: number | null;
  turnCanceled: boolean;
  answerEvidence: 'final' | 'legacy' | 'missing';
  prevTotalInput: number;
  prevTotalOutput: number;
  curTotalInput: number;
  curTotalOutput: number;
  curTotalCachedInput: number;
  hasTokenData: boolean;
  sessionId: string;
  currentEditLocs: FileEditLocMap;
  editLocIndex?: EditLocIndex;
  pendingToolEdits: Map<string, PendingCodexEdit>;
}

interface PendingCodexEdit {
  editLocs: FileEditLocMap;
  editedFiles: string[];
}

/** Tool names (lowercase) that actually write/edit files. */
const CODEX_WRITE_TOOLS = new Set([
  'write', 'write_file', 'create_file', 'edit', 'edit_file',
  'apply_diff', 'apply_patch', 'patch', 'multi_edit', 'create', 'overwrite',
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

function createCodexState(initialModel: string, editLocIndex?: EditLocIndex): CodexParseState {
  return {
    requests: [],
    firstTs: null,
    lastTs: null,
    currentUserMessage: '',
    currentImageCount: 0,
    currentImages: [],
    hasUserResponseItem: false,
    hasUserMessageEvent: false,
    currentAssistantTexts: [],
    currentToolsUsed: [],
    investigationDelegations: [],
    webDomains: [],
    currentEditedFiles: [],
    currentReferencedFiles: [],
    currentSkillsUsed: [],
    turnModel: initialModel,
    turnEffort: null,
    turnStartTs: null,
    turnCanceled: false,
    answerEvidence: 'missing',
    prevTotalInput: 0,
    prevTotalOutput: 0,
    curTotalInput: 0,
    curTotalOutput: 0,
    curTotalCachedInput: 0,
    hasTokenData: false,
    sessionId: '',
    currentEditLocs: new Map(),
    editLocIndex,
    pendingToolEdits: new Map(),
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
  const noActivity = state.imageScan
    ? !state.imageScan.hasAssistantText && !state.imageScan.hasTools
    : state.currentAssistantTexts.length === 0 && state.currentToolsUsed.length === 0 && state.currentEditedFiles.length === 0;
  return noActivity && !state.turnCanceled
    && state.curTotalInput === state.prevTotalInput
    && state.curTotalOutput === state.prevTotalOutput;
}

function commitCodexEdit(state: CodexParseState, pending: PendingCodexEdit): void {
  mergeFileEditLoc(state.currentEditLocs, pending.editLocs);
  state.currentEditedFiles.push(...pending.editedFiles);
}

function flushCodexTurn(state: CodexParseState, defaultModel: string): void {
  const hasResponse = state.imageScan ? state.imageScan.hasAssistantText : state.currentAssistantTexts.length > 0;
  if (!state.currentUserMessage && state.currentImageCount === 0 && !hasResponse) return;
  state.pendingToolEdits.clear();
  if (state.imageScan) {
    const scan = state.imageScan;
    if (scan.currentIndex === scan.targetIndex) {
      scan.images = state.currentImages;
      scan.found = true;
    }
    scan.currentIndex++;
    state.prevTotalInput = state.curTotalInput;
    state.prevTotalOutput = state.curTotalOutput;
    resetCodexTurn(state);
    return;
  }

  const responseText = state.currentAssistantTexts.join('\n');
  const reqPromptTokens = state.hasTokenData && state.curTotalInput > state.prevTotalInput
    ? state.curTotalInput - state.prevTotalInput
    : null;
  const reqCompletionTokens = state.hasTokenData && state.curTotalOutput > state.prevTotalOutput
    ? state.curTotalOutput - state.prevTotalOutput
    : null;
  state.prevTotalInput = state.curTotalInput;
  state.prevTotalOutput = state.curTotalOutput;

  const requestId = `${state.sessionId || 'unknown'}:codex:${state.requests.length}`;
  state.requests.push(createRequest({
    requestId,
    timestamp: state.turnStartTs,
    messageText: state.currentUserMessage,
    responseText,
    answerEvidence: state.answerEvidence,
    isCanceled: state.turnCanceled,
    agentName: 'Codex',
    agentMode: 'agent',
    modelId: state.turnModel || defaultModel,
    toolsUsed: state.currentToolsUsed,
    investigationDelegations: [...new Set(state.investigationDelegations)],
    webDomains: [...new Set(state.webDomains)],
    editedFiles: [...new Set(state.currentEditedFiles)],
    referencedFiles: [...new Set(state.currentReferencedFiles)],
    skillsUsed: [...new Set(state.currentSkillsUsed)],
    variableKinds: state.currentImageCount > 0 ? { image: state.currentImageCount } : {},
    totalElapsed: state.turnStartTs && state.lastTs ? state.lastTs - state.turnStartTs : null,
    promptTokens: reqPromptTokens,
    completionTokens: reqCompletionTokens,
    reasoningEffort: state.turnEffort ?? extractReasoningEffortFromModelId(state.turnModel || defaultModel),
  }));
  mergeRequestEditLoc(state.editLocIndex, requestId, state.currentEditLocs);

  resetCodexTurn(state);
}

function resetCodexTurn(state: CodexParseState): void {
  state.currentUserMessage = '';
  state.currentImageCount = 0;
  state.currentImages = [];
  state.hasUserResponseItem = false;
  state.hasUserMessageEvent = false;
  state.currentAssistantTexts = [];
  state.currentToolsUsed = [];
  state.investigationDelegations = [];
  state.webDomains = [];
  state.currentEditedFiles = [];
  state.currentReferencedFiles = [];
  state.currentSkillsUsed = [];
  state.turnStartTs = null;
  state.turnCanceled = false;
  state.currentEditLocs = new Map();
  state.answerEvidence = 'missing';
  if (state.imageScan) {
    state.imageScan.hasAssistantText = false;
    state.imageScan.hasTools = false;
  }
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

/** Pull SKILL.md path references out of Codex function-call arguments,
 *  which are typically shell commands like `cat .../skills/<name>/SKILL.md`.
 *  Updates state.currentReferencedFiles and state.currentSkillsUsed. */
function collectSkillsFromArgs(args: Record<string, unknown> | null | undefined, state: CodexParseState): void {
  if (!args) return;
  const candidates: string[] = [];
  for (const key of ['cmd', 'command', 'script', 'input']) {
    const v = args[key];
    if (typeof v === 'string') candidates.push(v);
    else if (Array.isArray(v)) {
      for (const part of v) if (typeof part === 'string') candidates.push(part);
    }
  }
  for (const text of candidates) {
    for (const skillPath of extractSkillPathsFromText(text)) {
      state.currentReferencedFiles.push(skillPath);
      const name = extractSkillNameFromPath(skillPath);
      if (name) state.currentSkillsUsed.push(name);
    }
  }
}

function extractFilePath(args: Record<string, unknown> | null | undefined): string | null {
  if (!args) return null;
  if (typeof args.file_path === 'string') return args.file_path;
  if (typeof args.path === 'string') return args.path;
  if (typeof args.filename === 'string') return args.filename;
  return null;
}

function recordCodexWrite(
  toolName: string,
  rawArguments: unknown,
  args: Record<string, unknown> | null,
): PendingCodexEdit {
  const pending: PendingCodexEdit = { editLocs: new Map(), editedFiles: [] };
  const toolLower = toolName.toLowerCase();
  if (!CODEX_WRITE_TOOLS.has(toolLower)) return pending;

  if (toolLower === 'apply_patch' || toolLower === 'apply_diff' || toolLower === 'patch') {
    const patch = typeof rawArguments === 'string' && !args
      ? rawArguments
      : stringValue(args?.patch) || stringValue(args?.input);
    const patchEdits = parseApplyPatch(patch);
    mergeFileEditLoc(pending.editLocs, patchEdits);
    pending.editedFiles.push(...patchEdits.keys());
    return pending;
  }

  const filePath = extractFilePath(args);
  if (!filePath) return pending;
  pending.editedFiles.push(filePath);

  const previous = stringValue(args?.old_string) || stringValue(args?.old_str);
  const next = stringValue(args?.new_string) || stringValue(args?.new_str);
  if (previous || next) {
    recordContentReplacement(pending.editLocs, filePath, previous, next);
    return pending;
  }
  const content = stringValue(args?.content) || stringValue(args?.file_text) || stringValue(args?.text);
  if (content) recordCreatedContent(pending.editLocs, filePath, content);
  return pending;
}

function codexCallId(payload: Record<string, unknown>): string {
  return stringValue(payload.call_id) || stringValue(payload.callId);
}

function queueCodexWrite(
  toolName: string,
  rawArguments: unknown,
  args: Record<string, unknown> | null,
  callId: string,
  state: CodexParseState,
): void {
  const pending = recordCodexWrite(toolName, rawArguments, args);
  if (pending.editedFiles.length === 0) return;
  if (callId) state.pendingToolEdits.set(callId, pending);
  else commitCodexEdit(state, pending);
}

function handleCodexToolOutput(payload: Record<string, unknown>, state: CodexParseState): void {
  const callId = codexCallId(payload);
  const pending = state.pendingToolEdits.get(callId);
  if (!pending) return;
  const output = recordValue(payload.output);
  const success = typeof payload.success === 'boolean' ? payload.success
    : typeof output?.success === 'boolean' ? output.success
      : true;
  if (success) commitCodexEdit(state, pending);
  state.pendingToolEdits.delete(callId);
}

function collectCodexImages(payload: Record<string, unknown>, state: CodexParseState): void {
  const images = imageReferencesFromCodex(payload);
  // A turn can be recorded as both event_msg and response_item. They describe
  // the same attachments, not two separate sets of screenshots.
  state.currentImageCount = Math.max(state.currentImageCount, images.length);
  if (state.imageScan) state.currentImages = mergeImageReferences(state.currentImages, images);
}

function prepareCodexUserTurn(
  state: CodexParseState,
  text: string,
  ts: number | null,
  defaultModel: string,
  recordType: 'event' | 'response',
  imageCount: number,
): void {
  const hasTurn = state.currentUserMessage.length > 0 || state.currentImageCount > 0;
  const hasImages = imageCount > 0 || state.currentImageCount > 0;
  const mirror = recordType === 'event'
    ? state.hasUserResponseItem && !state.hasUserMessageEvent
    : state.hasUserMessageEvent && !state.hasUserResponseItem;
  const samePrompt = state.currentUserMessage === text || (hasImages && (!state.currentUserMessage || !text));
  const legacyDuplicate = recordType === 'event' && state.hasUserMessageEvent && !hasImages;
  if (hasTurn && samePrompt && isTurnEmpty(state) && (mirror || legacyDuplicate)) {
    if (state.turnStartTs === null) state.turnStartTs = ts;
    if (!state.currentUserMessage) state.currentUserMessage = text;
  } else {
    flushCodexTurn(state, defaultModel);
    state.currentUserMessage = text;
    state.turnStartTs = ts;
  }
  if (recordType === 'event') state.hasUserMessageEvent = true;
  else state.hasUserResponseItem = true;
}

function handleUserMessageEvent(payload: Record<string, unknown>, state: CodexParseState, ts: number | null, defaultModel: string): void {
  const newMessage = stringValue(payload.message) || stringValue(payload.text);
  // Harness-injected session-start context is recorded as a user message but is
  // not a real prompt; ignore it before flushing or mutating turn state.
  if (isHarnessInjectedContext(newMessage)) return;
  prepareCodexUserTurn(state, newMessage, ts, defaultModel, 'event', imageReferencesFromCodex(payload).length);
  collectCodexImages(payload, state);
}

function handleFunctionCallEvent(payload: Record<string, unknown>, state: CodexParseState): void {
  state.answerEvidence = 'missing';
  const toolName = stringValue(payload.name) || 'unknown';
  state.currentToolsUsed.push(toolName);

  const rawArguments = payload.arguments;
  const args = typeof rawArguments === 'string'
    ? parseJsonRecord(rawArguments)
    : recordValue(rawArguments) ?? null;
  const role = recordedInvestigation(toolName, args);
  if (role) state.investigationDelegations.push(role);
  state.webDomains.push(...recordedWebDomains(toolName, args));
  state.currentReferencedFiles.push(...recordedToolFiles(toolName, args).referenced);
  collectSkillsFromArgs(args, state);
  queueCodexWrite(toolName, rawArguments, args, codexCallId(payload), state);
}

function handleAssistantMessageEvent(payload: Record<string, unknown>, state: CodexParseState): void {
  const content = payload.content;
  if (typeof content === 'string') {
    state.currentAssistantTexts.push(content);
    if (content.trim()) state.answerEvidence = payload.phase === 'final' ? 'final' : payload.phase == null ? 'legacy' : 'missing';
  }
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
  if (eventType === 'function_call_output' || eventType === 'custom_tool_call_output') {
    handleCodexToolOutput(payload, state);
    return;
  }
  if (eventType === 'task_complete' && typeof payload.last_agent_message === 'string' && payload.last_agent_message.trim()) {
    state.answerEvidence = 'final';
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
  const text = extractContentItems(payload.content)
    .filter(item => item.type === 'input_text' && item.text && !item.text.startsWith('<') && !isHarnessInjectedContext(item.text))
    .map(item => item.text)
    .join('\n');
  if (!text && imageReferencesFromCodex(payload).length === 0) return;
  prepareCodexUserTurn(state, text, ts, defaultModel, 'response', imageReferencesFromCodex(payload).length);
  collectCodexImages(payload, state);
}

function handleAssistantResponseItem(payload: Record<string, unknown>, state: CodexParseState): void {
  for (const item of extractContentItems(payload.content)) {
    if (item.type === 'output_text' && item.text) {
      state.currentAssistantTexts.push(item.text);
      if (item.text.trim()) state.answerEvidence = payload.phase === 'final' || payload.channel === 'final' ? 'final'
        : payload.phase == null && payload.channel == null ? 'legacy' : 'missing';
    }
  }
}

function handleFunctionCallResponseItem(payload: Record<string, unknown>, state: CodexParseState): void {
  state.answerEvidence = 'missing';
  const toolName = stringValue(payload.name);
  if (!toolName) return;

  state.currentToolsUsed.push(toolName);

  const rawArguments = payload.arguments;
  const args = typeof rawArguments === 'string'
    ? parseJsonRecord(rawArguments)
    : recordValue(rawArguments) ?? null;
  const role = recordedInvestigation(toolName, args);
  if (role) state.investigationDelegations.push(role);
  state.webDomains.push(...recordedWebDomains(toolName, args));
  state.currentReferencedFiles.push(...recordedToolFiles(toolName, args).referenced);
  collectSkillsFromArgs(args, state);
  queueCodexWrite(toolName, rawArguments, args, codexCallId(payload), state);
}

function handleCustomToolCallResponseItem(payload: Record<string, unknown>, state: CodexParseState): void {
  const toolName = stringValue(payload.name);
  if (!toolName) return;
  state.currentToolsUsed.push(toolName);
  state.answerEvidence = 'missing';
  const input = stringValue(payload.input);
  queueCodexWrite(toolName, input, null, codexCallId(payload), state);
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
  else if (itemType === 'custom_tool_call') handleCustomToolCallResponseItem(payload, state);
  else if (itemType === 'function_call_output' || itemType === 'custom_tool_call_output') {
    handleCodexToolOutput(payload, state);
  }
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
  state.sessionId = meta.sessionId;
  const ts = line.timestamp ? new Date(line.timestamp).getTime() : null;
  updateTimestamps(state, ts);
  if (state.imageScan) {
    handleCodexImageLine(line, state, meta, state.imageScan);
    return;
  }

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

function handleCodexImageLine(line: CodexLine, state: CodexParseState, meta: CodexSessionMeta, scan: CodexImageScan): void {
  const payload = line.payload ?? {};
  const ts = line.timestamp ? new Date(line.timestamp).getTime() : null;
  if (line.type === 'event_msg') {
    const type = stringValue(payload.type);
    if (type === 'user_message') {
      handleUserMessageEvent(payload, state, ts, meta.model);
      return;
    }
    if (type === 'token_count') handleTokenCountEvent(payload, state);
    if (type === 'turn_aborted') state.turnCanceled = true;
    if (type === 'agent_reasoning' || (type === 'assistant_message' && typeof payload.content === 'string')) scan.hasAssistantText = true;
    if (type === 'function_call') scan.hasTools = true;
  } else if (line.type === 'response_item') {
    if (payload.role === 'user') {
      handleUserResponseItem(payload, state, ts, meta.model);
      return;
    }
    if (payload.role === 'assistant' && payload.type === 'message') {
      scan.hasAssistantText ||= extractContentItems(payload.content).some(item => item.type === 'output_text' && !!item.text);
    } else if ((payload.type === 'function_call' || payload.type === 'custom_tool_call') && stringValue(payload.name)) {
      scan.hasTools = true;
    }
  }
  if (scan.currentIndex === scan.targetIndex && !isTurnEmpty(state)) flushCodexTurn(state, meta.model);
}

function readCodexJsonlStreaming(filePath: string, onLine: (line: CodexLine) => void, shouldStop?: () => boolean): void {
  forEachJsonlLine(filePath, raw => {
    if (!raw.trim()) return;
    const parsed = parseCodexLine(raw);
    if (parsed) onLine(parsed);
  }, shouldStop);
}

export function extractCodexImageReferences(filePath: string, sessionId: string, requestId: string, match?: ImageRequestMatch): ImageReference[] {
  assertTrustedPath(filePath);
  const index = imageRequestIndex(sessionId, requestId, 'codex', match);
  if (index === null) return [];
  const state = createCodexState('');
  const scan: CodexImageScan = {
    targetIndex: index, currentIndex: 0, images: [], found: false, hasAssistantText: false, hasTools: false,
  };
  state.imageScan = scan;
  const meta: CodexSessionMeta = { sessionId, cwd: '', source: '', model: '' };
  let wrongSession = false;
  readCodexJsonlStreaming(filePath, line => {
    handleCodexLine(line, state, meta);
    wrongSession = meta.sessionId !== sessionId;
  }, () => scan.found || wrongSession);
  if (wrongSession) return [];
  if (!scan.found) flushCodexTurn(state, meta.model);
  return scan.images;
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

export function parseCodexSessions(sessionsDir: string, editLocIndex?: EditLocIndex, sessionSourceIndex?: Map<string, SessionSource>): Session[] {
  const sessions: Session[] = [];
  const files = findAllJsonlFiles(sessionsDir);

  for (const filePath of files) {
    const session = parseCodexSessionFile(filePath, editLocIndex);
    if (session) {
      sessions.push(session);
      sessionSourceIndex?.set(session.sessionId, {
        kind: 'codex-jsonl',
        filePath,
        workspaceId: session.workspaceId,
        workspaceName: session.workspaceName,
        workspaceRootPath: session.workspaceRootPath,
        harness: session.harness,
      });
    }
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

export function parseCodexSessionFile(filePath: string, editLocIndex?: EditLocIndex): Session | null {
  assertTrustedPath(filePath);
  const meta: CodexSessionMeta = {
    sessionId: path.basename(filePath, '.jsonl'),
    cwd: '',
    source: '',
    model: '',
  };
  const state = createCodexState('', editLocIndex);
  state.sessionId = meta.sessionId;
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
  state.sessionId = meta.sessionId;

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
