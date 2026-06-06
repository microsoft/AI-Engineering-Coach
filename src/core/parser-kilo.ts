/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Kilo session parser
 *
 * Data layout:
 *   ~/.local/share/kilo/kilo.db -- SQLite database
 *
 * The session table holds session metadata (id, project_id, workspace_id, slug,
 * directory, path, title, agent, model, time_created, time_updated).
 * The message table holds messages with a JSON `data` column containing
 * the message info (role, time, agent, model, tokens, cost, etc.).
 * The part table holds parts with a JSON `data` column containing
 * the part payload (text, tool, reasoning, step-start/finish, etc.).
 *
 * Messages have: id, session_id, time_created, time_updated,
 *   data: { role (user|assistant), time: {created, completed?}, agent,
 *          model: {providerID, modelID, variant?}, tokens: {input, output, ...},
 *          cost, finish, parentID, variant }
 * Parts have: id, message_id, session_id, time_created, time_updated,
 *   data: { type (text|tool|reasoning|step-start|step-finish|...), ... }
 */

import * as fs from 'fs';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { Session, SessionRequest } from './types';
import { assertTrustedPath, createRequest, createSession, detectDevcontainerFromRequests } from './parser-shared';
import { canonicalizeReasoningEffort, extractReasoningEffortFromModelId } from './helpers';

interface KiloSessionRow {
  id: string;
  project_id: string;
  workspace_id: string | null;
  slug: string;
  directory: string;
  path: string | null;
  title: string;
  version: string;
  agent: string | null;
  model: string | null;
  time_created: number;
  time_updated: number;
}

interface KiloMessageRow {
  id: string;
  session_id: string;
  time_created: number;
  time_updated: number;
  data: string;
}

interface KiloPartRow {
  id: string;
  message_id: string;
  session_id: string;
  time_created: number;
  time_updated: number;
  data: string;
}

interface KiloWorkspaceRow {
  id: string;
  type: string;
  name: string;
  directory: string | null;
  branch: string | null;
}

interface KiloAssistantData {
  responseText: string;
  toolsUsed: string[];
  editedFiles: string[];
  referencedFiles: string[];
  modelId: string;
  totalElapsed: number | null;
  lastTs: number | null;
  tokenSource: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } } | null;
}

const WRITE_TOOLS = new Set(['write', 'edit', 'create', 'patch', 'apply_patch', 'multi_edit', 'replace']);
const READ_TOOLS = new Set(['read', 'glob', 'grep', 'bash', 'ls', 'find', 'search_file', 'search_content', 'list_files', 'list_code_definition_names']);

export function findKiloDirs(): string[] {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const dirs: string[] = [];

  const kiloDir = path.join(home, '.local', 'share', 'kilo');
  if (fs.existsSync(path.join(kiloDir, 'kilo.db'))) dirs.push(kiloDir);

  return dirs;
}

function projectNameFromDir(directory: string): string {
  return directory.replaceAll('\\', '/').replace(/\/+$/, '').split('/').pop() || 'unknown';
}

function getKiloUserText(userData: Record<string, unknown>, partsByMsg: Map<string, Record<string, unknown>[]>, msgId: string): string {
  const userParts = partsByMsg.get(msgId) || [];
  const userTextFromParts = userParts
    .filter(p => String(p.type) === 'text' && typeof p.text === 'string')
    .map(p => String(p.text!))
    .join('\n');
  if (userTextFromParts) return userTextFromParts;
  const summary = userData.summary as Record<string, unknown> | undefined;
  return typeof summary?.title === 'string' ? summary.title : '';
}

function findAssistantMessage(messages: KiloMessageRow[], startIndex: number, parentId: string, parsedData: Map<string, Record<string, unknown>>): KiloMessageRow | null {
  for (let i = startIndex; i < messages.length; i++) {
    const candidate = messages[i];
    const data = parsedData.get(candidate.id);
    if (!data) continue;
    if (String(data.role) === 'assistant' && String(data.parentID) === parentId) return candidate;
  }
  const next = messages[startIndex];
  if (next) {
    const data = parsedData.get(next.id);
    if (data && String(data.role) === 'assistant') return next;
  }
  return null;
}

function getInputPath(input: Record<string, unknown> | undefined, key: string): string | null {
  const value = input?.[key];
  return typeof value === 'string' ? value : null;
}

