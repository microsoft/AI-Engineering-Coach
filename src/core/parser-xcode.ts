/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Xcode Copilot Chat SQLite parser
 *
 * Data layout:
 *   ~/.config/github-copilot/xcode/<machine-id>/conversations/<id>.db
 *
 * Uses sqlite3 CLI to query Conversation and Turn tables.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync, execFile } from 'child_process';
import { Session, SessionRequest } from './types';
import { assertTrustedPath, extractCodeBlocks, createRequest, createSession, detectDevcontainerFromRequests } from './parser-shared';
import { fileUriToPath } from './helpers';
import { EditLocIndex } from './edit-loc-diff';
import { FileEditLocMap, recordContentReplacement } from './edit-tool-diff';
import { recordedWebDomains } from './curiosity-activity';
import { imageReferencesFromXcode, type ImageReference } from './image-data';
import type { SessionSource } from './cache';
import { warnCore } from './log';

/* ---- Directory discovery ---- */

export function findXcodeDirs(): string[] {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const dirs: string[] = [];
  const xcodeBase = path.join(home, '.config', 'github-copilot', 'xcode');
  if (fs.existsSync(xcodeBase)) dirs.push(xcodeBase);
  return dirs;
}

/* ---- Helpers ---- */

function collectDbFilesFromDir(convDir: string, dbFiles: string[]): void {
  try {
    const files = fs.readdirSync(convDir, { withFileTypes: true });
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith('.db')) continue;
      dbFiles.push(path.join(convDir, f.name));
    }
  } catch (e) {
    console.debug(`No conversations dir in ${path.dirname(convDir)}:`, e instanceof Error ? e.message : e);
  }
}

function findXcodeDbFiles(xcodeBase: string): string[] {
  const dbFiles: string[] = [];
  try {
    const machineIds = fs.readdirSync(xcodeBase, { withFileTypes: true })
      .filter(e => e.isDirectory());
    for (const mid of machineIds) {
      const convDir = path.join(xcodeBase, mid.name, 'conversations');
      collectDbFilesFromDir(convDir, dbFiles);
    }
  } catch (e) {
    console.debug(`Cannot read Xcode dir ${xcodeBase}:`, e instanceof Error ? e.message : e);
  }
  return dbFiles;
}

/** Quote a string as a SQLite literal (doubling embedded quotes) so the
 *  conversation-ID allowlist checks are defence-in-depth rather than the
 *  only barrier against SQL injection. */
function sqlQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

// Shared sqlite3 exec options. cwd:os.tmpdir() keeps the bare 'sqlite3' name from
// resolving against an attacker-controlled workspace dir (binary planting, esp.
// on Windows). Defined once so no call site can drift from the hardened config.
const SQLITE_QUERY_OPTS = { timeout: 30000, killSignal: 'SIGKILL', maxBuffer: 50 * 1024 * 1024, cwd: os.tmpdir() } as const;
const SQLITE_PROBE_OPTS = { timeout: 3000, cwd: os.tmpdir() } as const;

function sqliteQuery(dbPath: string, sql: string): string {
  assertTrustedPath(dbPath);
  try {
    return execFileSync('sqlite3', ['-readonly', '-json', dbPath, sql], { encoding: 'utf-8', ...SQLITE_QUERY_OPTS });
  } catch (e) {
    console.debug(`sqlite3 query failed on ${dbPath}:`, e instanceof Error ? e.message : e);
    return '';
  }
}

/** Run a sqlite3 query off the main thread, resolving stdout (or '' on error).
 *  assertTrustedPath lives here so no async caller can forget it. */
function sqliteExecAsync(dbPath: string, args: string[]): Promise<string> {
  assertTrustedPath(dbPath);
  return new Promise(resolve => {
    execFile('sqlite3', args, { encoding: 'utf-8', ...SQLITE_QUERY_OPTS }, (err, stdout) => {
      if (err) {
        console.debug(`sqlite3 query failed on ${dbPath}:`, err.message);
        resolve('');
      } else {
        resolve(stdout);
      }
    });
  });
}

function sqliteQueryAsync(dbPath: string, sql: string): Promise<string> {
  return sqliteExecAsync(dbPath, ['-readonly', '-json', dbPath, sql]);
}

/** Fast Turn query that avoids sqlite3's slow -json serialization.
 *  Uses raw output with unit separator (\\x1f) between columns and
 *  replaces embedded newlines in data blobs so each row is one line. */
