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

import * as path from 'path';
import { Session, SessionRequest, CompactionEvent, ModelUsage, CompactionContextSnapshot, SessionContextComposition, SystemPromptSegment } from './types';
import { createRequest, createSession, detectDevcontainerFromRequests, recordFailedFile } from './parser-shared';
import { forEachJsonlLine, forEachJsonlLineAsync } from './parser-vscode-files';
import { canonicalizeReasoningEffort, extractReasoningEffortFromModelId, normalizeModel } from './helpers';
import { compositionFromCliUsage, readSystemSegments, type CliTurnUsage } from './context-composition';
import { readCliModelCall, type CliModelCall } from './cli-model-calls';
import { CallTimelineBuilder } from './call-timeline';
import { CliCacheTracker } from './prompt-cache-cli';
import { cacheModelName, uncachedTokens } from './prompt-cache-usage';
import { addTurnCompaction, readCliCompaction } from './cli-compaction';
import { SubagentRunTracker } from './cli-subagents';
import { TurnContextAccumulator } from './cli-turn-context';
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
import type { NonHumanKind, UserWait } from './types';
import { cliNonHumanKind, cliRelaySenderId } from './parser-turn-kinds';
import { NANO_AIU_PER_AI_CREDIT } from './github-app-issue-credit-model';
import { readCliWorkspaceMeta } from './session-workspace-meta';

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
  /** Same turns as `nonHumanKind`; the Curiosity exclusion reads it. */
  nonUser?: boolean;
  nonHumanKind?: NonHumanKind;
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
  /** Every compaction of the turn; `compaction` is the first. */
  compactions: CompactionEvent[];
  reasoningEffort: 'max' | 'high' | 'medium' | 'low' | null;
  imageCount: number;
  editLocs: FileEditLocMap;
  pendingToolEdits: Map<string, PendingToolEdit>;
  /** Main-agent model calls of this turn (from session.usage_record). */
  usage: CliTurnUsage;
  /** AI credits and tokens of every model call of the turn, sub-agents included (from session.usage_record). */
  logged: TurnUsageTotals;
  /** Questions and permission prompts you answered during the turn: when it waited on you. */
  userWaits: UserWait[];
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
  /** Latest known system-prompt size (checkpoint segments, compaction or shutdown). */
  systemTokens: number | null;
  /** Turns flushed before any system-prompt size was known. */
  pendingCompositions: { request: SessionRequest; usage: CliTurnUsage }[];
  systemSegments: SystemPromptSegment[];
  checkpointToolCount: number | null;
  checkpointToolTokens: number | null;
  compactionSnapshots: CompactionContextSnapshot[];
  /** Main-agent model calls in order (`Session.callTimeline`). */
  timeline: CallTimelineBuilder;
  /** Prompt-cache usage and breaks (`SessionRequest.promptCache`, `Session.promptCache`). */
  cache: CliCacheTracker;
  /** Sub-agent runs, attributed to the turn that launched them when the session is finalized. */
  subagents: SubagentRunTracker;
  /** Main-agent context of the turn being built (`SessionRequest.contextUsage`). */
  context: TurnContextAccumulator;
  /** Main-agent calls logged so far: the index of the next call in the call timeline. */
  mainCalls: number;
  /** Session-starting tool calls (`create_session`, `open_pr_session`, `open_issue_session`) awaiting their result. */
  sessionToolCalls: Set<string>;
  /** Session IDs in the results of those calls: the sessions this one started. */
  childSessionIds: Set<string>;
  /** Sender of the session's first message, when that message was relayed from another session. */
  relaySenderId?: string;
  /** Credits and tokens of usage records logged before the first prompt; the first turn takes them. */
  pendingUsage: TurnUsageTotals;
  /** Questions and permission prompts awaiting a decision, by tool call ID or `permission:<request ID>`. */
  openWaits: Map<string, OpenUserWait>;
  /** Resolved ones without evidence yet that you answered, awaiting a `human_response.recorded` event. */
  unconfirmedWaits: Map<string, { wait: UserWait; owner: number }>;
  /** Keys with a `human_response.recorded` event. */
  humanResponses: Set<string>;
  /** Waits answered before the first turn; the first turn takes them. */
  earlyWaits: UserWait[];
}