function applyKiloPart(
  partData: Record<string, unknown>,
  data: Pick<KiloAssistantData, 'toolsUsed' | 'editedFiles' | 'referencedFiles'>,
  textParts: string[],
): void {
  const type = String(partData.type || '');
  if (type === 'text' && typeof partData.text === 'string') {
    textParts.push(partData.text);
    return;
  }

  if (type === 'reasoning' && typeof partData.text === 'string') {
    textParts.push(partData.text);
    return;
  }

  if (type !== 'tool' || !partData.tool) return;

  const tool = String(partData.tool);
  data.toolsUsed.push(tool);

  const state = partData.state as Record<string, unknown> | undefined;
  const stateInput = state?.input as Record<string, unknown> | undefined;
  const input = stateInput || {};

  const filePath = getInputPath(input, 'filePath')
    ?? getInputPath(input, 'file_path')
    ?? getInputPath(input, 'path')
    ?? null;
  if (!filePath) return;

  const toolLower = tool.toLowerCase();
  if (WRITE_TOOLS.has(toolLower)) {
    data.editedFiles.push(filePath);
    const content = typeof input.content === 'string' ? input.content
      : typeof input.code === 'string' ? input.code
        : typeof input.new_string === 'string' ? input.new_string
          : typeof state?.output === 'string' ? state.output
            : null;
    if (content) {
      const ext = filePath.split('.').pop() || 'unknown';
      textParts.push(`\n\`\`\`${ext}\n${content}\n\`\`\`\n`);
    }
  } else if (READ_TOOLS.has(toolLower)) {
    data.referencedFiles.push(filePath);
  }
}

function collectKiloAssistantData(
  assistantData: Record<string, unknown> | null,
  partsByMsg: Map<string, Record<string, unknown>[]>,
  userTs: number | null,
  lastTs: number | null,
): KiloAssistantData {
  const result: KiloAssistantData = {
    responseText: '',
    toolsUsed: [],
    editedFiles: [],
    referencedFiles: [],
    modelId: '',
    totalElapsed: null,
    lastTs,
    tokenSource: null,
  };
  if (!assistantData) return result;

  const time = assistantData.time as Record<string, unknown> | undefined;
  const assistantTs = typeof time?.completed === 'number' ? time.completed
    : typeof time?.created === 'number' ? time.created
      : null;
  if (assistantTs && (!result.lastTs || assistantTs > result.lastTs)) result.lastTs = assistantTs;
  if (userTs && assistantTs) result.totalElapsed = assistantTs - userTs;

  result.modelId = `${String(assistantData.providerID || '')}/${String(assistantData.modelID || '')}`;
  if (result.modelId === '/') result.modelId = '';

  result.tokenSource = (assistantData.tokens as KiloAssistantData['tokenSource']) ?? null;

  const textParts: string[] = [];
  const parts = partsByMsg.get(String((assistantData as Record<string, unknown>).id)) || [];
  for (const part of parts) {
    applyKiloPart(part, result, textParts);
  }
  result.responseText = textParts.join('\n');

  return result;
}

function getKiloWorkspace(
  rawSession: KiloSessionRow,
  wsRow: KiloWorkspaceRow | null,
): { wsId: string; wsName: string } {
  const wsId = `kilo-${rawSession.id}`;
  if (wsRow?.name) {
    return { wsId: `kilo-ws-${wsRow.id}`, wsName: wsRow.name };
  }
  return {
    wsId,
    wsName: rawSession.directory
      ? projectNameFromDir(rawSession.directory)
      : rawSession.title || rawSession.slug || 'unknown',
  };
}

function buildKiloRequest(
  userData: Record<string, unknown>,
  partsByMsg: Map<string, Record<string, unknown>[]>,
  assistantData: KiloAssistantData,
  userTs: number | null,
): SessionRequest {
  const cacheRead = assistantData.tokenSource?.cache?.read ?? 0;
  const cacheWrite = assistantData.tokenSource?.cache?.write ?? 0;
  const hasTokenData = assistantData.tokenSource != null;

  const variant = typeof userData.variant === 'string' ? userData.variant : undefined;

  return createRequest({
    requestId: String(userData.id || ''),
    timestamp: userTs,
    messageText: getKiloUserText(userData, partsByMsg, String(userData.id || '')),
    responseText: assistantData.responseText,
    agentName: String(userData.agent || 'Kilo'),
    agentMode: String(userData.agent || 'agent'),
    modelId: assistantData.modelId,
    toolsUsed: assistantData.toolsUsed,
    editedFiles: [...new Set(assistantData.editedFiles)],
    referencedFiles: [...new Set(assistantData.referencedFiles)],
    totalElapsed: assistantData.totalElapsed,
    promptTokens: hasTokenData ? (assistantData.tokenSource?.input ?? 0) + cacheRead + cacheWrite : null,
    completionTokens: hasTokenData ? (assistantData.tokenSource?.output ?? 0) : null,
    cacheReadTokens: cacheRead > 0 ? cacheRead : null,
    cacheWriteTokens: cacheWrite > 0 ? cacheWrite : null,
    reasoningEffort: canonicalizeReasoningEffort(variant ?? null)
      ?? extractReasoningEffortFromModelId(assistantData.modelId),
  });
}

