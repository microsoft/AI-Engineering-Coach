/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* GitHub Copilot Chat "transcript" parsing for VS Code session discovery.
 *
 * Newer VS Code / Copilot Chat builds no longer persist `chatSessions/*.json`. Instead each
 * chat session is written as `GitHub.copilot-chat/transcripts/<sessionId>.jsonl`, one JSON
 * event per line: `session.start`, `user.message`, `assistant.message`,
 * `tool.execution_start`/`tool.execution_complete`, `assistant.turn_start`/`turn_end`.
 *
 * The event envelope matches the Copilot CLI's `events.jsonl` schema (see
 * parser-vscode-cli.ts), but tool-call arguments use VS Code's built-in tool names and argument
 * shapes (`filePath`, `oldString`/`newString`, `content`, ...) rather than the CLI's snake_case
 * ones, so this gets its own turn accumulator instead of reusing the CLI parser.
 *
 * There is no `workspace.json` sidecar for these workspaceStorage entries (that mechanism was
 * dropped along with `chatSessions`), so the workspace root is derived from the absolute file
 * paths touched by edit tool calls in the transcript itself.
 */

import { Session, SessionRequest } from './types';
import { createRequest, createSession, detectDevcontainerFromRequests, recordFailedFile } from './parser-shared';
import { forEachJsonlLine } from './parser-vscode-files';
import { EditLocIndex } from './edit-loc-diff';
import {
  FileEditLocMap,
  mergeFileEditLoc,
  mergeRequestEditLoc,
  recordContentReplacement,
  recordCreatedContent,
} from './edit-tool-diff';

interface TranscriptEvent {
  type: string;
  data?: Record<string, unknown>;
  timestamp?: string;
  id?: string;
}

/** Accumulated state for a single user turn (user.message → next user.message). */
interface TurnState {
  userMsg: string;
  userTs: string | null;
  responseChunks: string[];
  toolNames: Set<string>;
  editedFiles: Set<string>;
  referencedFiles: Set<string>;
  lastAssistantTs: string | null;
  lastAssistantId: string | null;
  editLocs: FileEditLocMap;
  pendingToolEdits: Map<string, PendingToolEdit>;
}

interface PendingToolEdit {
  editLocs: FileEditLocMap;
  editedFiles: Set<string>;
}

interface TranscriptParseState {
  sessionId: string;
  startTime: string | null;
  requests: SessionRequest[];
  turn: TurnState | null;
  editLocIndex?: EditLocIndex;
  /** Absolute paths edited during the session, used to derive `workspaceRootPath`. */
  editedPaths: string[];
  /** Absolute paths merely read/referenced; used as a fallback when nothing was edited. */
  referencedPaths: string[];
}