interface TurnUsageTotals {
  credits: number;
  tokens: number;
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
    compactions: [],
    reasoningEffort,
    imageCount: 0,
    editLocs: new Map(),
    pendingToolEdits: new Map(),
    usage: { calls: 0, inputTokens: 0, toolTokens: 0, availableTools: 0 },
    logged: { credits: 0, tokens: 0 },
    userWaits: [],
  };
}

/** Tools that start another session and return its ID. */
const SESSION_TOOLS = ['create_session', 'open_pr_session', 'open_issue_session'];
/** Tools that stop the turn until you answer: a question to you, or a child session's question relayed to you. */
const QUESTION_TOOLS = ['ask_user', 'relay_session_input'];
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** Where a session-starting tool's result names the new session: its link, or a labelled ID. */
const STARTED_SESSION_PATTERNS = [
  new RegExp(String.raw`ghapp://sessions/(${UUID})`, 'i'),
  new RegExp(String.raw`\b(?:session_id|sessionId|id)\s*[:=]\s*["']?(${UUID})`, 'i'),
  new RegExp(String.raw`\bSession (${UUID}) is ready`, 'i'),
];

/** Whether `name` is one of `tools`, bare or behind an MCP server prefix (`server-tool`, `mcp_server_tool`). */
function isToolNamed(name: string, tools: readonly string[]): boolean {
  return tools.some(tool => name === tool || (name.endsWith(tool) && /[-_./]/.test(name[name.length - tool.length - 1])));
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
  const request = createRequest({
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
    nonHumanKind: turn.nonHumanKind,
    curiosity: turn.nonUser ? { kind: 'excluded', excerpts: [] } : undefined,
  });
  state.requests.push(request);
  if (turn.compactions.length > 1) request.compactions = turn.compactions;
  if (turn.logged.credits > 0) request.aiCredits = turn.logged.credits;
  if (turn.logged.tokens > 0) request.loggedTokens = turn.logged.tokens;
  if (turn.userWaits.length || (state.requests.length === 1 && state.earlyWaits.length)) {
    request.userWaits = mergedUserWaits([...turn.userWaits, ...(state.requests.length === 1 ? state.earlyWaits : [])]);
  }
  attachTurnUsage(state, turn, request);
  mergeRequestEditLoc(state.editLocIndex, requestId, turn.editLocs);
}

/** Attach the turn's prompt-cache usage and the rows of its calls without cache data, its context and its composition
 *  (deferred until a system-prompt size is known). */
function attachTurnUsage(state: CLIParseState, turn: TurnState, request: SessionRequest): void {
  const promptCache = state.cache.takeRequest();
  if (promptCache) request.promptCache = promptCache;
  const callRowsWithoutCacheData = state.cache.takeRowsWithoutCacheData();
  if (callRowsWithoutCacheData) request.callRowsWithoutCacheData = callRowsWithoutCacheData;
  const contextUsage = state.context.take();
  if (contextUsage) request.contextUsage = contextUsage;
  if (turn.usage.calls > 0) {
    if (state.systemTokens == null) state.pendingCompositions.push({ request, usage: turn.usage });
    else attachComposition(request, turn.usage, state.systemTokens);
  }
}

function attachComposition(request: SessionRequest, usage: CliTurnUsage, systemTokens: number | null): void {
  const composition = compositionFromCliUsage(usage, systemTokens);
  if (composition) request.promptComposition = composition;
}

/** Record the latest system-prompt size and resolve turns that were waiting for one. */
function setSystemTokens(state: CLIParseState, tokens: unknown): void {
  if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens <= 0) return;
  state.systemTokens = tokens;
  for (const pending of state.pendingCompositions) attachComposition(pending.request, pending.usage, tokens);
  state.pendingCompositions = [];
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function eventTime(ev: CLIEvent): number | null {
  const ts = ev.timestamp ? Date.parse(ev.timestamp) : Number.NaN;
  return Number.isFinite(ts) ? ts : null;
}

interface OpenUserWait {
  start: number;
  kind: UserWait['kind'];
  /** The turn that asked: its index in `requests` (the turn in progress gets the next one), -1 before the first. */
  owner: number;
}

function openUserWait(state: CLIParseState, key: string, start: number | null, kind: UserWait['kind']): void {
  if (start !== null && key && !key.endsWith(':')) state.openWaits.set(key, { start, kind, owner: state.turn ? state.requests.length : -1 });
}