function sqliteQueryTurnsAsync(
  dbPath: string,
  conversationId: string,
): Promise<{ rowID: number; id: string; role: string; data: string; createdAt: number }[]> {
  // Validate conversation ID to prevent SQL injection
  if (!/^[\w-]+$/.test(conversationId)) return Promise.resolve([]);
  const UNIT_SEP = '\x1f';
  const NEWLINE_PLACEHOLDER = '\x1e';
  const sql =
    `SELECT rowID, id, role, replace(data, x'0a', x'1e'), createdAt ` +
    `FROM Turn WHERE conversationID = ${sqlQuote(conversationId)} ORDER BY rowID`;
  return sqliteExecAsync(dbPath, ['-readonly', '-separator', UNIT_SEP, dbPath, sql]).then(stdout => {
    const rows: { rowID: number; id: string; role: string; data: string; createdAt: number }[] = [];
    for (const line of stdout.split('\n')) {
      if (!line) continue;
      const parts = line.split(UNIT_SEP);
      if (parts.length < 5) continue;
      rows.push({
        rowID: Number.parseInt(parts[0], 10),
        id: parts[1],
        role: parts[2],
        data: parts[3].replaceAll(NEWLINE_PLACEHOLDER, '\n'),
        createdAt: Number.parseFloat(parts[4]),
      });
    }
    return rows;
  });
}

/* ---- Main parser ---- */

interface XcodeConversationRow {
  id: string;
  title: string | null;
  createdAt: number;
  updatedAt: number;
}

interface XcodeTurnRow {
  rowID: number;
  id: string;
  role: string;
  data: string;
  createdAt: number;
}

interface XcodeTurnData {
  content?: string;
  contentImageReferences?: unknown[];
  requestType?: string;
  references?: { uri?: string; path?: string; external?: string }[];
}

interface XcodeAssistantData {
  content?: string;
  editAgentRounds?: { reply?: string; toolCalls?: { name?: string; input?: Record<string, unknown> }[] }[];
  fileEdits?: XcodeFileEditLike[];
  turnStatus?: string;
}

export interface XcodeFileEditLike {
  filePath?: string;
  fileURL?: string;
  originalContent?: string;
  modifiedContent?: string;
  status?: string;
}

function parseAssistantReply(turns: XcodeTurnRow[], index: number): { assistantContent: string; assistantData: XcodeAssistantData | null } {
  if (index + 1 >= turns.length || turns[index + 1].role !== 'assistant') {
    return { assistantContent: '', assistantData: null };
  }

  try {
    const assistantData = JSON.parse(turns[index + 1].data) as XcodeAssistantData;
    let assistantContent = assistantData?.content || '';
    if (!assistantContent && Array.isArray(assistantData?.editAgentRounds)) {
      assistantContent = assistantData.editAgentRounds
        .map(round => round.reply || '')
        .filter(Boolean)
        .join('\n');
    }
    return { assistantContent, assistantData };
  } catch {
    return { assistantContent: '', assistantData: null };
  }
}

function extractToolsFromRounds(rounds: Array<{ toolCalls?: Array<{ name?: string }> }>): string[] {
  const toolsUsed: string[] = [];
  for (const round of rounds) {
    for (const tc of round.toolCalls ?? []) {
      if (tc.name) toolsUsed.push(tc.name);
    }
  }
  return toolsUsed;
}

function extractEditedFiles(assistantData: XcodeAssistantData | null): string[] {
  const editedFiles: string[] = [];
  if (assistantData?.fileEdits) {
    for (const fileEdit of assistantData.fileEdits) {
      const fp = fileEdit.filePath
        || (typeof fileEdit.fileURL === 'string'
          ? fileUriToPath(fileEdit.fileURL)
          : '');
      if (fp) editedFiles.push(fp);
    }
  }
  return editedFiles;
}

export function accumulateXcodeFileEdits(
  fileEdits: XcodeFileEditLike[] | undefined,
  requestId: string,
  editLocIndex: EditLocIndex | undefined,
): void {
  if (!editLocIndex || !fileEdits || editLocIndex.has(requestId)) return;
  const deltas: FileEditLocMap = new Map();
  let recognized = 0;
  for (const edit of fileEdits) {
    if (edit.status === 'undone') {
      recognized++;
      continue;
    }
    const file = edit.filePath
      || (typeof edit.fileURL === 'string' ? fileUriToPath(edit.fileURL) : '');
    if (!file || typeof edit.originalContent !== 'string' || typeof edit.modifiedContent !== 'string') continue;
    recordContentReplacement(deltas, file, edit.originalContent, edit.modifiedContent);
    recognized++;
  }
  // Persisted Xcode telemetry is authoritative even when every edit was undone, but only once
  // at least one edit was understood. A turn that edited nothing (chat-only) or whose edits
  // carry no persisted contents must still fall back to counting response code blocks.
  if (recognized > 0) editLocIndex.set(requestId, deltas);
}

