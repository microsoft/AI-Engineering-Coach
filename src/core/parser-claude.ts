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
import { createHash } from 'crypto';
import { CompactionEvent, Session, SessionRequest, UserWait, UserWaitText } from './types';
import { assertTrustedPath, MAX_FILE_SIZE, createRequest, createSession, detectDevcontainerFromRequests, extractSkillNameFromPath, recordFailedFile, recordSkippedLines } from './parser-shared';
import { extractReasoningEffortFromModelId } from './helpers';
import { warnCore } from './log';
import { EditLocIndex } from './edit-loc-diff';
import { markNonHuman } from './human-turns';
import { claudeNonHumanKind } from './parser-turn-kinds';
import {
  FileEditLocMap,
  mergeRequestEditLoc,
  recordContentReplacement,
  recordCreatedContent,
} from './edit-tool-diff';
import { recordedInvestigation, recordedWebDomains } from './curiosity-activity';
import { imageReferencesFromContent, type ImageReference, type ImageRequestMatch } from './image-data';
import { ClaudeResponseAccumulator, type ClaudeRequestUsage } from './parser-claude-responses';
import type { SessionSource } from './cache';
import { forEachJsonlLine } from './parser-vscode-files';
import { readClaudeCompaction, requestCompactionFields } from './agent-compaction';
import { addTurnCompaction } from './cli-compaction';
import { withInheritedTurnsRemoved } from './fork-ownership';

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
  /** API response id. Claude Code writes one line per content block and repeats `usage` on each,
   *  so usage must be counted once per id. */
  id?: string;
  role?: string;
  model?: string;
  content?: ClaudeContentBlock[] | string;
  usage?: Record<string, unknown>;
  stop_reason?: string;
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
   *  Not every Claude Code build writes it there, so the prompt cache and a
   *  request's own chain also read the file's own classification
   *  (`ClaudeCacheState.subagentFile`, see `claudeStream`).
   *  Carried through so callers can roll subagent requests up into the
   *  parent session rather than treating them as standalone sessions. */
  isSidechain?: boolean;
  isMeta?: boolean;
  /** Set on the turn that replays a compacted conversation summary. */
  isCompactSummary?: boolean;
  /** Subagent identifier on `subagents/` files. Present alongside
   *  `isSidechain: true`. Not used for billing math; surfaced for diagnostics. */
  agentId?: string;
  /** `system` lines: `compact_boundary` marks a compaction. */
  subtype?: unknown;
  /** On a `compact_boundary` line: `trigger`, `preTokens`, `postTokens`, `durationMs`. */
  compactMetadata?: unknown;
  /** Who sent a user line (`{ kind: "human" }` on a typed prompt); see `claudeNonHumanKind`. */
  origin?: unknown;
  /** `attachment` lines: context the harness added, such as the instruction files it loaded. */
  attachment?: unknown;
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
  /** The agent's own text blocks, without the code its write tools wrote (`assistantTexts` holds both). */
  replyTexts: string[];
  toolsUsed: string[];
  editedFiles: string[];
  referencedFiles: string[];
  skillsUsed: string[];
  model: string;
  assistantCount: number;
  /** Token totals, context and rows of the request's API responses. */
  usage: ClaudeRequestUsage;
  editLocs: FileEditLocMap;
  answerEvidence: 'final' | 'legacy' | 'missing';
  investigationDelegations: ('research' | 'explore')[];
  webDomains: string[];
  /** `AskUserQuestion` calls: from the question to your answer (the tool result). */
  userWaits: UserWait[];
  /** Compactions logged during the request (`compact_boundary` lines), in order. */
  compactions: CompactionEvent[];
}

/** A `compact_boundary` line's compaction, or `null` for any other line. */
function claudeCompaction(line: ClaudeLine): CompactionEvent | null {
  return line.type === 'system' && line.subtype === 'compact_boundary' ? readClaudeCompaction(line.compactMetadata) : null;
}

/** Put compactions logged before the request's prompt ahead of its own, within the cap. */
function prependCompactions(data: ClaudeAssistantData, earlier: CompactionEvent[]): void {
  if (earlier.length === 0) return;
  const own = data.compactions.splice(0);
  for (const compaction of [...earlier, ...own]) addTurnCompaction(data.compactions, compaction);
}
interface ClaudeCacheState {
  sawMain: boolean;
  /** The file is a sub-agent's transcript (`isClaudeSubagentFile`): every call in it is sub-agent work, whether or
   *  not its lines are marked `isSidechain`. */
  subagentFile: boolean;
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
  if (value.isMeta !== undefined && typeof value.isMeta !== 'boolean') return false;
  if (value.isCompactSummary !== undefined && typeof value.isCompactSummary !== 'boolean') return false;
  if (value.agentId !== undefined && typeof value.agentId !== 'string') return false;
  if (value.message !== undefined && !isClaudeMessage(value.message)) return false;
  return true;
}

/**
 * A prompt the user typed while the agent was busy. Claude delivers it into the running turn and logs it only as a
 * `queued_command` attachment, with `origin.kind: "human"`, so it becomes a user line here. Task notifications and
 * messages from other sessions are queued the same way, but stay out, as before.
 */
function queuedPromptLine(line: ClaudeLine): ClaudeLine | null {
  if (line.type !== 'attachment' || !isRecord(line.attachment)) return null;
  const attachment = line.attachment;
  if (attachment.type !== 'queued_command' || !isRecord(attachment.origin) || attachment.origin.kind !== 'human') return null;
  if (attachment.commandMode !== undefined && attachment.commandMode !== 'prompt') return null;
  const prompt = attachment.prompt;
  const content = typeof prompt === 'string' ? prompt : Array.isArray(prompt) && prompt.every(isClaudeContentBlock) ? prompt : null;
  if (content === null) return null;
  return {
    ...line,
    type: 'user',
    origin: attachment.origin,
    isMeta: undefined,
    attachment: undefined,
    message: { role: 'user', content },
  };
}

function parseClaudeLine(rawLine: string): ClaudeLine | null {
  try {
    const parsed: unknown = JSON.parse(rawLine);
    if (!isClaudeLine(parsed)) return null;
    const record = parsed as unknown as Record<string, unknown>;
    if (typeof record.uuid === 'number') record.uuid = String(record.uuid);
    if (typeof record.parentUuid === 'number') record.parentUuid = String(record.parentUuid);
    if (typeof record.timestamp === 'number') record.timestamp = new Date(record.timestamp).toISOString();
    return queuedPromptLine(parsed) ?? parsed;
  } catch {
    return null;
  }
}