/** The question or permission prompt `key` was resolved at `end`. It counts as a wait on you only with evidence that
 *  you answered (`answered`, or a `human_response.recorded` event for it, which can come before or after). */
function closeUserWait(state: CLIParseState, key: string, end: number | null, answered: boolean): void {
  const open = key ? state.openWaits.get(key) : undefined;
  if (!open) return;
  state.openWaits.delete(key);
  if (end === null || end <= open.start) return;
  const wait: UserWait = { start: open.start, end, kind: open.kind };
  if (answered || state.humanResponses.has(key)) attachUserWait(state, wait, open.owner);
  else state.unconfirmedWaits.set(key, { wait, owner: open.owner });
}

function recordHumanResponse(data: Record<string, unknown>, state: CLIParseState): void {
  for (const key of [str(data.toolCallId), data.requestId ? `permission:${str(data.requestId)}` : '']) {
    if (!key) continue;
    state.humanResponses.add(key);
    const pending = state.unconfirmedWaits.get(key);
    if (pending) {
      state.unconfirmedWaits.delete(key);
      attachUserWait(state, pending.wait, pending.owner);
    }
  }
}

/** A wait goes to the turn that asked, with its own timestamps: it can end after that turn's last message, or during a
 *  later turn. One asked before the first turn goes to the first turn. */
function attachUserWait(state: CLIParseState, wait: UserWait, owner: number): void {
  if (owner >= 0 && owner === state.requests.length && state.turn) {
    state.turn.userWaits.push(wait);
  } else if (owner >= 0 && owner < state.requests.length) {
    const request = state.requests[owner];
    request.userWaits = mergedUserWaits([...(request.userWaits ?? []), wait]);
  } else {
    state.earlyWaits.push(wait);
  }
}

/** A question tool's result says you answered it: Copilot's `User selected:`/`User responded:`, or a relayed question
 *  answered in the child session or here. An interrupted or failed call is not an answer. */
function questionAnswered(data: Record<string, unknown>): boolean {
  if (data.success === false) return false;
  const result = recordValue(data.result);
  const content = str(result?.content ?? data.result).trim();
  if (/^User (selected|responded)\b/.test(content)) return true;
  if (!content.startsWith('{')) return false;
  try {
    const parsed: unknown = JSON.parse(content);
    return isRecord(parsed) && /^answered/.test(str(parsed.outcome));
  } catch {
    return false;
  }
}

/** You decided the permission: the log says so (`human_response`), or you denied it interactively. Policy decisions,
 *  and older builds that don't log who decided, aren't counted. */
function permissionDecidedByYou(data: Record<string, unknown>): boolean {
  return str(data.decisionSource) === 'human_response' || str(recordValue(data.result)?.kind) === 'denied-interactively-by-user';
}

/** The turn's waits in order, overlaps merged (a permission asked during a question counts once). */
function mergedUserWaits(waits: UserWait[]): UserWait[] {
  const merged: UserWait[] = [];
  for (const wait of [...waits].sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1);
    if (last && wait.start <= last.end) {
      if (wait.end > last.end) last.end = wait.end;
    } else {
      merged.push({ ...wait });
    }
  }
  return merged;
}

/** One model call: read it once, then feed the call timeline, the prompt-cache tracker, the turn's context
 *  and the turn's composition. Records logged before the first prompt are taken by the first turn. */
function handleUsageRecord(ev: CLIEvent, state: CLIParseState): void {
  addLoggedUsage(ev.data, state);
  const call = readCliModelCall(ev.data || {}, eventTime(ev), state.currentModelId);
  if (!call) return;
  // The limit the turn's context rule gives the call, so the timeline's limit agrees with the turn's.
  const contextLimit = state.context.addCall(call);
  const callIndex = call.stream === 'main'
    ? state.timeline.add({
      timestamp: call.timestamp,
      requestIndex: state.requests.length,
      cacheReported: call.cacheReported,
      cacheRead: call.cacheReadTokens,
      cacheWrite: call.cacheWriteTokens,
      uncached: uncachedTokens({ input: call.inputTokens, cacheRead: call.cacheReadTokens, cacheWrite: call.cacheWriteTokens }),
      promptTokens: call.inputTokens,
      contextLimit,
      outputTokens: call.outputTokens,
      reasoningTokens: call.reasoningTokens,
      truncated: call.finishReason === 'length',
    })
    : null;
  if (callIndex != null) state.mainCalls = callIndex + 1;
  state.cache.onCall(call, callIndex, state.requests.length);
  addCompositionUsage(state.turn, call);
}