function extractReferencedFiles(turnData: XcodeTurnData): string[] {
  const referencedFiles: string[] = [];
  if (Array.isArray(turnData.references)) {
    for (const ref of turnData.references) {
      if (typeof ref !== 'object' || !ref) continue;
      const refPath = ref.uri || ref.path || ref.external || '';
      if (refPath) referencedFiles.push(String(refPath));
    }
  }
  return referencedFiles;
}

function computeElapsed(turns: XcodeTurnRow[], i: number, turn: XcodeTurnRow): number | null {
  if (i + 1 < turns.length && turns[i + 1].role === 'assistant') {
    const userMs = turn.createdAt * 1000;
    const assistantMs = turns[i + 1].createdAt * 1000;
    if (assistantMs > userMs) return assistantMs - userMs;
  }
  return null;
}

function processTurn(
  turns: XcodeTurnRow[],
  i: number,
  turn: XcodeTurnRow,
  turnData: XcodeTurnData,
  editLocIndex?: EditLocIndex,
): SessionRequest | null {
  if (turn.role !== 'user') return null;

  const userContent = turnData.content || '';
  const requestType = turnData.requestType || '';
  const { assistantContent, assistantData } = parseAssistantReply(turns, i);

  const totalElapsed = computeElapsed(turns, i, turn);
  const editedFiles = extractEditedFiles(assistantData);
  const referencedFiles = extractReferencedFiles(turnData);
  const imageCount = imageReferencesFromXcode(turnData.contentImageReferences).length;

  const toolsUsed = Array.isArray(assistantData?.editAgentRounds)
    ? extractToolsFromRounds(assistantData.editAgentRounds)
    : [];
  accumulateXcodeFileEdits(assistantData?.fileEdits, turn.id, editLocIndex);
  const webDomains = [...new Set((assistantData?.editAgentRounds ?? [])
    .flatMap(round => (round.toolCalls ?? []).flatMap(call => recordedWebDomains(call.name ?? '', call.input))))];

  return createRequest({
    requestId: turn.id,
    userEventId: turn.id,
    timestamp: turn.createdAt * 1000,
    messageText: userContent,
    variableKinds: imageCount > 0 ? { image: imageCount } : {},
    responseText: assistantContent,
    answerEvidence: assistantData?.content?.trim() && assistantData.turnStatus === 'completed' ? 'final'
      : assistantData?.content?.trim() && !assistantData.turnStatus ? 'legacy' : 'missing',
    isCanceled: assistantData?.turnStatus === 'canceled',
    agentName: 'Copilot (Xcode)',
    agentMode: requestType || 'conversation',
    toolsUsed,
    webDomains,
    editedFiles,
    referencedFiles,
    totalElapsed,
    userCode: extractCodeBlocks(userContent),
    aiCode: extractCodeBlocks(assistantContent),
    endState: 'no-data',
  });
}

function buildXcodeSession(
  conversation: XcodeConversationRow,
  turns: XcodeTurnRow[],
  editLocIndex?: EditLocIndex,
  onTurnParseError?: (turnId: string, error: unknown) => void,
): Session | null {
  if (turns.length === 0) return null;

  const requests: SessionRequest[] = [];
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    let turnData: XcodeTurnData;
    try {
      turnData = JSON.parse(turn.data) as XcodeTurnData;
    } catch (error) {
      onTurnParseError?.(turn.id, error);
      continue;
    }

    const request = processTurn(turns, i, turn, turnData, editLocIndex);
    if (request) requests.push(request);
  }

  if (requests.length === 0) return null;

  return createSession({
    sessionId: conversation.id,
    workspaceId: `xcode-${conversation.id}`,
    workspaceName: conversation.title || 'Xcode Chat',
    location: 'xcode',
    harness: 'Xcode',
    creationDate: conversation.createdAt * 1000,
    lastMessageDate: turns[turns.length - 1].createdAt * 1000,
    requests,
    hasDevcontainer: detectDevcontainerFromRequests(requests),
  });
}

