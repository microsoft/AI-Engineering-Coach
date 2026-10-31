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

/** The element the harness wraps a message from another session in, anywhere on a line. */
const RELAY_WRAPPER = /<(?:cross_session_message|relayed_message)\b/;
/** A sender ID header the harness adds to a message from another session, for example `from_session_id:`. */
const RELAY_ID_HEADER = /^(?:from|sender)(?:_project)?_(?:session|agent)_id[ \t]*[:=]/;
/** A line that opens a block the harness adds around text it quotes, such as `<ide_selection>`; group 1 is the tag. */
const BLOCK_START = /^<([a-z][\w-]*)\b[^>]*>/;

/** What the harness added to a message: `transformedContent` without the typed `content`, compared without CRLF line
 *  endings or surrounding whitespace, which the harness may change. */
function harnessAddedText(data: Record<string, unknown> | undefined): string {
  const transformed = text(data?.transformedContent).replaceAll('\r\n', '\n');
  const typed = text(data?.content).replaceAll('\r\n', '\n').trim();
  const at = typed ? transformed.lastIndexOf(typed) : -1;
  return at < 0 ? transformed : transformed.slice(0, at) + transformed.slice(at + typed.length);
}

/**
 * True when the harness relayed the message from another session: it wrapped it in a relay element, or added a
 * sender ID header. Blocks it adds around quoted text (an IDE selection, a file) and fenced code hold the user's
 * own text, so nothing inside them counts.
 */
function isRelayed(data: Record<string, unknown> | undefined): boolean {
  let block: string | undefined;
  let fenced = false;
  for (const raw of harnessAddedText(data).split('\n')) {
    const line = raw.trim();
    if (block) {
      if (line.includes(`</${block}>`)) block = undefined;
      continue;
    }
    if (line.startsWith('```')) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (RELAY_WRAPPER.test(line) || RELAY_ID_HEADER.test(line)) return true;
    const start = BLOCK_START.exec(line);
    if (start && !line.includes(`</${start[1]}>`)) block = start[1];
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