/** AI credits (`copilotUsage.totalNanoAiu`) and tokens of any model call, sub-agents included, for the turn. */
function addLoggedUsage(data: Record<string, unknown> | undefined, state: CLIParseState): void {
  const usage = recordValue(data?.usage);
  if (!usage) return;
  const target = state.turn ? state.turn.logged : state.pendingUsage;
  const nano = finiteNumber(recordValue(usage.copilotUsage)?.totalNanoAiu);
  if (nano != null && nano > 0) target.credits += nano / NANO_AIU_PER_AI_CREDIT;
  const input = finiteNumber(usage.inputTokens);
  const output = finiteNumber(usage.outputTokens);
  target.tokens += Math.max(0, input ?? 0) + Math.max(0, output ?? 0);
}

/** Main-thread calls build the main context; sub-agent calls have their own. */
function addCompositionUsage(turn: TurnState | null, call: CliModelCall): void {
  if (!turn || call.stream !== 'main' || call.toolTokens == null) return;
  turn.usage.calls++;
  turn.usage.inputTokens += call.inputTokens;
  turn.usage.toolTokens += Math.max(0, call.toolTokens);
  if (call.availableTools != null && call.availableTools > turn.usage.availableTools) turn.usage.availableTools = call.availableTools;
}

/** Reads only segment names/tokens and tool totals; hashes, tool names and schemas are ignored
 *  (the prompt-cache tracker compares them in memory and keeps only which segments changed). */
function handleUsageCheckpoint(data: Record<string, unknown>, state: CLIParseState): void {
  const states = recordArrayValue(data.promptCacheBreakState);
  // A lone entry counts as the main agent only when it doesn't name its conversation: a sub-agent's
  // checkpoint must not replace the main agent's segments and tool totals or back-fill its turns.
  const main = states.find(s => s.conversation === 'main')
    ?? (states.length === 1 && states[0].conversation == null ? states[0] : undefined);
  if (!main) return;
  const models = recordValue(main.models);
  const active = str(main.lastActiveModel);
  const modelName = models && Object.prototype.hasOwnProperty.call(models, active) ? active : Object.keys(models ?? {})[0] ?? '';
  const model = models ? recordValue(models[modelName]) : undefined;
  state.cache.onCheckpoint(main, model, modelName);
  if (!model) return;
  const segments = readSystemSegments(model.system_segments);
  if (segments.length > 0) {
    state.systemSegments = segments;
    setSystemTokens(state, segments.reduce((sum, segment) => sum + segment.tokens, 0));
  }
  state.checkpointToolCount = finiteNumber(model.tool_count) ?? state.checkpointToolCount;
  state.checkpointToolTokens = finiteNumber(model.tool_tokens) ?? state.checkpointToolTokens;
}

const MAX_COMPACTION_SNAPSHOTS = 50;

function handleCompactionStart(ev: CLIEvent, state: CLIParseState): void {
  const data = ev.data || {};
  state.cache.onCompactionStart(eventTime(ev));
  setSystemTokens(state, data.systemTokens);
  const currentTokens = finiteNumber(data.currentTokens);
  const systemTokens = finiteNumber(data.systemTokens);
  const conversationTokens = finiteNumber(data.conversationTokens);
  const toolDefinitionTokens = finiteNumber(data.toolDefinitionsTokens);
  if (currentTokens == null || systemTokens == null || conversationTokens == null || toolDefinitionTokens == null) return;
  if (currentTokens <= 0 || state.compactionSnapshots.length >= MAX_COMPACTION_SNAPSHOTS) return;
  const ts = ev.timestamp ? new Date(ev.timestamp).getTime() : Number.NaN;
  const tokenLimit = finiteNumber(data.tokenLimit);
  state.compactionSnapshots.push({
    timestamp: Number.isFinite(ts) ? ts : null,
    systemTokens: Math.max(0, systemTokens),
    toolDefinitionTokens: Math.max(0, toolDefinitionTokens),
    conversationTokens: Math.max(0, conversationTokens),
    currentTokens,
    tokenLimit: tokenLimit != null && tokenLimit > 0 ? tokenLimit : null,
  });
}

