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

/** Text with each run of whitespace collapsed to one space: its words, and where each starts in the original text
 *  (`at`) and in the collapsed text (`collapsedAt`). */
interface Collapsed { text: string; words: string[]; at: number[]; collapsedAt: number[] }

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
  return { text: words.join(' '), words, at, collapsedAt };
}

/** The word an index falls in, given where each word starts. */
function wordAt(index: number, starts: readonly number[]): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle] <= index) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** Maps an index inside a word to the other text, given where each word starts in this one and in the other. */
function mapIndex(index: number, starts: readonly number[], otherStarts: readonly number[]): number {
  const word = wordAt(index, starts);
  return otherStarts[word] + index - starts[word];
}

/** True when the span from `start` to `end` of the text the harness added lies in text the user typed. */
type IsTyped = (start: number, end: number) => boolean;

const NOTHING_TYPED: IsTyped = () => false;

/**
 * For text the harness changed beyond whitespace: a span is typed when its recorded words are words the user typed,
 * next to a word they typed before or after them. That neighbor is the nearest recorded word on that side that is one
 * of the typed words, past any words the harness inserted. Text the user typed keeps its typed neighbors wherever the
 * harness moved the line breaks or added text; a marker, tag or fence the harness wrote doesn't.
 */
function typedWithNeighbor(recorded: Collapsed, typed: readonly string[]): IsTyped {
  const positions = new Map<string, number[]>();
  for (const [k, word] of typed.entries()) {
    const list = positions.get(word);
    if (list) list.push(k);
    else positions.set(word, [k]);
  }
  const nearestTyped = (from: number, step: number): string | undefined => {
    for (let i = from; i >= 0 && i < recorded.words.length; i += step) {
      if (positions.has(recorded.words[i])) return recorded.words[i];
    }
    return undefined;
  };
  return (start, end) => {
    const first = wordAt(start, recorded.at);
    const candidates = positions.get(recorded.words[first]);
    if (!candidates) return false;
    const length = wordAt(end - 1, recorded.at) - first + 1;
    const before = nearestTyped(first - 1, -1);
    const after = nearestTyped(first + length, 1);
    return candidates.some(k => {
      if (k + length > typed.length) return false;
      for (let i = 1; i < length; i++) if (typed[k + i] !== recorded.words[first + i]) return false;
      return (k > 0 && typed[k - 1] === before) || (k + length < typed.length && typed[k + length] === after);
    });
  };
}

/** The text the harness added to a message, and which of its spans the user typed when it couldn't take them out. */
interface HarnessText { text: string; isTyped: IsTyped }

/**
 * What the harness added to a message: `transformedContent` without the typed `content`. The harness may change the
 * typed text's whitespace (CRLF line endings, the whitespace around it, and line breaks: it can split a typed line,
 * join typed lines or drop a blank line), so the typed text is found with any run of whitespace matching any other,
 * and cut from the text as recorded, keeping the lines, quoted elements and fences around it. When the harness changed
 * more than whitespace, for example by adding a file's path after a mention, the typed text can't be found whole: the
 * text stays as it is, and text that is typed, with a typed word next to it, is skipped. Its markers don't count, and
 * its tags and fences quote nothing, as when it is cut.
 */
function harnessAddedText(data: Record<string, unknown> | undefined): HarnessText {
  const transformed = text(data?.transformedContent);
  const typed = collapseWhitespace(text(data?.content));
  if (!typed.text) return { text: transformed, isTyped: NOTHING_TYPED };
  const recorded = collapseWhitespace(transformed);
  const found = recorded.text.lastIndexOf(typed.text);
  if (found >= 0) {
    const start = mapIndex(found, recorded.collapsedAt, recorded.at);
    const end = mapIndex(found + typed.text.length - 1, recorded.collapsedAt, recorded.at) + 1;
    return { text: transformed.slice(0, start) + transformed.slice(end), isTyped: NOTHING_TYPED };
  }
  return { text: transformed, isTyped: typedWithNeighbor(recorded, typed.words) };
}

/** Where a scan of the text the harness added is: in fenced code (its opening delimiter), or in a quoted element
 *  (its name, and how deep elements of that name nest inside it). */
interface QuoteState { fence?: string; element?: string; depth: number }

