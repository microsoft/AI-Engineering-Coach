/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* OpenCode session parser
 *
 * V1 JSON layout (macOS):
 *   ~/.local/share/opencode/storage/session/global/<session-id>.json   -- session metadata
 *   ~/.local/share/opencode/storage/message/<session-id>/<msg-id>.json -- message metadata
 *   ~/.local/share/opencode/storage/part/<msg-id>/<part-id>.json       -- content parts (text, tool, step-start/finish)
 * SQLite: opencode.db (and channel-specific databases) stores V1 session/message/part
 * tables or V2 session_v2/session_message tables with inline content. Both can coexist.
 *
 * Sessions have: id, slug, version, projectID, directory, title, time.created/updated
 * Messages have: id, sessionID, role (user|assistant), time, agent, model {providerID, modelID}, tokens, cost
 * Parts have: id, sessionID, messageID, type (text|tool|step-start|step-finish), text, tool, callID, state, tokens, cost
 */

import * as fs from 'fs';
import * as path from 'path';
import { Session, SessionRequest } from './types';
import { assertTrustedPath, createRequest, createSession, detectDevcontainerFromRequests } from './parser-shared';
import { canonicalizeReasoningEffort, extractReasoningEffortFromModelId } from './helpers';
import { warnCore } from './log';
import { EditLocIndex } from './edit-loc-diff';
import {
  addFileEditLoc,
  FileEditLocMap,
  mergeFileEditLoc,
  mergeRequestEditLoc,
  parseApplyPatch,
  recordContentReplacement,
  recordCreatedContent,
} from './edit-tool-diff';
import { recordedInvestigation, recordedWebDomains } from './curiosity-activity';
import { imageReferencesFromContent, type ImageReference } from './image-data';
import type { SessionSource } from './cache';

interface OcSession {
  id: string;
  slug?: string;
  version?: string;
  projectID?: string;
  directory?: string;
  title?: string;
  time?: { created?: number; updated?: number };
}

interface OcMessage {
  id: string;
  sessionID: string;
  role: string;
  time?: { created?: number; completed?: number };
  parentID?: string;
  modelID?: string;
  providerID?: string;
  mode?: string;
  agent?: string;
  cost?: number;
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } };
  finish?: string;
  summary?: { title?: string; diffs?: OcFileDiff[] };
  variant?: string;
  model?: { providerID?: string; modelID?: string };
  seq?: number;
  text?: string;
  files?: unknown[];
  content?: unknown[];
}

interface OcFileDiff {
  file?: string;
  path?: string;
  patch?: string;
  additions?: number;
  deletions?: number;
}

interface OcPart {
  id: string;
  sessionID: string;
  messageID: string;
  type: string;
  text?: string;
  mime?: string;
  url?: string;
  data?: unknown;
  tool?: string;
  callID?: string;
  state?: { status?: string; input?: Record<string, unknown>; output?: string };
  tokens?: { input?: number; output?: number; reasoning?: number };
  cost?: number;
  reason?: string;
  fileDiffs?: OcFileDiff[];
}

interface OpenCodeAssistantData {
  responseText: string;
  toolsUsed: string[];
  editedFiles: string[];
  referencedFiles: string[];
  modelId: string;
  agent: string;
  variant?: string;
  totalElapsed: number | null;
  lastTs: number | null;
  tokenSource: OcMessage['tokens'] | null;
  editLocs: FileEditLocMap;
  answerEvidence: SessionRequest['answerEvidence'];
  investigationDelegations: ('research' | 'explore')[];
  webDomains: string[];
}

const WRITE_TOOLS = new Set(['write', 'edit', 'create', 'patch', 'apply_patch']);
const READ_TOOLS = new Set(['read', 'glob', 'grep', 'ls', 'find']);

/** The subset of `node:sqlite` this parser uses, so the module stays optional at build time. */
interface SqliteDatabase {
  prepare(sql: string): {
    all(...parameters: string[]): unknown[];
    iterate(...parameters: string[]): Iterable<unknown>;
  };
  close(): void;
}

interface SqliteModule {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteDatabase;
}

let sqliteModule: SqliteModule | null | undefined;