function buildSessionComposition(state: CLIParseState): SessionContextComposition | undefined {
  if (state.systemSegments.length === 0 && state.compactionSnapshots.length === 0
    && state.checkpointToolCount == null && state.checkpointToolTokens == null) return undefined;
  return {
    systemSegments: state.systemSegments,
    toolCount: state.checkpointToolCount,
    toolTokens: state.checkpointToolTokens,
    compactions: state.compactionSnapshots,
  };
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
  const isFirst = state.turn === null && state.requests.length === 0;
  flushTurn(state);
  state.turn = freshTurn(
    str(ev.data?.content),
    ev.timestamp || null,
    str(ev.data?.agentMode) || 'agent',
    state.currentReasoningEffort,
  );
  state.turn.nonHumanKind = cliNonHumanKind(ev.data);
  state.turn.nonUser = state.turn.nonHumanKind !== undefined;
  state.turn.userEventId = ev.id;
  // Only the first message says who started the session: coordinators also receive relayed reports.
  if (isFirst && state.turn.nonHumanKind === 'relayed') state.relaySenderId = cliRelaySenderId(ev.data);
  state.turn.logged = state.pendingUsage;
  state.pendingUsage = { credits: 0, tokens: 0 };
  addAttachmentReferences(state.turn, ev.data?.attachments);
  const images = [
    ...imageReferencesFromAttachments(ev.data?.attachments),
    ...imageReferencesFromVariables(ev.data?.variables),
  ];
  state.turn.imageCount = images.length;
}

function handleToolExecutionStart(ev: CLIEvent, state: CLIParseState): void {
  const data = ev.data || {};
  const toolName = str(data.toolName);
  if (isToolNamed(toolName, SESSION_TOOLS) && str(data.toolCallId)) state.sessionToolCalls.add(str(data.toolCallId));
  if (isToolNamed(toolName, QUESTION_TOOLS)) openUserWait(state, str(data.toolCallId), eventTime(ev), 'question');
  const turn = state.turn;
  if (!turn) return;

  const rawArgs = data.arguments;
  const args = recordValue(rawArgs) || {};
  const ts = ev.timestamp ? new Date(ev.timestamp).getTime() : null;

  if (ts && turn.firstToolTs === null) turn.firstToolTs = ts;
  // CLI/App logs identify MCP calls by server metadata rather than a name prefix.
  // Use the MCP naming convention consumed by rules and feature analysis.
  const mcpServerName = str(data.mcpServerName);
  const recordedName = mcpServerName && toolName && !toolName.startsWith('mcp_')
    ? `mcp_${mcpServerName}_${toolName}`
    : toolName;
  // The assistant request may have recorded the raw name before server metadata arrived.
  if (recordedName !== toolName) turn.toolNames.delete(toolName);
  addRecordedTools(turn, recordedName, data.arguments);
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

/** A session-starting tool call finished: the session its result names is one this one started. */
function recordStartedSessions(data: Record<string, unknown>, state: CLIParseState): void {
  const toolCallId = str(data.toolCallId);
  if (!toolCallId || !state.sessionToolCalls.delete(toolCallId) || data.success === false) return;
  const id = startedSessionId(data.result, 0)?.toLowerCase();
  if (id && id !== state.sessionId.toLowerCase()) state.childSessionIds.add(id);
}

/** The started session's ID: a `session_id`/`sessionId` field, else the link or labelled ID in the result text. Any
 *  other UUID in the result (a project, the session name) is ignored. */
function startedSessionId(value: unknown, depth: number): string | undefined {
  const uuid = new RegExp(`^${UUID}$`, 'i');
  if (typeof value === 'string') {
    const text = value.trim();
    if (text.startsWith('{') && depth < 3) {
      try {
        const id = startedSessionId(JSON.parse(text), depth + 1);
        if (id) return id;
      } catch { /* plain text */ }
    }
    // Session names are quoted; never read an ID out of one.
    const unquoted = text.replaceAll(/'[^'\n]*'|"[^"\n]*"/g, "''");
    for (const pattern of STARTED_SESSION_PATTERNS) {
      const match = pattern.exec(unquoted);
      if (match) return match[1];
    }
    return undefined;
  }
  if (!isRecord(value) || depth > 3) return undefined;
  for (const key of ['session_id', 'sessionId']) {
    if (typeof value[key] === 'string' && uuid.test(value[key])) return value[key];
  }
  for (const key of ['content', 'text', 'result']) {
    const id = startedSessionId(value[key], depth + 1);
    if (id) return id;
  }
  return undefined;
}

function handleToolExecutionComplete(ev: CLIEvent, state: CLIParseState): void {
  const data = ev.data || {};
  recordStartedSessions(data, state);
  const toolCallId = str(data.toolCallId);
  closeUserWait(state, toolCallId, eventTime(ev), questionAnswered(data));
  const turn = state.turn;
  if (!turn) return;
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

function handleCompactionComplete(data: Record<string, unknown>, state: CLIParseState, at: number | null): void {
  state.cache.onCompactionComplete(data, at);
  setSystemTokens(state, data.systemTokens);
  const event = readCliCompaction(data);
  state.context.addLimit(event.tokenLimit, cacheModelName(state.currentModelId));
  const turn = state.turn;
  if (!turn) return;
  if (state.mainCalls > 0) event.atCall = state.mainCalls;
  addTurnCompaction(turn.compactions, event);
  turn.compaction ??= event;
}

function tokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Billed tokens per type from a model's `tokenDetails` (`input`, `cache_read`, `cache_write` and `output`, each
 *  `{ tokenCount }`). They cover every billed call of the model, compaction summaries included, and `input` is
 *  the uncached part. `null` unless all four are logged, so the totals never mix the two scopes. */
function billedTokens(details: unknown): Pick<ModelUsage, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'> | null {
  const record = recordValue(details);
  if (!record) return null;
  const countOf = (type: string): number | null => tokenCount(recordValue(record[type])?.tokenCount);
  const inputTokens = countOf('input');
  const cacheReadTokens = countOf('cache_read');
  const cacheWriteTokens = countOf('cache_write');
  const outputTokens = countOf('output');
  if (inputTokens == null || cacheReadTokens == null || cacheWriteTokens == null || outputTokens == null) return null;
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
}

