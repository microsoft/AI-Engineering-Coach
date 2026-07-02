/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* OpenCode session parser
 *
 * Legacy data layout (JSON files, macOS/Linux):
 *   ~/.local/share/opencode/storage/session/global/<session-id>.json   -- session metadata
 *   ~/.local/share/opencode/storage/message/<session-id>/<msg-id>.json -- message metadata
 *   ~/.local/share/opencode/storage/part/<msg-id>/<part-id>.json       -- content parts (text, tool, step-start/finish)
 *
 * Current data layout (newer OpenCode versions migrate the JSON files into SQLite):
 *   ~/.local/share/opencode/opencode.db
 *     session(id, slug, directory, title, time_created, time_updated, ...)  -- plain columns
 *     message(id, session_id, data)  -- data = OcMessage JSON without id/sessionID (ids live in columns)
 *     part(id, message_id, session_id, data)  -- data = OcPart JSON without ids
 *   Read via the node:sqlite builtin (Node >= 22.5). When unavailable (e.g. an
 *   older extension host) the SQLite source is skipped gracefully.
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
  summary?: { title?: string; diffs?: unknown[] };
  variant?: string;
  model?: { providerID?: string; modelID?: string };
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
}

const WRITE_TOOLS = new Set(['write', 'edit', 'create', 'patch']);
const READ_TOOLS = new Set(['read', 'glob', 'grep', 'ls', 'find']);

