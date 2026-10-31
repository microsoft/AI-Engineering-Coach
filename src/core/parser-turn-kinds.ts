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

/** The text the harness added to a message, and the typed lines it couldn't take out of it. */
interface HarnessText { text: string; typedLines: ReadonlySet<string> }

/**
 * What the harness added to a message: `transformedContent` without the typed `content`, compared without CRLF line
 * endings or surrounding whitespace, which the harness may change. When the harness reflowed the typed text, so it
 * can't be found whole, the text stays as it is, keeping the quoted elements and fences around the typed lines, and
 * the typed lines come back so that markers on them don't count.
 */
function harnessAddedText(data: Record<string, unknown> | undefined): HarnessText {
  const transformed = text(data?.transformedContent).replaceAll('\r\n', '\n');
  const typed = text(data?.content).replaceAll('\r\n', '\n').trim();
  if (!typed) return { text: transformed, typedLines: new Set() };
  const at = transformed.lastIndexOf(typed);
  if (at >= 0) return { text: transformed.slice(0, at) + transformed.slice(at + typed.length), typedLines: new Set() };
  return { text: transformed, typedLines: new Set(typed.split('\n').map(line => line.trim()).filter(Boolean)) };
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
 * Walks the element tags on a line; true at a relay element outside quoted text when `markers` is set. Every
 * element other than the relay wrapper quotes text (an IDE selection, a file, a notification) until its own closing
 * tag, on the same line or a later one, and elements of the same name nest inside it. Updates `state`.
 */
function relayElementOnLine(line: string, state: QuoteState, markers: boolean): boolean {
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
    if (!RELAY_ELEMENT.test(name)) {
      state.element = name;
      state.depth = 1;
    } else if (markers) {
      return true;
    }
  }
  return false;
}

/** True when a line the user didn't type carries a relay marker outside quoted text and fenced code. Markers after
 *  a quoted element closes still count. Updates `state` for the next line. */
function lineIsRelayed(raw: string, state: QuoteState, typedLines: ReadonlySet<string>): boolean {
  const line = raw.trim();
  const markers = !typedLines.has(line);
  if (!state.element) {
    if (inFencedCode(line, state)) return false;
    if (markers && RELAY_ID_HEADER.test(line)) return true;
  }
  return relayElementOnLine(line, state, markers);
}

/** True when the harness relayed the message from another session: it wrapped it in a relay element, or added a
 *  sender ID header, outside the text it quotes. */
function isRelayed(data: Record<string, unknown> | undefined): boolean {
  const { text: added, typedLines } = harnessAddedText(data);
  const state: QuoteState = { depth: 0 };
  return added.split('\n').some(line => lineIsRelayed(line, state, typedLines));
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
