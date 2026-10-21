/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* GitHub Copilot CLI event parsing for VS Code session discovery.
 *
 * Event flow per user turn:
 *   user.message → (assistant.message → tool.execution_start/complete)* → user.message
 * A single user turn may contain many assistant.message events (multi-step agent loop).
 * We aggregate all events between consecutive user.message events into one SessionRequest.
 */

import { Session, SessionRequest, CompactionEvent, ModelUsage } from './types';
import { createRequest, createSession, detectDevcontainerFromRequests, recordFailedFile } from './parser-shared';
import { forEachJsonlLine, forEachJsonlLineAsync } from './parser-vscode-files';
import { canonicalizeReasoningEffort, extractReasoningEffortFromModelId, normalizeModel } from './helpers';
import { EditLocIndex } from './edit-loc-diff';
import {
  FileEditLocMap,
  mergeFileEditLoc,
  mergeRequestEditLoc,
  parseApplyPatch,
  recordContentReplacement,
  recordCreatedContent,
} from './edit-tool-diff';
import { recordedTools, recordedToolFiles, recordedInvestigation, recordedWebDomains } from './curiosity-activity';
import { imageReferencesFromAttachments, imageReferencesFromVariables, imageRequestIndex, type ImageReference, type ImageRequestMatch } from './image-data';

interface CLIEvent {
  type: string;
  data?: Record<string, unknown>;
  timestamp?: string;
  id?: string;
}

/* The desktop Copilot app and the terminal Copilot CLI both write
 * ~/.copilot/session-state/<id>/events.jsonl. Only the app emits the
 * remoteSteerable field on session.start, so we use it to tell them apart. */
function harnessName(state: CLIParseState): string {
  return state.isApp ? 'GitHub Copilot App' : 'GitHub Copilot CLI';
}

/** Accumulated state for a single user turn (user.message → next user.message). */
interface TurnState {
  userMsg: string;
  userEventId?: string;
  answerEvidence: 'final' | 'legacy' | 'missing';
  nonUser?: boolean;
  userTs: string | null;
  agentMode: string;
  responseChunks: string[];
  toolNames: Set<string>;
  investigationDelegations: Set<'research' | 'explore'>;
  webDomains: Set<string>;
  editedFiles: Set<string>;
  referencedFiles: Set<string>;
  skillsUsed: Set<string>;
  firstToolTs: number | null;
  lastAssistantTs: string | null;
  lastAssistantId: string | null;
  totalOutputTokens: number;
  modelId: string;
  isCanceled: boolean;
  compaction: CompactionEvent | null;
  reasoningEffort: 'max' | 'high' | 'medium' | 'low' | null;
  imageCount: number;
  editLocs: FileEditLocMap;
  pendingToolEdits: Map<string, PendingToolEdit>;
}

interface PendingToolEdit {
  editLocs: FileEditLocMap;
  editedFiles: Set<string>;
  codeBlock: string | null;
}

interface CLIParseState {
  sessionId: string;
  workspaceRootPath?: string;
  isApp: boolean;
  startTime: string | null;
  currentModelId: string;
  currentReasoningEffort: 'max' | 'high' | 'medium' | 'low' | null;
  modelUsage: Record<string, ModelUsage> | undefined;
  sawShutdown: boolean;
  requests: SessionRequest[];
  turn: TurnState | null;
  editLocIndex?: EditLocIndex;
}

function freshTurn(userMsg: string, userTs: string | null, agentMode: string, reasoningEffort: 'max' | 'high' | 'medium' | 'low' | null): TurnState {
  return {
    userMsg,
    answerEvidence: 'missing',
    userTs,
    agentMode,
    responseChunks: [],
    toolNames: new Set(),
    investigationDelegations: new Set(),
    webDomains: new Set(),
    editedFiles: new Set(),
    referencedFiles: new Set(),
    skillsUsed: new Set(),
    firstToolTs: null,
    lastAssistantTs: null,
    lastAssistantId: null,
    totalOutputTokens: 0,
    modelId: '',
    isCanceled: false,
    compaction: null,
    reasoningEffort,
    imageCount: 0,
    editLocs: new Map(),
    pendingToolEdits: new Map(),
  };
}