/**
 * Raw API request records: most of a large transcript's bytes, and nothing the parser reads but their presence. Matched
 * wherever `type` sits among the keys. Quotes inside JSON string values are escaped, so a prompt that mentions the text
 * cannot match.
 */
const CLAUDE_API_REQUEST_LINE = /"type"\s*:\s*"api-request/;
/** A turn's own `api-request` record (not its `-shape` or `-blob` companions): kept as a bare `{ type }` marker, unparsed,
 *  because `claudeLoggedLive` reads it as a sign the turn was logged live rather than copied by a fork. */
const CLAUDE_TURN_API_REQUEST_LINE = /"type"\s*:\s*"api-request"/;

/** Characters of kept lines, after inline base64 data is blanked, parsed from one transcript. */
const CLAUDE_MAX_KEPT_CHARS = 200 * 1024 * 1024;
const INLINE_DATA_KEY = '"data"';
const MIN_INLINE_DATA_CHARS = 1024;

function isJsonSpace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

function isBase64Char(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) // A-Z
    || (code >= 0x61 && code <= 0x7a) // a-z
    || (code >= 0x30 && code <= 0x39) // 0-9
    || code === 0x2b || code === 0x2f || code === 0x3d; // + / =
}

/**
 * Blanks long base64 `data` values (inline images and documents): most of an image-heavy transcript, and nothing the
 * analytics read (image counts come from the block type; image bytes are read from the file on demand). Only a value
 * made entirely of base64 characters is blanked, so a value with escapes or other text is left as it is and the JSON
 * stays valid. A scan, not a regex: on multi-MB values V8's regex engine overflows its stack.
 */
function stripInlineData(line: string): string {
  if (!line.includes('"base64"')) return line;
  let out = '';
  let copied = 0;
  let at = line.indexOf(INLINE_DATA_KEY);
  while (at >= 0) {
    // Outside strings only: inside a JSON string every quote is escaped, so `"data"` cannot occur there.
    let i = at + INLINE_DATA_KEY.length;
    while (isJsonSpace(line.charCodeAt(i))) i++;
    if (line.charCodeAt(i) === 0x3a /* : */) {
      i++;
      while (isJsonSpace(line.charCodeAt(i))) i++;
      if (line.charCodeAt(i) === 0x22 /* " */) {
        const start = i + 1;
        let end = start;
        while (isBase64Char(line.charCodeAt(end))) end++;
        if (end - start >= MIN_INLINE_DATA_CHARS && line.charCodeAt(end) === 0x22) {
          out += line.slice(copied, start);
          copied = end;
        }
        i = end;
      }
    }
    at = line.indexOf(INLINE_DATA_KEY, i);
  }
  return copied === 0 ? line : out + line.slice(copied);
}

/**
 * Streams a transcript's lines, leaving out raw API request records and inline base64 data. A line over MAX_FILE_SIZE
 * is skipped while it streams in, and past CLAUDE_MAX_KEPT_CHARS the rest of the transcript is left out; both are
 * counted as skipped lines and the transcript is reported, so memory stays bounded whatever the file holds and a
 * transcript that was cut short shows in the dashboard's skipped-history notice.
 */
