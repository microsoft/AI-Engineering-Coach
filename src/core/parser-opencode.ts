/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* OpenCode session parser
 *
 * Data layout (macOS, legacy JSON storage):
 *   ~/.local/share/opencode/storage/session/global/<session-id>.json   -- session metadata
 *   ~/.local/share/opencode/storage/message/<session-id>/<msg-id>.json -- message metadata
 *   ~/.local/share/opencode/storage/part/<msg-id>/<part-id>.json       -- content parts (text, tool, step-start/finish)
 *
 * Current OpenCode versions instead store the same data in a SQLite database:
 *   ~/.local/share/opencode/opencode.db (or opencode-<id>.db)
 * with `session`, `message`, and `part` tables. `message`/`part` rows carry their JSON payload
 * in a `data` column, with id/session/message linkage in dedicated columns. The database is
 * opened read-only via `node:sqlite` (Node >= 22.5); when unavailable, only the legacy layout
 * is read. Both layouts describe the same shapes below.
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
  tool?: string;
  callID?: string;
  state?: { status?: string; input?: Record<string, unknown>; output?: string };
  tokens?: { input?: number; output?: number; reasoning?: number };
  cost?: number;
  reason?: string;
}

interface OpenCodeAssistantData {
  responseText: string;
  toolsUsed: string[];
  editedFiles: string[];
  referencedFiles: string[];
  modelId: string;
  totalElapsed: number | null;
  lastTs: number | null;
  tokenSource: OcMessage['tokens'] | null;
  editLocs: FileEditLocMap;
}

const WRITE_TOOLS = new Set(['write', 'edit', 'create', 'patch', 'apply_patch']);
const READ_TOOLS = new Set(['read', 'glob', 'grep', 'ls', 'find']);

