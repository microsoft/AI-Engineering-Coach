/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Cursor Agent session parser
 *
 * Data layout:
 *   ~/.cursor/projects/<encoded-workspace>/agent-transcripts/<session-id>/<session-id>.jsonl
 *   ~/.cursor/projects/<encoded-workspace>/agent-transcripts/<session-id>/subagents/<id>.jsonl
 *
 * Each JSONL line is typically:
 *   { "role": "user"|"assistant", "message": { "content": [ { type, text?, name?, input? } ] } }
 * or a meta marker:
 *   { "type": "turn_ended", "status": "success"|"error"|... }
 *
 * User text usually wraps the prompt as:
 *   <timestamp>...</timestamp>\n<user_query>...</user_query>
 *
 * Tokens / model ids are not present in these transcripts — leave them null / no-data
 * after a finalized turn (`turn_ended`). In-flight turns (assistant without turn_ended)
 * stay `pending`.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Session, SessionRequest } from './types';
import {
  assertTrustedPath,
  createRequest,
  createSession,
  detectDevcontainerFromRequests,
  extractSkillNameFromPath,
  readFileSafe,
} from './parser-shared';
import { warnCore } from './log';

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
  message?: CursorMessage;
}

interface CursorAssistantData {
  nextIndex: number;
  lastTs: number | null;
  assistantTexts: string[];
  toolsUsed: string[];
  editedFiles: string[];
  referencedFiles: string[];
  skillsUsed: string[];
  /** Absolute directory candidates for workspace-root inference (tool-role classified). */
  rootCandidates: string[];
  assistantCount: number;
  sawTurnEnded: boolean;
  turnEndedError: boolean;
}

/** Path kind for workspace-root LCP: files contribute their dirname; dirs as-is. */
type PathKind = 'file' | 'dir';

const CURSOR_WRITE_TOOLS = new Set(['Write', 'StrReplace', 'SearchReplace', 'Edit', 'ApplyPatch']);
const CURSOR_READ_FILE_TOOLS = new Set(['Read']);
const CURSOR_READ_PATH_TOOLS = new Set(['Glob', 'Grep', 'SemanticSearch', 'LS', 'Find']);

const TIMESTAMP_RE = /<timestamp>([\s\S]*?)<\/timestamp>/i;
const USER_QUERY_RE = /<user_query>([\s\S]*?)<\/user_query>/i;
const USER_QUERY_OPEN_RE = /<user_query>/i;

/** Per-parse cache so slug resolution is not repeated for name + root. */
const resolveCache = new Map<string, string | undefined>();

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
  if (value.content === undefined) return true;
  const content = value.content;
  if (typeof content === 'string') return true;
  return Array.isArray(content) && content.every(isCursorContentBlock);
}

function isCursorLine(value: unknown): value is CursorLine {
  if (!isRecord(value)) return false;
  if (value.role !== undefined && typeof value.role !== 'string') return false;
  if (value.type !== undefined && typeof value.type !== 'string') return false;
  if (value.status !== undefined && typeof value.status !== 'string') return false;
  if (value.message !== undefined && !isCursorMessage(value.message)) return false;
  return true;
}

