/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Claude session parser
 *
 * Data layout (macOS):
 *   ~/.claude/projects/<encoded-project-path>/<session-uuid>.jsonl
 *
 * Each .jsonl file is a session. Lines have { type: 'user'|'assistant'|'queue-operation'|'last-prompt', ... }
 *
 * user lines:   message.content[].text, timestamp, cwd, sessionId, version, gitBranch
 * assistant lines: message.content[] with type 'thinking'|'text'|'tool_use',
 *                  message.model, message.usage, timestamp
 */

import * as fs from 'fs';
import * as path from 'path';
import { Session, SessionRequest } from './types';
import { assertTrustedPath, readFileSafe, createRequest, createSession, detectDevcontainerFromRequests, extractSkillNameFromPath } from './parser-shared';
import { extractReasoningEffortFromModelId } from './helpers';
import { warnCore } from './log';
import { EditLocIndex } from './edit-loc-diff';
import {
  FileEditLocMap,
  mergeRequestEditLoc,
  recordContentReplacement,
  recordCreatedContent,
} from './edit-tool-diff';

interface ClaudeContentBlock {
  type: string;
  id?: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  is_error?: boolean;
}

interface ClaudeMessage {
  role?: string;
  model?: string;
  content?: ClaudeContentBlock[] | string;
  usage?: Record<string, unknown>;
}

interface ClaudeLine {
  type: string;
  uuid?: string;
  parentUuid?: string;
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  version?: string;
  gitBranch?: string;
  /** Set from CLAUDE_CODE_ENTRYPOINT env var at launch time. Known values:
   *  cli, sdk-ts, sdk-py, sdk-cli, mcp, claude-code-github-action,
   *  claude-desktop, local-agent. Used to classify the session as
   *  interactive (cli, claude-desktop) vs programmatic (everything else). */
  entrypoint?: string;
  /** True on subagent lines (`<sessionId>/subagents/agent-*.jsonl` files).
   *  Carried through so callers can roll subagent requests up into the
   *  parent session rather than treating them as standalone sessions. */
  isSidechain?: boolean;
  /** Subagent identifier on `subagents/` files. Present alongside
   *  `isSidechain: true`. Not used for billing math; surfaced for diagnostics. */
  agentId?: string;
  message?: ClaudeMessage;
}

/** Allow-list of `entrypoint` values that indicate the user launched Claude
 *  Code interactively. Anything outside this set (sdk-ts, sdk-py, mcp,
 *  claude-code-github-action, local-agent, unknown, missing) is treated as
 *  programmatic — i.e. spawned by another tool. Defaulting unknown values to
 *  programmatic is the safer choice: it keeps standalone Claude usage
 *  conservative (under-attributed rather than over-attributed). */
const INTERACTIVE_ENTRYPOINTS: ReadonlySet<string> = new Set(['cli', 'claude-desktop']);

function classifyLauncher(entrypoint: string | undefined): 'interactive' | 'programmatic' {
  return entrypoint && INTERACTIVE_ENTRYPOINTS.has(entrypoint) ? 'interactive' : 'programmatic';
}

function harnessForLauncher(_launcherKind: 'interactive' | 'programmatic'): string {
  return 'Claude';
}

interface ClaudeAssistantData {
  nextIndex: number;
  lastTs: number | null;
  assistantTexts: string[];
  toolsUsed: string[];
  editedFiles: string[];
  referencedFiles: string[];
  skillsUsed: string[];
  model: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  assistantCount: number;
  editLocs: FileEditLocMap;
}