const FILE_REF_TOOLS = new Set(['view', 'grep', 'glob', 'rg', 'show_file']);
const FILE_EDIT_TOOLS = new Set(['edit', 'create', 'apply_patch']);
const META_TOOLS = new Set(['report_intent']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function recordArrayValue(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord);
}

function parseCLIEventLine(line: string): CLIEvent | null {
  try {
    const parsed: unknown = JSON.parse(line);
    if (!isRecord(parsed) || typeof parsed.type !== 'string') return null;
    return {
      type: parsed.type,
      data: recordValue(parsed.data),
      timestamp: typeof parsed.timestamp === 'string' ? parsed.timestamp : undefined,
      id: typeof parsed.id === 'string' ? parsed.id : undefined,
    };
  } catch {
    return null;
  }
}

function getTurnEndState(turn: TurnState): 'errored' | 'pending' | undefined {
  const noResponseRecorded = turn.responseChunks.length === 0
    && turn.toolNames.size === 0
    && turn.totalOutputTokens === 0;
  return noResponseRecorded ? turn.isCanceled ? 'errored' : 'pending' : undefined;
}

function commitToolEdit(turn: TurnState, edit: PendingToolEdit): void {
  mergeFileEditLoc(turn.editLocs, edit.editLocs);
  for (const file of edit.editedFiles) turn.editedFiles.add(file);
  if (edit.codeBlock) turn.responseChunks.push(edit.codeBlock);
}

function flushTurn(state: CLIParseState): void {
  const turn = state.turn;
  if (!turn) return;
  turn.pendingToolEdits.clear();

  const msgTs = turn.userTs ? new Date(turn.userTs).getTime() : null;
  const respTs = turn.lastAssistantTs ? new Date(turn.lastAssistantTs).getTime() : null;
  const firstProgress = turn.firstToolTs && msgTs ? turn.firstToolTs - msgTs : null;
  const responseText = turn.responseChunks.filter(Boolean).join('\n\n');

  const requestId = turn.lastAssistantId || `${state.sessionId}:cli:${state.requests.length}`;
  state.requests.push(createRequest({
    requestId,
    userEventId: turn.userEventId,
    answerEvidence: turn.answerEvidence,
    timestamp: msgTs,
    messageText: turn.userMsg,
    responseText,
    agentName: harnessName(state),
    agentMode: turn.agentMode || 'agent',
    modelId: turn.modelId || state.currentModelId,
    toolsUsed: [...turn.toolNames],
    investigationDelegations: [...turn.investigationDelegations],
    webDomains: [...turn.webDomains],
    editedFiles: [...turn.editedFiles],
    referencedFiles: [...turn.referencedFiles],
    skillsUsed: [...turn.skillsUsed],
    variableKinds: turn.imageCount > 0 ? { image: turn.imageCount } : {},
    firstProgress: firstProgress !== null && firstProgress >= 0 ? firstProgress : null,
    totalElapsed: msgTs && respTs ? respTs - msgTs : null,
    completionTokens: turn.totalOutputTokens || null,
    isCanceled: turn.isCanceled,
    compaction: turn.compaction,
    // Reasoning effort: prefer the value captured at user.message time
    // (carried forward from session.start / model_change). Fall back to
    // model-id suffix inference for sessions that pre-date the explicit
    // event field.
    reasoningEffort: turn.reasoningEffort
      ?? extractReasoningEffortFromModelId(turn.modelId || state.currentModelId),
    endState: getTurnEndState(turn),
    curiosity: turn.nonUser ? { kind: 'excluded', excerpts: [] } : undefined,
  }));
  mergeRequestEditLoc(state.editLocIndex, requestId, turn.editLocs);
}

function addAttachmentReferences(turn: TurnState, attachments: unknown): void {
  for (const attachment of recordArrayValue(attachments)) {
    const filePath = attachment.path;
    if (typeof filePath === 'string') turn.referencedFiles.add(filePath);
  }
}