/** True when a line that starts at `at` in the text opens, closes or sits in fenced code; updates `state.fence`. As in
 *  Markdown, only a fence of the same character, at least as long and with nothing after it, closes the code. A
 *  delimiter the user typed is text, not a fence. */
function inFencedCode(line: string, at: number, state: QuoteState, isTyped: IsTyped): boolean {
  const match = FENCE.exec(line)?.[1];
  const fence = match && !isTyped(at, at + match.length) ? match : undefined;
  if (!state.fence) {
    if (fence) state.fence = fence;
    return fence !== undefined;
  }
  if (fence && fence[0] === state.fence[0] && fence.length >= state.fence.length && line === fence) state.fence = undefined;
  return true;
}

/**
 * Walks the element tags on a line that starts at `at` in the text; true at a relay element outside quoted text. Every
 * element other than the relay wrapper quotes text (an IDE selection, a file, a notification) until its own closing
 * tag, on the same line or a later one, and elements of the same name nest inside it. A tag the user typed is skipped.
 * Updates `state`.
 */
function relayElementOnLine(line: string, at: number, state: QuoteState, isTyped: IsTyped): boolean {
  TAG.lastIndex = 0;
  for (let tag = TAG.exec(line); tag; tag = TAG.exec(line)) {
    const [, closing, name, selfClosing] = tag;
    if (selfClosing || isTyped(at + tag.index, at + tag.index + tag[0].length)) continue;
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

/** True when a line that starts at `start` in the text carries a relay marker outside quoted text, fenced code and
 *  typed text. Markers after a quoted element closes still count. Updates `state` for the next line. */
function lineIsRelayed(raw: string, start: number, state: QuoteState, isTyped: IsTyped): boolean {
  const line = raw.trim();
  const at = start + raw.length - raw.trimStart().length;
  if (!state.element) {
    if (inFencedCode(line, at, state, isTyped)) return false;
    const header = RELAY_ID_HEADER.exec(line);
    if (header && !isTyped(at, at + header[0].length)) return true;
  }
  return relayElementOnLine(line, at, state, isTyped);
}

/** True when the harness relayed the message from another session: it wrapped it in a relay element, or added a
 *  sender ID header, outside the text it quotes. */
function isRelayed(data: Record<string, unknown> | undefined): boolean {
  const { text: added, isTyped } = harnessAddedText(data);
  const state: QuoteState = { depth: 0 };
  let start = 0;
  for (const line of added.split('\n')) {
    if (lineIsRelayed(line, start, state, isTyped)) return true;
    start += line.length + 1;
  }
  return false;
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

/** True when the nearest earlier user line, before any assistant line, is a typed slash command. */
function expandsTypedCommand(lines: readonly ClaudeTurnLine[], index: number): boolean {
  for (let i = index - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.type === 'assistant') return false;
    if (line.type === 'user') return CLAUDE_TYPED_COMMAND.test(claudeText(line).trimStart());
  }
  return false;
}

/**
 * Claude marks sub-agent transcripts `isSidechain`, the turn that replays a compacted conversation
 * `isCompactSummary`, and lines it wrote itself `isMeta` (the local-command caveat, skill bodies). A typed prompt
 * command is the exception: Claude logs the `<command-name>` line, then the expanded prompt as an `isMeta` line,
 * which is the user's turn. Background task results arrive as `<task-notification>` lines.
 */
export function claudeNonHumanKind(lines: readonly ClaudeTurnLine[], index: number): NonHumanKind | undefined {
  const line = lines[index];
  if (line.isSidechain) return 'subagent';
  if (line.isCompactSummary) return 'compaction';
  const start = claudeText(line).trimStart();
  if (start.startsWith('<task-notification>')) return 'system';
  if (CLAUDE_COMMAND_OUTPUT.test(start)) return 'output';
  if (line.isMeta && !expandsTypedCommand(lines, index)) return 'meta';
  return undefined;
}

/* ---- Codex rollout files ---- */

/** `session_meta.source` is `{ subagent: … }` for review, compact and spawned threads, and `{ internal: … }` for
 *  internal sessions; their prompts come from the parent agent. `cli`, `vscode`, `exec` and `mcp` don't say who typed. */
export function codexSessionNonHumanKind(source: unknown): NonHumanKind | undefined {
  if (isRecord(source) && ('subagent' in source || 'internal' in source)) return 'subagent';
  if (/^(?:subagent|internal)(?:_|$)/i.test(text(source))) return 'subagent';
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