const CLAUDE_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'MultiEditTool']);
const CLAUDE_READ_FILE_TOOLS = new Set(['Read', 'View']);
const CLAUDE_READ_PATH_TOOLS = new Set(['Glob', 'LS', 'Find']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isClaudeContentBlock(value: unknown): value is ClaudeContentBlock {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  if (value.id !== undefined && typeof value.id !== 'string') return false;
  if (value.text !== undefined && typeof value.text !== 'string') return false;
  if (value.name !== undefined && typeof value.name !== 'string') return false;
  if (value.input !== undefined && value.input !== null && !isRecord(value.input)) return false;
  if (value.tool_use_id !== undefined && typeof value.tool_use_id !== 'string') return false;
  if (value.is_error !== undefined && typeof value.is_error !== 'boolean') return false;
  return true;
}

function isClaudeMessage(value: unknown): value is ClaudeMessage {
  if (!isRecord(value)) return false;
  if (value.role !== undefined && typeof value.role !== 'string') return false;
  if (value.model !== undefined && typeof value.model !== 'string') return false;
  if (value.content !== undefined) {
    const content = value.content;
    if (typeof content !== 'string' && (!Array.isArray(content) || !content.every(isClaudeContentBlock))) {
      return false;
    }
  }
  if (value.usage !== undefined && !isRecord(value.usage)) return false;
  return true;
}

function isClaudeLine(value: unknown): value is ClaudeLine {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  if (value.uuid !== undefined && typeof value.uuid !== 'string' && typeof value.uuid !== 'number') return false;
  if (value.parentUuid !== undefined && value.parentUuid !== null && typeof value.parentUuid !== 'string' && typeof value.parentUuid !== 'number') return false;
  if (value.sessionId !== undefined && typeof value.sessionId !== 'string') return false;
  if (value.timestamp !== undefined && typeof value.timestamp !== 'string' && typeof value.timestamp !== 'number') return false;
  if (value.cwd !== undefined && typeof value.cwd !== 'string') return false;
  if (value.version !== undefined && typeof value.version !== 'string') return false;
  if (value.gitBranch !== undefined && typeof value.gitBranch !== 'string') return false;
  if (value.entrypoint !== undefined && typeof value.entrypoint !== 'string') return false;
  if (value.isSidechain !== undefined && typeof value.isSidechain !== 'boolean') return false;
  if (value.agentId !== undefined && typeof value.agentId !== 'string') return false;
  if (value.message !== undefined && !isClaudeMessage(value.message)) return false;
  return true;
}

function parseClaudeLine(rawLine: string): ClaudeLine | null {
  try {
    const parsed: unknown = JSON.parse(rawLine);
    if (!isClaudeLine(parsed)) return null;
    const record = parsed as unknown as Record<string, unknown>;
    if (typeof record.uuid === 'number') record.uuid = String(record.uuid);
    if (typeof record.parentUuid === 'number') record.parentUuid = String(record.parentUuid);
    if (typeof record.timestamp === 'number') record.timestamp = new Date(record.timestamp).toISOString();
    return parsed;
  } catch {
    return null;
  }
}

function parseClaudeLines(raw: string): ClaudeLine[] {
  const lines: ClaudeLine[] = [];
  for (const rawLine of raw.split('\n')) {
    if (!rawLine.trim()) continue;
    const parsed = parseClaudeLine(rawLine);
    if (parsed) lines.push(parsed);
  }
  return lines;
}

function toContentArray(content: ClaudeContentBlock[] | string | undefined): ClaudeContentBlock[] {
  if (Array.isArray(content)) return content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return [];
}

function userHasText(line: ClaudeLine): boolean {
  const content = line.message?.content;
  let text: string;
  if (typeof content === 'string') {
    text = content.trim();
  } else if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block.type === 'text' && block.text) parts.push(block.text);
    }
    text = parts.join('\n').trim();
  } else {
    return false;
  }
  if (text.length === 0) return false;
  // Claude wraps slash-command input/output in <command-...> / <local-command-...> tags
  if (/^<(local-)?command-/.test(text)) return false;
  // Interrupt markers are auto-injected when the user cancels a tool call
  if (text.startsWith('[Request interrupted')) return false;
  return true;
}

function getTimestamp(timestamp?: string): number | null {
  return timestamp ? new Date(timestamp).getTime() : null;
}

function getNumberField(record: Record<string, unknown> | undefined, key: string): number {
  const value = record?.[key];
  return typeof value === 'number' ? value : 0;
}

function getInputPath(input: Record<string, unknown> | undefined, key: string): string | null {
  const value = input?.[key];
  return typeof value === 'string' ? value : null;
}

function getClaudeUserText(line: ClaudeLine): string {
  return toContentArray(line.message?.content)
    .filter(block => block.type === 'text')
    .map(block => block.text || '')
    .join('\n');
}

function countClaudeImages(line: ClaudeLine): number {
  return toContentArray(line.message?.content)
    .filter(block => block.type === 'image').length;
}

/** Record `sourceFilePath` on image-bearing requests so the source index can
 *  re-read their images from the right file after they are merged into another
 *  session (Claude subagent files rolled up into their parent). Only requests
 *  that carry images need it; the rest fall back to the session source file. */