function readClaudeLines(filePath: string): ClaudeLine[] {
  const lines: ClaudeLine[] = [];
  let keptChars = 0;
  let leftOut = 0;
  let tooLong = 0;
  forEachJsonlLine(filePath, rawLine => {
    if (!rawLine.trim()) return;
    if (CLAUDE_API_REQUEST_LINE.test(rawLine)) {
      if (leftOut === 0 && CLAUDE_TURN_API_REQUEST_LINE.test(rawLine)) lines.push({ type: 'api-request' });
      return;
    }
    if (leftOut > 0) {
      leftOut++;
      return;
    }
    const line = stripInlineData(rawLine);
    keptChars += line.length;
    if (keptChars > CLAUDE_MAX_KEPT_CHARS) {
      leftOut = 1;
      return;
    }
    const parsed = parseClaudeLine(line);
    if (parsed && !parsed.type.startsWith('api-request')) lines.push(parsed);
  }, undefined, {
    maxChars: MAX_FILE_SIZE,
    // An API request record is left out anyway, so dropping one for its length loses nothing.
    onSkip: start => {
      if (CLAUDE_API_REQUEST_LINE.test(start)) {
        if (leftOut === 0 && CLAUDE_TURN_API_REQUEST_LINE.test(start)) lines.push({ type: 'api-request' });
        return;
      }
      if (leftOut > 0) leftOut++;
      else tooLong++;
    },
  });
  if (leftOut + tooLong > 0) {
    const reasons: string[] = [];
    if (tooLong > 0) reasons.push(`left out ${tooLong} line(s) over ${MAX_FILE_SIZE / 1024 / 1024} MB`);
    if (leftOut > 0) reasons.push(`parsed the first ${CLAUDE_MAX_KEPT_CHARS / 1024 / 1024} MB of messages and left out the last ${leftOut} line(s)`);
    // Shown in the dashboard's skipped-history notice and, with the reason, in the output channel.
    recordSkippedLines(leftOut + tooLong);
    recordFailedFile('parser-claude', filePath, reasons.join('; '));
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
  if (text.length === 0) return countClaudeImages(line) > 0;
  // Claude wraps slash-command input/output in <command-...> / <local-command-...> tags
  if (/^<(local-)?command-/.test(text)) return false;
  // Interrupt markers are auto-injected when the user cancels a tool call
  if (text.startsWith('[Request interrupted')) return false;
  return true;
}

function getTimestamp(timestamp?: string): number | null {
  return timestamp ? new Date(timestamp).getTime() : null;
}

function getInputPath(input: Record<string, unknown> | undefined, key: string): string | null {
  const value = input?.[key];
  return typeof value === 'string' ? value : null;
}

/** File and selection context the VS Code extension adds to a typed prompt. */
const CLAUDE_IDE_CONTEXT = /<(ide_opened_file|ide_selection)>[\s\S]*?<\/\1>/g;

/** The typed text of a user line, without the IDE context the extension added to it. */
function getClaudeUserText(line: ClaudeLine): string {
  return toContentArray(line.message?.content)
    .filter(block => block.type === 'text')
    .flatMap(block => {
      const text = block.text || '';
      const typed = text.replaceAll(CLAUDE_IDE_CONTEXT, '');
      if (typed === text) return [text];
      return typed.trim() ? [typed.trim()] : [];
    })
    .join('\n');
}

function countClaudeImages(line: ClaudeLine): number {
  return imageReferencesFromContent(line.message?.content).length;
}

/** Claude Code writes each sub-agent's transcript to `<sessionId>/subagents/agent-*.jsonl`, beside the session's
 *  own `<sessionId>.jsonl`. */
export function isClaudeSubagentFile(filePath: string): boolean {
  return path.basename(path.dirname(filePath)) === 'subagents';
}

function claudeTranscriptKey(filePath: string): string {
  const resolved = path.resolve(filePath);
  return createHash('sha256').update(process.platform === 'win32' ? resolved.toLowerCase() : resolved).digest('hex').slice(0, 32);
}

function claudeRequestId(line: ClaudeLine, sessionId: string, requestIndex: number, transcriptKey: string): string {
  return line.uuid || `${line.sessionId ?? sessionId}:claude:${transcriptKey}:${requestIndex}`;
}

export function extractClaudeImageReferences(
  filePath: string,
  requestId: string,
  match?: ImageRequestMatch,
): { images: ImageReference[]; workspaceRootPath?: string } {
  let sessionId = path.basename(filePath, '.jsonl');
  const transcriptKey = claudeTranscriptKey(filePath);
  let firstLine = true;
  let requestIndex = 0;
  let workspaceRootPath: string | undefined;
  let images: ImageReference[] = [];
  let found = false;
  let done = false;
  // The same line limit as readClaudeLines, so request indices match the parsed session's.
  forEachJsonlLine(filePath, raw => {
    if (!firstLine && !raw.includes('"user"') && !raw.includes('"queued_command"')) return;
    const line = parseClaudeLine(raw);
    if (!line) return;
    if (firstLine) {
      sessionId = line.sessionId || sessionId;
      firstLine = false;
    }
    if (line.type !== 'user' || !userHasText(line)) return;
    if (!workspaceRootPath && line.cwd) workspaceRootPath = line.cwd;
    const id = claudeRequestId(line, sessionId, requestIndex, transcriptKey);
    requestIndex++;
    if (!found && (match?.userEventId ? line.uuid === match.userEventId : id === requestId)) {
      images = imageReferencesFromContent(line.message?.content);
      if (line.cwd) workspaceRootPath = line.cwd;
      found = true;
    }
    const needsRoot = images.some(image => image.path && !path.isAbsolute(image.path) && !/^[a-z][a-z0-9+.-]*:/i.test(image.path));
    done = found && (workspaceRootPath !== undefined || !needsRoot);
  }, () => done, { maxChars: MAX_FILE_SIZE, onSkip: () => undefined });
  return { images, workspaceRootPath };
}

function applyClaudeToolBlock(
  block: ClaudeContentBlock,
  data: Pick<ClaudeAssistantData, 'toolsUsed' | 'editedFiles' | 'referencedFiles' | 'skillsUsed' | 'editLocs' | 'investigationDelegations' | 'webDomains'>,
  failed: boolean,
): void {
  if (block.type !== 'tool_use' || !block.name) return;

  data.toolsUsed.push(block.name);
  data.webDomains.push(...recordedWebDomains(block.name, block.input));
  const role = recordedInvestigation(block.name, block.input);
  if (role && !data.investigationDelegations.includes(role)) data.investigationDelegations.push(role);
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

/** A tool result that says something: text, or a non-empty content block. An empty result is no answer. */
function toolResultHasContent(block: ClaudeContentBlock): boolean {
  const content = (block as { content?: unknown }).content;
  if (typeof content === 'string') return content.trim() !== '';
  return Array.isArray(content) && content.some(c => typeof c === 'object' && c !== null
    && (typeof (c as { text?: unknown }).text !== 'string' || (c as { text: string }).text.trim() !== ''));
}

function toolResultText(block: ClaudeContentBlock): string {
  const content = (block as { content?: unknown }).content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content.map(c => (isRecord(c) && typeof c.text === 'string' ? c.text : '')).filter(Boolean).join('\n').trim();
}

/** An `AskUserQuestion` call's questions and options, your answer (its result) and what the agent said before it. */
function askUserQuestionText(input: unknown, answer: string | undefined, before: string | undefined): UserWaitText | undefined {
  const questions = isRecord(input) && Array.isArray(input.questions) ? input.questions.filter(isRecord) : [];
  const ask = questions.map(q => (typeof q.question === 'string' ? q.question.trim() : '')).filter(Boolean).join('\n');
  const choices = questions.flatMap((q): unknown[] => (Array.isArray(q.options) ? q.options : []))
    .map(o => (isRecord(o) && typeof o.label === 'string' ? o.label : '')).filter(Boolean);
  const text: UserWaitText = {
    ...(ask ? { ask } : {}), ...(choices.length ? { choices } : {}), ...(answer ? { answer } : {}), ...(before?.trim() ? { before: before.trim() } : {}),
  };
  return Object.keys(text).length ? text : undefined;
}

/** The stream of a line's response: a sub-agent's for a sidechain line, and for any line of a sub-agent's transcript,
 *  marked or not. Read for every line of a request's responses, and for its prompt, so the request's own chain agrees
 *  with their prompt-cache streams. */
function claudeStream(line: ClaudeLine, cacheState: ClaudeCacheState): 'main' | 'subagent' {
  return cacheState.subagentFile || line.isSidechain ? 'subagent' : 'main';
}

/** Every `AskUserQuestion` result in the transcript, by its call ID, with when it came and whether it holds an answer.
 *  A result can come after your next prompt, so the whole transcript is read once, not only the asking turn. */
interface ClaudeQuestionResults {
  results: Map<string, { ts: number | null; answered: boolean; text: string }>;
  /** Each line's own timestamp or the next one logged after it: where an unanswered question's stop ends. */
  nextTs: (number | null)[];
}

function indexClaudeQuestionResults(lines: ClaudeLine[]): ClaudeQuestionResults {
  const asked = new Set<string>();
  for (const line of lines) {
    if (line.type !== 'assistant') continue;
    for (const block of toContentArray(line.message?.content)) if (block.type === 'tool_use' && block.name === 'AskUserQuestion' && block.id) asked.add(block.id);
  }
  const results = new Map<string, { ts: number | null; answered: boolean; text: string }>();
  const nextTs = new Array<number | null>(lines.length).fill(null);
  if (asked.size === 0) return { results, nextTs };
  let next: number | null = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    next = getTimestamp(lines[i].timestamp) ?? next;
    nextTs[i] = next;
  }
  for (const line of lines) if (line.type === 'user') noteQuestionResults(line, asked, results);
  return { results, nextTs };
}

/** The first result of each asked question in a user line: when it came, whether you answered and what you said. */
function noteQuestionResults(line: ClaudeLine, asked: Set<string>, results: ClaudeQuestionResults['results']): void {
  for (const block of toContentArray(line.message?.content)) {
    if (block.type !== 'tool_result' || !block.tool_use_id || !asked.has(block.tool_use_id) || results.has(block.tool_use_id)) continue;
    const answered = block.is_error !== true && toolResultHasContent(block);
    results.set(block.tool_use_id, { ts: getTimestamp(line.timestamp), answered, text: answered ? toolResultText(block) : '' });
  }
}

/** Assistant data of the request whose prompt is the user line at `userIndex`. */
function collectClaudeAssistantData(
  lines: ClaudeLine[],
  userIndex: number,
  lastTs: number | null,
  cacheState: ClaudeCacheState,
  questions: ClaudeQuestionResults = { results: new Map(), nextTs: [] },
): ClaudeAssistantData {
  const startIndex = userIndex + 1;
  const responses = new ClaudeResponseAccumulator(claudeStream(lines[userIndex], cacheState) === 'subagent');
  const data: Omit<ClaudeAssistantData, 'usage'> = {
    nextIndex: startIndex,
    lastTs,
    assistantTexts: [],
    replyTexts: [],
    toolsUsed: [],
    editedFiles: [],
    referencedFiles: [],
    skillsUsed: [],
    model: '',
    assistantCount: 0,
    editLocs: new Map(),
    answerEvidence: 'missing',
    investigationDelegations: [],
    webDomains: [],
    userWaits: [],
    compactions: [],
  };

  const toolResults = collectClaudeToolResults(lines, startIndex);
  let i = startIndex;
  while (i < lines.length) {
    const next = lines[i];
    if (next.type === 'user' && userHasText(next)) break;
    const compaction = claudeCompaction(next);
    if (compaction) addTurnCompaction(data.compactions, compaction);
    if (next.type === 'assistant') {
      const blocks = toContentArray(next.message?.content);
      const hasText = blocks.some(block => block.type === 'text' && block.text?.trim());
      data.answerEvidence = hasText && next.message?.stop_reason === 'end_turn' ? 'final'
        : hasText && next.message?.stop_reason == null && !blocks.some(block => block.type === 'tool_use') ? 'legacy' : 'missing';
      data.assistantCount++;
      const assistantTs = getTimestamp(next.timestamp);
      if (assistantTs && (!data.lastTs || assistantTs > data.lastTs)) data.lastTs = assistantTs;
      if (!data.model && next.message?.model) data.model = next.message.model;
      responses.add(next.message, claudeStream(next, cacheState) === 'subagent');

      for (const block of toContentArray(next.message?.content)) {
        if (block.type === 'text' && block.text) {
          data.assistantTexts.push(block.text);
          data.replyTexts.push(block.text);
          continue;
        }
        if (block.type === 'tool_use' && block.name === 'AskUserQuestion' && block.id && assistantTs) {
          // Answered or not, the question stopped the agent: until its result, or, with none logged, the next line.
          const result = questions.results.get(block.id);
          const end = result?.ts ?? questions.nextTs[i + 1] ?? assistantTs;
          if (end >= assistantTs) {
            const text = askUserQuestionText(block.input, result?.text, data.replyTexts[data.replyTexts.length - 1]);
            data.userWaits.push({ start: assistantTs, end, kind: 'question', answered: result?.answered ?? false, ...(text ? { text } : {}) });
          }
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
  return { ...data, usage: responses.finish(cacheState) };
}

export function findClaudeDirs(): string[] {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const dirs: string[] = [];
  const projectsDir = path.join(home, '.claude', 'projects');
  if (fs.existsSync(projectsDir)) dirs.push(projectsDir);
  return dirs;
}

/** Encode a single filesystem component the way Claude Code does:
 *  replace every character outside A-Z, a-z and 0-9 with a hyphen (one per
 *  UTF-16 code unit). Path separators never appear in a single
 *  component name, and colons are not handled here because Windows component
 *  names cannot contain them. */
function encodeComponentForMatch(name: string): string {
  return name.replaceAll(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Resolve an encoded Claude project directory name back to the real folder name.
 *
 * Claude encodes workspace paths by replacing every character outside
 * A-Z, a-z and 0-9 (one per UTF-16 code unit) with `-`.  For example
 * `c--dev-AI-Engineering-Coach` represents `C:\dev\AI-Engineering-Coach`.  Because the encoding is lossy (hyphens, spaces,
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

/** Claude Code encodes a session's launch directory into its project folder
 *  name: every character outside A-Z, a-z and 0-9 becomes `-`, and a result
 *  over 200 characters keeps its first 200 plus `-<hash>`. */
function cwdMatchesProjectDir(cwd: string, dirName: string): boolean {
  const encoded = cwd.replaceAll(/[^a-zA-Z0-9]/g, '-').toLowerCase();
  const dir = dirName.toLowerCase();
  return encoded === dir || (encoded.length > 200 && dir.startsWith(`${encoded.slice(0, 200)}-`));
}

/** The workspace name from the first recorded `cwd` that belongs to this
 *  project folder. Unlike decoding the folder name, this works when the folder
 *  was deleted, the path was truncated, or the log came from another OS. */
function workspaceNameFromCwd(cwds: (string | undefined)[], dirName: string): string | undefined {
  for (const cwd of cwds) {
    if (!cwd || !cwdMatchesProjectDir(cwd, dirName)) continue;
    // win32 splits on both separators, so a cwd logged on any OS works.
    const name = path.win32.basename(cwd);
    if (name) return name;
  }
  return undefined;
}

/**
 * What to leave out across project folders. A transcript can be hard-linked into a second project folder, and a fork,
 * or a copy of a session in another project folder, replays earlier turns with the same `uuid`; each is counted once.
 */
interface ClaudeDiscovery {
  /** Top-level transcripts to skip: hard links of one parsed from another project folder. */
  skipFiles: Set<string>;
  /** `subagents/` folders beside skipped transcripts, by the project folder and session id they merge into. */
  extraSubagentDirs: Map<string, string[]>;
  /** Each parsed top-level transcript's place when all of them are ordered by when they started, oldest first. */
  transcriptRanks: Map<string, number>;
  /** The rank of each parsed session's transcript, filled in while parsing. Sub-agent turns take their parent's. */
  sessionRanks: Map<Session, number>;
  /** The source each parsed session was given. Sessions in two folders can share an id, and so an index entry. */
  sessionSources: Map<Session, SessionSource>;
}

type ClaudeProjectResult = { sessions: Session[]; workspaceId: string; workspaceName: string };

/** Sorts after any real birth time, in nanoseconds since 1970. */
const UNKNOWN_BIRTH = 2n ** 63n;

function discoveryKey(dirName: string, sessionName: string): string {
  return `${dirName}\0${sessionName}`;
}

/** Hands a transcript's first 200 lines to `onLine` until it returns true, whatever the file's size. A line over
 *  MAX_FILE_SIZE is left out but counts towards the 200, and a file that can't be read is left to the parse. */
function readClaudeHead(filePath: string, onLine: (raw: string) => boolean): void {
  let read = 0;
  let done = false;
  try {
    forEachJsonlLine(filePath, raw => {
      read++;
      done = onLine(raw);
    }, () => done || read >= 200, { maxChars: MAX_FILE_SIZE, onSkip: () => { read++; } });
  } catch {
    // Left to parseClaudeSessionFile, which reads the file again.
  }
}

/** The first `cwd` a transcript records. */
function readClaudeCwd(filePath: string): string | undefined {
  let cwd: string | undefined;
  readClaudeHead(filePath, raw => {
    if (raw.includes('"cwd"')) cwd = parseClaudeLine(raw)?.cwd || undefined;
    return cwd !== undefined;
  });
  return cwd;
}

/**
 * Finds transcripts that are one file under two project folders (the same device and inode). The copy in the folder
 * Claude Code would use for the transcript's working folder is parsed, or the first by folder name; the others are
 * skipped, and their `subagents/` folders merge into the parsed copy's session. The stat is read as `bigint`, because
 * Windows file IDs can be too large for a number to tell apart, and a file with one link is not a hard link.
 */
function planClaudeDiscovery(projectsDir: string, dirNames: readonly string[]): ClaudeDiscovery {
  const discovery: ClaudeDiscovery = { skipFiles: new Set(), extraSubagentDirs: new Map(), transcriptRanks: new Map(), sessionRanks: new Map(), sessionSources: new Map() };
  const transcripts: { filePath: string; birth: bigint }[] = [];
  const byFile = new Map<string, { dirName: string; filePath: string }[]>();
  for (const dirName of [...dirNames].sort()) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(projectsDir, dirName), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const filePath = path.join(projectsDir, dirName, entry.name);
      let stat: fs.BigIntStats;
      let key: string;
      try {
        stat = fs.statSync(filePath, { bigint: true });
        // A file system that doesn't record birth times reports 0: order those files after the rest. Where statx isn't
        // available, libuv reports the change time instead, which moves on append; it only decides equal starts.
        transcripts.push({ filePath, birth: stat.birthtimeNs || UNKNOWN_BIRTH });
        if (stat.nlink < 2n) continue;
        key = stat.ino ? `${stat.dev}:${stat.ino}` : fs.realpathSync(filePath);
      } catch {
        continue;
      }
      const copies = byFile.get(key) ?? [];
      copies.push({ dirName, filePath });
      byFile.set(key, copies);
    }
  }
  for (const copies of byFile.values()) {
    if (copies.length < 2) continue;
    const cwd = readClaudeCwd(copies[0].filePath);
    const kept = copies.find(copy => cwd !== undefined && cwdMatchesProjectDir(cwd, copy.dirName)) ?? copies[0];
    for (const copy of copies) {
      if (copy === kept) continue;
      discovery.skipFiles.add(copy.filePath);
      const sessionName = path.basename(copy.filePath, '.jsonl');
      const key = discoveryKey(kept.dirName, sessionName);
      const dirs = discovery.extraSubagentDirs.get(key) ?? [];
      dirs.push(path.join(path.dirname(copy.filePath), sessionName, 'subagents'));
      discovery.extraSubagentDirs.set(key, dirs);
    }
  }
  // Oldest first, so a turn stays with the transcript it was typed in, whichever folder its copies are in. A copy's
  // first line can carry the original's timestamp, so equal starts go by when the file was created, then by name.
  const ordered = transcripts
    .filter(({ filePath }) => !discovery.skipFiles.has(filePath))
    .map(({ filePath, birth }) => ({ filePath, birth, start: transcriptStart(filePath) }))
    .sort((a, b) => a.start - b.start || Number(a.birth - b.birth)
      || path.basename(a.filePath).localeCompare(path.basename(b.filePath)) || a.filePath.localeCompare(b.filePath));
  for (const [rank, { filePath }] of ordered.entries()) discovery.transcriptRanks.set(filePath, rank);
  return discovery;
}

/** When a transcript was started: its first line's timestamp. A fork, or a copy of a session in another project
 *  folder, replays older turns, but its own first line is normally written when it starts. */
function transcriptStart(filePath: string): number {
  let start = Number.POSITIVE_INFINITY;
  readClaudeHead(filePath, raw => {
    const ts = raw.includes('"timestamp"') ? parseClaudeLine(raw)?.timestamp : undefined;
    if (ts) start = Date.parse(ts);
    return Number.isFinite(start);
  });
  return Number.isFinite(start) ? start : Number.POSITIVE_INFINITY;
}

/** The earliest timestamp among the requests. */
export function earliestRequestTime(requests: readonly SessionRequest[]): number | null {
  let earliest: number | null = null;
  for (const { timestamp } of requests) {
    if (timestamp && (earliest === null || timestamp < earliest)) earliest = timestamp;
  }
  return earliest;
}

/** How strongly a turn says it was typed in its transcript: a prompt older than the transcript's first line was copied
 *  there (`historyLeadMs`); one logged live (`loggedLive`) was typed there; otherwise nothing says. */
function claudeTurnWitness(request: SessionRequest): number {
  if ((request.historyLeadMs ?? 0) > 0) return 0;
  return request.loggedLive ? 2 : 1;
}

/**
 * Resolves, from what each transcript logged, which sessions copied turns from which (`withInheritedTurnsRemoved`): a
 * fork loses its copies and records its source, or that nothing says which one it is; a fork of nothing but copies
 * stays, with no turns of its own. The results go onto the parsed sessions themselves, which `discovery` is keyed by,
 * and the removed ids onto their sources, so a session's detail leaves them out too.
 */
function resolveClaudeForks(results: ClaudeProjectResult[], discovery: ClaudeDiscovery): void {
  const sessions = results.flatMap(result => result.sessions);
  const resolved = withInheritedTurnsRemoved(sessions);
  for (const [i, session] of sessions.entries()) {
    const next = resolved[i];
    if (next === session) continue;
    const kept = new Set(next.requests);
    const removed = session.requests.flatMap(request => (!kept.has(request) && request.userEventId ? [request.userEventId] : []));
    Object.assign(session, next);
    const source = discovery.sessionSources.get(session);
    if (source && removed.length > 0) source.droppedUserEventIds = [...(source.droppedUserEventIds ?? []), ...removed];
  }
}

/**
 * Keeps each user line in one session across every project folder, and leaves it out of the others: a fork, or a copy
 * of a session in another project folder, replays earlier turns with the same `uuid`. Forks are resolved first, by the
 * evidence their transcripts logged (`resolveClaudeForks`); a turn still held twice after that is kept by the session
 * whose copy says it was typed there (`claudeTurnWitness`), else the one whose transcript started first, and nothing
 * says which session the other copied it from. A session left with no requests is dropped, unless it is a fork that
 * holds only copied turns.
 */
function keepEachTurnOnce(
  results: ClaudeProjectResult[],
  discovery: ClaudeDiscovery,
  sessionSourceIndex?: Map<string, SessionSource>,
): ClaudeProjectResult[] {
  resolveClaudeForks(results, discovery);
  const owners = new Map<string, { session: Session; request: SessionRequest; rank: number }>();
  for (const { sessions } of results) {
    for (const session of sessions) {
      const rank = discovery.sessionRanks.get(session) ?? Number.MAX_SAFE_INTEGER;
      for (const request of session.requests) {
        if (!request.userEventId) continue;
        const owner = owners.get(request.userEventId);
        const witness = claudeTurnWitness(request);
        if (!owner) {
          owners.set(request.userEventId, { session, request, rank });
          continue;
        }
        const ownerWitness = claudeTurnWitness(owner.request);
        if (witness > ownerWitness || (witness === ownerWitness && rank < owner.rank)) owners.set(request.userEventId, { session, request, rank });
      }
    }
  }
  for (const result of results) {
    result.sessions = result.sessions.filter(session => {
      const source = discovery.sessionSources.get(session);
      if (keepOwnedTurns(session, owners, source)) return true;
      if (source && sessionSourceIndex?.get(session.sessionId) === source) sessionSourceIndex.delete(session.sessionId);
      return false;
    });
  }
  // A dropped session can have held the index entry of a kept session with the same id, such as a copied folder's.
  for (const { sessions } of results) {
    for (const session of sessions) {
      const source = discovery.sessionSources.get(session);
      if (source && !sessionSourceIndex?.has(session.sessionId)) sessionSourceIndex?.set(session.sessionId, source);
    }
  }
  return results.filter(result => result.sessions.length > 0);
}

/** Leaves out a session's turns that another session owns, or that it repeats. A session that loses turns is dated
 *  from its earliest kept turn, as `parseClaudeSessionFile` dates every session, and its source records the ids
 *  another session owns, so its detail leaves them out too. Turns another session owns count as inherited
 *  (`inheritedTurns`), from a source nothing names (`forkSourceAmbiguous`) unless the session already records one.
 *  Returns whether the session still has requests. */
function keepOwnedTurns(
  session: Session,
  owners: Map<string, { session: Session; request: SessionRequest }>,
  source?: SessionSource,
): boolean {
  const dropped: string[] = [];
  const requests = session.requests.filter(request => {
    const id = request.userEventId;
    if (!id) return true;
    const owner = owners.get(id);
    if (!owner || owner.request === request) return true;
    if (owner.session !== session) dropped.push(id);
    return false;
  });
  if (requests.length === session.requests.length) return true;
  session.requests = requests;
  session.requestCount = requests.length;
  if (requests.length === 0) return false;
  session.creationDate = earliestRequestTime(requests) ?? session.creationDate;
  if (dropped.length > 0) {
    session.inheritedTurns = (session.inheritedTurns ?? 0) + dropped.length;
    if (!session.forkedFromId) session.forkSourceAmbiguous = true;
  }
  if (source && dropped.length > 0) source.droppedUserEventIds = [...(source.droppedUserEventIds ?? []), ...dropped];
  return true;
}

function parseClaudeProjectSessions(
  projectsDir: string,
  dirName: string,
  discovery: ClaudeDiscovery,
  editLocIndex?: EditLocIndex,
  sessionSourceIndex?: Map<string, SessionSource>,
): ClaudeProjectResult | null {
  const projPath = path.join(projectsDir, dirName);
  const workspaceId = `claude-${dirName}`;
  let workspaceName = projectNameFromEncoded(dirName, projectsDir);

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
  const sessionFiles = new Map<string, string[]>();
  const cwds: (string | undefined)[] = [];
  const skippedSessions = new Set<string>();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const filePath = path.join(projPath, entry.name);
    if (discovery.skipFiles.has(filePath)) {
      skippedSessions.add(path.basename(entry.name, '.jsonl'));
      continue;
    }
    const session = parseClaudeSessionFile(filePath, workspaceId, workspaceName, { editLocIndex });
    if (!session) continue;
    cwds.push(session.workspaceRootPath);
    discovery.sessionRanks.set(session, discovery.transcriptRanks.get(filePath) ?? Number.MAX_SAFE_INTEGER);
    sessions.push(session);
    sessionsById.set(session.sessionId, session);
    sessionFiles.set(session.sessionId, [filePath]);
  }

  // Pass 2: walk `<sessionId>/subagents/agent-*.jsonl` directories. Each
  // subagent file is a fan-out of work the parent session orchestrated; we
  // merge its requests into the parent rather than emitting it as its own
  // session. Orphans (subagent dir whose parent session is missing) become
  // standalone programmatic sessions — they're still GHCP-spawned work.
  // Either way, every call in the file is sub-agent work, marked or not.
  // The folders beside a skipped hard-linked transcript merge into its parsed copy instead.
  const subagentDirs = new Map<string, string[]>();
  for (const entry of entries) {
    if (!entry.isDirectory() || skippedSessions.has(entry.name)) continue;
    subagentDirs.set(entry.name, [path.join(projPath, entry.name, 'subagents')]);
  }
  const prefix = discoveryKey(dirName, '');
  for (const [key, dirs] of discovery.extraSubagentDirs) {
    if (!key.startsWith(prefix)) continue;
    const sessionName = key.slice(prefix.length);
    subagentDirs.set(sessionName, [...(subagentDirs.get(sessionName) ?? []), ...dirs]);
  }

  for (const [sessionName, dirs] of subagentDirs) {
    const parent = sessionsById.get(sessionName);
    const orphanRequests: SessionRequest[] = [];
    let orphanFirstTs: number | null = null;
    let orphanLastTs: number | null = null;
    let orphanEntrypoint: string | undefined;

    for (const subagentDir of dirs) {
      let subagentEntries: fs.Dirent[];
      try {
        subagentEntries = fs.readdirSync(subagentDir, { withFileTypes: true });
      } catch {
        continue; // no subagents/ folder under this session — fine
      }

      for (const subEntry of subagentEntries) {
        if (!subEntry.isFile() || !subEntry.name.endsWith('.jsonl')) continue;
        const filePath = path.join(subagentDir, subEntry.name);
        const subSession = parseClaudeSessionFile(filePath, workspaceId, workspaceName, { editLocIndex, subagentFile: true });
        if (!subSession) continue;
        cwds.push(subSession.workspaceRootPath);
        const sourceId = parent?.sessionId ?? sessionName;
        const files = sessionFiles.get(sourceId) ?? [];
        files.push(filePath);
        sessionFiles.set(sourceId, files);

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
    }

    if (parent) continue;

    if (orphanRequests.length > 0) {
      warnCore('parser-claude', `subagent dir without parent session: ${sessionName}`, {
        requestCount: orphanRequests.length,
      });
      orphanRequests.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
      const launcherKind: 'interactive' | 'programmatic' = 'programmatic';
      const orphan = createSession({
        sessionId: sessionName,
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

  const cwdName = workspaceNameFromCwd(cwds, dirName);
  if (cwdName) workspaceName = cwdName;

  // Final pass: re-sort merged parent sessions' requests by timestamp and
  // refresh the cached requestCount.
  for (const session of sessions) {
    session.workspaceName = workspaceName;
    if (session.requests.length > 1) {
      session.requests.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
    }
    session.requestCount = session.requests.length;
    const files = sessionFiles.get(session.sessionId);
    if (files?.length && sessionSourceIndex) {
      const source: SessionSource = {
        kind: 'claude-jsonl',
        filePath: files[0],
        additionalFilePaths: files.slice(1),
        workspaceId,
        workspaceName,
        workspaceRootPath: session.workspaceRootPath,
        harness: session.harness,
      };
      sessionSourceIndex.set(session.sessionId, source);
      discovery.sessionSources.set(session, source);
    }
  }

  return sessions.length > 0 ? { sessions, workspaceId, workspaceName } : null;
}

export function parseClaudeSessions(
  projectsDir: string,
  editLocIndex?: EditLocIndex,
  sessionSourceIndex?: Map<string, SessionSource>,
): { sessions: Session[]; workspaceId: string; workspaceName: string }[] {
  const results: { sessions: Session[]; workspaceId: string; workspaceName: string }[] = [];

  let projectDirs: fs.Dirent[];
  try {
    projectDirs = fs.readdirSync(projectsDir, { withFileTypes: true }).filter(e => e.isDirectory());
  } catch {
    return results;
  }

  const discovery = planClaudeDiscovery(projectsDir, projectDirs.map(dir => dir.name));
  for (const projDir of projectDirs) {
    const result = parseClaudeProjectSessions(projectsDir, projDir.name, discovery, editLocIndex, sessionSourceIndex);
    if (result) results.push(result);
  }

  return keepEachTurnOnce(results, discovery, sessionSourceIndex);
}

export async function parseClaudeSessionsAsync(
  projectsDir: string,
  onProject?: (idx: number, total: number, name: string) => void,
  editLocIndex?: EditLocIndex,
  sessionSourceIndex?: Map<string, SessionSource>,
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

  const discovery = planClaudeDiscovery(projectsDir, projectDirs);
  for (let i = 0; i < projectDirs.length; i++) {
    const dirName = projectDirs[i];
    const result = parseClaudeProjectSessions(projectsDir, dirName, discovery, editLocIndex, sessionSourceIndex);
    if (result) results.push(result);

    // Report after parsing, so the progress detail shows the name taken from the recorded cwd.
    if (onProject) onProject(i + 1, projectDirs.length, result?.workspaceName ?? projectNameFromEncoded(dirName, projectsDir));

    // Yield every 5 projects so the event loop stays responsive
    if (i % 5 === 0) await new Promise<void>(r => setTimeout(r, 0));
  }

  return keepEachTurnOnce(results, discovery, sessionSourceIndex);
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
  requestId: string,
  editLocIndex?: EditLocIndex,
): SessionRequest {
  const hasAnyTokens = assistantData.assistantCount > 0;
  const { usage } = assistantData;
  const imageCount = countClaudeImages(line);
  const uniqueRefs = [...new Set(assistantData.referencedFiles)];
  const skills = new Set(assistantData.skillsUsed);
  for (const name of extractSkillsFromRefs(uniqueRefs)) skills.add(name);
  const request = createRequest({
    requestId,
    userEventId: line.uuid,
    answerEvidence: assistantData.answerEvidence,
    timestamp: userTs,
    messageText: getClaudeUserText(line),
    responseText: assistantData.assistantTexts.join('\n'),
    replyText: assistantData.replyTexts.join('\n'),
    agentName: 'Claude',
    agentMode: 'agent',
    modelId: assistantData.model,
    toolsUsed: assistantData.toolsUsed,
    investigationDelegations: assistantData.investigationDelegations,
    webDomains: [...new Set(assistantData.webDomains)],
    editedFiles: [...new Set(assistantData.editedFiles)],
    referencedFiles: uniqueRefs,
    skillsUsed: [...skills],
    variableKinds: imageCount > 0 ? { image: imageCount } : {},
    totalElapsed: userTs && assistantData.lastTs ? assistantData.lastTs - userTs : null,
    promptTokens: hasAnyTokens ? usage.promptTokens : null,
    completionTokens: hasAnyTokens ? usage.completionTokens : null,
    // null: no cache usage was reported. 0: it was reported with no cache reads or writes (caching off).
    cacheReadTokens: usage.cacheReported ? usage.cacheReadTokens : null,
    cacheWriteTokens: usage.cacheReported ? usage.cacheWriteTokens : null,
    reasoningEffort: extractReasoningEffortFromModelId(assistantData.model),
    curiosity: line.isSidechain || line.isMeta || line.isCompactSummary ? { kind: 'excluded', excerpts: [] } : undefined,
    ...(usage.promptCache ? { promptCache: usage.promptCache } : {}),
    ...(usage.callRowsWithoutCacheData ? { callRowsWithoutCacheData: usage.callRowsWithoutCacheData } : {}),
    ...(usage.contextUsage ? { contextUsage: usage.contextUsage } : {}),
    ...requestCompactionFields(assistantData.compactions),
  });
  if (assistantData.userWaits.length) request.userWaits = assistantData.userWaits;
  mergeRequestEditLoc(editLocIndex, requestId, assistantData.editLocs);
  return request;
}

/** Parse one transcript file. `subagentFile`: the file is a sub-agent's transcript (see `isClaudeSubagentFile`). */
/** Records Claude Code writes beside a turn as it runs; a fork (`--fork-session`) copies the conversation lines of its
 *  source, not these. A prompt's queue record comes just before it; its API request, last-prompt and cost records after. */
const TURN_RECORDS = new Set(['api-request', 'last-prompt', 'cost-state']);
const CONVERSATION = new Set(['user', 'assistant', 'attachment']);

/** The prompt at `i` (its turn ending at `next`) was logged live: queued just before it, or with its own turn records. */
function claudeLoggedLive(lines: ClaudeLine[], i: number, next: number): boolean {
  for (let j = i - 1; j >= 0 && !CONVERSATION.has(lines[j].type); j--) if (lines[j].type === 'queue-operation') return true;
  return lines.slice(i + 1, next).some(l => TURN_RECORDS.has(l.type));
}

export function parseClaudeSessionFile(
  filePath: string,
  wsId: string,
  wsName: string,
  { editLocIndex, subagentFile = false }: { editLocIndex?: EditLocIndex; subagentFile?: boolean } = {},
): Session | null {
  assertTrustedPath(filePath);
  let lines: ClaudeLine[];
  try {
    lines = readClaudeLines(filePath);
  } catch {
    return null;
  }
  if (lines.length === 0) return null;

  const sessionId = lines[0].sessionId || path.basename(filePath, '.jsonl');
  const transcriptKey = claudeTranscriptKey(filePath);
  const requests: SessionRequest[] = [];
  const cacheState: ClaudeCacheState = { sawMain: false, subagentFile };
  // A fork (`--fork-session`) starts its transcript with the source's messages, copied with their own, older times:
  // a prompt older than the transcript's first line was copied.
  const fileStart = lines.map(l => getTimestamp(l.timestamp)).find((ts): ts is number => !!ts) ?? null;
  let cwd = '';
  let firstTs: number | null = null;
  let lastTs: number | null = null;
  let entrypoint: string | undefined;
  const questions = indexClaudeQuestionResults(lines);
  // Compactions logged before the first prompt go to the first request.
  const earlyCompactions: CompactionEvent[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line.type !== 'user' || !userHasText(line)) {
      const compaction = requests.length === 0 ? claudeCompaction(line) : null;
      if (compaction) addTurnCompaction(earlyCompactions, compaction);
      i++;
      continue;
    }

    if (!cwd && line.cwd) cwd = line.cwd;
    // Capture the first non-empty entrypoint we see. In practice Claude Code
    // writes it on every user line, but we only need one.
    if (!entrypoint && line.entrypoint) entrypoint = line.entrypoint;
    const userTs = getTimestamp(line.timestamp);
    ({ firstTs, lastTs } = updateClaudeTimestampRange(userTs, firstTs, lastTs));

    const assistantData = collectClaudeAssistantData(lines, i, lastTs, cacheState, questions);
    if (requests.length === 0) prependCompactions(assistantData, earlyCompactions);
    lastTs = assistantData.lastTs;
    const requestId = claudeRequestId(line, sessionId, requests.length, transcriptKey);
    const request = buildClaudeRequest(line, assistantData, userTs, requestId, editLocIndex);
    // Every turn in a sub-agent's transcript came from the parent agent, whether or not Claude marked it
    // `isSidechain`, which `claudeNonHumanKind` reads for other files.
    const nonHumanKind = subagentFile ? 'subagent' : claudeNonHumanKind(lines, i);
    if (nonHumanKind) markNonHuman(request, nonHumanKind);
    if (!subagentFile && userTs && fileStart !== null && userTs < fileStart) request.historyLeadMs = fileStart - userTs;
    // A copied prompt can sit just after the fork's own opening queue record: one older than the transcript is no live turn.
    if (!request.historyLeadMs && claudeLoggedLive(lines, i, assistantData.nextIndex)) request.loggedLive = true;
    requests.push(request);
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
  });
}
