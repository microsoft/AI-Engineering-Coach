/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Synthetic Copilot CLI and Copilot App sessions for prompt-cache tests: one events.jsonl file per session, written
 * under a directory the test owns and read by the real parser. Prompts are placeholders, and each call carries only
 * token counts, times and the model, as current builds log them. */

import * as fs from 'fs';
import * as path from 'path';
import { parseCLIEventsFile } from '../core/parser-vscode-cli';
import type { Session } from '../core/types';

/** Yesterday and today in these sessions, 09:00 UTC. */
export const YESTERDAY = Date.parse('2026-10-28T09:00:00Z');
export const TODAY = YESTERDAY + 86_400_000;

const PROMPT_TOKENS = 150_000;

const iso = (ms: number): string => new Date(ms).toISOString();

/** One turn: a prompt and its main-agent call, which starts and is logged at `at`. A call that reports its cache reads
 *  `read` tokens from it, and the cache then expires 5 minutes after the call's start; a call that doesn't logs
 *  `cacheDetailsReported: false` and no expiry. The agent makes the first turn's call; you send the later prompts. */
export interface CopilotTurn {
  at: number;
  reported: boolean;
  read?: number;
}

function usageRecord(turn: CopilotTurn, initiator: 'user' | 'agent'): object {
  const read = turn.read ?? 0;
  const cache = turn.reported
    ? { cacheReadTokens: read, cacheWriteTokens: PROMPT_TOKENS - read, cacheExpiresAt: iso(turn.at + 300_000), cacheTtlSeconds: 300, cacheDetailsReported: true }
    : { cacheReadTokens: 0, cacheWriteTokens: 0, cacheDetailsReported: false };
  return {
    type: 'session.usage_record',
    timestamp: iso(turn.at),
    data: { usage: { model: 'claude-opus-5.5', initiator, interactionType: 'conversation-agent', inputTokens: PROMPT_TOKENS, outputTokens: 500, ...cache } },
  };
}

/** A Copilot App session (`app`) or a Copilot CLI one under `dir`, parsed. */
export function copilotSession(dir: string, sessionId: string, app: boolean, turns: CopilotTurn[]): Session {
  const start = iso(turns[0]?.at ?? YESTERDAY);
  const lines = [
    { type: 'session.start', timestamp: start, data: { sessionId, startTime: start, selectedModel: 'claude-opus-5.5', ...(app ? { remoteSteerable: true } : {}) } },
    ...turns.flatMap((turn, i) => [
      { type: 'user.message', id: `u${i}`, timestamp: iso(turn.at), data: { content: `prompt ${i}` } },
      usageRecord(turn, i === 0 ? 'agent' : 'user'),
    ]),
  ];
  const file = path.join(dir, sessionId, 'events.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map(line => JSON.stringify(line)).join('\n') + '\n', 'utf-8');
  const session = parseCLIEventsFile(file, `ws-${sessionId}`, sessionId);
  if (!session) throw new Error(`no session parsed from ${file}`);
  return session;
}

/** Today, a prompt you sent a minute after the agent's call, which reported its cache and read it all. */
export function returnedToday(dir: string, sessionId: string, app: boolean): Session {
  return copilotSession(dir, sessionId, app, [{ at: TODAY, reported: true }, { at: TODAY + 60_000, reported: true, read: PROMPT_TOKENS }]);
}

/** Today, a prompt you sent after the cache of yesterday's call, which reported it, had expired. The call that
 *  answered it reported no cache details, so its request has return counts but no cache rows. */
export function returnedAfterExpiryWithoutCacheData(dir: string, sessionId: string, app: boolean): Session {
  return copilotSession(dir, sessionId, app, [{ at: YESTERDAY, reported: true }, { at: TODAY, reported: false }]);
}