/** Token totals of one model from `session.shutdown.modelMetrics`, with `inputTokens` uncached like every other
 *  `ModelUsage`. `usage.inputTokens` counts the tokens read from and written to the cache too, so without
 *  `tokenDetails` the cached tokens are subtracted (unless it's below them, as it would be if a build reported
 *  them separately). */
function shutdownTokens(info: Record<string, unknown>): Omit<ModelUsage, 'reasoningTokens'> {
  const billed = billedTokens(info.tokenDetails);
  if (billed) return billed;
  const usage = recordValue(info.usage) || {};
  const input = tokenCount(usage.inputTokens) ?? 0;
  const cacheReadTokens = tokenCount(usage.cacheReadTokens) ?? 0;
  const cacheWriteTokens = tokenCount(usage.cacheWriteTokens) ?? 0;
  const cached = cacheReadTokens + cacheWriteTokens;
  return {
    inputTokens: input >= cached ? input - cached : input,
    outputTokens: tokenCount(usage.outputTokens) ?? 0,
    cacheReadTokens,
    cacheWriteTokens,
  };
}

function addModelUsage(collected: Record<string, ModelUsage>, rawModel: string, info: unknown): void {
  const infoRecord = recordValue(info);
  if (!infoRecord) return;

  const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = shutdownTokens(infoRecord);
  const reasoningTokens = tokenCount(recordValue(infoRecord.usage)?.reasoningTokens) ?? 0;
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
  // Only the system size is used: shutdown toolDefinitionsTokens disagrees with per-call tool tokens.
  setSystemTokens(state, data.systemTokens);
  const modelMetrics = recordValue(data.modelMetrics) || {};
  const collected: Record<string, ModelUsage> = {};
  for (const [rawModel, info] of Object.entries(modelMetrics)) {
    addModelUsage(collected, rawModel, info);
  }
  if (Object.keys(collected).length > 0) state.modelUsage = collected;
}