/**
 * `node:sqlite` only exists on Node >= 22.5 (unflagged from 22.13) and is absent from some
 * Electron builds. It is loaded lazily so an unavailable module degrades to "no OpenCode
 * database support" instead of throwing while the parser bundle is being loaded, which would
 * take down every harness.
 */
function loadSqlite(): SqliteModule | null {
  if (sqliteModule !== undefined) return sqliteModule;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    sqliteModule = require('node:sqlite') as SqliteModule;
  } catch (e) {
    sqliteModule = null;
    warnCore('parser-opencode', 'node:sqlite unavailable; skipping OpenCode database sources', e);
  }
  return sqliteModule;
}

export function findOpenCodeDirs(): string[] {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const bases = new Set<string>();
  if (process.env.XDG_DATA_HOME) bases.add(path.join(process.env.XDG_DATA_HOME, 'opencode'));
  if (home) {
    bases.add(path.join(home, '.local', 'share', 'opencode'));
    bases.add(path.join(home, 'Library', 'Application Support', 'opencode'));
  }
  if (process.env.LOCALAPPDATA) bases.add(path.join(process.env.LOCALAPPDATA, 'opencode'));

  const sources: string[] = [];
  for (const base of bases) {
    let databases: string[] = [];
    try {
      databases = fs.readdirSync(base, { withFileTypes: true })
        .filter(entry => entry.isFile() && /^opencode(?:-[A-Za-z0-9._-]+)?\.db$/.test(entry.name))
        .map(entry => path.join(base, entry.name));
    } catch {
      // Missing data roots are expected for users who have not run OpenCode.
    }
    if (databases.length > 0 && loadSqlite()) {
      sources.push(...databases);
      continue;
    }
    const legacy = path.join(base, 'storage');
    if (fs.existsSync(legacy)) sources.push(legacy);
  }
  return sources;
}