function handleSessionStart(ev: CLIEvent, state: CLIParseState, wsId: string): void {
  const data = ev.data || {};
  state.sessionId = str(data.sessionId) || wsId;
  state.isApp = 'remoteSteerable' in data;
  state.startTime = str(data.startTime) || ev.timestamp || null;
  state.currentModelId = str(data.selectedModel);
  state.workspaceRootPath = str(recordValue(data.context)?.cwd) || str(data.cwd) || undefined;
  state.currentReasoningEffort = canonicalizeReasoningEffort(str(data.reasoningEffort))
    ?? extractReasoningEffortFromModelId(state.currentModelId);
}

function handleModelChange(data: Record<string, unknown>, state: CLIParseState): void {
  state.currentModelId = str(data.newModel) || state.currentModelId;
  state.currentReasoningEffort = canonicalizeReasoningEffort(str(data.reasoningEffort))
    ?? extractReasoningEffortFromModelId(state.currentModelId);
}

function handleUserMessage(ev: CLIEvent, state: CLIParseState): void {
  flushTurn(state);
  state.turn = freshTurn(
    str(ev.data?.content),
    ev.timestamp || null,
    str(ev.data?.agentMode) || 'agent',
    state.currentReasoningEffort,
  );
  // Relayed turns name their sender in harness-added text, for example `from_session_id:`.
  const injected = str(ev.data?.transformedContent).replace(str(ev.data?.content), '');
  state.turn.nonUser = /^(?:agent(?:-|$)|skill(?:-|$)|system$|autopilot$)/i.test(str(ev.data?.source))
    || /^[ \t]*(?:from|sender)(?:_[a-z]+)+[ \t]*[:=]/im.test(injected);
  state.turn.userEventId = ev.id;
  addAttachmentReferences(state.turn, ev.data?.attachments);
  const images = [
    ...imageReferencesFromAttachments(ev.data?.attachments),
    ...imageReferencesFromVariables(ev.data?.variables),
  ];
  state.turn.imageCount = images.length;
}

function handleToolExecutionStart(ev: CLIEvent, state: CLIParseState): void {
  const turn = state.turn;
  if (!turn) return;

  const data = ev.data || {};
  const toolName = str(data.toolName);
  const rawArgs = data.arguments;
  const args = recordValue(rawArgs) || {};
  const ts = ev.timestamp ? new Date(ev.timestamp).getTime() : null;

  if (ts && turn.firstToolTs === null) turn.firstToolTs = ts;
  addRecordedTools(turn, toolName, data.arguments);
  const pending: PendingToolEdit = {
    editLocs: new Map(),
    editedFiles: new Set(recordedToolFiles(toolName, rawArgs).edited),
    codeBlock: null,
  };
  if (toolName === 'apply_patch') {
    const patch = typeof rawArgs === 'string'
      ? rawArgs
      : str(args.patch) || str(args.input);
    const patchEdits = parseApplyPatch(patch);
    mergeFileEditLoc(pending.editLocs, patchEdits);
    for (const file of patchEdits.keys()) pending.editedFiles.add(file);
  } else if (FILE_EDIT_TOOLS.has(toolName) && typeof args.path === 'string') {
    pending.editedFiles.add(args.path);
    if (toolName === 'create') {
      const content = str(args.file_text) || str(args.content) || str(args.code);
      if (content) recordCreatedContent(pending.editLocs, args.path, content);
    } else if (toolName === 'edit') {
      const previous = str(args.old_str) || str(args.oldString) || str(args.old_string);
      const next = str(args.new_str) || str(args.newString) || str(args.new_string);
      if (previous || next) recordContentReplacement(pending.editLocs, args.path, previous, next);
    }
    // Include generated code content so extractCodeBlocks() can detect AI-produced code.
    // CLI tools use snake_case field names: create → file_text, edit → new_str.
    const code = typeof args.file_text === 'string' ? args.file_text
      : typeof args.content === 'string' ? args.content
        : typeof args.new_str === 'string' ? args.new_str
          : typeof args.newString === 'string' ? args.newString
            : typeof args.code === 'string' ? args.code
              : null;
    if (code) {
      const ext = args.path.split('.').pop() || 'unknown';
      pending.codeBlock = `\`\`\`${ext}\n${code}\n\`\`\``;
    }
  }
  if (pending.editedFiles.size > 0) {
    const toolCallId = str(data.toolCallId);
    if (toolCallId) turn.pendingToolEdits.set(toolCallId, pending);
    else commitToolEdit(turn, pending);
  }
  if (FILE_REF_TOOLS.has(toolName) && typeof args.path === 'string') turn.referencedFiles.add(args.path);
  if (toolName === 'skill' && typeof args.skill === 'string') turn.skillsUsed.add(args.skill);
}

