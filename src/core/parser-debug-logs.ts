/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* VS Code Copilot debug-logs parser for remote SSH / newer VS Code versions.
 *
 * Data layout:
 *   <workspaceStorage>/<wsId>/GitHub.copilot-chat/debug-logs/<sessionId>/main.jsonl
 *
 * Each line is a span: { ts, dur, sid, type, name, spanId, status, attrs }
 *
 * Event flow per user turn:
 *   session_start → (turn_start → user_message → llm_request → tool_call* → agent_response → turn_end)*
 */

import * as fs from 'fs';
import * as path from 'path';
import { Session, SessionRequest } from './types';
import { createRequest, createSession, detectDevcontainerFromRequests } from './parser-shared';
import { readFile } from './parser-vscode-files';
import { normalizeModel } from './helpers';

interface DebugSpan {
  ts: number;
  dur?: number;
  sid: string;
  type: string;
  name?: string;
  spanId?: string;
  status?: string;
  attrs?: Record<string, unknown>;
}

interface TurnAccumulator {
  userMsg: string;
  userTs: number | null;
  responseChunks: string[];
  toolNames: string[];
  modelId: string;
  inputTokens: number;
  outputTokens: number;
}

function freshTurn(): TurnAccumulator {
  return {
    userMsg: '',
    userTs: null,
    responseChunks: [],
    toolNames: [],
    modelId: '',
    inputTokens: 0,
    outputTokens: 0,
  };
}

function parseSpan(line: string): DebugSpan | null {
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.type !== 'string') return null;
    return {
      ts: typeof obj.ts === 'number' ? obj.ts : 0,
      dur: typeof obj.dur === 'number' ? obj.dur : undefined,
      sid: typeof obj.sid === 'string' ? obj.sid : '',
      type: obj.type,
      name: typeof obj.name === 'string' ? obj.name : undefined,
      spanId: typeof obj.spanId === 'string' ? obj.spanId : undefined,
      status: typeof obj.status === 'string' ? obj.status : undefined,
      attrs: typeof obj.attrs === 'object' && obj.attrs !== null ? obj.attrs as Record<string, unknown> : undefined,
    };
  } catch {
    return null;
  }
}

function flushTurn(turn: TurnAccumulator, requests: SessionRequest[]): void {
  if (!turn.userMsg && turn.responseChunks.length === 0) return;

  const responseText = turn.responseChunks.join('\n');
  requests.push(createRequest({
    messageText: turn.userMsg,
    responseText,
    timestamp: turn.userTs,
    modelId: turn.modelId ? normalizeModel(turn.modelId) : '',
    toolsUsed: turn.toolNames,
    promptTokens: turn.inputTokens > 0 ? turn.inputTokens : null,
    completionTokens: turn.outputTokens > 0 ? turn.outputTokens : null,
  }));
}

export function parseDebugLogSession(mainJsonlPath: string, wsId: string, wsName: string, harness: string, customInstructionsBytes?: number): Session | null {
  let raw: string;
  try {
    raw = readFile(mainJsonlPath);
  } catch {
    return null;
  }

  const lines = raw.split('\n');
  const requests: SessionRequest[] = [];
  let sessionId = '';
  let startTime: number | null = null;
  let turn = freshTurn();

  for (const line of lines) {
    if (!line.trim()) continue;
    const span = parseSpan(line);
    if (!span) continue;

    switch (span.type) {
      case 'session_start':
        sessionId = span.sid || wsId;
        startTime = span.ts || null;
        break;

      case 'user_message': {
        // Flush previous turn if it had content
        if (turn.userMsg || turn.responseChunks.length > 0) {
          flushTurn(turn, requests);
        }
        turn = freshTurn();
        turn.userTs = span.ts || null;
        const content = span.attrs?.content;
        if (typeof content === 'string') {
          turn.userMsg = content;
        }
        break;
      }

      case 'llm_request': {
        const attrs = span.attrs;
        if (!attrs) break;
        const model = attrs.model;
        if (typeof model === 'string' && model) {
          turn.modelId = model;
        }
        const inp = attrs.inputTokens;
        const out = attrs.outputTokens;
        if (typeof inp === 'number') turn.inputTokens += inp;
        if (typeof out === 'number') turn.outputTokens += out;
        break;
      }

      case 'tool_call': {
        const toolName = span.name;
        if (typeof toolName === 'string' && toolName) {
          turn.toolNames.push(toolName);
        }
        break;
      }

      case 'agent_response': {
        const attrs = span.attrs;
        if (!attrs) break;
        const response = attrs.response;
        if (typeof response === 'string' && response) {
          turn.responseChunks.push(response);
        }
        break;
      }

      case 'turn_end':
        // Turn boundary — flush accumulated turn
        flushTurn(turn, requests);
        turn = freshTurn();
        break;
    }
  }

  // Flush any remaining turn
  flushTurn(turn, requests);

  if (requests.length === 0) return null;

  return createSession({
    sessionId: sessionId || wsId,
    workspaceId: wsId,
    workspaceName: wsName,
    location: 'panel',
    harness,
    creationDate: startTime ?? undefined,
    requests,
    customInstructionsBytes,
    hasDevcontainer: detectDevcontainerFromRequests(requests),
  });
}

export function listDebugLogSessions(wsEntryPath: string): string[] {
  const debugLogsDir = path.join(wsEntryPath, 'GitHub.copilot-chat', 'debug-logs');
  try {
    return fs.readdirSync(debugLogsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => path.join(debugLogsDir, d.name, 'main.jsonl'))
      .filter(p => fs.existsSync(p));
  } catch {
    return [];
  }
}
