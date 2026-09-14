/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Cursor Agent session parser
 *
 * Data layout:
 *   ~/.cursor/projects/<encoded-workspace>/agent-transcripts/<session-uuid>/<session-uuid>.jsonl
 *   ~/.cursor/projects/<encoded-workspace>/agent-transcripts/<session-uuid>/subagents/<id>.jsonl
 *
 * Each .jsonl file is a session. Lines have { role: 'user'|'assistant', message: { content: [...] } }
 * or { type: 'turn_ended', status: 'success'|... }.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Session, SessionRequest, ToolConfirmation } from './types';
import {
  assertTrustedPath,
  readFileSafe,
  createRequest,
  createSession,
  detectDevcontainerFromRequests,
  extractSkillNameFromPath,
} from './parser-shared';
import { warnCore } from './log';
import { EditLocIndex } from './edit-loc-diff';
import {
  FileEditLocMap,
  mergeRequestEditLoc,
  recordContentReplacement,
  recordCreatedContent,
} from './edit-tool-diff';

interface CursorContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface CursorMessage {
  content?: CursorContentBlock[] | string;
}

interface CursorLine {
  role?: string;
  type?: string;
  status?: string;
  error?: string;
  message?: CursorMessage;
}

interface CursorAssistantData {
  nextIndex: number;
  assistantTexts: string[];
  toolsUsed: string[];
  editedFiles: string[];
  referencedFiles: string[];
  skillsUsed: string[];
  toolConfirmations: ToolConfirmation[];
  editLocs: FileEditLocMap;
  turnEndStatus: string | undefined;
  turnEndError: string | undefined;
}

const CURSOR_WRITE_TOOLS = new Set(['Write', 'StrReplace']);
const CURSOR_DELETE_TOOLS = new Set(['Delete']);
const CURSOR_READ_FILE_TOOLS = new Set(['Read']);
const CURSOR_READ_PATH_TOOLS = new Set(['Grep', 'Glob']);

const USER_QUERY_RE = /<user_query>([\s\S]*?)<\/user_query>/i;
const TIMESTAMP_RE = /<timestamp>([\s\S]*?)<\/timestamp>/i;
const SYSTEM_NOTIFICATION_RE = /<system_notification>[\s\S]*?<\/system_notification>/gi;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCursorContentBlock(value: unknown): value is CursorContentBlock {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  if (value.text !== undefined && typeof value.text !== 'string') return false;
  if (value.name !== undefined && typeof value.name !== 'string') return false;
  if (value.input !== undefined && value.input !== null && !isRecord(value.input)) return false;
  return true;
}

function isCursorMessage(value: unknown): value is CursorMessage {
  if (!isRecord(value)) return false;
  if (value.content !== undefined) {
    const content = value.content;
    if (typeof content !== 'string' && (!Array.isArray(content) || !content.every(isCursorContentBlock))) {
      return false;
    }
  }
  return true;
}

function isCursorLine(value: unknown): value is CursorLine {
  if (!isRecord(value)) return false;
  if (value.role !== undefined && typeof value.role !== 'string') return false;
  if (value.type !== undefined && typeof value.type !== 'string') return false;
  if (value.status !== undefined && typeof value.status !== 'string') return false;
  if (value.error !== undefined && typeof value.error !== 'string') return false;
  if (value.message !== undefined && !isCursorMessage(value.message)) return false;
  return value.role !== undefined || value.type !== undefined;
}