function parseKiloSession(db: DatabaseSync, rawSession: KiloSessionRow): Session | null {
  if (!rawSession.id) return null;

  const messageRows = db.prepare(
    'SELECT * FROM message WHERE session_id = ? ORDER BY time_created, id',
  ).all(rawSession.id) as unknown as KiloMessageRow[];
  if (messageRows.length === 0) return null;

  const parsedData = new Map<string, Record<string, unknown>>();
  for (const row of messageRows) {
    try {
      parsedData.set(row.id, JSON.parse(row.data));
    } catch {
      continue;
    }
  }

  const partRows = db.prepare(
    'SELECT * FROM part WHERE session_id = ? ORDER BY message_id, id',
  ).all(rawSession.id) as unknown as KiloPartRow[];
  const partsByMsg = new Map<string, Record<string, unknown>[]>();
  for (const row of partRows) {
    let partData: Record<string, unknown>;
    try {
      partData = JSON.parse(row.data);
    } catch {
      continue;
    }
    partData.id = row.id;
    partData.sessionID = row.session_id;
    partData.messageID = row.message_id;
    const list = partsByMsg.get(row.message_id);
    if (list) list.push(partData);
    else partsByMsg.set(row.message_id, [partData]);
  }

  let wsRow: KiloWorkspaceRow | null = null;
  if (rawSession.workspace_id) {
    wsRow = db.prepare('SELECT * FROM workspace WHERE id = ?').get(rawSession.workspace_id) as unknown as KiloWorkspaceRow | null;
  }
  const { wsId, wsName } = getKiloWorkspace(rawSession, wsRow);

  const requests: SessionRequest[] = [];
  let firstTs: number | null = null;
  let lastTs: number | null = null;

  for (let i = 0; i < messageRows.length; i++) {
    const row = messageRows[i];
    const data = parsedData.get(row.id);
    if (!data) continue;
    if (String(data.role) !== 'user') continue;

    const userTs = typeof (data.time as Record<string, unknown> | undefined)?.created === 'number'
      ? (data.time as Record<string, unknown>).created as number
      : null;
    if (userTs && (!firstTs || userTs < firstTs)) firstTs = userTs;

    const assistantMsg = findAssistantMessage(messageRows, i + 1, row.id, parsedData);
    const assistantRowData = assistantMsg ? parsedData.get(assistantMsg.id) ?? null : null;
    const assistantData = collectKiloAssistantData(assistantRowData, partsByMsg, userTs, lastTs);
    lastTs = assistantData.lastTs;
    requests.push(buildKiloRequest(data, partsByMsg, assistantData, userTs));
  }

  if (requests.length === 0) return null;

  return createSession({
    sessionId: rawSession.id,
    workspaceId: wsId,
    workspaceName: wsName,
    location: 'terminal',
    harness: 'Kilo',
    creationDate: firstTs || rawSession.time_created || null,
    lastMessageDate: lastTs || rawSession.time_updated || null,
    requests,
    hasDevcontainer: detectDevcontainerFromRequests(requests, rawSession.directory),
    workspaceRootPath: rawSession.directory || rawSession.path || undefined,
  });
}

export function parseKiloSessions(kiloDir: string): Session[] {
  const dbPath = path.join(kiloDir, 'kilo.db');
  assertTrustedPath(dbPath);
  if (!fs.existsSync(dbPath)) return [];

  const db = new DatabaseSync(dbPath, { open: true, readOnly: true });
  try {
    const sessionRows = db.prepare(
      'SELECT * FROM session ORDER BY time_created DESC',
    ).all() as unknown as KiloSessionRow[];

    const sessions: Session[] = [];
    for (const rawSession of sessionRows) {
      const session = parseKiloSession(db, rawSession);
      if (session) sessions.push(session);
    }
    return sessions;
  } finally {
    db.close();
  }
}