function handleToolExecutionComplete(data: Record<string, unknown>, state: CLIParseState): void {
  const turn = state.turn;
  if (!turn) return;
  const toolCallId = str(data.toolCallId);
  const pending = toolCallId ? turn.pendingToolEdits.get(toolCallId) : undefined;
  if (pending) {
    if (data.success !== false) commitToolEdit(turn, pending);
    turn.pendingToolEdits.delete(toolCallId);
  }
  const model = str(data.model);
  if (model && !turn.modelId) turn.modelId = model;
}

function addRecordedTools(turn: TurnState, name: string, args: unknown): void {
  if (!name || META_TOOLS.has(name)) return;
  turn.answerEvidence = 'missing';
  for (const call of recordedTools(name, args)) {
    turn.toolNames.add(call.name);
    const role = recordedInvestigation(call.name, call.args);
    if (role) turn.investigationDelegations.add(role);
    for (const domain of recordedWebDomains(call.name, call.args)) turn.webDomains.add(domain);
    const files = recordedToolFiles(call.name, call.args);
    for (const file of files.referenced) turn.referencedFiles.add(file);
  }
}

function addAssistantToolRequests(turn: TurnState, toolRequests: unknown): void {
  for (const request of recordArrayValue(toolRequests)) {
    const toolName = str(request.toolName) || str(request.name);
    addRecordedTools(turn, toolName, request.arguments);
  }
}

function handleAssistantMessage(ev: CLIEvent, state: CLIParseState): void {
  const turn = state.turn;
  if (!turn) return;

  const data = ev.data || {};
  const content = str(data.content);
  if (content.trim()) {
    if (data.phase === 'final' || data.phase === 'final_answer') turn.answerEvidence = 'final';
    else if (data.phase == null && !recordArrayValue(data.toolRequests).length && turn.answerEvidence !== 'final') {
      turn.answerEvidence = 'legacy';
    }
    else if (turn.answerEvidence === 'legacy') turn.answerEvidence = 'missing';
  }
  if (content) turn.responseChunks.push(content);
  turn.lastAssistantTs = ev.timestamp || turn.lastAssistantTs;
  turn.lastAssistantId = str(ev.id) || turn.lastAssistantId;

  if (typeof data.outputTokens === 'number') turn.totalOutputTokens += data.outputTokens;
  addAssistantToolRequests(turn, data.toolRequests);
}

function handleCompactionComplete(data: Record<string, unknown>, state: CLIParseState): void {
  const turn = state.turn;
  if (!turn) return;
  turn.compaction = {
    mode: str(data.mode) === 'simple' ? 'simple' : 'full',
    numRounds: typeof data.numRounds === 'number' ? data.numRounds : 0,
    numRoundsSinceLastSummarization: typeof data.numRoundsSinceLastSummarization === 'number' ? data.numRoundsSinceLastSummarization : 0,
    contextLengthBefore: typeof data.contextLengthBefore === 'number' ? data.contextLengthBefore : 0,
    durationMs: typeof data.durationMs === 'number' ? data.durationMs : 0,
    model: typeof data.model === 'string' ? data.model : '',
    outcome: typeof data.outcome === 'string' ? data.outcome : '',
  };
}