/* Context-composition and prompt-cache events. A Map (not an object) because event types come from the file. */
const CONTEXT_EVENT_HANDLERS = new Map<string, (ev: CLIEvent, state: CLIParseState) => void>([
  ['session.usage_record', handleUsageRecord],
  ['session.usage_checkpoint', (ev, state) => handleUsageCheckpoint(ev.data || {}, state)],
  ['session.compaction_start', handleCompactionStart],
  ['session.mode_changed', (_ev, state) => state.cache.onSignal('mode-change')],
  ['session.resume', (_ev, state) => state.cache.onSignal('resume')],
]);

function handleCliEvent(ev: CLIEvent, state: CLIParseState, wsId: string): void {
  const contextHandler = CONTEXT_EVENT_HANDLERS.get(ev.type);
  if (contextHandler) {
    contextHandler(ev, state);
    return;
  }
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
      handleToolExecutionComplete(ev, state);
      return;
    case 'permission.requested':
      openUserWait(state, `permission:${str(ev.data?.requestId)}`, eventTime(ev), 'permission');
      return;
    case 'permission.completed':
      closeUserWait(state, `permission:${str(ev.data?.requestId)}`, eventTime(ev), permissionDecidedByYou(ev.data || {}));
      return;
    case 'human_response.recorded':
      recordHumanResponse(ev.data || {}, state);
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
      handleCompactionComplete(ev.data || {}, state, eventTime(ev));
      return;
    case 'subagent.started':
      state.subagents.start(ev.data || {}, state.turn ? state.requests.length : null);
      return;
    case 'subagent.completed':
      state.subagents.complete(ev.data || {}, state.turn ? state.requests.length : null);
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
    systemTokens: null,
    pendingCompositions: [],
    systemSegments: [],
    checkpointToolCount: null,
    checkpointToolTokens: null,
    compactionSnapshots: [],
    timeline: new CallTimelineBuilder(),
    cache: new CliCacheTracker(),
    subagents: new SubagentRunTracker(),
    context: new TurnContextAccumulator(),
    mainCalls: 0,
    sessionToolCalls: new Set(),
    childSessionIds: new Set(),
    pendingUsage: { credits: 0, tokens: 0 },
    openWaits: new Map(),
    unconfirmedWaits: new Map(),
    humanResponses: new Set(),
    earlyWaits: [],
  };
}

function finalizeCliSession(
  state: CLIParseState,
  wsId: string,
  wsName: string,
  customInstructionsBytes?: number,
  sessionDir?: string,
): Session | null {
  flushTurn(state);
  // No system-prompt size was ever recorded: keep the non-tool remainder unattributed.
  for (const pending of state.pendingCompositions) attachComposition(pending.request, pending.usage, null);
  state.pendingCompositions = [];
  state.subagents.attach(state.requests);

  if (state.requests.length === 0) return null;

  const creationDate = state.startTime ? new Date(state.startTime).getTime() : null;
  const contextComposition = buildSessionComposition(state);
  const callTimeline = state.timeline.build();
  const promptCache = state.cache.finish();
  return createSession({
    sessionId: state.sessionId,
    workspaceId: wsId,
    workspaceName: wsName,
    location: 'cli',
    harness: harnessName(state),
    ...(creationDate === null ? {} : { creationDate }),
    requests: state.requests,
    modelUsage: state.modelUsage,
    ...(contextComposition ? { contextComposition } : {}),
    ...(callTimeline ? { callTimeline } : {}),
    ...(promptCache ? { promptCache } : {}),
    endReason: state.sawShutdown ? 'shutdown' : 'active',
    customInstructionsBytes,
    hasDevcontainer: detectDevcontainerFromRequests(state.requests),
    workspaceRootPath: state.workspaceRootPath,
    ...(sessionDir ? readCliWorkspaceMeta(sessionDir) : {}),
    ...(state.childSessionIds.size > 0 ? { childSessionIds: [...state.childSessionIds] } : {}),
    ...(state.relaySenderId && state.relaySenderId !== state.sessionId.toLowerCase() ? { relaySenderId: state.relaySenderId } : {}),
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

  return finalizeCliSession(state, wsId, wsName, customInstructionsBytes, path.dirname(eventsPath));
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

  return finalizeCliSession(state, wsId, wsName, customInstructionsBytes, path.dirname(eventsPath));
}