function stampSubagentImageSource(requests: SessionRequest[], sourceFilePath: string | undefined): void {
  if (!sourceFilePath) return;
  for (const r of requests) {
    if ((r.variableKinds.image ?? 0) > 0) r.sourceFilePath = sourceFilePath;
  }
}

function applyClaudeToolBlock(
  block: ClaudeContentBlock,
  data: Pick<ClaudeAssistantData, 'toolsUsed' | 'editedFiles' | 'referencedFiles' | 'skillsUsed' | 'editLocs'>,
  failed: boolean,
): void {
  if (block.type !== 'tool_use' || !block.name) return;

  data.toolsUsed.push(block.name);
  if (failed) return;

  // Claude Code's Skill tool: { name: 'Skill', input: { skill: '<name>', args: '...' } }
  if (block.name === 'Skill') {
    const skillName = getInputPath(block.input, 'skill')?.trim();
    if (skillName && !skillName.includes('ai_toolkit')) data.skillsUsed.push(skillName);
    return;
  }
  if (CLAUDE_WRITE_TOOLS.has(block.name)) {
    const filePath = getInputPath(block.input, 'file_path');
    if (filePath) {
      data.editedFiles.push(filePath);
      if (block.name === 'Write') {
        const content = getInputPath(block.input, 'content');
        if (content !== null) recordCreatedContent(data.editLocs, filePath, content);
      } else if (block.name === 'Edit') {
        const previous = getInputPath(block.input, 'old_string')
          ?? getInputPath(block.input, 'old_str')
          ?? '';
        const next = getInputPath(block.input, 'new_string')
          ?? getInputPath(block.input, 'new_str')
          ?? '';
        if (previous || next) recordContentReplacement(data.editLocs, filePath, previous, next);
      } else if (Array.isArray(block.input?.edits)) {
        for (const rawEdit of block.input.edits) {
          if (!isRecord(rawEdit)) continue;
          const previous = getInputPath(rawEdit, 'old_string')
            ?? getInputPath(rawEdit, 'old_str')
            ?? '';
          const next = getInputPath(rawEdit, 'new_string')
            ?? getInputPath(rawEdit, 'new_str')
            ?? '';
          if (previous || next) recordContentReplacement(data.editLocs, filePath, previous, next);
        }
      }
    }
    return;
  }

  if (CLAUDE_READ_FILE_TOOLS.has(block.name)) {
    const filePath = getInputPath(block.input, 'file_path');
    if (filePath) data.referencedFiles.push(filePath);
    return;
  }

  if (CLAUDE_READ_PATH_TOOLS.has(block.name)) {
    const targetPath = getInputPath(block.input, 'path');
    if (targetPath) data.referencedFiles.push(targetPath);
  }
}

function collectClaudeToolResults(
  lines: ClaudeLine[],
  startIndex: number,
): { completed: Set<string>; failed: Set<string> } {
  const completed = new Set<string>();
  const failed = new Set<string>();
  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i];
    if (line.type === 'user' && userHasText(line)) break;
    if (line.type !== 'user') continue;
    for (const block of toContentArray(line.message?.content)) {
      if (block.type !== 'tool_result' || !block.tool_use_id) continue;
      completed.add(block.tool_use_id);
      if (block.is_error === true) failed.add(block.tool_use_id);
    }
  }
  return { completed, failed };
}