export function findOpenCodeDirs(): string[] {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const dirs: string[] = [];

  // macOS / Linux — the storage dir may be gone after the SQLite migration,
  // so the presence of opencode.db alone also qualifies the install.
  const base = path.join(home, '.local', 'share', 'opencode');
  const storagePath = path.join(base, 'storage');
  if (fs.existsSync(storagePath) || fs.existsSync(path.join(base, 'opencode.db'))) dirs.push(storagePath);

  return dirs;
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

function applyOpenCodePart(part: OcPart, data: Pick<OpenCodeAssistantData, 'toolsUsed' | 'editedFiles' | 'referencedFiles'>, textParts: string[]): void {
  if (part.type === 'text' && part.text) {
    textParts.push(part.text);
    return;
  }

  if (part.type !== 'tool' || !part.tool) return;

  data.toolsUsed.push(part.tool);
  const input = part.state?.input || {};
  const filePath = typeof input.filePath === 'string'
    ? input.filePath
    : typeof input.file_path === 'string'
      ? input.file_path
      : typeof input.path === 'string'
        ? input.path
        : null;
  if (!filePath) return;

  const toolLower = part.tool.toLowerCase();
  if (WRITE_TOOLS.has(toolLower)) {
    data.editedFiles.push(filePath);
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
): SessionRequest {
  const cacheRead = assistantData.tokenSource?.cache?.read ?? 0;
  const cacheWrite = assistantData.tokenSource?.cache?.write ?? 0;
  const hasTokenData = assistantData.tokenSource != null;
  return createRequest({
    requestId: msg.id,
    timestamp: userTs,
    messageText: getOpenCodeUserText(msg, partsByMsg),
    responseText: assistantData.responseText,
    agentName: msg.agent || 'OpenCode',
    agentMode: msg.agent || 'build',
    modelId: assistantData.modelId,
    toolsUsed: assistantData.toolsUsed,
    editedFiles: [...new Set(assistantData.editedFiles)],
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

function assembleOpenCodeSession(rawSession: OcSession, rawMessages: OcMessage[], partsByMsg: Map<string, OcPart[]>): Session | null {
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
    requests.push(buildOpenCodeRequest(msg, partsByMsg, assistantData, userTs));
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

function parseOpenCodeSession(rawSession: OcSession, storageDir: string): Session | null {
  if (!rawSession.id) return null;

  const msgDir = path.join(storageDir, 'message', rawSession.id);
  const rawMessages = readAllJsonInDir<OcMessage>(msgDir);
  rawMessages.sort((a, b) => (a.time?.created || 0) - (b.time?.created || 0));
  if (rawMessages.length === 0) return null;

  const partsByMsg = indexPartsByMessage(rawMessages, storageDir);
  return assembleOpenCodeSession(rawSession, rawMessages, partsByMsg);
}

type NodeSqlite = typeof import('node:sqlite');

interface SqliteSessionRow {
  id: string;
  slug: string | null;
  directory: string | null;
  title: string | null;
  time_created: number | null;
  time_updated: number | null;
}

interface SqliteMessageRow { id: string; session_id: string; data: string }
interface SqlitePartRow { id: string; message_id: string; session_id: string; data: string }

/* node:sqlite ships with Node >= 22.5 but not with every extension host, so it
 * is loaded lazily; callers skip the SQLite source when it is unavailable. */
function loadNodeSqlite(): NodeSqlite | null {
  try {
    const getBuiltinModule = (process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
    return (getBuiltinModule?.call(process, 'node:sqlite') as NodeSqlite | undefined) ?? null;
  } catch {
    return null;
  }
}

function parseDbJson<T>(data: string): T | null {
  try {
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
}

function indexDbMessagesBySession(rows: SqliteMessageRow[]): Map<string, OcMessage[]> {
  const messagesBySession = new Map<string, OcMessage[]>();
  for (const row of rows) {
    const parsed = parseDbJson<Omit<OcMessage, 'id' | 'sessionID'>>(row.data);
    if (!parsed) continue;
    const msg: OcMessage = {
      ...parsed,
      id: row.id,
      sessionID: row.session_id,
      // The db payload nests the model; the parser reads the flat modelID.
      modelID: parsed.modelID ?? parsed.model?.modelID,
    };
    const list = messagesBySession.get(row.session_id);
    if (list) list.push(msg);
    else messagesBySession.set(row.session_id, [msg]);
  }
  return messagesBySession;
}

function indexDbPartsByMessage(rows: SqlitePartRow[]): Map<string, OcPart[]> {
  const partsByMsg = new Map<string, OcPart[]>();
  for (const row of rows) {
    const parsed = parseDbJson<Omit<OcPart, 'id' | 'sessionID' | 'messageID'>>(row.data);
    if (!parsed) continue;
    const part: OcPart = { ...parsed, id: row.id, sessionID: row.session_id, messageID: row.message_id };
    const list = partsByMsg.get(row.message_id);
    if (list) list.push(part);
    else partsByMsg.set(row.message_id, [part]);
  }
  return partsByMsg;
}

function dbRowToOcSession(row: SqliteSessionRow): OcSession {
  return {
    id: row.id,
    slug: row.slug ?? undefined,
    directory: row.directory ?? undefined,
    title: row.title ?? undefined,
    time: { created: row.time_created ?? undefined, updated: row.time_updated ?? undefined },
  };
}

/** Parses sessions from the OpenCode SQLite database (`opencode.db`). The db
 *  stores the same JSON payloads as the legacy file layout in `data` columns,
 *  minus the id fields, which live in dedicated columns and are re-attached
 *  here. `knownIds` skips sessions already parsed from the legacy layout. */
export function parseOpenCodeDbSessions(dbPath: string, knownIds?: ReadonlySet<string>): Session[] {
  const sqlite = loadNodeSqlite();
  if (!sqlite) return [];

  const sessions: Session[] = [];
  let db: InstanceType<NodeSqlite['DatabaseSync']> | null = null;
  try {
    assertTrustedPath(dbPath);
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });

    const sessionRows = db.prepare(
      'SELECT id, slug, directory, title, time_created, time_updated FROM session',
    ).all() as unknown as SqliteSessionRow[];
    const messageRows = db.prepare(
      'SELECT id, session_id, data FROM message ORDER BY time_created',
    ).all() as unknown as SqliteMessageRow[];
    const partRows = db.prepare(
      'SELECT id, message_id, session_id, data FROM part',
    ).all() as unknown as SqlitePartRow[];

    const messagesBySession = indexDbMessagesBySession(messageRows);
    const partsByMsg = indexDbPartsByMessage(partRows);

    for (const row of sessionRows) {
      if (!row.id || knownIds?.has(row.id)) continue;
      const rawMessages = messagesBySession.get(row.id);
      if (!rawMessages || rawMessages.length === 0) continue;
      rawMessages.sort((a, b) => (a.time?.created || 0) - (b.time?.created || 0));

      const session = assembleOpenCodeSession(dbRowToOcSession(row), rawMessages, partsByMsg);
      if (session) sessions.push(session);
    }
  } catch {
    // Unreadable/locked db (e.g. concurrent OpenCode process mid-migration):
    // return whatever was assembled, mirroring readJsonSafe's tolerance.
    return sessions;
  } finally {
    db?.close();
  }

  return sessions;
}

export function parseOpenCodeSessions(storageDir: string): Session[] {
  const sessions: Session[] = [];
  const sessionDir = path.join(storageDir, 'session', 'global');
  const rawSessions = readAllJsonInDir<OcSession>(sessionDir);

  for (const rawSession of rawSessions) {
    const session = parseOpenCodeSession(rawSession, storageDir);
    if (session) sessions.push(session);
  }

  // Newer OpenCode versions migrate the JSON layout into a SQLite db that
  // lives one level above the storage dir (~/.local/share/opencode/opencode.db).
  const dbPath = path.join(path.dirname(storageDir), 'opencode.db');
  if (fs.existsSync(dbPath)) {
    const knownIds = new Set(sessions.map((s) => s.sessionId));
    sessions.push(...parseOpenCodeDbSessions(dbPath, knownIds));
  }

  return sessions;
}
