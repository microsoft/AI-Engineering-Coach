/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Pi (badlogic/pi-mono) session parser
 *
 * Data layout:
 *   ~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<session-uuid>.jsonl
 *
 * Each JSONL file is one session. Entry types (one JSON object per line):
 *   {type:"session", id, timestamp, cwd}                       -- header (first line)
 *   {type:"model_change", provider, modelId}                   -- model switches
 *   {type:"message", message:{role:"user"|"assistant"|"toolResult", ...}}
 *
 * Assistant messages carry `model`, `provider`, `usage {input, output,
 * cacheRead, cacheWrite}`, and a content array of {type:"text"|"thinking"|
 * "toolCall"} items; toolCall items have `name` and `arguments` (with `path`
 * for file tools). A single user turn is usually followed by several
 * assistant/toolResult steps, so token counts are summed per turn (same
 * convention as the Claude Code parser).
 */

import * as fs from 'fs';
import * as path from 'path';
import { Session, SessionRequest } from './types';
import { assertTrustedPath, createRequest, createSession, detectDevcontainerFromRequests } from './parser-shared';
import { extractReasoningEffortFromModelId } from './helpers';

interface PiContentItem {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  arguments?: Record<string, unknown>;
}

interface PiMessage {
  role: string;
  content?: PiContentItem[] | string;
  model?: string;
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  timestamp?: number;
}

interface PiEntry {
  type: string;
  id?: string;
  timestamp?: string;
  cwd?: string;
  message?: PiMessage;
}

const PI_WRITE_TOOLS = new Set(['write', 'edit', 'multi_edit', 'multiedit']);
const PI_READ_TOOLS = new Set(['read', 'glob', 'grep', 'ls', 'find', 'view_file']);

export function findPiDirs(): string[] {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const sessionsDir = path.join(home, '.pi', 'agent', 'sessions');
  return fs.existsSync(sessionsDir) ? [sessionsDir] : [];
}

function readPiEntries(filePath: string): PiEntry[] {
  const entries: PiEntry[] = [];
  try {
    assertTrustedPath(filePath);
    for (const line of fs.readFileSync(filePath, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as PiEntry);
      } catch {
        /* skip malformed lines */
      }
    }
  } catch {
    /* skip unreadable files */
  }
  return entries;
}

function contentItems(message: PiMessage): PiContentItem[] {
  return Array.isArray(message.content) ? message.content : [];
}

function messageTextOf(message: PiMessage): string {
  if (typeof message.content === 'string') return message.content;
  return contentItems(message)
    .filter(item => item.type === 'text' && item.text)
    .map(item => item.text!)
    .join('\n');
}

interface PiTurnData {
  responseText: string;
  toolsUsed: string[];
  editedFiles: string[];
  referencedFiles: string[];
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  sawUsage: boolean;
  lastTs: number | null;
}

function filePathFromToolArgs(args: Record<string, unknown>): string | null {
  const candidate = args['path'] ?? args['filePath'] ?? args['file_path'];
  return typeof candidate === 'string' ? candidate : null;
}

function applyPiToolCall(item: PiContentItem, turn: PiTurnData): void {
  if (!item.name) return;
  turn.toolsUsed.push(item.name);

  const filePath = filePathFromToolArgs(item.arguments ?? {});
  if (!filePath) return;

  const tool = item.name.toLowerCase();
  if (PI_WRITE_TOOLS.has(tool)) turn.editedFiles.push(filePath);
  else if (PI_READ_TOOLS.has(tool)) turn.referencedFiles.push(filePath);
}

function applyAssistantMessage(message: PiMessage, entryTs: number | null, turn: PiTurnData, textParts: string[]): void {
  if (message.model) turn.modelId = message.model;
  if (entryTs && (!turn.lastTs || entryTs > turn.lastTs)) turn.lastTs = entryTs;

  const usage = message.usage;
  if (usage) {
    turn.sawUsage = true;
    const cacheRead = usage.cacheRead ?? 0;
    const cacheWrite = usage.cacheWrite ?? 0;
    // Prompt tokens include cached context so context-window analysis sees the
    // full window; cached portions are also tracked separately.
    turn.inputTokens += (usage.input ?? 0) + cacheRead + cacheWrite;
    turn.outputTokens += usage.output ?? 0;
    turn.cacheReadTokens += cacheRead;
    turn.cacheWriteTokens += cacheWrite;
  }

  for (const item of contentItems(message)) {
    if (item.type === 'text' && item.text) textParts.push(item.text);
    else if (item.type === 'toolCall') applyPiToolCall(item, turn);
  }
}