function collectClaudeAssistantData(lines: ClaudeLine[], startIndex: number, lastTs: number | null): ClaudeAssistantData {
  const data: ClaudeAssistantData = {
    nextIndex: startIndex,
    lastTs,
    assistantTexts: [],
    toolsUsed: [],
    editedFiles: [],
    referencedFiles: [],
    skillsUsed: [],
    model: '',
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    assistantCount: 0,
    editLocs: new Map(),
  };

  const toolResults = collectClaudeToolResults(lines, startIndex);
  let i = startIndex;
  while (i < lines.length) {
    const next = lines[i];
    if (next.type === 'user' && userHasText(next)) break;
    if (next.type === 'assistant') {
      data.assistantCount++;
      const assistantTs = getTimestamp(next.timestamp);
      if (assistantTs && (!data.lastTs || assistantTs > data.lastTs)) data.lastTs = assistantTs;
      if (!data.model && next.message?.model) data.model = next.message.model;

      const usage = next.message?.usage;
      const cacheRead = getNumberField(usage, 'cache_read_input_tokens');
      const cacheWrite = getNumberField(usage, 'cache_creation_input_tokens');
      data.totalInputTokens += getNumberField(usage, 'input_tokens') + cacheRead + cacheWrite;
      data.totalOutputTokens += getNumberField(usage, 'output_tokens');
      data.totalCacheReadTokens += cacheRead;
      data.totalCacheWriteTokens += cacheWrite;

      for (const block of toContentArray(next.message?.content)) {
        if (block.type === 'text' && block.text) {
          data.assistantTexts.push(block.text);
          continue;
        }
        const incomplete = !!block.id && !toolResults.completed.has(block.id);
        const failed = incomplete || (!!block.id && toolResults.failed.has(block.id));
        applyClaudeToolBlock(block, data, failed);
        // Extract code content from write tools so extractCodeBlocks() can count LoC.
        // Claude Write uses `content`; current Edit uses `new_string` (legacy logs used `new_str`).
        if (!failed && block.type === 'tool_use' && block.name && CLAUDE_WRITE_TOOLS.has(block.name) && block.input) {
          const filePath = getInputPath(block.input, 'file_path');
          const code = typeof block.input.content === 'string' ? block.input.content
            : typeof block.input.new_string === 'string' ? block.input.new_string
              : typeof block.input.new_str === 'string' ? block.input.new_str
              : null;
          if (code && filePath) {
            const ext = filePath.split('.').pop() || 'unknown';
            data.assistantTexts.push(`\`\`\`${ext}\n${code}\n\`\`\``);
          }
        }
      }
    }
    i++;
  }

  data.nextIndex = i;
  return data;
}

export function findClaudeDirs(): string[] {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const dirs: string[] = [];
  const projectsDir = path.join(home, '.claude', 'projects');
  if (fs.existsSync(projectsDir)) dirs.push(projectsDir);
  return dirs;
}

/** Encode a single filesystem component the way Claude Code does:
 *  replace whitespace with hyphens. Path separators never appear in a single
 *  component name, and colons are not handled here because Windows component
 *  names cannot contain them. */
function encodeComponentForMatch(name: string): string {
  return name.replace(/\s/g, '-');
}

/**
 * Resolve an encoded Claude project directory name back to the real folder name.
 *
 * Claude encodes workspace paths by replacing `/`, `\`, `:`, and whitespace
 * with `-`.  For example `c--dev-AI-Engineering-Coach` represents
 * `C:\dev\AI-Engineering-Coach`.  Because the encoding is lossy (hyphens, spaces,
 * and path separators all become `-`) we resolve the name by listing each
 * directory level and matching entries against the remaining encoded string.
 *
 * @param encoded  The encoded project directory name.
 * @param _projectsDir  The `.claude/projects` directory containing this project.
 */
