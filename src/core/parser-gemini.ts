/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Gemini CLI session parser
 *
 * Data layout:
 *   ~/.gemini/history/<project-id>/sessions/<session-id>.jsonl
 *   ~/.gemini/tmp/<project-name>/chats/<session-id>.jsonl
 */

import * as fs from 'fs';
import * as path from 'path';
import { Session, SessionRequest } from './types';
import { assertTrustedPath, readFileSafe, createRequest, createSession, detectDevcontainerFromRequests } from './parser-shared';
import { normalizeModel } from './helpers';

interface GeminiTokenUsage {
  input?: number;
  output?: number;
  cached?: number;
  thoughts?: number;
  tool?: number;
  total?: number;
}

interface GeminiThought {
  subject?: string;
  description?: string;
  timestamp?: string;
}

interface GeminiToolCall {
  name: string;
  args?: Record<string, unknown>;
  result?: Array<{ functionResponse?: { response?: { output?: string } } }>;
}

interface GeminiMessage {
  id: string;
  timestamp: string;
  type: 'user' | 'gemini';
  content?: string | Array<{ text?: string; functionResponse?: unknown }>;
  thoughts?: GeminiThought[];
  tokens?: GeminiTokenUsage;
  model?: string;
  toolCalls?: GeminiToolCall[];
}

function isGeminiMessage(line: unknown): line is GeminiMessage {
  const l = line as GeminiMessage;
  return l && typeof l.id === 'string' && (l.type === 'user' || l.type === 'gemini');
}

function extractText(content: GeminiMessage['content']): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(c => c.text)
      .map(c => c.text)
      .join('\n');
  }
  return '';
}

const FILE_EDIT_TOOLS = new Set(['edit', 'write_file', 'replace', 'create_file']);
const FILE_REF_TOOLS = new Set(['read_file', 'list_directory', 'grep_search', 'glob']);

function handleGeminiFileEdit(filePath: string, args: Record<string, unknown>, currentRequest: Partial<SessionRequest>) {
  if (!currentRequest.editedFiles) currentRequest.editedFiles = [];
  currentRequest.editedFiles.push(filePath);
  const code = (args.content || args.new_string || args.new_str || args.text) as string;
  if (code && typeof code === 'string') {
    const ext = filePath.split('.').pop() || 'unknown';
    currentRequest.responseText += `\n\`\`\`${ext}\n${code}\n\`\`\``;
  }
}

function handleGeminiToolCall(tc: GeminiToolCall, currentRequest: Partial<SessionRequest>) {
  if (!currentRequest.toolsUsed) currentRequest.toolsUsed = [];
  currentRequest.toolsUsed.push(tc.name);
  const args = tc.args || {};
  const filePath = (args.file_path || args.path || args.dir_path || args.dirPath) as string;

  if (filePath && typeof filePath === 'string') {
    if (FILE_EDIT_TOOLS.has(tc.name)) {
      handleGeminiFileEdit(filePath, args, currentRequest);
    } else if (FILE_REF_TOOLS.has(tc.name)) {
      if (!currentRequest.referencedFiles) currentRequest.referencedFiles = [];
      currentRequest.referencedFiles.push(filePath);
    }
  }

  if (tc.name === 'activate_skill' && args.name) {
    if (!currentRequest.skillsUsed) currentRequest.skillsUsed = [];
    currentRequest.skillsUsed.push(args.name as string);
  }
}

function handleGeminiGeminiMessage(line: GeminiMessage, currentRequest: Partial<SessionRequest>) {
  currentRequest.responseText = extractText(line.content);
  currentRequest.modelId = normalizeModel(line.model || '');
  if (line.tokens) {
    currentRequest.promptTokens = (currentRequest.promptTokens || 0) + (line.tokens.input || 0) + (line.tokens.cached || 0);
    currentRequest.completionTokens = (currentRequest.completionTokens || 0) + (line.tokens.output || 0);
  }
  if (line.toolCalls) {
    for (const tc of line.toolCalls) handleGeminiToolCall(tc, currentRequest);
  }
  if (line.thoughts?.length) {
    const thoughtText = line.thoughts.map(t => `> **${t.subject}**: ${t.description}`).join('\n');
    currentRequest.responseText = thoughtText + '\n\n' + currentRequest.responseText;
  }
}