function readJsonSafe<T>(filePath: string): T | null {
  try {
    assertTrustedPath(filePath);
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function readAllJsonInDir<T>(dir: string): T[] {
  const results: T[] = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.json')) continue;
      const data = readJsonSafe<T>(path.join(dir, e.name));
      if (data) results.push(data);
    }
  } catch {
    /* skip unreadable dirs */
  }
  return results;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function projectNameFromDir(directory: string): string {
  return directory.replaceAll('\\', '/').replace(/\/+$/, '').split('/').pop() || 'unknown';
}

function getOpenCodeUserText(msg: OcMessage, partsByMsg: Map<string, OcPart[]>): string {
  const userParts = partsByMsg.get(msg.id) || [];
  const userTextFromParts = userParts
    .filter(part => part.type === 'text' && part.text)
    .map(part => part.text!)
    .join('\n');
  return userTextFromParts || msg.summary?.title || '';
}

function findAssistantMessages(messages: OcMessage[], startIndex: number): OcMessage[] {
  const result: OcMessage[] = [];
  for (let i = startIndex; i < messages.length; i++) {
    const candidate = messages[i];
    if (candidate.role === 'user') break;
    if (candidate.role === 'assistant') result.push(candidate);
  }
  return result;
}

function applyOpenCodePart(
  part: OcPart,
  data: Pick<OpenCodeAssistantData, 'toolsUsed' | 'editedFiles' | 'referencedFiles' | 'editLocs' | 'investigationDelegations' | 'webDomains'>,
  textParts: string[],
): void {
  if (part.type === 'text' && part.text) {
    textParts.push(part.text);
    return;
  }

  if (part.type !== 'tool' || !part.tool) return;

  data.toolsUsed.push(part.tool);
  const input = part.state?.input || {};
  data.webDomains.push(...recordedWebDomains(part.tool, input));
  const role = recordedInvestigation(part.tool, input);
  if (role && !data.investigationDelegations.includes(role)) data.investigationDelegations.push(role);
  const toolLower = part.tool.toLowerCase();
  const toolSucceeded = part.state?.status === undefined || part.state.status === 'completed';
  if (!toolSucceeded && WRITE_TOOLS.has(toolLower)) return;
  const recordedLocs: FileEditLocMap = new Map();
  if (WRITE_TOOLS.has(toolLower)) {
    for (const diff of part.fileDiffs ?? []) {
      if (diff.file && typeof diff.additions === 'number' && typeof diff.deletions === 'number') {
        addFileEditLoc(recordedLocs, diff.file, diff.additions, diff.deletions);
      }
    }
    mergeFileEditLoc(data.editLocs, recordedLocs);
    data.editedFiles.push(...recordedLocs.keys());
  }
  if ((toolLower === 'patch' || toolLower === 'apply_patch') && recordedLocs.size === 0) {
    const patch = typeof input.patchText === 'string' ? input.patchText
      : typeof input.patch === 'string' ? input.patch
        : typeof input.input === 'string' ? input.input
          : '';
    const patchEdits = parseApplyPatch(patch);
    mergeFileEditLoc(data.editLocs, patchEdits);
    for (const file of patchEdits.keys()) data.editedFiles.push(file);
  }
  const filePath = typeof input.filePath === 'string'
    ? input.filePath
    : typeof input.file_path === 'string'
      ? input.file_path
      : typeof input.path === 'string'
        ? input.path
        : null;
  if (!filePath) return;

  if (WRITE_TOOLS.has(toolLower)) {
    data.editedFiles.push(filePath);
    const previous = typeof input.oldString === 'string' ? input.oldString
      : typeof input.old_string === 'string' ? input.old_string
        : typeof input.old_str === 'string' ? input.old_str
          : '';
    const next = typeof input.newString === 'string' ? input.newString
      : typeof input.new_string === 'string' ? input.new_string
        : typeof input.new_str === 'string' ? input.new_str
          : '';
    // Recorded diffs capture replace-all and overwrite behavior that inputs alone cannot.
    if (!recordedLocs.has(filePath) && (previous || next)) {
      recordContentReplacement(data.editLocs, filePath, previous, next);
    } else if (!recordedLocs.has(filePath)) {
      const written = typeof input.content === 'string' ? input.content
        : typeof input.code === 'string' ? input.code
          : '';
      if (written && toolLower !== 'patch' && toolLower !== 'apply_patch') {
        recordCreatedContent(data.editLocs, filePath, written);
      }
    }
    // Include generated code content so extractCodeBlocks() can detect AI-produced code.
    // Write tools store the code in various input fields; also check state.output.
    const content = typeof input.content === 'string' ? input.content
      : typeof input.code === 'string' ? input.code
        : typeof input.newString === 'string' ? input.newString
          : typeof input.new_string === 'string' ? input.new_string
            : typeof part.state?.output === 'string' ? part.state.output
              : null;
    if (content) {
      const ext = filePath.split('.').pop() || 'unknown';
      textParts.push(`\n\`\`\`${ext}\n${content}\n\`\`\`\n`);
    }
  } else if (READ_TOOLS.has(toolLower)) {
    data.referencedFiles.push(filePath);
  }
}

function collectAssistantData(
  assistantMessages: OcMessage[],
  partsByMsg: Map<string, OcPart[]>,
  userTs: number | null,
  lastTs: number | null,
): OpenCodeAssistantData {
  const data: OpenCodeAssistantData = {
    responseText: '',
    toolsUsed: [],
    editedFiles: [],
    referencedFiles: [],
    modelId: '',
    agent: '',
    totalElapsed: null,
    lastTs,
    tokenSource: null,
    editLocs: new Map(),
    answerEvidence: 'missing',
    investigationDelegations: [],
    webDomains: [],
  };
  const assistantMsg = assistantMessages[0];
  if (!assistantMsg) return data;

  const textParts: string[] = [];
  for (const message of assistantMessages) {
    const assistantTs = message.time?.completed || message.time?.created || null;
    if (assistantTs && (!data.lastTs || assistantTs > data.lastTs)) data.lastTs = assistantTs;
    // Multi-round turn: totalElapsed measures from the user message to the *last*
    // assistant message, yielding a more accurate total turn duration.
    if (userTs && assistantTs) data.totalElapsed = assistantTs - userTs;
    data.modelId = message.modelID || data.modelId;
    data.agent = message.agent || data.agent;
    data.variant = message.variant ?? data.variant;
    if (message.tokens) {
      // Context uses the last recorded round; generated output accumulates across rounds.
      data.tokenSource = { ...message.tokens, output: (data.tokenSource?.output ?? 0) + (message.tokens.output ?? 0) };
    }
    const parts = partsByMsg.get(message.id) || [];
    const hasText = parts.some(part => part.type === 'text' && part.text?.trim());
    data.answerEvidence = hasText && (message.finish === 'stop' || message.finish === 'end_turn') ? 'final'
      : hasText && !message.finish && !parts.some(part => part.type === 'tool') ? 'legacy' : 'missing';
    for (const part of parts) applyOpenCodePart(part, data, textParts);
  }
  data.responseText = textParts.join('\n');

  return data;
}

function indexPartsByMessage(rawMessages: OcMessage[], storageDir: string): Map<string, OcPart[]> {
  const partsByMsg = new Map<string, OcPart[]>();
  for (const msg of rawMessages) {
    const partDir = path.join(storageDir, 'part', msg.id);
    const parts = readAllJsonInDir<OcPart>(partDir);
    if (parts.length > 0) partsByMsg.set(msg.id, parts);
  }
  return partsByMsg;
}

function getOpenCodeWorkspace(rawSession: OcSession): { wsId: string; wsName: string } {
  return {
    wsId: `opencode-${rawSession.id}`,
    wsName: rawSession.directory
      ? projectNameFromDir(rawSession.directory)
      : rawSession.title || rawSession.slug || 'unknown',
  };
}

function buildOpenCodeRequest(
  msg: OcMessage,
  partsByMsg: Map<string, OcPart[]>,
  assistantData: OpenCodeAssistantData,
  userTs: number | null,
  editLocIndex?: EditLocIndex,
): SessionRequest {
  const cacheRead = assistantData.tokenSource?.cache?.read ?? 0;
  const cacheWrite = assistantData.tokenSource?.cache?.write ?? 0;
  const hasTokenData = assistantData.tokenSource != null;
  const hasSummaryDiffs = Array.isArray(msg.summary?.diffs);
  const summaryLocs: FileEditLocMap = new Map();
  for (const diff of msg.summary?.diffs ?? []) {
    const file = diff.file || diff.path || '';
    if (file && typeof diff.additions === 'number' && typeof diff.deletions === 'number') {
      addFileEditLoc(summaryLocs, file, diff.additions, diff.deletions);
    } else if (typeof diff.patch === 'string') {
      mergeFileEditLoc(summaryLocs, parseApplyPatch(diff.patch));
    }
  }
  const exactLocs = hasSummaryDiffs ? summaryLocs : assistantData.editLocs;
  const imageCount = imageReferencesFromContent(partsByMsg.get(msg.id)).length;
  mergeRequestEditLoc(editLocIndex, msg.id, exactLocs, hasSummaryDiffs);

  return createRequest({
    requestId: msg.id,
    userEventId: msg.id,
    answerEvidence: assistantData.answerEvidence,
    timestamp: userTs,
    messageText: getOpenCodeUserText(msg, partsByMsg),
    variableKinds: imageCount > 0 ? { image: imageCount } : {},
    responseText: assistantData.responseText,
    agentName: msg.agent || assistantData.agent || 'OpenCode',
    agentMode: msg.agent || assistantData.agent || 'build',
    modelId: assistantData.modelId,
    toolsUsed: assistantData.toolsUsed,
    investigationDelegations: assistantData.investigationDelegations,
    webDomains: [...new Set(assistantData.webDomains)],
    editedFiles: hasSummaryDiffs
      ? [...exactLocs.keys()]
      : [...new Set([...assistantData.editedFiles, ...exactLocs.keys()])],
    referencedFiles: [...new Set(assistantData.referencedFiles)],
    totalElapsed: assistantData.totalElapsed,
    // promptTokens = total input context (uncached input + cache read + cache write)
    // so that context-window analysis sees the full context. Cached portions
    // are tracked separately for billing.
    promptTokens: hasTokenData ? (assistantData.tokenSource?.input ?? 0) + cacheRead + cacheWrite : null,
    completionTokens: hasTokenData ? (assistantData.tokenSource?.output ?? 0) : null,
    cacheReadTokens: cacheRead > 0 ? cacheRead : null,
    cacheWriteTokens: cacheWrite > 0 ? cacheWrite : null,
    // V1 stores variants on user messages; V2 records them on assistant models.
    reasoningEffort: canonicalizeReasoningEffort(msg.variant ?? assistantData.variant)
      ?? extractReasoningEffortFromModelId(assistantData.modelId),
  });
}

function buildOpenCodeSession(
  rawSession: OcSession,
  rawMessages: OcMessage[],
  partsByMsg: Map<string, OcPart[]>,
  editLocIndex?: EditLocIndex,
): Session | null {
  if (!rawSession.id) return null;

  rawMessages.sort((a, b) => a.seq !== undefined && b.seq !== undefined
    ? a.seq - b.seq : (a.time?.created || 0) - (b.time?.created || 0));
  if (rawMessages.length === 0) return null;

  const { wsId, wsName } = getOpenCodeWorkspace(rawSession);
  const requests: SessionRequest[] = [];
  let firstTs: number | null = null;
  let lastTs: number | null = null;

  for (let i = 0; i < rawMessages.length; i++) {
    const msg = rawMessages[i];
    if (msg.role !== 'user') continue;

    const userTs = msg.time?.created || null;
    if (userTs && (!firstTs || userTs < firstTs)) firstTs = userTs;
    if (userTs && (!lastTs || userTs > lastTs)) lastTs = userTs;

    const assistantMessages = findAssistantMessages(rawMessages, i + 1);
    const assistantData = collectAssistantData(assistantMessages, partsByMsg, userTs, lastTs);
    lastTs = assistantData.lastTs;
    requests.push(buildOpenCodeRequest(msg, partsByMsg, assistantData, userTs, editLocIndex));
  }

  if (requests.length === 0) return null;

  return createSession({
    sessionId: rawSession.id,
    workspaceId: wsId,
    workspaceName: wsName,
    location: 'terminal',
    harness: 'OpenCode',
    creationDate: firstTs || (rawSession.time?.created || null),
    lastMessageDate: lastTs || (rawSession.time?.updated || null),
    requests,
    hasDevcontainer: detectDevcontainerFromRequests(requests, rawSession.directory),
    workspaceRootPath: rawSession.directory || undefined,
  });
}

function parseLegacyOpenCodeSessions(storageDir: string, editLocIndex?: EditLocIndex, sessionId?: string): Session[] {
  const sessions: Session[] = [];
  const sessionDir = path.join(storageDir, 'session', 'global');
  const selected = sessionId === undefined ? null : readJsonSafe<OcSession>(path.join(sessionDir, `${sessionId}.json`));
  const rawSessions = sessionId === undefined ? readAllJsonInDir<OcSession>(sessionDir)
    : selected?.id === sessionId ? [selected] : [];

  for (const rawSession of rawSessions) {
    const rawMessages = readAllJsonInDir<OcMessage>(path.join(storageDir, 'message', rawSession.id));
    const partsByMsg = indexPartsByMessage(rawMessages, storageDir);
    const session = buildOpenCodeSession(rawSession, rawMessages, partsByMsg, editLocIndex);
    if (session) sessions.push(session);
  }

  return sessions;
}

function queryOpenCodeDatabase<T>(database: SqliteDatabase, sql: string, ...parameters: string[]): T[] {
  try {
    return database.prepare(sql).all(...parameters) as T[];
  } catch (error) {
    warnCore('parser-opencode', 'Could not query OpenCode database', error);
    return [];
  }
}

interface OcDbSessionRow {
  id: string;
  projectID?: string;
  directory?: string;
  title?: string;
  slug?: string;
  created?: number;
  updated?: number;
}

interface OcDbDataRow {
  id: string;
  sessionID: string;
  messageID?: string;
  created?: number;
  completed?: number;
  data: string;
  type?: string;
  seq?: number;
}

function decodeOpenCodeMessage(row: OcDbDataRow): OcMessage | null {
  try {
    const data: unknown = JSON.parse(row.data);
    if (!isRecord(data)) return null;
    const time = isRecord(data.time) ? data.time : {};
    const model = isRecord(data.model) ? data.model : {};
    return {
      ...data,
      id: row.id,
      sessionID: row.sessionID,
      role: row.type ?? (typeof data.role === 'string' ? data.role : ''),
      seq: row.seq,
      modelID: typeof model.id === 'string' ? model.id : data.modelID,
      variant: typeof model.variant === 'string' ? model.variant : data.variant,
      time: {
        created: typeof time.created === 'number' ? time.created : row.created,
        completed: typeof time.completed === 'number' ? time.completed : row.completed,
      },
    } as OcMessage;
  } catch {
    return null;
  }
}

function decodeOpenCodePart(row: OcDbDataRow): OcPart | null {
  try {
    const data: unknown = JSON.parse(row.data);
    if (!isRecord(data)) return null;
    return {
      ...data,
      id: row.id,
      sessionID: row.sessionID,
      messageID: row.messageID || '',
      type: typeof data.type === 'string' ? data.type : '',
    } as OcPart;
  } catch {
    return null;
  }
}

function readOpenCodeV1Database(database: SqliteDatabase, editLocIndex: EditLocIndex | undefined,
  sessionId: string | undefined, excludeIds: string[]): Session[] {
  const parameters = sessionId === undefined ? [] : [sessionId];
  const sessionFilter = sessionId === undefined ? '' : ' WHERE id = ?';
  const dataFilter = sessionId === undefined ? '' : ' WHERE session_id = ?';
  // Use parameterized NOT IN to exclude V2 session IDs — avoids a wasteful
  // `NOT IN (SELECT id FROM session_v2)` subquery on every query.
  let sessionExclusion = '';
  if (excludeIds.length > 0) {
    const placeholders = excludeIds.map(() => '?').join(',');
    sessionExclusion = `${sessionFilter ? ' AND' : ' WHERE'} id NOT IN (${placeholders})`;
    parameters.push(...excludeIds);
  }
  let dataExclusion = '';
  if (excludeIds.length > 0) {
    const placeholders = excludeIds.map(() => '?').join(',');
    dataExclusion = `${dataFilter ? ' AND' : ' WHERE'} session_id NOT IN (${placeholders})`;
  }
  const rawSessions = queryOpenCodeDatabase<OcDbSessionRow>(database,
    'SELECT id, project_id AS projectID, directory, title, slug, '
      + `time_created AS created, time_updated AS updated FROM session${sessionFilter}${sessionExclusion} ORDER BY time_created`, ...parameters);
  if (rawSessions.length === 0) return [];
  const messageRows = queryOpenCodeDatabase<OcDbDataRow>(database,
    'SELECT id, session_id AS sessionID, time_created AS created, '
      + `time_updated AS completed, data FROM message${dataFilter}${dataExclusion} ORDER BY session_id, time_created, id`, ...parameters);
  const partRows = queryOpenCodeDatabase<OcDbDataRow>(database,
    'SELECT id, session_id AS sessionID, message_id AS messageID, '
      + `time_created AS created, time_updated AS completed, data FROM part${dataFilter}${dataExclusion} `
      + 'ORDER BY session_id, time_created, id', ...parameters);
  const messagesBySession = new Map<string, OcMessage[]>();
  for (const message of messageRows.map(decodeOpenCodeMessage)) {
    if (!message) continue;
    const messages = messagesBySession.get(message.sessionID) ?? [];
    messages.push(message);
    messagesBySession.set(message.sessionID, messages);
  }
  const partsBySession = new Map<string, Map<string, OcPart[]>>();
  for (const part of partRows.map(decodeOpenCodePart)) {
    if (!part) continue;
    let partsByMessage = partsBySession.get(part.sessionID);
    if (!partsByMessage) {
      partsByMessage = new Map();
      partsBySession.set(part.sessionID, partsByMessage);
    }
    const parts = partsByMessage.get(part.messageID) ?? [];
    parts.push(part);
    partsByMessage.set(part.messageID, parts);
  }

  const sessions: Session[] = [];
  for (const row of rawSessions) {
    if (!/^[\w-]+$/.test(row.id)) continue;
    const rawSession: OcSession = {
      id: row.id,
      projectID: row.projectID,
      directory: row.directory,
      title: row.title,
      slug: row.slug,
      time: { created: row.created, updated: row.updated },
    };
    const session = buildOpenCodeSession(
      rawSession,
      messagesBySession.get(row.id) ?? [],
      partsBySession.get(row.id) ?? new Map<string, OcPart[]>(),
      editLocIndex,
    );
    if (session) sessions.push(session);
  }
  return sessions;
}

function openCodeDatabaseTables(database: SqliteDatabase): Set<string> {
  return new Set(queryOpenCodeDatabase<{ name: string }>(database,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('session', 'message', 'part', 'session_v2', 'session_message')",
  ).map(row => row.name));
}

function openCodeV2Parts(message: OcMessage): OcPart[] {
  const values: unknown[] = message.role === 'user'
    ? [{ type: 'text', text: message.text }, ...(Array.isArray(message.files)
      ? message.files.filter(isRecord).map(file => ({ ...file, type: 'file' })) : [])]
    : message.role === 'assistant' && Array.isArray(message.content) ? message.content : [];
  return values.filter(isRecord).map((value, index) => {
    const state = isRecord(value.state) ? value.state : {};
    const source = isRecord(value.source) ? value.source : {};
    const metadata = isRecord(state.metadata) ? state.metadata : {};
    const files: unknown[] = Array.isArray(metadata.files) ? metadata.files : [];
    const fileDiffs = [metadata.filediff, ...files]
      .filter(isRecord).map(diff => ({
        file: typeof diff.file === 'string' ? diff.file : undefined,
        additions: typeof diff.additions === 'number' ? diff.additions : undefined,
        deletions: typeof diff.deletions === 'number' ? diff.deletions : undefined,
      }));
    return {
      id: `${message.id}:${index}`, sessionID: message.sessionID, messageID: message.id,
      type: typeof value.type === 'string' ? value.type : '',
      text: value.type === 'text' && typeof value.text === 'string' ? value.text : undefined,
      tool: typeof value.name === 'string' ? value.name : undefined,
      mime: typeof value.mime === 'string' ? value.mime : undefined,
      data: value.data,
      fileDiffs,
      url: typeof source.uri === 'string' ? source.uri : undefined,
      // Tool output can be very large and is not needed for analytics.
      state: { status: typeof state.status === 'string' ? state.status : undefined,
        input: isRecord(state.input) ? state.input : {} },
    };
  });
}

function readOpenCodeV2Database(database: SqliteDatabase, editLocIndex?: EditLocIndex, sessionId?: string): Session[] {
  const parameters = sessionId === undefined ? [] : [sessionId];
  const filter = sessionId === undefined ? '' : ' WHERE id = ?';
  const rows = queryOpenCodeDatabase<OcDbSessionRow>(database,
    'SELECT id, project_id AS projectID, coalesce(nullif(directory, \'\'), path) AS directory, title, slug, '
    + `time_created AS created, time_updated AS updated FROM session_v2${filter} ORDER BY time_created`, ...parameters);
  const sessions: Session[] = [];
  for (const row of rows) {
    if (!/^[\w-]+$/.test(row.id)) continue;
    const messages: OcMessage[] = [];
    const partsByMsg = new Map<string, OcPart[]>();
    try {
      // Stream one session at a time; retaining every tool output can exhaust the worker heap.
      const messageRows = database.prepare('SELECT id, session_id AS sessionID, type, seq, '
        + "time_created AS created, data FROM session_message WHERE session_id = ? AND type IN ('user', 'assistant') ORDER BY seq, id").iterate(row.id);
      for (const messageRow of messageRows) {
        const message = decodeOpenCodeMessage(messageRow as OcDbDataRow);
        if (!message || (message.role !== 'user' && message.role !== 'assistant')) continue;
        partsByMsg.set(message.id, openCodeV2Parts(message));
        message.content = undefined;
        message.files = undefined;
        messages.push(message);
      }
    } catch (error) {
      warnCore('parser-opencode', 'Could not read OpenCode V2 messages', error);
      continue;
    }
    const session = buildOpenCodeSession({ ...row, time: { created: row.created, updated: row.updated } }, messages, partsByMsg, editLocIndex);
    if (session) sessions.push(session);
  }
  return sessions;
}

function parseOpenCodeDatabase(dbPath: string, editLocIndex?: EditLocIndex, sessionId?: string): Session[] {
  assertTrustedPath(dbPath);
  const sqlite = loadSqlite();
  if (!sqlite) return [];
  let database: SqliteDatabase | undefined;
  try {
    database = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    const tables = openCodeDatabaseTables(database);
    const hasV2 = tables.has('session_v2') && tables.has('session_message');
    const sessions = hasV2 ? readOpenCodeV2Database(database, editLocIndex, sessionId) : [];
    // Skip V1 query for a specific session when V2 already has it — avoids a wasteful
    // `NOT IN (SELECT id FROM session_v2)` subquery that would return zero rows.
    if (sessionId === undefined || !hasV2 || sessions.every(s => s.sessionId !== sessionId)) {
      if (tables.has('session') && tables.has('message') && tables.has('part')) {
        const excludeIds = hasV2
          ? queryOpenCodeDatabase<{ id: string }>(database, 'SELECT id FROM session_v2').map(r => r.id)
          : [];
        sessions.push(...readOpenCodeV1Database(database, editLocIndex, sessionId, excludeIds));
      }
    }
    return sessions;
  } catch (error) {
    warnCore('parser-opencode', 'Could not read OpenCode database', error);
    return [];
  } finally {
    database?.close();
  }
}

export function loadOpenCodeSession(source: string, sessionId: string): Session | null {
  if (!/^[\w-]+$/.test(sessionId)) {
    warnCore('parser-opencode', 'Invalid OpenCode session ID');
    return null;
  }
  const sessions = source.endsWith('.db')
    ? parseOpenCodeDatabase(source, undefined, sessionId)
    : parseLegacyOpenCodeSessions(source, undefined, sessionId);
  return sessions[0] ?? null;
}

export function parseOpenCodeSessions(source: string, editLocIndex?: EditLocIndex, sessionSourceIndex?: Map<string, SessionSource>): Session[] {
  const sessions = source.endsWith('.db')
    ? parseOpenCodeDatabase(source, editLocIndex)
    : parseLegacyOpenCodeSessions(source, editLocIndex);
  for (const session of sessions) {
    sessionSourceIndex?.set(session.sessionId, {
      kind: source.endsWith('.db') ? 'opencode-db' : 'opencode-storage',
      filePath: source,
      workspaceId: session.workspaceId,
      workspaceName: session.workspaceName,
      workspaceRootPath: session.workspaceRootPath,
      harness: session.harness,
    });
  }
  return sessions;
}

export function readOpenCodeImageReferences(source: string, sessionId: string, requestId: string): ImageReference[] {
  assertTrustedPath(source);
  if (!source.endsWith('.db')) {
    if (![sessionId, requestId].every(id => /^[\w-]+$/.test(id))) {
      warnCore('image-extract', 'Invalid OpenCode session or message ID');
      return [];
    }
    const message = readJsonSafe<OcMessage>(path.join(source, 'message', sessionId, `${requestId}.json`));
    if (message?.role !== 'user' || (message.sessionID !== undefined && message.sessionID !== sessionId)) return [];
    return imageReferencesFromContent(readAllJsonInDir<OcPart>(path.join(source, 'part', requestId)));
  }
  const sqlite = loadSqlite();
  if (!sqlite) return [];
  let database: SqliteDatabase | undefined;
  try {
    database = new sqlite.DatabaseSync(source, { readOnly: true });
    const tables = openCodeDatabaseTables(database);
    if (tables.has('session_v2') && tables.has('session_message')
      && database.prepare('SELECT id FROM session_v2 WHERE id = ?').all(sessionId).length > 0) {
      const rows = queryOpenCodeDatabase<OcDbDataRow>(database,
        "SELECT id, session_id AS sessionID, type, data FROM session_message WHERE session_id = ? AND id = ? AND type = 'user'",
        sessionId, requestId);
      const message = rows[0] && decodeOpenCodeMessage(rows[0]);
      return message ? imageReferencesFromContent(openCodeV2Parts(message)) : [];
    }
    if (!tables.has('message') || !tables.has('part')) return [];
    const rows = database.prepare(
      'SELECT part.data FROM part JOIN message ON message.id = part.message_id AND message.session_id = part.session_id '
      + "WHERE part.session_id = ? AND part.message_id = ? AND json_extract(message.data, '$.role') = 'user' "
      + 'ORDER BY part.time_created, part.id',
    ).all(sessionId, requestId);
    const parts: unknown[] = [];
    for (const row of rows) {
      if (!isRecord(row) || typeof row.data !== 'string') continue;
      try {
        parts.push(JSON.parse(row.data));
      } catch (error) {
        warnCore('image-extract', 'Could not decode an OpenCode image part', error);
      }
    }
    return imageReferencesFromContent(parts);
  } catch (error) {
    warnCore('image-extract', 'Could not read OpenCode image parts', error);
    return [];
  } finally {
    database?.close();
  }
}