function addModelUsage(collected: Record<string, ModelUsage>, rawModel: string, info: unknown): void {
  const infoRecord = recordValue(info);
  if (!infoRecord) return;

  const usage = recordValue(infoRecord.usage) || {};
  const inputTokens = typeof usage.inputTokens === 'number' ? usage.inputTokens : 0;
  const outputTokens = typeof usage.outputTokens === 'number' ? usage.outputTokens : 0;
  const cacheReadTokens = typeof usage.cacheReadTokens === 'number' ? usage.cacheReadTokens : 0;
  const cacheWriteTokens = typeof usage.cacheWriteTokens === 'number' ? usage.cacheWriteTokens : 0;
  const reasoningTokens = typeof usage.reasoningTokens === 'number' ? usage.reasoningTokens : 0;
  if (inputTokens === 0 && outputTokens === 0 && cacheReadTokens === 0 && cacheWriteTokens === 0) return;

  const key = normalizeModel(rawModel);
  const existing = collected[key];
  if (existing) {
    existing.inputTokens += inputTokens;
    existing.outputTokens += outputTokens;
    existing.cacheReadTokens += cacheReadTokens;
    existing.cacheWriteTokens += cacheWriteTokens;
    existing.reasoningTokens = (existing.reasoningTokens ?? 0) + reasoningTokens;
    return;
  }

  collected[key] = { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens };
}

function handleShutdown(data: Record<string, unknown>, state: CLIParseState): void {
  state.sawShutdown = true;
  const modelMetrics = recordValue(data.modelMetrics) || {};
  const collected: Record<string, ModelUsage> = {};
  for (const [rawModel, info] of Object.entries(modelMetrics)) {
    addModelUsage(collected, rawModel, info);
  }
  if (Object.keys(collected).length > 0) state.modelUsage = collected;
}

function handleCliEvent(ev: CLIEvent, state: CLIParseState, wsId: string): void {
  switch (ev.type) {
    case 'session.start':
      handleSessionStart(ev, state, wsId);
      return;
    case 'session.model_change':
      handleModelChange(ev.data || {}, state);
      return;
    case 'user.message':
      handleUserMessage(ev, state);
      return;
    case 'tool.execution_start':
      handleToolExecutionStart(ev, state);
      return;
    case 'tool.execution_complete':
      handleToolExecutionComplete(ev.data || {}, state);
      return;
    case 'assistant.message':
      handleAssistantMessage(ev, state);
      return;
    case 'session.task_complete':
      if (state.turn && ev.data?.success === true && typeof ev.data.summary === 'string' && ev.data.summary.trim()) {
        state.turn.answerEvidence = 'final';
        if (!state.turn.responseChunks.includes(ev.data.summary)) state.turn.responseChunks.push(ev.data.summary);
        state.turn.lastAssistantTs = ev.timestamp || state.turn.lastAssistantTs;
      }
      return;
    case 'abort':
      if (state.turn) state.turn.isCanceled = true;
      return;
    case 'session.compaction_complete':
      handleCompactionComplete(ev.data || {}, state);
      return;
    case 'session.shutdown':
      handleShutdown(ev.data || {}, state);
      return;
  }
}

function createInitialCliState(wsId: string, editLocIndex?: EditLocIndex): CLIParseState {
  return {
    sessionId: wsId,
    isApp: false,
    startTime: null,
    currentModelId: '',
    currentReasoningEffort: null,
    modelUsage: undefined,
    sawShutdown: false,
    requests: [],
    turn: null,
    editLocIndex,
  };
}

function finalizeCliSession(
  state: CLIParseState,
  wsId: string,
  wsName: string,
  customInstructionsBytes?: number,
): Session | null {
  flushTurn(state);

  if (state.requests.length === 0) return null;

  const creationDate = state.startTime ? new Date(state.startTime).getTime() : null;
  return createSession({
    sessionId: state.sessionId,
    workspaceId: wsId,
    workspaceName: wsName,
    location: 'cli',
    harness: harnessName(state),
    ...(creationDate === null ? {} : { creationDate }),
    requests: state.requests,
    modelUsage: state.modelUsage,
    endReason: state.sawShutdown ? 'shutdown' : 'active',
    customInstructionsBytes,
    hasDevcontainer: detectDevcontainerFromRequests(state.requests),
    workspaceRootPath: state.workspaceRootPath,
  });
}