export function parseXcodeDatabases(xcodeBase: string, editLocIndex?: EditLocIndex, sessionSourceIndex?: Map<string, SessionSource>): Session[] {
  const sessions: Session[] = [];
  const dbFiles = findXcodeDbFiles(xcodeBase);

  // Check sqlite3 is available (neutral cwd so the bare name can't resolve
  // against an attacker-controlled workspace dir — see the query calls above).
  try { execFileSync('sqlite3', ['--version'], { encoding: 'utf-8', ...SQLITE_PROBE_OPTS }); }
  catch (e) {
    console.debug('sqlite3 not available, skipping Xcode parsing:', e instanceof Error ? e.message : e);
    return sessions;
  }

  for (const dbPath of dbFiles) {
    let conversations: XcodeConversationRow[];
    try {
      const raw = sqliteQuery(dbPath, 'SELECT id, title, createdAt, updatedAt FROM Conversation');
      if (!raw.trim()) continue;
      conversations = JSON.parse(raw) as XcodeConversationRow[];
    } catch (e) {
      console.debug(`Failed to parse conversations from ${dbPath}:`, e instanceof Error ? e.message : e);
      continue;
    }

    for (const conv of conversations) {
      // Validate conversation ID to prevent SQL injection
      if (!/^[\w-]+$/.test(conv.id)) continue;

      let turns: XcodeTurnRow[];
      try {
        const raw = sqliteQuery(dbPath,
          `SELECT rowID, id, role, data, createdAt FROM Turn WHERE conversationID = ${sqlQuote(conv.id)} ORDER BY rowID`);
        if (!raw.trim()) continue;
        turns = JSON.parse(raw) as XcodeTurnRow[];
      } catch (e) {
        console.debug(`Failed to parse turns for conversation ${conv.id}:`, e instanceof Error ? e.message : e);
        continue;
      }

      const session = buildXcodeSession(conv, turns, editLocIndex, (turnId, error) => {
        console.debug(`Failed to parse turn data for turn ${turnId}:`, error instanceof Error ? error.message : error);
      });
      if (session) {
        sessions.push(session);
        recordXcodeSource(session, dbPath, sessionSourceIndex);
      }
    }
  }

  return sessions;
}

/** Async version with per-conversation yields and non-blocking sqlite3 queries. */
export async function parseXcodeDatabasesAsync(
  xcodeBase: string,
  editLocIndex?: EditLocIndex,
  sessionSourceIndex?: Map<string, SessionSource>,
): Promise<Session[]> {
  const sessions: Session[] = [];
  const dbFiles = findXcodeDbFiles(xcodeBase);

  // Check sqlite3 is available (neutral cwd — see note on the sync variant).
  try { execFileSync('sqlite3', ['--version'], { encoding: 'utf-8', ...SQLITE_PROBE_OPTS }); }
  catch { return sessions; }

  for (const dbPath of dbFiles) {
    let conversations: XcodeConversationRow[];
    try {
      const raw = await sqliteQueryAsync(dbPath, 'SELECT id, title, createdAt, updatedAt FROM Conversation');
      if (!raw.trim()) continue;
      conversations = JSON.parse(raw) as XcodeConversationRow[];
    } catch { continue; }

    for (const conv of conversations) {
      if (!/^[\w-]+$/.test(conv.id)) continue;

      let turns: XcodeTurnRow[];
      try {
        turns = await sqliteQueryTurnsAsync(dbPath, conv.id);
      } catch { continue; }

      const session = buildXcodeSession(conv, turns, editLocIndex);
      if (session) {
        sessions.push(session);
        recordXcodeSource(session, dbPath, sessionSourceIndex);
      }

      // Yield between conversations so the event loop stays responsive
      await new Promise<void>(r => setTimeout(r, 0));
    }
  }

  return sessions;
}

function recordXcodeSource(session: Session, dbPath: string, index?: Map<string, SessionSource>): void {
  index?.set(session.sessionId, {
    kind: 'xcode-db',
    filePath: dbPath,
    workspaceId: session.workspaceId,
    workspaceName: session.workspaceName,
    harness: session.harness,
  });
}

export function readXcodeImageReferences(dbPath: string, sessionId: string, requestId: string): ImageReference[] {
  try {
    const raw = sqliteQuery(dbPath,
      `SELECT data FROM Turn WHERE conversationID = ${sqlQuote(sessionId)} AND id = ${sqlQuote(requestId)} AND role = 'user'`);
    const rows: unknown = JSON.parse(raw || '[]');
    if (!Array.isArray(rows)) return [];
    const images: ImageReference[] = [];
    for (const value of rows) {
      const row: unknown = value;
      if (typeof row !== 'object' || row === null || !('data' in row) || typeof row.data !== 'string') continue;
      const data: unknown = JSON.parse(row.data);
      if (typeof data === 'object' && data !== null && 'contentImageReferences' in data) {
        images.push(...imageReferencesFromXcode(data.contentImageReferences));
      }
    }
    return images;
  } catch (error) {
    warnCore('image-extract', 'Could not read Xcode image references', error);
    return [];
  }
}

export function loadXcodeSession(dbPath: string, sessionId: string): Session | null {
  const conversations = JSON.parse(sqliteQuery(dbPath,
    `SELECT id, title, createdAt, updatedAt FROM Conversation WHERE id = ${sqlQuote(sessionId)}`) || '[]') as XcodeConversationRow[];
  if (!conversations[0]) return null;
  const turns = JSON.parse(sqliteQuery(dbPath,
    `SELECT rowID, id, role, data, createdAt FROM Turn WHERE conversationID = ${sqlQuote(sessionId)} ORDER BY rowID`) || '[]') as XcodeTurnRow[];
  return buildXcodeSession(conversations[0], turns);
}