function parseCursorLine(rawLine: string): CursorLine | null {
  try {
    const parsed: unknown = JSON.parse(rawLine);
    return isCursorLine(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseCursorLines(raw: string): CursorLine[] {
  const lines: CursorLine[] = [];
  for (const rawLine of raw.split('\n')) {
    if (!rawLine.trim()) continue;
    const parsed = parseCursorLine(rawLine);
    if (parsed) lines.push(parsed);
  }
  return lines;
}

function toContentArray(content: CursorContentBlock[] | string | undefined): CursorContentBlock[] {
  if (Array.isArray(content)) return content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return [];
}

function getCursorUserText(line: CursorLine): string {
  return toContentArray(line.message?.content)
    .filter(block => block.type === 'text')
    .map(block => block.text || '')
    .join('\n');
}

function getInputPath(input: Record<string, unknown> | undefined, key: string): string | null {
  const value = input?.[key];
  return typeof value === 'string' ? value : null;
}

function extractUserQueryText(userText: string): string | null {
  const match = USER_QUERY_RE.exec(userText);
  return match ? match[1].trim() : null;
}

function extractUserTimestampMs(userText: string): number | null {
  const match = TIMESTAMP_RE.exec(userText);
  if (!match) return null;
  const ts = new Date(match[1].trim()).getTime();
  return Number.isFinite(ts) ? ts : null;
}

function cursorUserHasQuery(line: CursorLine): boolean {
  const userText = getCursorUserText(line);
  if (!userText.trim()) return false;
  if (!USER_QUERY_RE.test(userText)) return false;
  const withoutNotifications = userText.replace(SYSTEM_NOTIFICATION_RE, '').trim();
  if (!USER_QUERY_RE.test(withoutNotifications)) return false;
  return true;
}

function isAbortLike(status?: string, error?: string): boolean {
  const combined = `${status ?? ''} ${error ?? ''}`.toLowerCase();
  return combined.includes('abort') || combined.includes('cancel');
}

function applyCursorToolBlock(
  block: CursorContentBlock,
  data: Pick<CursorAssistantData, 'toolsUsed' | 'editedFiles' | 'referencedFiles' | 'skillsUsed' | 'toolConfirmations' | 'editLocs'>,
): void {
  if (block.type !== 'tool_use' || !block.name) return;

  data.toolsUsed.push(block.name);

  if (block.name === 'Shell') {
    const command = getInputPath(block.input, 'command');
    if (command) {
      data.toolConfirmations.push({
        toolId: 'Shell',
        confirmationType: 0,
        isTerminal: true,
        commandLine: command,
      });
    }
    return;
  }

  if (CURSOR_WRITE_TOOLS.has(block.name)) {
    const filePath = getInputPath(block.input, 'path');
    if (filePath) {
      data.editedFiles.push(filePath);
      if (block.name === 'Write') {
        const content = getInputPath(block.input, 'contents');
        if (content !== null) recordCreatedContent(data.editLocs, filePath, content);
      } else if (block.name === 'StrReplace') {
        const previous = getInputPath(block.input, 'old_string') ?? '';
        const next = getInputPath(block.input, 'new_string') ?? '';
        if (previous || next) recordContentReplacement(data.editLocs, filePath, previous, next);
      }
    }
    return;
  }

  if (CURSOR_DELETE_TOOLS.has(block.name)) {
    const filePath = getInputPath(block.input, 'path');
    if (filePath) data.editedFiles.push(filePath);
    return;
  }

  if (CURSOR_READ_FILE_TOOLS.has(block.name)) {
    const filePath = getInputPath(block.input, 'path');
    if (filePath) {
      data.referencedFiles.push(filePath);
      const skillName = extractSkillNameFromPath(filePath);
      if (skillName) data.skillsUsed.push(skillName);
    }
    return;
  }

  if (CURSOR_READ_PATH_TOOLS.has(block.name)) {
    const targetPath = getInputPath(block.input, 'path')
      ?? getInputPath(block.input, 'target_directory');
    if (targetPath) data.referencedFiles.push(targetPath);
  }
}

function collectCursorAssistantData(lines: CursorLine[], startIndex: number): CursorAssistantData {
  const data: CursorAssistantData = {
    nextIndex: startIndex,
    assistantTexts: [],
    toolsUsed: [],
    editedFiles: [],
    referencedFiles: [],
    skillsUsed: [],
    toolConfirmations: [],
    editLocs: new Map(),
    turnEndStatus: undefined,
    turnEndError: undefined,
  };

  let i = startIndex;
  while (i < lines.length) {
    const line = lines[i];
    if (line.role === 'user' && cursorUserHasQuery(line)) break;
    if (line.type === 'turn_ended') {
      data.turnEndStatus = line.status;
      data.turnEndError = line.error;
      i++;
      break;
    }
    if (line.role === 'assistant') {
      for (const block of toContentArray(line.message?.content)) {
        if (block.type === 'text' && block.text) {
          data.assistantTexts.push(block.text);
          continue;
        }
        applyCursorToolBlock(block, data);
      }
    }
    i++;
  }

  data.nextIndex = i;
  return data;
}

function computeCursorEndState(assistantData: CursorAssistantData): {
  endState: 'pending' | 'errored' | 'no-data';
  isCanceled: boolean;
} {
  if (assistantData.turnEndStatus === undefined) {
    return { endState: 'pending', isCanceled: false };
  }
  if (assistantData.turnEndStatus !== 'success') {
    return {
      endState: 'errored',
      isCanceled: isAbortLike(assistantData.turnEndStatus, assistantData.turnEndError),
    };
  }
  return { endState: 'no-data', isCanceled: false };
}

function buildCursorRequest(
  userText: string,
  assistantData: CursorAssistantData,
  userTs: number | null,
  requestIndex: number,
  sessionId: string,
  editLocIndex?: EditLocIndex,
): SessionRequest {
  const messageText = extractUserQueryText(userText) ?? '';
  const { endState, isCanceled } = computeCursorEndState(assistantData);
  const uniqueTools = [...new Set(assistantData.toolsUsed)];
  const uniqueRefs = [...new Set(assistantData.referencedFiles)];
  const requestId = `${sessionId}:cursor:${requestIndex}`;
  const request = createRequest({
    requestId,
    timestamp: userTs,
    messageText,
    responseText: assistantData.assistantTexts.join('\n'),
    isCanceled,
    agentName: 'Cursor',
    agentMode: 'agent',
    modelId: '',
    toolsUsed: uniqueTools,
    editedFiles: [...new Set(assistantData.editedFiles)],
    referencedFiles: uniqueRefs,
    skillsUsed: [...new Set(assistantData.skillsUsed)],
    toolConfirmations: assistantData.toolConfirmations,
    promptTokens: null,
    completionTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    endState,
  });
  mergeRequestEditLoc(editLocIndex, requestId, assistantData.editLocs);
  return request;
}

function updateTimestampRange(
  ts: number | null,
  firstTs: number | null,
  lastTs: number | null,
): { firstTs: number | null; lastTs: number | null } {
  if (ts == null) return { firstTs, lastTs };
  return {
    firstTs: firstTs == null || ts < firstTs ? ts : firstTs,
    lastTs: lastTs == null || ts > lastTs ? ts : lastTs,
  };
}

function parseCursorSessionFile(
  filePath: string,
  wsId: string,
  wsName: string,
  workspaceRootPath?: string,
  editLocIndex?: EditLocIndex,
): Session | null {
  assertTrustedPath(filePath);
  let raw: string;
  try {
    const content = readFileSafe(filePath);
    if (content === null) return null;
    raw = content;
  } catch {
    return null;
  }

  const lines = parseCursorLines(raw);
  if (lines.length === 0) return null;

  const sessionId = path.basename(filePath, '.jsonl');
  const requests: SessionRequest[] = [];
  let firstTs: number | null = null;
  let lastTs: number | null = null;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line.role !== 'user' || !cursorUserHasQuery(line)) {
      i++;
      continue;
    }

    const userText = getCursorUserText(line);
    const userTs = extractUserTimestampMs(userText);
    ({ firstTs, lastTs } = updateTimestampRange(userTs, firstTs, lastTs));

    const assistantData = collectCursorAssistantData(lines, i + 1);
    requests.push(buildCursorRequest(userText, assistantData, userTs, requests.length, sessionId, editLocIndex));
    i = assistantData.nextIndex;
  }

  if (requests.length === 0) return null;

  return createSession({
    sessionId,
    workspaceId: wsId,
    workspaceName: wsName,
    location: 'panel',
    harness: 'Cursor',
    creationDate: firstTs,
    lastMessageDate: lastTs,
    requests,
    hasDevcontainer: detectDevcontainerFromRequests(requests, workspaceRootPath ?? ''),
    workspaceRootPath,
  });
}

export function findCursorDirs(): string[] {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const dirs: string[] = [];
  const projectsDir = path.join(home, '.cursor', 'projects');
  if (fs.existsSync(projectsDir)) dirs.push(projectsDir);
  return dirs;
}

/** Encode a single filesystem component the way Cursor does:
 *  replace whitespace with hyphens. */
function encodeComponentForMatch(name: string): string {
  return name.replace(/\s/g, '-');
}

/** Resolve an encoded project directory name back to the real absolute path. */
function workspaceRootPathFromEncoded(encoded: string, _projectsDir: string): string | undefined {
  const segments = encoded.split('-');
  let root: string;
  let startIdx: number;

  if (segments.length >= 2 && /^[a-zA-Z]$/.test(segments[0]) && segments[1] === '') {
    root = `${segments[0]}:\\`;
    startIdx = 2;
  } else if (segments[0] === '') {
    root = '/';
    startIdx = 1;
  } else {
    return undefined;
  }

  const remaining = segments.slice(startIdx).join('-');
  let resolved = root;
  let offset = 0;

  while (offset < remaining.length) {
    let dirEntries: { name: string; encoded: string }[];
    try {
      dirEntries = fs.readdirSync(resolved, { withFileTypes: true })
        .filter(e => e.isDirectory() || e.isSymbolicLink())
        .map(e => ({ name: e.name, encoded: encodeComponentForMatch(e.name) }))
        .sort((a, b) => b.encoded.length - a.encoded.length);
    } catch {
      break;
    }

    const rest = remaining.slice(offset);
    let found = false;
    for (const entry of dirEntries) {
      if (rest === entry.encoded) {
        resolved = path.join(resolved, entry.name);
        offset = remaining.length;
        found = true;
        break;
      }
      if (rest.startsWith(entry.encoded + '-')) {
        resolved = path.join(resolved, entry.name);
        offset += entry.encoded.length + 1;
        found = true;
        break;
      }
    }

    if (!found) {
      resolved = path.join(resolved, rest);
      break;
    }
  }

  return fs.existsSync(resolved) ? resolved : undefined;
}

function projectNameFromEncoded(encoded: string, projectsDir: string): string {
  const rootPath = workspaceRootPathFromEncoded(encoded, projectsDir);
  return rootPath ? path.basename(rootPath) : encoded;
}

function parseCursorProjectSessions(
  projectsDir: string,
  dirName: string,
  editLocIndex?: EditLocIndex,
): { sessions: Session[]; workspaceId: string; workspaceName: string } | null {
  const projPath = path.join(projectsDir, dirName);
  const transcriptsDir = path.join(projPath, 'agent-transcripts');
  if (!fs.existsSync(transcriptsDir)) return null;

  const workspaceId = `cursor-${dirName}`;
  const workspaceName = projectNameFromEncoded(dirName, projectsDir);
  const workspaceRootPath = workspaceRootPathFromEncoded(dirName, projectsDir);

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(transcriptsDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const sessionsById = new Map<string, Session>();
  const sessions: Session[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sessionFile = path.join(transcriptsDir, entry.name, `${entry.name}.jsonl`);
    if (!fs.existsSync(sessionFile)) continue;
    const session = parseCursorSessionFile(sessionFile, workspaceId, workspaceName, workspaceRootPath, editLocIndex);
    if (!session) continue;
    sessions.push(session);
    sessionsById.set(session.sessionId, session);
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const subagentDir = path.join(transcriptsDir, entry.name, 'subagents');
    let subagentEntries: fs.Dirent[];
    try {
      subagentEntries = fs.readdirSync(subagentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    const parent = sessionsById.get(entry.name);
    const orphanRequests: SessionRequest[] = [];
    let orphanFirstTs: number | null = null;
    let orphanLastTs: number | null = null;

    for (const subEntry of subagentEntries) {
      if (!subEntry.isFile() || !subEntry.name.endsWith('.jsonl')) continue;
      const subSession = parseCursorSessionFile(
        path.join(subagentDir, subEntry.name),
        workspaceId,
        workspaceName,
        workspaceRootPath,
        editLocIndex,
      );
      if (!subSession) continue;

      if (parent) {
        for (const r of subSession.requests) parent.requests.push(r);
        if (subSession.lastMessageDate != null &&
            (parent.lastMessageDate == null || subSession.lastMessageDate > parent.lastMessageDate)) {
          parent.lastMessageDate = subSession.lastMessageDate;
        }
      } else {
        for (const r of subSession.requests) orphanRequests.push(r);
        if (subSession.creationDate != null &&
            (orphanFirstTs == null || subSession.creationDate < orphanFirstTs)) {
          orphanFirstTs = subSession.creationDate;
        }
        if (subSession.lastMessageDate != null &&
            (orphanLastTs == null || subSession.lastMessageDate > orphanLastTs)) {
          orphanLastTs = subSession.lastMessageDate;
        }
      }
    }

    if (parent) continue;

    if (orphanRequests.length > 0) {
      warnCore('parser-cursor', `subagent dir without parent session: ${entry.name}`, {
        requestCount: orphanRequests.length,
      });
      orphanRequests.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
      const orphan = createSession({
        sessionId: entry.name,
        workspaceId,
        workspaceName,
        location: 'panel',
        harness: 'Cursor',
        creationDate: orphanFirstTs,
        lastMessageDate: orphanLastTs,
        requests: orphanRequests,
        workspaceRootPath,
      });
      sessions.push(orphan);
    }
  }

  for (const session of sessions) {
    if (session.requests.length > 1) {
      session.requests.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
    }
    session.requestCount = session.requests.length;
  }

  return sessions.length > 0 ? { sessions, workspaceId, workspaceName } : null;
}

export function parseCursorSessions(
  projectsDir: string,
  editLocIndex?: EditLocIndex,
): { sessions: Session[]; workspaceId: string; workspaceName: string }[] {
  const results: { sessions: Session[]; workspaceId: string; workspaceName: string }[] = [];

  let projectDirs: fs.Dirent[];
  try {
    projectDirs = fs.readdirSync(projectsDir, { withFileTypes: true }).filter(e => e.isDirectory());
  } catch {
    return results;
  }

  for (const projDir of projectDirs) {
    const result = parseCursorProjectSessions(projectsDir, projDir.name, editLocIndex);
    if (result) results.push(result);
  }

  return results;
}

export async function parseCursorSessionsAsync(
  projectsDir: string,
  onProject?: (idx: number, total: number, name: string) => void,
  editLocIndex?: EditLocIndex,
): Promise<{ sessions: Session[]; workspaceId: string; workspaceName: string }[]> {
  const results: { sessions: Session[]; workspaceId: string; workspaceName: string }[] = [];

  let projectDirs: string[];
  try {
    projectDirs = (await fs.promises.readdir(projectsDir, { withFileTypes: true }))
      .filter(e => e.isDirectory())
      .map(e => e.name);
  } catch {
    return results;
  }

  for (let i = 0; i < projectDirs.length; i++) {
    const dirName = projectDirs[i];
    const workspaceName = projectNameFromEncoded(dirName, projectsDir);

    if (onProject) onProject(i + 1, projectDirs.length, workspaceName);

    const result = parseCursorProjectSessions(projectsDir, dirName, editLocIndex);
    if (result) results.push(result);

    if (i % 5 === 0) await new Promise<void>(r => setTimeout(r, 0));
  }

  return results;
}