function projectNameFromEncoded(encoded: string, _projectsDir: string): string {
  const segments = encoded.split('-');
  let root: string;
  let startIdx: number;

  // Windows drive: encoded starts with "<letter>--..." → "X:\\"
  if (segments.length >= 2 && /^[a-zA-Z]$/.test(segments[0]) && segments[1] === '') {
    root = `${segments[0]}:\\`;
    startIdx = 2;
  // Unix-style absolute path: encoded starts with "-..." → "/"
  } else if (segments[0] === '') {
    root = '/';
    startIdx = 1;
  } else {
    return encoded;  // unexpected format
  }

  // Join remaining segments back into the encoded tail so we can match
  // against directory entries whose names may contain spaces or hyphens.
  const remaining = segments.slice(startIdx).join('-');
  let resolved = root;
  let offset = 0;

  while (offset < remaining.length) {
    let dirEntries: { name: string; encoded: string }[];
    try {
      dirEntries = fs.readdirSync(resolved, { withFileTypes: true })
        .filter(e => e.isDirectory() || e.isSymbolicLink())
        .map(e => ({ name: e.name, encoded: encodeComponentForMatch(e.name) }))
        // Longest encoded form first — greedy match avoids splitting names
        // that contain hyphens (e.g. `AI-Engineering-Coach`).
        .sort((a, b) => b.encoded.length - a.encoded.length);
    } catch {
      break;
    }

    const rest = remaining.slice(offset);
    let found = false;
    for (const entry of dirEntries) {
      if (rest === entry.encoded) {
        // Exact match — last component
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
      // Can't resolve further — take the rest as one segment
      resolved = path.join(resolved, rest);
      break;
    }
  }

  return path.basename(resolved);
}

function parseClaudeProjectSessions(
  projectsDir: string,
  dirName: string,
  editLocIndex?: EditLocIndex,
): { sessions: Session[]; workspaceId: string; workspaceName: string } | null {
  const projPath = path.join(projectsDir, dirName);
  const workspaceId = `claude-${dirName}`;
  const workspaceName = projectNameFromEncoded(dirName, projectsDir);

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(projPath, { withFileTypes: true });
  } catch {
    return null;
  }

  // Pass 1: parse parent sessions from top-level .jsonl files. Index them by
  // sessionId so subagent files (in `<sessionId>/subagents/agent-*.jsonl`)
  // can be merged into the right parent in pass 2.
  const sessionsById = new Map<string, Session>();
  const sessions: Session[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const session = parseClaudeSessionFile(path.join(projPath, entry.name), workspaceId, workspaceName, editLocIndex);
    if (!session) continue;
    sessions.push(session);
    sessionsById.set(session.sessionId, session);
  }

  // Pass 2: walk `<sessionId>/subagents/agent-*.jsonl` directories. Each
  // subagent file is a fan-out of work the parent session orchestrated; we
  // merge its requests into the parent rather than emitting it as its own
  // session. Orphans (subagent dir whose parent session is missing) become
  // standalone programmatic sessions — they're still GHCP-spawned work.
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const subagentDir = path.join(projPath, entry.name, 'subagents');
    let subagentEntries: fs.Dirent[];
    try {
      subagentEntries = fs.readdirSync(subagentDir, { withFileTypes: true });
    } catch {
      continue; // no subagents/ folder under this session — fine
    }

    const parent = sessionsById.get(entry.name);
    const orphanRequests: SessionRequest[] = [];
    let orphanFirstTs: number | null = null;
    let orphanLastTs: number | null = null;
    let orphanEntrypoint: string | undefined;

    for (const subEntry of subagentEntries) {
      if (!subEntry.isFile() || !subEntry.name.endsWith('.jsonl')) continue;
      const subSession = parseClaudeSessionFile(
        path.join(subagentDir, subEntry.name), workspaceId, workspaceName, editLocIndex,
      );
      if (!subSession) continue;
      // Subagent requests are merged into the parent (or orphan) session, but
      // their image bytes stay in this subagent file. Record that path on
      // image-bearing requests so the source index can point lazy image
      // re-reads (the Coding Moments gallery) at the right file.
      stampSubagentImageSource(subSession.requests, subSession.sourceFilePath);

      if (parent) {
        // Merge subagent requests into parent. Sorting happens after all
        // subagents are collected, below.
        for (const r of subSession.requests) parent.requests.push(r);
        // Extend parent's last-message timestamp if the subagent ran longer.
        if (subSession.lastMessageDate &&
            (!parent.lastMessageDate || subSession.lastMessageDate > parent.lastMessageDate)) {
          parent.lastMessageDate = subSession.lastMessageDate;
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
        if (!orphanEntrypoint && subSession.entrypoint) orphanEntrypoint = subSession.entrypoint;
      }
    }

    if (parent) continue;

    if (orphanRequests.length > 0) {
      warnCore('parser-claude', `subagent dir without parent session: ${entry.name}`, {
        requestCount: orphanRequests.length,
      });
      orphanRequests.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
      const launcherKind: 'interactive' | 'programmatic' = 'programmatic';
      const orphan = createSession({
        sessionId: entry.name,
        workspaceId,
        workspaceName,
        location: 'terminal',
        harness: harnessForLauncher(launcherKind),
        creationDate: orphanFirstTs,
        lastMessageDate: orphanLastTs,
        requests: orphanRequests,
        launcherKind,
        entrypoint: orphanEntrypoint,
      });
      sessions.push(orphan);
    }
  }

  // Final pass: re-sort merged parent sessions' requests by timestamp and
  // refresh the cached requestCount.
  for (const session of sessions) {
    if (session.requests.length > 1) {
      session.requests.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
    }
    session.requestCount = session.requests.length;
  }

  return sessions.length > 0 ? { sessions, workspaceId, workspaceName } : null;
}

export function parseClaudeSessions(
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
    const result = parseClaudeProjectSessions(projectsDir, projDir.name, editLocIndex);
    if (result) results.push(result);
  }

  return results;
}