function parseCursorLine(rawLine: string): CursorLine | null {
  try {
    const parsed: unknown = JSON.parse(rawLine);
    if (!isCursorLine(parsed)) return null;
    return parsed;
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

function getTextFromLine(line: CursorLine): string {
  return toContentArray(line.message?.content)
    .filter(block => block.type === 'text' && block.text)
    .map(block => block.text || '')
    .join('\n');
}

function extractUserQuery(text: string): string {
  const match = USER_QUERY_RE.exec(text);
  if (match) return match[1].trim();
  // Incomplete mid-write: open tag without close — keep text after the open tag.
  const open = USER_QUERY_OPEN_RE.exec(text);
  if (open) {
    return text.slice(open.index + open[0].length).replace(TIMESTAMP_RE, '').trim();
  }
  return text.replace(TIMESTAMP_RE, '').trim();
}

/** A user turn is a Coach request only when it carries a <user_query> marker
 *  (closed or still-open for incrementally written transcripts). Arbitrary
 *  role=user text is ignored — real Cursor Agent transcripts use this wrapper. */
function userHasRequestText(line: CursorLine): boolean {
  if (line.role !== 'user') return false;
  const text = getTextFromLine(line).trim();
  if (!text) return false;
  return USER_QUERY_OPEN_RE.test(text);
}

/** Parse Cursor's human-readable timestamp tags into epoch ms. */
export function parseCursorTimestamp(text: string | undefined): number | null {
  if (!text) return null;
  const match = TIMESTAMP_RE.exec(text);
  if (!match) return null;
  const raw = match[1].trim();
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

function getInputPath(input: Record<string, unknown> | undefined, key: string): string | null {
  const value = input?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isAbsoluteToolPath(p: string): boolean {
  return path.isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\') || p.startsWith('//');
}

function toRootCandidate(fileOrDir: string, kind: PathKind): string | undefined {
  if (!isAbsoluteToolPath(fileOrDir)) return undefined;
  const normalized = fileOrDir.replaceAll('\\', '/');
  if (kind === 'file') {
    const dir = path.posix.dirname(normalized);
    return fileOrDir.includes('\\') ? dir.replaceAll('/', '\\') : dir;
  }
  return fileOrDir;
}

function applyCursorToolBlock(
  block: CursorContentBlock,
  data: Pick<CursorAssistantData, 'toolsUsed' | 'editedFiles' | 'referencedFiles' | 'skillsUsed' | 'rootCandidates'>,
): void {
  if (block.type !== 'tool_use' || !block.name) return;

  data.toolsUsed.push(block.name);
  const input = block.input;

  if (CURSOR_WRITE_TOOLS.has(block.name)) {
    const filePath = getInputPath(input, 'path') || getInputPath(input, 'file_path');
    if (filePath) {
      data.editedFiles.push(filePath);
      const candidate = toRootCandidate(filePath, 'file');
      if (candidate) data.rootCandidates.push(candidate);
    }
    return;
  }

  if (CURSOR_READ_FILE_TOOLS.has(block.name)) {
    const filePath = getInputPath(input, 'path') || getInputPath(input, 'file_path');
    if (filePath) {
      data.referencedFiles.push(filePath);
      const candidate = toRootCandidate(filePath, 'file');
      if (candidate) data.rootCandidates.push(candidate);
    }
    return;
  }

  if (block.name === 'Grep') {
    const filePath = getInputPath(input, 'path');
    if (filePath) {
      data.referencedFiles.push(filePath);
      // Grep path may be a file or a directory; treat as dir candidate when no
      // extension-looking basename, otherwise as file. Prefer dirname of files.
      const base = path.posix.basename(filePath.replaceAll('\\', '/'));
      const kind: PathKind = /\.[A-Za-z0-9]+$/.test(base) ? 'file' : 'dir';
      const candidate = toRootCandidate(filePath, kind);
      if (candidate) data.rootCandidates.push(candidate);
    }
    return;
  }

  if (CURSOR_READ_PATH_TOOLS.has(block.name)) {
    const target =
      getInputPath(input, 'target_directory') ||
      getInputPath(input, 'path');
    if (target) {
      data.referencedFiles.push(target);
      const candidate = toRootCandidate(target, 'dir');
      if (candidate) data.rootCandidates.push(candidate);
    }
  }
}

function injectWriteToolCode(block: CursorContentBlock, assistantTexts: string[]): void {
  if (block.type !== 'tool_use' || !block.name || !CURSOR_WRITE_TOOLS.has(block.name) || !block.input) return;
  const filePath = getInputPath(block.input, 'path') || getInputPath(block.input, 'file_path');
  const code =
    typeof block.input.contents === 'string' ? block.input.contents
      : typeof block.input.content === 'string' ? block.input.content
        : typeof block.input.new_string === 'string' ? block.input.new_string
          : typeof block.input.new_str === 'string' ? block.input.new_str
            : null;
  if (!code || !filePath) return;
  const ext = filePath.split(/[/\\]/).pop()?.split('.').pop() || 'unknown';
  assistantTexts.push(`\`\`\`${ext}\n${code}\n\`\`\``);
}

function collectCursorAssistantData(lines: CursorLine[], startIndex: number, lastTs: number | null): CursorAssistantData {
  const data: CursorAssistantData = {
    nextIndex: startIndex,
    lastTs,
    assistantTexts: [],
    toolsUsed: [],
    editedFiles: [],
    referencedFiles: [],
    skillsUsed: [],
    rootCandidates: [],
    assistantCount: 0,
    sawTurnEnded: false,
    turnEndedError: false,
  };

  let i = startIndex;
  while (i < lines.length) {
    const next = lines[i];
    if (next.role === 'user' && userHasRequestText(next)) break;

    if (next.type === 'turn_ended') {
      data.sawTurnEnded = true;
      if (next.status && next.status !== 'success') data.turnEndedError = true;
      i++;
      continue;
    }

    if (next.role === 'assistant') {
      data.assistantCount++;
      const text = getTextFromLine(next);
      const assistantTs = parseCursorTimestamp(text);
      if (assistantTs && (!data.lastTs || assistantTs > data.lastTs)) data.lastTs = assistantTs;

      for (const block of toContentArray(next.message?.content)) {
        if (block.type === 'text' && block.text) {
          data.assistantTexts.push(block.text);
          continue;
        }
        applyCursorToolBlock(block, data);
        injectWriteToolCode(block, data.assistantTexts);
      }
    }
    i++;
  }

  data.nextIndex = i;
  return data;
}

function extractSkillsFromRefs(referencedFiles: string[]): string[] {
  const skills = new Set<string>();
  for (const ref of referencedFiles) {
    const name = extractSkillNameFromPath(ref);
    if (name) skills.add(name);
  }
  return [...skills];
}

function buildCursorRequest(
  userText: string,
  userTs: number | null,
  assistantData: CursorAssistantData,
  requestIndex: number,
  sessionId: string,
): SessionRequest {
  const uniqueRefs = [...new Set(assistantData.referencedFiles)];
  const skills = new Set(assistantData.skillsUsed);
  for (const name of extractSkillsFromRefs(uniqueRefs)) skills.add(name);

  // endState semantics (session-types / analyzer-consumption):
  //   errored  — turn finalized with a non-success status
  //   no-data  — turn finalized; Cursor JSONL never records tokens
  //   pending  — still in-flight / truncated (no turn_ended yet)
  let endState: 'pending' | 'errored' | 'no-data';
  if (assistantData.turnEndedError) endState = 'errored';
  else if (assistantData.sawTurnEnded) endState = 'no-data';
  else endState = 'pending';

  return createRequest({
    requestId: `${sessionId}-${requestIndex}`,
    timestamp: userTs,
    messageText: extractUserQuery(userText),
    responseText: assistantData.assistantTexts.join('\n'),
    agentName: 'Cursor',
    agentMode: 'agent',
    modelId: '',
    toolsUsed: assistantData.toolsUsed,
    editedFiles: [...new Set(assistantData.editedFiles)],
    referencedFiles: uniqueRefs,
    skillsUsed: [...skills],
    totalElapsed: userTs && assistantData.lastTs ? assistantData.lastTs - userTs : null,
    promptTokens: null,
    completionTokens: null,
    endState,
  });
}

function updateTimestampRange(
  ts: number | null,
  firstTs: number | null,
  lastTs: number | null,
): { firstTs: number | null; lastTs: number | null } {
  if (!ts) return { firstTs, lastTs };
  return {
    firstTs: !firstTs || ts < firstTs ? ts : firstTs,
    lastTs: !lastTs || ts > lastTs ? ts : lastTs,
  };
}

/**
 * Longest common ancestor of absolute directory candidates.
 * Callers must pass directories (not files) — tool-role classification happens upstream.
 * Exported for unit tests.
 */
export function inferWorkspaceRootFromPaths(dirs: string[]): string | undefined {
  const abs = dirs.filter(isAbsoluteToolPath);
  if (abs.length === 0) return undefined;

  const normalized = abs.map(p => p.replaceAll('\\', '/'));

  let common = normalized[0];
  for (let i = 1; i < normalized.length; i++) {
    while (common && !normalized[i].startsWith(common.endsWith('/') ? common : common + '/') && normalized[i] !== common) {
      const parent = path.posix.dirname(common);
      if (parent === common) {
        common = '';
        break;
      }
      common = parent;
    }
    if (!common) break;
  }
  if (!common || common === '/' || /^[A-Za-z]:\/?$/.test(common)) return undefined;

  if (abs[0].includes('\\')) return common.replaceAll('/', '\\');
  return common;
}

function encodeComponentForMatch(name: string): string {
  return name.replace(/\s/g, '-');
}

/**
 * Resolve a Cursor project directory slug back to a human workspace name.
 *
 * Cursor encoding is lossy (spaces, hyphens, and path separators all become `-`).
 * We recover a display name via best-effort filesystem matching when possible;
 * otherwise the encoded slug itself is used. Do not treat the result as a
 * guaranteed live path — check existsSync before using as workspaceRootPath.
 */
export function projectNameFromCursorEncoded(encoded: string, resolved?: string): string {
  const pathResolved = resolved !== undefined ? resolved : resolveCursorEncodedPath(encoded);
  if (pathResolved) {
    // Prefer basename only when the path exists (or is a confident full match).
    // Invented partial tails still yield a basename that is often the last folder.
    return path.basename(pathResolved);
  }
  return encoded;
}

/** Best-effort absolute path from a Cursor project slug. Results are cached per process. */
export function resolveCursorEncodedPath(encoded: string): string | undefined {
  if (resolveCache.has(encoded)) return resolveCache.get(encoded);

  const resolved = resolveCursorEncodedPathUncached(encoded);
  resolveCache.set(encoded, resolved);
  return resolved;
}

/** Clear the slug-resolve cache (tests only). */
export function clearCursorResolveCache(): void {
  resolveCache.clear();
}

function resolveCursorEncodedPathUncached(encoded: string): string | undefined {
  if (!encoded || /^\d+$/.test(encoded)) {
    return undefined;
  }

  const segments = encoded.split('-');
  let root: string;
  let startIdx: number;

  // Windows drive: "e-projects-..." → "E:\"
  if (segments.length >= 2 && /^[a-zA-Z]$/.test(segments[0])) {
    root = `${segments[0].toUpperCase()}:\\`;
    startIdx = 1;
  } else {
    // Unix-style: "home-user-..." → "/home/user/..."
    root = '/';
    startIdx = 0;
  }

  const remaining = segments.slice(startIdx).join('-');
  if (!remaining) return undefined;

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
      // Missing drive, permission denied, etc. — do not invent a path.
      return undefined;
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
      // Partial matches are ambiguous under a lossy encoding — refuse rather
      // than return a too-shallow path (e.g. `/home`) that happens to exist.
      return undefined;
    }
  }

  return resolved;
}

export function findCursorDirs(): string[] {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (!home) return [];
  const projectsDir = path.join(home, '.cursor', 'projects');
  if (fs.existsSync(projectsDir)) return [projectsDir];
  return [];
}

function pickWorkspaceRoot(decodedPath: string | undefined, toolCandidates: string[]): string | undefined {
  if (decodedPath && fs.existsSync(decodedPath)) return decodedPath;
  return inferWorkspaceRootFromPaths(toolCandidates);
}

function parseCursorSessionFile(
  filePath: string,
  wsId: string,
  wsName: string,
  decodedPath?: string,
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
  const rootCandidates: string[] = [];
  let firstTs: number | null = null;
  let lastTs: number | null = null;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!userHasRequestText(line)) {
      i++;
      continue;
    }

    const userText = getTextFromLine(line);
    const userTs = parseCursorTimestamp(userText);
    ({ firstTs, lastTs } = updateTimestampRange(userTs, firstTs, lastTs));

    const assistantData = collectCursorAssistantData(lines, i + 1, lastTs);
    lastTs = assistantData.lastTs ?? lastTs;
    for (const p of assistantData.rootCandidates) rootCandidates.push(p);

    requests.push(buildCursorRequest(userText, userTs, assistantData, requests.length, sessionId));
    i = assistantData.nextIndex;
  }

  if (requests.length === 0) return null;

  const workspaceRootPath = pickWorkspaceRoot(decodedPath, rootCandidates);
  return createSession({
    sessionId,
    workspaceId: wsId,
    workspaceName: wsName,
    location: 'panel',
    harness: 'Cursor',
    creationDate: firstTs,
    lastMessageDate: lastTs,
    requests,
    hasDevcontainer: detectDevcontainerFromRequests(requests, workspaceRootPath),
    workspaceRootPath,
  });
}