function entryTimestamp(entry: PiEntry): number | null {
  if (entry.message?.timestamp) return entry.message.timestamp;
  if (entry.timestamp) {
    const parsed = Date.parse(entry.timestamp);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/** Collects every assistant step following `startIndex` until the next user message. */
function collectPiTurn(entries: PiEntry[], startIndex: number, userTs: number | null): { turn: PiTurnData; nextIndex: number } {
  const turn: PiTurnData = {
    responseText: '',
    toolsUsed: [],
    editedFiles: [],
    referencedFiles: [],
    modelId: '',
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    sawUsage: false,
    lastTs: userTs,
  };

  const textParts: string[] = [];
  let i = startIndex;

  for (; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.type !== 'message' || !entry.message) continue;
    if (entry.message.role === 'user') break;
    if (entry.message.role === 'assistant') {
      applyAssistantMessage(entry.message, entryTimestamp(entry), turn, textParts);
    }
  }

  turn.responseText = textParts.join('\n');
  return { turn, nextIndex: i };
}

function buildPiRequest(userEntry: PiEntry, turn: PiTurnData, userTs: number | null): SessionRequest {
  return createRequest({
    requestId: userEntry.id ?? '',
    timestamp: userTs,
    messageText: userEntry.message ? messageTextOf(userEntry.message) : '',
    responseText: turn.responseText,
    agentName: 'Pi',
    modelId: turn.modelId,
    toolsUsed: turn.toolsUsed,
    editedFiles: [...new Set(turn.editedFiles)],
    referencedFiles: [...new Set(turn.referencedFiles)],
    totalElapsed: userTs && turn.lastTs && turn.lastTs > userTs ? turn.lastTs - userTs : null,
    promptTokens: turn.sawUsage ? turn.inputTokens : null,
    completionTokens: turn.sawUsage ? turn.outputTokens : null,
    cacheReadTokens: turn.cacheReadTokens > 0 ? turn.cacheReadTokens : null,
    cacheWriteTokens: turn.cacheWriteTokens > 0 ? turn.cacheWriteTokens : null,
    reasoningEffort: extractReasoningEffortFromModelId(turn.modelId),
  });
}

function parsePiSessionFile(filePath: string): Session | null {
  const entries = readPiEntries(filePath);
  const header = entries.find(entry => entry.type === 'session');
  if (!header?.id) return null;

  const requests: SessionRequest[] = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.type !== 'message' || entry.message?.role !== 'user') continue;

    const userTs = entryTimestamp(entry);
    const { turn, nextIndex } = collectPiTurn(entries, i + 1, userTs);
    requests.push(buildPiRequest(entry, turn, userTs));
    i = nextIndex - 1;
  }

  if (requests.length === 0) return null;

  const cwd = header.cwd || '';
  const workspaceName = cwd ? (cwd.replaceAll('\\', '/').replace(/\/+$/, '').split('/').pop() || 'unknown') : 'unknown';

  return createSession({
    sessionId: header.id,
    workspaceId: `pi-${cwd || header.id}`,
    workspaceName,
    location: 'terminal',
    harness: 'Pi',
    requests,
    hasDevcontainer: detectDevcontainerFromRequests(requests, cwd || undefined),
    workspaceRootPath: cwd || undefined,
  });
}

export function parsePiSessions(sessionsDir: string): Session[] {
  const sessions: Session[] = [];

  let projectDirs: fs.Dirent[];
  try {
    projectDirs = fs.readdirSync(sessionsDir, { withFileTypes: true }).filter(e => e.isDirectory());
  } catch {
    return sessions;
  }

  for (const projectDir of projectDirs) {
    const dirPath = path.join(sessionsDir, projectDir.name);
    let files: string[];
    try {
      files = fs.readdirSync(dirPath).filter(name => name.endsWith('.jsonl'));
    } catch {
      continue;
    }

    for (const file of files) {
      const session = parsePiSessionFile(path.join(dirPath, file));
      if (session) sessions.push(session);
    }
  }

  return sessions;
}
