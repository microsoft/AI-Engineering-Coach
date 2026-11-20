/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Per-harness rules for "user" turns the user didn't type. Each rule reads only what the harness recorded
 * about who sent the turn (a sender field, flag or harness-written tag), never how the text reads, so a typed
 * message that is only code, a URL, a quote or an attachment stays a human turn. */

import type { NonHumanKind } from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/* ---- Copilot CLI and Copilot App (`user.message` events) ---- */

/** The elements the harness wraps a message from another session in. */
const RELAY_ELEMENT = /^(?:cross_session_message|relayed_message)$/;
/** A sender ID header the harness adds to a message from another session, for example `from_session_id:`. */
const RELAY_ID_HEADER = /^(?:from|sender)(?:_project)?_(?:session|agent)_id[ \t]*[:=]/;
/** An element tag: group 1 is `/` in a closing tag, group 2 the name, group 3 `/` in a self-closing tag. */
const TAG = /<(\/?)([a-z][\w-]*)\b[^>]*?(\/?)>/g;
/** A fenced-code delimiter: three or more backticks or tildes. */
const FENCE = /^(`{3,}|~{3,})/;

/** A reference tag the App writes for a typed mention of a repository, issue or session; its label is the typed text. */
const COPILOT_REF = /<copilot-ref(?:\s+[\w-]+="[^"]*")*\s*\/>/g;
const REF_LABEL = /\slabel="([^"]+)"/;
/** The label the App writes before an attached file's name and path. */
const ATTACHED_FILE = 'Attached file: ';

/** Text with each run of whitespace collapsed to one space, and where each word starts in the original text (`at`)
 *  and in the collapsed text (`collapsedAt`). */
interface Collapsed { text: string; at: number[]; collapsedAt: number[] }

function collapseWhitespace(value: string): Collapsed {
  const words: string[] = [];
  const at: number[] = [];
  const collapsedAt: number[] = [];
  let length = 0;
  for (const word of value.matchAll(/\S+/g)) {
    if (words.length > 0) length++;
    at.push(word.index);
    collapsedAt.push(length);
    words.push(word[0]);
    length += word[0].length;
  }
  return { text: words.join(' '), at, collapsedAt };
}

/** Maps an index inside a word to the other text, given where each word starts in this one and in the other. */
function mapIndex(index: number, starts: readonly number[], otherStarts: readonly number[]): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle] <= index) low = middle;
    else high = middle - 1;
  }
  return otherStarts[low] + index - starts[low];
}

/** A mention the App expanded: the span the expansion takes, and the text the user typed for it. */
interface Expansion { start: number; end: number; typed: string }

/**
 * Puts back as typed each mention the App expanded in whitespace-collapsed text: a reference tag becomes its label,
 * and an attached file's name and path, as in `Attached file: notes.md (C:\repo\notes.md)`, become the name. The name
 * and path come from the message's `attachments`, with their whitespace collapsed too; the label before them is
 * optional. Returns the text and its expansions in order, keeping the first of any that overlap.
 */
function unexpandMentions(value: string, attachments: unknown): { text: string; expansions: Expansion[] } {
  const found: Expansion[] = [];
  for (const ref of value.matchAll(COPILOT_REF)) {
    const label = REF_LABEL.exec(ref[0])?.[1].trim();
    if (label) found.push({ start: ref.index, end: ref.index + ref[0].length, typed: label });
  }
  for (const attachment of Array.isArray(attachments) ? attachments : []) {
    const name = isRecord(attachment) ? collapseWhitespace(text(attachment.displayName)).text : '';
    const filePath = isRecord(attachment) ? collapseWhitespace(text(attachment.path)).text : '';
    if (!name || !filePath) continue;
    const expanded = `${name} (${filePath})`;
    for (let at = value.indexOf(expanded); at >= 0; at = value.indexOf(expanded, at + expanded.length)) {
      const labelled = at >= ATTACHED_FILE.length && value.startsWith(ATTACHED_FILE, at - ATTACHED_FILE.length);
      found.push({ start: labelled ? at - ATTACHED_FILE.length : at, end: at + expanded.length, typed: name });
    }
  }
  const expansions: Expansion[] = [];
  let unexpanded = '';
  let cursor = 0;
  for (const expansion of found.sort((a, b) => a.start - b.start)) {
    if (expansion.start < cursor) continue;
    expansions.push(expansion);
    unexpanded += value.slice(cursor, expansion.start) + expansion.typed;
    cursor = expansion.end;
  }
  return { text: unexpanded + value.slice(cursor), expansions };
}

/**
 * Where an index of the un-expanded text is in the text it came from. A span that starts or ends (`isEnd`) inside a
 * mention's typed text takes its whole expansion.
 */
function recordedIndex(index: number, expansions: readonly Expansion[], isEnd: boolean): number {
  let shift = 0;
  for (const { start, end, typed } of expansions) {
    const at = start - shift;
    if (isEnd ? index <= at : index < at) break;
    if (isEnd ? index <= at + typed.length : index < at + typed.length) return isEnd ? end : start;
    shift += end - start - typed.length;
  }
  return index + shift;
}

/**
 * What the harness added to a message: `transformedContent` without the typed `content`. The complete typed text must
 * align, with only the changes the harness is known to make: to its whitespace (CRLF line endings, the whitespace
 * around it, and line breaks: it can split a typed line, join typed lines or drop a blank line) and to its mentions,
 * which it expands. So both texts get their whitespace collapsed and their mentions put back as typed, the last place
 * the typed text appears in the recorded one is found, and that span, with the expansions in it, is cut from the text
 * as recorded, keeping the lines, quoted elements and fences around it. When the typed text doesn't align whole, as
 * after the harness expanded a slash command, none of it is proven typed, so nothing is cut.
 */
function harnessAddedText(data: Record<string, unknown> | undefined): string {
  const transformed = text(data?.transformedContent);
  const typed = unexpandMentions(collapseWhitespace(text(data?.content)).text, data?.attachments).text;
  if (!typed) return transformed;
  const recorded = collapseWhitespace(transformed);
  const { text: unexpanded, expansions } = unexpandMentions(recorded.text, data?.attachments);
  const found = unexpanded.lastIndexOf(typed);
  if (found < 0) return transformed;
  const start = mapIndex(recordedIndex(found, expansions, false), recorded.collapsedAt, recorded.at);
  const end = mapIndex(recordedIndex(found + typed.length, expansions, true) - 1, recorded.collapsedAt, recorded.at) + 1;
  return transformed.slice(0, start) + transformed.slice(end);
}

/** Where a scan of the text the harness added is: in fenced code (its opening delimiter), or in a quoted element
 *  (its name, and how deep elements of that name nest inside it). */
interface QuoteState { fence?: string; element?: string; depth: number }

/** True when a line opens, closes or sits in fenced code; updates `state.fence`. As in Markdown, only a fence of the
 *  same character, at least as long and with nothing after it, closes the code. */
function inFencedCode(line: string, state: QuoteState): boolean {
  const fence = FENCE.exec(line)?.[1];
  if (!state.fence) {
    if (fence) state.fence = fence;
    return fence !== undefined;
  }
  if (fence && fence[0] === state.fence[0] && fence.length >= state.fence.length && line === fence) state.fence = undefined;
  return true;
}

/**
 * Walks the element tags on a line; true at a relay element outside quoted text. Every element other than the relay
 * wrapper quotes text (an IDE selection, a file, a notification) until its own closing tag, on the same line or a
 * later one, and elements of the same name nest inside it. Updates `state`.
 */
function relayElementOnLine(line: string, state: QuoteState): boolean {
  TAG.lastIndex = 0;
  for (let tag = TAG.exec(line); tag; tag = TAG.exec(line)) {
    const [, closing, name, selfClosing] = tag;
    if (selfClosing) continue;
    if (state.element) {
      if (name === state.element) state.depth += closing ? -1 : 1;
      if (state.depth === 0) state.element = undefined;
      continue;
    }
    if (closing) continue;
    if (RELAY_ELEMENT.test(name)) return true;
    state.element = name;
    state.depth = 1;
  }
  return false;
}

/** True when a line carries a relay marker outside quoted text and fenced code. Markers after a quoted element closes
 *  still count. Updates `state` for the next line. */
function lineIsRelayed(raw: string, state: QuoteState): boolean {
  const line = raw.trim();
  if (!state.element) {
    if (inFencedCode(line, state)) return false;
    if (RELAY_ID_HEADER.test(line)) return true;
  }
  return relayElementOnLine(line, state);
}

/** True when the harness relayed the message from another session: it wrapped it in a relay element, or added a
 *  sender ID header, outside the text it quotes. */
function isRelayed(data: Record<string, unknown> | undefined): boolean {
  const state: QuoteState = { depth: 0 };
  return harnessAddedText(data).split('\n').some(line => lineIsRelayed(line, state));
}

/**
 * `data.source` names the sender of a message the user didn't type: `agent-*`, `skill-*`, `system` or `autopilot`
 * (autopilot continuations also carry `isAutopilotContinuation`). A message from another session carries the relay
 * wrapper or a sender ID header in the text the harness added to `transformedContent`. A message with neither is
 * the user's.
 */
export function cliNonHumanKind(data: Record<string, unknown> | undefined): NonHumanKind | undefined {
  const source = text(data?.source);
  if (/^autopilot$/i.test(source) || (/^system$/i.test(source) && data?.isAutopilotContinuation === true)) return 'autopilot';
  if (/^system$/i.test(source)) return 'system';
  if (/^skill(?:-|$)/i.test(source)) return 'skill';
  if (isRelayed(data)) return 'relayed';
  if (/^agent(?:-|$)/i.test(source)) return 'agent';
  return undefined;
}

/* ---- VS Code chat sessions (Local Agent, Insiders and Server) ---- */

/** VS Code flags requests it sent itself (`isSystemInitiated`, e.g. a background terminal finished) and requests
 *  another session delegated (`origin.kind: "delegation"`). Confirmations the user clicks stay the user's. */
export function vscodeNonHumanKind(request: { isSystemInitiated?: unknown; origin?: unknown }): NonHumanKind | undefined {
  if (request.isSystemInitiated === true) return 'system';
  if (isRecord(request.origin) && request.origin.kind === 'delegation') return 'relayed';
  return undefined;
}

/* ---- Claude Code transcripts ---- */

interface ClaudeTurnLine {
  type: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  /** Who sent the line: `{ kind: "human" }` on a typed prompt, `task-notification` or `peer` for other senders. */
  origin?: unknown;
  /** `sdk` on a prompt sent through the SDK (`claude -p`) rather than typed. */
  promptSource?: unknown;
  turnOrigin?: unknown;
  version?: unknown;
  message?: { content?: unknown };
}

function claudeText(line: ClaudeTurnLine): string {
  const content = line.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is { type: string; text: string } => isRecord(block) && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n');
}

/** The line a typed slash command writes before the command runs (`<command-name>`, or `<command-message>` first). */
const CLAUDE_TYPED_COMMAND = /^<command-(?:name|message)>/;
/** Output of `!` shell commands and local commands, which Claude logs as user lines. */
const CLAUDE_COMMAND_OUTPUT = /^<(?:bash-stdout|bash-stderr|local-command-stdout|local-command-stderr)>/;
/** A `!` shell command the user typed. */
const CLAUDE_TYPED_SHELL = /^<bash-input>/;

/** True when the nearest earlier user line, before any assistant line, is a typed slash command. */
function expandsTypedCommand(lines: readonly ClaudeTurnLine[], index: number): boolean {
  for (let i = index - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.type === 'assistant') return false;
    if (line.type === 'user') return CLAUDE_TYPED_COMMAND.test(claudeText(line).trimStart());
  }
  return false;
}

/** The `<system-reminder>` blocks Claude adds to a turn. */
const CLAUDE_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

/** True when the text is only `<system-reminder>` blocks. */
function onlyReminders(start: string): boolean {
  return start.startsWith('<system-reminder>') && start.replace(CLAUDE_REMINDER, '').trim() === '';
}

function claudeOriginKind(line: ClaudeTurnLine): string {
  return isRecord(line.origin) ? text(line.origin.kind) : '';
}

/** Compares dotted version numbers; a missing part counts as 0. */
function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(part => parseInt(part, 10) || 0);
  const right = b.split('.').map(part => parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** The earliest Claude Code version in a transcript that wrote `origin` on a user line, if any did. Lines that
 *  version or later without `origin` were not typed. */
export function claudeOriginSince(lines: readonly ClaudeTurnLine[]): string | undefined {
  let since: string | undefined;
  for (const line of lines) {
    if (line.type !== 'user' || !isRecord(line.origin) || typeof line.version !== 'string') continue;
    if (since === undefined || compareVersions(line.version, since) < 0) since = line.version;
  }
  return since;
}

/** True when the line comes from a build that writes `origin` on every typed prompt: it has the `turnOrigin` or
 *  `promptSource` those builds write, or the transcript wrote `origin` from an earlier or the same version. */
function writesOrigin(line: ClaudeTurnLine, originSince: string | undefined): boolean {
  if (typeof line.turnOrigin === 'string' || typeof line.promptSource === 'string') return true;
  if (originSince === undefined) return false;
  return typeof line.version !== 'string' || compareVersions(line.version, originSince) >= 0;
}

/**
 * Claude marks sub-agent transcripts `isSidechain` (and `parseClaudeSessionFile` marks every turn of a file under
 * `subagents/`, with or without that field), the turn that replays a compacted conversation
 * `isCompactSummary`, and lines it wrote itself `isMeta` (the local-command caveat, skill bodies). A typed prompt
 * command is the exception: Claude logs the `<command-name>` line, then the expanded prompt as an `isMeta` line,
 * which is the user's turn. Background task results arrive as `<task-notification>` lines.
 *
 * Newer builds also write `origin` on user lines: `human` for a typed prompt, `task-notification` and `peer` for
 * other senders. From the first build that writes it (`originSince`, see `claudeOriginSince`), a line without it was
 * not typed: a prompt sent through the SDK (`promptSource: "sdk"`, as `claude -p` from a script) or one the harness
 * sent, such as a scheduled run. Older logs keep the rules above.
 */
export function claudeNonHumanKind(lines: readonly ClaudeTurnLine[], index: number, originSince?: string): NonHumanKind | undefined {
  const line = lines[index];
  if (line.isSidechain) return 'subagent';
  if (line.isCompactSummary) return 'compaction';
  const start = claudeText(line).trimStart();
  const origin = claudeOriginKind(line);
  if (origin === 'task-notification' || start.startsWith('<task-notification>')) return 'system';
  if (CLAUDE_COMMAND_OUTPUT.test(start)) return 'output';
  if (origin === 'peer') return 'relayed';
  if (origin && origin !== 'human') return 'system';
  const expandsCommand = expandsTypedCommand(lines, index);
  if (line.isMeta && !expandsCommand) return 'meta';
  if (onlyReminders(start)) return 'meta';
  if (!origin && !expandsCommand && !CLAUDE_TYPED_SHELL.test(start) && writesOrigin(line, originSince)) {
    return line.promptSource === 'sdk' || line.turnOrigin === 'sdk' ? 'scripted' : 'system';
  }
  return undefined;
}

/* ---- Codex rollout files ---- */

/** `session_meta.source` is `{ subagent: … }` for review, compact and spawned threads, and `{ internal: … }` for
 *  internal sessions; their prompts come from the parent agent. `exec` (originator `codex_exec`) is a
 *  non-interactive `codex exec` run, which scripts and other agents start. `cli`, `vscode` and `mcp` don't say who
 *  typed. */
export function codexSessionNonHumanKind(source: unknown, originator?: unknown): NonHumanKind | undefined {
  if (isRecord(source) && ('subagent' in source || 'internal' in source)) return 'subagent';
  if (/^(?:subagent|internal)(?:_|$)/i.test(text(source))) return 'subagent';
  if (/^exec$/i.test(text(source)) || /^codex_exec$/i.test(text(originator))) return 'scripted';
  return undefined;
}

/* ---- OpenCode messages ---- */

/** The synthetic text OpenCode logs when the user runs a `!` shell command. */
const OPENCODE_USER_SHELL = 'The following tool was executed by the user';

/**
 * OpenCode writes an automatic compaction request as a user message with a `compaction` part (`auto: true`;
 * `false` when the user typed `/compact`), and marks every part of a message it generated `synthetic`, as in the
 * "Continue if you have next steps" message after compaction. Its shell-command marker is the user's turn.
 */
export function openCodeMessageNonHumanKind(
  parts: readonly { type?: unknown; text?: unknown; synthetic?: unknown; auto?: unknown }[] | undefined,
): NonHumanKind | undefined {
  if (!parts || parts.length === 0) return undefined;
  if (parts.some(part => part.type === 'compaction' && part.auto === true)) return 'compaction';
  const generated = parts.every(part => part.synthetic === true);
  if (generated && !parts.some(part => text(part.text).trim() === OPENCODE_USER_SHELL)) return 'system';
  return undefined;
}