function handleGeminiMessage(line: GeminiMessage, state: { requests: SessionRequest[], currentRequest: Partial<SessionRequest> | null, startTime: number | null, lastTs: number | null }) {
  const ts = new Date(line.timestamp).getTime();
  if (!state.startTime || ts < state.startTime) state.startTime = ts;
  if (!state.lastTs || ts > state.lastTs) state.lastTs = ts;

  if (line.type === 'user') {
    if (state.currentRequest?.messageText) {
      state.requests.push(createRequest(state.currentRequest as SessionRequest));
    }
    const text = extractText(line.content);
    if (text.includes('<session_context>')) return;
    state.currentRequest = {
      requestId: line.id,
      timestamp: ts,
      messageText: text,
      responseText: '',
      agentName: 'Gemini',
      agentMode: 'agent',
      toolsUsed: [],
      editedFiles: [],
      referencedFiles: [],
      skillsUsed: [],
    };
  } else if (line.type === 'gemini' && state.currentRequest) {
    handleGeminiGeminiMessage(line, state.currentRequest);
    state.requests.push(createRequest(state.currentRequest as SessionRequest));
    state.currentRequest = null;
  }
}

function parseGeminiSessionFile(filePath: string, wsId: string, wsName: string): Session | null {
  assertTrustedPath(filePath);
  const raw = readFileSafe(filePath);
  if (!raw) return null;

  const lines = raw.split('\n').filter(l => l.trim()).map(l => {
    try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; }
  }).filter((l): l is Record<string, unknown> => l !== null);

  if (lines.length === 0) return null;

  const state = {
    requests: [] as SessionRequest[],
    currentRequest: null as Partial<SessionRequest> | null,
    startTime: null as number | null,
    lastTs: null as number | null,
  };
  let sessionId = wsId;

  for (const line of lines) {
    if (line.sessionId && !state.startTime) {
      sessionId = line.sessionId as string;
      if (line.startTime) state.startTime = new Date(line.startTime as string).getTime();
      continue;
    }
    if (isGeminiMessage(line)) {
      handleGeminiMessage(line, state);
    }
  }

  if (state.requests.length === 0) return null;

  return createSession({
    sessionId,
    workspaceId: wsId,
    workspaceName: wsName,
    location: 'terminal',
    harness: 'Gemini CLI',
    creationDate: state.startTime ?? undefined,
    lastMessageDate: state.lastTs ?? undefined,
    requests: state.requests,
    hasDevcontainer: detectDevcontainerFromRequests(state.requests),
  });
}

export function findGeminiDirs(): string[] {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const dirs: string[] = [];
  const historyDir = path.join(home, '.gemini', 'history');
  const tmpDir = path.join(home, '.gemini', 'tmp');
  if (fs.existsSync(historyDir)) dirs.push(historyDir);
  if (fs.existsSync(tmpDir)) dirs.push(tmpDir);
  return dirs;
}

export function parseGeminiSessions(baseDir: string): { sessions: Session[]; workspaceId: string; workspaceName: string }[] {
  const results: { sessions: Session[]; workspaceId: string; workspaceName: string }[] = [];
  function walk(currentDir: string, depth: number) {
    if (depth > 3) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(currentDir, { withFileTypes: true }); } catch { return; }
    const jsonlFiles = entries.filter(e => e.isFile() && e.name.endsWith('.jsonl'));
    if (jsonlFiles.length > 0) {
      const workspaceId = `gemini-${path.basename(path.dirname(currentDir))}`;
      const workspaceName = path.basename(path.dirname(currentDir));
      const sessions: Session[] = [];
      for (const file of jsonlFiles) {
        const session = parseGeminiSessionFile(path.join(currentDir, file.name), workspaceId, workspaceName);
        if (session) sessions.push(session);
      }
      if (sessions.length > 0) results.push({ sessions, workspaceId, workspaceName });
    }
    for (const entry of entries) { if (entry.isDirectory()) walk(path.join(currentDir, entry.name), depth + 1); }
  }
  walk(baseDir, 0);
  return results;
}

export async function parseGeminiSessionsAsync(
  baseDir: string,
  _onProject?: (idx: number, total: number, name: string) => void,
): Promise<{ sessions: Session[]; workspaceId: string; workspaceName: string }[]> {
  return await Promise.resolve(parseGeminiSessions(baseDir));
}