function freshTurn(userMsg: string, userTs: string | null): TurnState {
  return {
    userMsg,
    userTs,
    responseChunks: [],
    toolNames: new Set(),
    editedFiles: new Set(),
    referencedFiles: new Set(),
    lastAssistantTs: null,
    lastAssistantId: null,
    editLocs: new Map(),
    pendingToolEdits: new Map(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function recordArrayValue(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord);
}

function parseTranscriptEventLine(line: string): TranscriptEvent | null {
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

/** Built-in tools that edit file content directly (vs. merely reading/searching). */
const FILE_EDIT_TOOLS = new Set(['create_file', 'replace_string_in_file', 'edit_notebook_file']);

function applyEdit(pending: PendingToolEdit, filePath: string, args: Record<string, unknown>, toolName: string): void {
  pending.editedFiles.add(filePath);
  if (toolName === 'create_file') {
    const content = str(args.content);
    if (content) recordCreatedContent(pending.editLocs, filePath, content);
  } else if (toolName === 'replace_string_in_file') {
    const oldString = str(args.oldString);
    const newString = str(args.newString);
    if (oldString || newString) recordContentReplacement(pending.editLocs, filePath, oldString, newString);
  }
}

/** Extracts edited/referenced file paths from a tool call's arguments, by known tool name where
 *  possible and falling back to a generic `filePath` lookup so unrecognized/future built-in
 *  tools still contribute file references instead of being silently dropped. */
function extractToolFilePaths(toolName: string, args: Record<string, unknown>, pending: PendingToolEdit, turn: TurnState): void {
  if (toolName === 'multi_replace_string_in_file') {
    for (const replacement of recordArrayValue(args.replacements)) {
      const filePath = str(replacement.filePath);
      if (filePath) applyEdit(pending, filePath, replacement, 'replace_string_in_file');
    }
    return;
  }
  const filePath = str(args.filePath);
  if (!filePath) return;
  if (FILE_EDIT_TOOLS.has(toolName)) {
    applyEdit(pending, filePath, args, toolName);
  } else {
    // Read/search tools (read_file, list_dir, ...) and any unrecognized future built-in tool
    // with a `filePath` argument are treated as references — better to under-attribute (no LOC
    // delta) than to silently drop the file entirely.
    turn.referencedFiles.add(filePath);
  }
}

function commitToolEdit(turn: TurnState, edit: PendingToolEdit): void {
  mergeFileEditLoc(turn.editLocs, edit.editLocs);
  for (const file of edit.editedFiles) turn.editedFiles.add(file);
}

function flushTurn(state: TranscriptParseState): void {
  const turn = state.turn;
  state.turn = null;
  if (!turn || (turn.responseChunks.length === 0 && turn.toolNames.size === 0)) return;
  turn.pendingToolEdits.clear();

  const msgTs = turn.userTs ? new Date(turn.userTs).getTime() : null;
  const respTs = turn.lastAssistantTs ? new Date(turn.lastAssistantTs).getTime() : null;
  const responseText = turn.responseChunks.filter(Boolean).join('\n\n');
  const requestId = turn.lastAssistantId || `${state.sessionId}:vscode-transcript:${state.requests.length}`;

  state.requests.push(createRequest({
    requestId,
    timestamp: msgTs,
    messageText: turn.userMsg,
    responseText,
    agentMode: 'agent',
    toolsUsed: [...turn.toolNames],
    editedFiles: [...turn.editedFiles],
    referencedFiles: [...turn.referencedFiles],
    totalElapsed: msgTs && respTs ? respTs - msgTs : null,
    // This transcript format never records token usage — a known, permanent parser-coverage
    // gap (see SessionRequest.endState doc), not a transient in-progress state.
    endState: 'no-data',
  }));
  mergeRequestEditLoc(state.editLocIndex, requestId, turn.editLocs);

  for (const file of turn.editedFiles) state.editedPaths.push(file);
  for (const file of turn.referencedFiles) state.referencedPaths.push(file);
}

function addAttachmentReferences(turn: TurnState, attachments: unknown): void {
  for (const attachment of recordArrayValue(attachments)) {
    const filePath = attachment.path;
    if (typeof filePath === 'string') turn.referencedFiles.add(filePath);
  }
}

function handleSessionStart(ev: TranscriptEvent, state: TranscriptParseState): void {
  const data = ev.data || {};
  state.sessionId = str(data.sessionId) || state.sessionId;
  state.startTime = str(data.startTime) || ev.timestamp || null;
}

function handleUserMessage(ev: TranscriptEvent, state: TranscriptParseState): void {
  flushTurn(state);
  state.turn = freshTurn(str(ev.data?.content), ev.timestamp || null);
  addAttachmentReferences(state.turn, ev.data?.attachments);
}

function handleToolExecutionStart(ev: TranscriptEvent, state: TranscriptParseState): void {
  const turn = state.turn;
  if (!turn) return;

  const data = ev.data || {};
  const toolName = str(data.toolName);
  const args = recordValue(data.arguments) || {};

  if (toolName) turn.toolNames.add(toolName);

  const pending: PendingToolEdit = { editLocs: new Map(), editedFiles: new Set() };
  extractToolFilePaths(toolName, args, pending, turn);

  if (pending.editedFiles.size > 0) {
    const toolCallId = str(data.toolCallId);
    if (toolCallId) turn.pendingToolEdits.set(toolCallId, pending);
    else commitToolEdit(turn, pending);
  }
}

function handleToolExecutionComplete(ev: TranscriptEvent, state: TranscriptParseState): void {
  const turn = state.turn;
  if (!turn) return;
  const data = ev.data || {};
  const toolCallId = str(data.toolCallId);
  const pending = toolCallId ? turn.pendingToolEdits.get(toolCallId) : undefined;
  if (pending) {
    if (data.success !== false) commitToolEdit(turn, pending);
    turn.pendingToolEdits.delete(toolCallId);
  }
}

function handleAssistantMessage(ev: TranscriptEvent, state: TranscriptParseState): void {
  const turn = state.turn;
  if (!turn) return;
  const data = ev.data || {};
  const content = str(data.content);
  if (content) turn.responseChunks.push(content);
  turn.lastAssistantTs = ev.timestamp || turn.lastAssistantTs;
  turn.lastAssistantId = str(ev.id) || turn.lastAssistantId;

  for (const request of recordArrayValue(data.toolRequests)) {
    const toolName = str(request.toolName) || str(request.name);
    if (toolName) turn.toolNames.add(toolName);
  }
}

function handleTranscriptEvent(ev: TranscriptEvent, state: TranscriptParseState): void {
  switch (ev.type) {
    case 'session.start':
      handleSessionStart(ev, state);
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
    case 'assistant.message':
      handleAssistantMessage(ev, state);
      return;
  }
}

/** Minimum number of non-empty path segments a derived workspace root must have, so we never
 *  fall back to an overly broad root like `/home/alice` or `/`. */
const MIN_WORKSPACE_ROOT_SEGMENTS = 3;

function commonDirPrefix(paths: string[]): string | null {
  if (paths.length === 0) return null;
  const segmentLists = paths.map(p => p.replaceAll('\\', '/').split('/').slice(0, -1));
  let common = segmentLists[0];
  for (const segments of segmentLists.slice(1)) {
    let i = 0;
    while (i < common.length && i < segments.length && common[i] === segments[i]) i++;
    common = common.slice(0, i);
    if (common.length === 0) break;
  }
  const nonEmpty = common.filter(Boolean).length;
  if (nonEmpty < MIN_WORKSPACE_ROOT_SEGMENTS) return null;
  return common.join('/');
}

/** Derives a workspace root from touched file paths: edits are a stronger signal than reads
 *  (read-only exploration, e.g. a subagent, may span unrelated repos in the same session). */
function deriveWorkspaceRootPath(state: TranscriptParseState): string | undefined {
  return commonDirPrefix(state.editedPaths) ?? commonDirPrefix(state.referencedPaths) ?? undefined;
}

function finalizeSession(
  state: TranscriptParseState,
  wsId: string,
  wsName: string,
  harness: string,
  customInstructionsBytes?: number,
): Session | null {
  flushTurn(state);
  if (state.requests.length === 0) return null;

  const creationDate = state.startTime ? new Date(state.startTime).getTime() : null;
  return createSession({
    sessionId: state.sessionId,
    workspaceId: wsId,
    workspaceName: wsName,
    location: 'panel',
    harness,
    creationDate: creationDate ?? undefined,
    requests: state.requests,
    // No shutdown/close event exists in this format, and token usage is never recorded — treat
    // as a genuine, permanent parser-coverage gap rather than guessing "active" or "aborted".
    endReason: 'unknown',
    customInstructionsBytes,
    hasDevcontainer: detectDevcontainerFromRequests(state.requests),
    workspaceRootPath: deriveWorkspaceRootPath(state),
  });
}

export function parseTranscriptFile(
  transcriptPath: string,
  wsId: string,
  wsName: string,
  harness: string,
  customInstructionsBytes?: number,
  editLocIndex?: EditLocIndex,
): Session | null {
  const state: TranscriptParseState = {
    sessionId: wsId,
    startTime: null,
    requests: [],
    turn: null,
    editLocIndex,
    editedPaths: [],
    referencedPaths: [],
  };

  let sawAnyEvent = false;
  try {
    forEachJsonlLine(transcriptPath, (line) => {
      if (!line.trim()) return;
      const event = parseTranscriptEventLine(line);
      if (event) {
        handleTranscriptEvent(event, state);
        sawAnyEvent = true;
      }
    });
  } catch (e) {
    recordFailedFile('parser-vscode-transcripts', transcriptPath, e);
    return null;
  }

  if (!sawAnyEvent) return null;
  return finalizeSession(state, wsId, wsName, harness, customInstructionsBytes);
}