export function parseCLIEventsFile(
  eventsPath: string,
  wsId: string,
  wsName: string,
  customInstructionsBytes?: number,
  editLocIndex?: EditLocIndex,
): Session | null {
  const state = createInitialCliState(wsId, editLocIndex);

  let sawAnyEvent = false;
  try {
    // Stream events line-by-line and handle each immediately. The Copilot CLI events.jsonl can be
    // over 1 GB; reading it whole (or building a full events[] array) forces a single giant
    // allocation that trips Chromium's PartitionAlloc OOM guard inside Electron (issue #106).
    forEachJsonlLine(eventsPath, (line) => {
      if (!line.trim()) return;
      const event = parseCLIEventLine(line);
      if (event) {
        handleCliEvent(event, state, wsId);
        sawAnyEvent = true;
      }
    });
  } catch (e) {
    recordFailedFile('parser-vscode-cli', eventsPath, e);
    return null;
  }

  if (!sawAnyEvent) return null;

  return finalizeCliSession(state, wsId, wsName, customInstructionsBytes);
}

export function extractCLIImageReferences(
  eventsPath: string,
  sessionId: string,
  requestId: string,
  match?: ImageRequestMatch,
): ImageReference[] {
  const userEventId = match?.userEventId;
  const requestIndex = imageRequestIndex(sessionId, requestId, 'cli', match);
  let currentIndex = -1;
  let current: ImageReference[] = [];
  let images: ImageReference[] = [];
  let done = false;
  forEachJsonlLine(eventsPath, line => {
    if (!line.includes('"user.message"') && !line.includes('"session.start"')
      && (userEventId || requestIndex !== null || !line.includes('"assistant.message"'))) return;
    const event = parseCLIEventLine(line);
    if (!event) return;
    if (event.type === 'session.start' && typeof event.data?.sessionId === 'string' && event.data.sessionId !== sessionId) {
      done = true;
      return;
    }
    if (event.type === 'user.message') {
      currentIndex++;
      current = [
        ...imageReferencesFromAttachments(event.data?.attachments),
        ...imageReferencesFromVariables(event.data?.variables),
      ];
      if (userEventId ? event.id === userEventId : currentIndex === requestIndex) {
        images = current;
        done = true;
      }
    } else if (!userEventId && requestIndex === null && event.type === 'assistant.message' && event.id === requestId) {
      images = current;
      done = true;
    }
  }, () => done);
  return images;
}

/**
 * Async sibling of {@link parseCLIEventsFile} for the cold-parse path. Streams the events file
 * while yielding to the event loop and reporting byte progress, so a multi-GB events.jsonl no
 * longer blocks the worker for minutes or freezes the host progress bar (issue #106).
 */
export async function parseCLIEventsFileAsync(
  eventsPath: string,
  wsId: string,
  wsName: string,
  customInstructionsBytes?: number,
  onProgress?: (bytesRead: number, totalBytes: number) => void,
  editLocIndex?: EditLocIndex,
): Promise<Session | null> {
  const state = createInitialCliState(wsId, editLocIndex);

  let sawAnyEvent = false;
  try {
    await forEachJsonlLineAsync(eventsPath, (line) => {
      if (!line.trim()) return;
      const event = parseCLIEventLine(line);
      if (event) {
        handleCliEvent(event, state, wsId);
        sawAnyEvent = true;
      }
    }, onProgress);
  } catch (e) {
    recordFailedFile('parser-vscode-cli', eventsPath, e);
    return null;
  }

  if (!sawAnyEvent) return null;

  return finalizeCliSession(state, wsId, wsName, customInstructionsBytes);
}