/** The subset of `node:sqlite` this parser uses, so the module stays optional at build time. */
interface SqliteDatabase {
  prepare(sql: string): { all(): unknown[] };
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

function findAssistantMessage(messages: OcMessage[], startIndex: number, parentId: string): OcMessage | null {
  for (let i = startIndex; i < messages.length; i++) {
    const candidate = messages[i];
    if (candidate.role === 'assistant' && candidate.parentID === parentId) return candidate;
  }

  const next = messages[startIndex];
  return next?.role === 'assistant' ? next : null;
}

function applyOpenCodePart(
  part: OcPart,
  data: Pick<OpenCodeAssistantData, 'toolsUsed' | 'editedFiles' | 'referencedFiles' | 'editLocs'>,
  textParts: string[],
): void {
  if (part.type === 'text' && part.text) {
    textParts.push(part.text);
    return;
  }

  if (part.type !== 'tool' || !part.tool) return;

  data.toolsUsed.push(part.tool);
  const input = part.state?.input || {};
  const toolLower = part.tool.toLowerCase();
  const toolSucceeded = part.state?.status === undefined || part.state.status === 'completed';
  if (!toolSucceeded && WRITE_TOOLS.has(toolLower)) return;
  if (toolLower === 'patch' || toolLower === 'apply_patch') {
    const patch = typeof input.patch === 'string' ? input.patch
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
    const previous = typeof input.old_string === 'string' ? input.old_string
      : typeof input.old_str === 'string' ? input.old_str
        : '';
    const next = typeof input.new_string === 'string' ? input.new_string
      : typeof input.new_str === 'string' ? input.new_str
        : '';
    if (previous || next) {
      recordContentReplacement(data.editLocs, filePath, previous, next);
    } else {
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
  assistantMsg: OcMessage | null,
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
    totalElapsed: null,
    lastTs,
    tokenSource: null,
    editLocs: new Map(),
  };
  if (!assistantMsg) return data;

  const assistantTs = assistantMsg.time?.completed || assistantMsg.time?.created || null;
  if (assistantTs && (!data.lastTs || assistantTs > data.lastTs)) data.lastTs = assistantTs;
  if (userTs && assistantTs) data.totalElapsed = assistantTs - userTs;

  data.modelId = assistantMsg.modelID || '';
  data.tokenSource = assistantMsg.tokens ?? null;

  const textParts: string[] = [];
  const parts = partsByMsg.get(assistantMsg.id) || [];
  for (const part of parts) {
    applyOpenCodePart(part, data, textParts);
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
  mergeRequestEditLoc(editLocIndex, msg.id, exactLocs, hasSummaryDiffs);

  return createRequest({
    requestId: msg.id,
    timestamp: userTs,
    messageText: getOpenCodeUserText(msg, partsByMsg),
    responseText: assistantData.responseText,
    agentName: msg.agent || 'OpenCode',
    agentMode: msg.agent || 'build',
    modelId: assistantData.modelId,
    toolsUsed: assistantData.toolsUsed,
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
    // OpenCode stores reasoning effort as "variant" on user messages
    reasoningEffort: canonicalizeReasoningEffort(msg.variant)
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

  rawMessages.sort((a, b) => (a.time?.created || 0) - (b.time?.created || 0));
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

    const assistantMsg = findAssistantMessage(rawMessages, i + 1, msg.id);
    const assistantData = collectAssistantData(assistantMsg, partsByMsg, userTs, lastTs);
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

function parseLegacyOpenCodeSessions(storageDir: string, editLocIndex?: EditLocIndex): Session[] {
  const sessions: Session[] = [];
  const sessionDir = path.join(storageDir, 'session', 'global');
  const rawSessions = readAllJsonInDir<OcSession>(sessionDir);

  for (const rawSession of rawSessions) {
    const rawMessages = readAllJsonInDir<OcMessage>(path.join(storageDir, 'message', rawSession.id));
    const partsByMsg = indexPartsByMessage(rawMessages, storageDir);
    const session = buildOpenCodeSession(rawSession, rawMessages, partsByMsg, editLocIndex);
    if (session) sessions.push(session);
  }

  return sessions;
}

function queryOpenCodeDatabase<T>(database: SqliteDatabase, sql: string): T[] {
  try {
    return database.prepare(sql).all() as T[];
  } catch {
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
}

function decodeOpenCodeMessage(row: OcDbDataRow): OcMessage | null {
  try {
    const data: unknown = JSON.parse(row.data);
    if (!isRecord(data)) return null;
    const time = isRecord(data.time) ? data.time : {};
    return {
      ...data,
      id: row.id,
      sessionID: row.sessionID,
      role: typeof data.role === 'string' ? data.role : '',
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

function parseOpenCodeDatabase(dbPath: string, editLocIndex?: EditLocIndex): Session[] {
  assertTrustedPath(dbPath);
  const sqlite = loadSqlite();
  if (!sqlite) return [];
  let database: SqliteDatabase;
  try {
    database = new sqlite.DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return [];
  }

  const rawSessions = queryOpenCodeDatabase<OcDbSessionRow>(database,
    'SELECT id, project_id AS projectID, directory, title, slug, '
      + 'time_created AS created, time_updated AS updated FROM session ORDER BY time_created');
  const messageRows = queryOpenCodeDatabase<OcDbDataRow>(database,
    'SELECT id, session_id AS sessionID, time_created AS created, '
      + 'time_updated AS completed, data FROM message ORDER BY session_id, time_created, id');
  const partRows = queryOpenCodeDatabase<OcDbDataRow>(database,
    'SELECT id, session_id AS sessionID, message_id AS messageID, '
      + 'time_created AS created, time_updated AS completed, data FROM part '
      + 'ORDER BY session_id, time_created, id');
  database.close();
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

export function parseOpenCodeSessions(source: string, editLocIndex?: EditLocIndex): Session[] {
  return source.endsWith('.db')
    ? parseOpenCodeDatabase(source, editLocIndex)
    : parseLegacyOpenCodeSessions(source, editLocIndex);
}