export async function parseClaudeSessionsAsync(
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

    const result = parseClaudeProjectSessions(projectsDir, dirName, editLocIndex);
    if (result) results.push(result);

    // Yield every 5 projects so the event loop stays responsive
    if (i % 5 === 0) await new Promise<void>(r => setTimeout(r, 0));
  }

  return results;
}

function updateClaudeTimestampRange(
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

function extractSkillsFromRefs(referencedFiles: string[]): string[] {
  const skills = new Set<string>();
  for (const ref of referencedFiles) {
    const name = extractSkillNameFromPath(ref);
    if (name) skills.add(name);
  }
  return [...skills];
}

function buildClaudeRequest(
  line: ClaudeLine,
  assistantData: ClaudeAssistantData,
  userTs: number | null,
  requestIndex: number,
  sessionId: string,
  editLocIndex?: EditLocIndex,
): SessionRequest {
  const hasAnyTokens = assistantData.assistantCount > 0;
  const imageCount = countClaudeImages(line);
  const uniqueRefs = [...new Set(assistantData.referencedFiles)];
  const skills = new Set(assistantData.skillsUsed);
  for (const name of extractSkillsFromRefs(uniqueRefs)) skills.add(name);
  const requestId = line.uuid || `${line.sessionId ?? sessionId}:claude:${requestIndex}`;
  const request = createRequest({
    requestId,
    timestamp: userTs,
    messageText: getClaudeUserText(line),
    responseText: assistantData.assistantTexts.join('\n'),
    agentName: 'Claude',
    agentMode: 'agent',
    modelId: assistantData.model,
    toolsUsed: assistantData.toolsUsed,
    editedFiles: [...new Set(assistantData.editedFiles)],
    referencedFiles: uniqueRefs,
    skillsUsed: [...skills],
    variableKinds: imageCount > 0 ? { image: imageCount } : {},
    totalElapsed: userTs && assistantData.lastTs ? assistantData.lastTs - userTs : null,
    promptTokens: hasAnyTokens ? assistantData.totalInputTokens : null,
    completionTokens: hasAnyTokens ? assistantData.totalOutputTokens : null,
    cacheReadTokens: assistantData.totalCacheReadTokens > 0 ? assistantData.totalCacheReadTokens : null,
    cacheWriteTokens: assistantData.totalCacheWriteTokens > 0 ? assistantData.totalCacheWriteTokens : null,
    reasoningEffort: extractReasoningEffortFromModelId(assistantData.model),
  });
  mergeRequestEditLoc(editLocIndex, requestId, assistantData.editLocs);
  return request;
}

export function parseClaudeSessionFile(
  filePath: string,
  wsId: string,
  wsName: string,
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

  const lines = parseClaudeLines(raw);
  if (lines.length === 0) return null;

  const sessionId = lines[0].sessionId || path.basename(filePath, '.jsonl');
  const requests: SessionRequest[] = [];
  let cwd = '';
  let firstTs: number | null = null;
  let lastTs: number | null = null;
  let entrypoint: string | undefined;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line.type !== 'user' || !userHasText(line)) {
      i++;
      continue;
    }

    if (!cwd && line.cwd) cwd = line.cwd;
    // Capture the first non-empty entrypoint we see. In practice Claude Code
    // writes it on every user line, but we only need one.
    if (!entrypoint && line.entrypoint) entrypoint = line.entrypoint;
    const userTs = getTimestamp(line.timestamp);
    ({ firstTs, lastTs } = updateClaudeTimestampRange(userTs, firstTs, lastTs));

    const assistantData = collectClaudeAssistantData(lines, i + 1, lastTs);
    lastTs = assistantData.lastTs;
    requests.push(buildClaudeRequest(line, assistantData, userTs, requests.length, sessionId, editLocIndex));
    i = assistantData.nextIndex;
  }

  if (requests.length === 0) return null;

  const launcherKind = classifyLauncher(entrypoint);
  return createSession({
    sessionId,
    workspaceId: wsId,
    workspaceName: wsName,
    location: 'terminal',
    harness: harnessForLauncher(launcherKind),
    creationDate: firstTs,
    lastMessageDate: lastTs,
    requests,
    hasDevcontainer: detectDevcontainerFromRequests(requests, cwd),
    workspaceRootPath: cwd || undefined,
    launcherKind,
    entrypoint,
    sourceFilePath: filePath,
  });
}