function parseCursorProjectSessions(
  projectsDir: string,
  dirName: string,
): { sessions: Session[]; workspaceId: string; workspaceName: string } | null {
  const projPath = path.join(projectsDir, dirName);
  const transcriptsRoot = path.join(projPath, 'agent-transcripts');
  if (!fs.existsSync(transcriptsRoot)) return null;

  const workspaceId = `cursor-${dirName}`;
  const decodedPath = resolveCursorEncodedPath(dirName);
  const workspaceName = projectNameFromCursorEncoded(dirName, decodedPath);

  let sessionDirs: fs.Dirent[];
  try {
    sessionDirs = fs.readdirSync(transcriptsRoot, { withFileTypes: true }).filter(e => e.isDirectory());
  } catch {
    return null;
  }

  const sessionsById = new Map<string, Session>();
  const sessions: Session[] = [];
  const existingDecoded = decodedPath && fs.existsSync(decodedPath) ? decodedPath : undefined;

  // Pass 1: parent session JSONL files
  for (const entry of sessionDirs) {
    const sessionFile = path.join(transcriptsRoot, entry.name, `${entry.name}.jsonl`);
    if (!fs.existsSync(sessionFile)) continue;
    const session = parseCursorSessionFile(sessionFile, workspaceId, workspaceName, existingDecoded);
    if (!session) continue;
    sessions.push(session);
    sessionsById.set(session.sessionId, session);
  }

  // Pass 2: merge subagents into parents (or emit orphans) — Claude pattern
  for (const entry of sessionDirs) {
    const subagentDir = path.join(transcriptsRoot, entry.name, 'subagents');
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
        existingDecoded,
      );
      if (!subSession) continue;

      if (parent) {
        for (const r of subSession.requests) parent.requests.push(r);
        if (subSession.lastMessageDate &&
            (!parent.lastMessageDate || subSession.lastMessageDate > parent.lastMessageDate)) {
          parent.lastMessageDate = subSession.lastMessageDate;
        }
        if (subSession.creationDate &&
            (!parent.creationDate || subSession.creationDate < parent.creationDate)) {
          parent.creationDate = subSession.creationDate;
        }
        if (!parent.workspaceRootPath && subSession.workspaceRootPath) {
          parent.workspaceRootPath = subSession.workspaceRootPath;
        }
      } else {
        for (const r of subSession.requests) orphanRequests.push(r);
        if (subSession.creationDate &&
            (!orphanFirstTs || subSession.creationDate < orphanFirstTs)) {
          orphanFirstTs = subSession.creationDate;
        }
        if (subSession.lastMessageDate &&
            (!orphanLastTs || subSession.lastMessageDate > orphanLastTs)) {
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
        workspaceRootPath: existingDecoded,
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

export function parseCursorSessions(projectsDir: string): { sessions: Session[]; workspaceId: string; workspaceName: string }[] {
  const results: { sessions: Session[]; workspaceId: string; workspaceName: string }[] = [];

  let projectDirs: fs.Dirent[];
  try {
    projectDirs = fs.readdirSync(projectsDir, { withFileTypes: true }).filter(e => e.isDirectory());
  } catch {
    return results;
  }

  for (const projDir of projectDirs) {
    const result = parseCursorProjectSessions(projectsDir, projDir.name);
    if (result) results.push(result);
  }

  return results;
}

export async function parseCursorSessionsAsync(
  projectsDir: string,
  onProject?: (idx: number, total: number, name: string) => void,
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
    const decoded = resolveCursorEncodedPath(dirName);
    const workspaceName = projectNameFromCursorEncoded(dirName, decoded);
    if (onProject) onProject(i + 1, projectDirs.length, workspaceName);

    const result = parseCursorProjectSessions(projectsDir, dirName);
    if (result) results.push(result);

    if (i % 5 === 0) await new Promise<void>(r => setTimeout(r, 0));
  }

  return results;
}
