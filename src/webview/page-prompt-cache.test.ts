/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * @vitest-environment jsdom
 */

/* The Prompt Cache page when no Copilot CLI or Copilot App call in range logged cache tokens, but a prompt you sent
 * there returned to an earlier call: the page shows that return, measured against the call it returned to, which can
 * be outside the range, and claims no cache breaks or misses for those harnesses, whatever other harnesses logged.
 * Synthetic logs go through the real parsers and analyzer. */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PromptCacheData, Session } from '../core/types';
import { parseCLIEventsFile } from '../core/parser-vscode-cli';
import { parseClaudeSessions } from '../core/parser-claude';
import { PromptCacheAnalyzer } from '../core/analyzer-prompt-cache';
import { toDateStr } from '../core/helpers';
import { renderPromptCache } from './page-prompt-cache';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock('./shared', () => ({
  rpc,
  Chart: class {},
  trackChart: vi.fn(),
  createChart: vi.fn(),
  destroyChartById: vi.fn(),
  formatNum: (n: number) => String(n),
  harnessColor: () => '#888888',
  COLORS: new Proxy({}, { get: () => '#888888' }),
}));

const YESTERDAY = Date.parse('2026-10-28T09:00:00Z');
const TODAY = YESTERDAY + 86_400_000;
const iso = (ms: number): string => new Date(ms).toISOString();

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop() as string, { recursive: true, force: true });
});

function writeJsonl(file: string, lines: object[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map(line => JSON.stringify(line)).join('\n') + '\n', 'utf-8');
}

/** A Copilot App main-agent call that starts and is logged at `at`. A reported call's cache expires 5 minutes after
 *  its start; an unreported one logs `cacheDetailsReported: false` and no expiry. */
function appCall(at: number, initiator: 'user' | 'agent', reported: boolean): object {
  const cache = reported
    ? { cacheReadTokens: 0, cacheWriteTokens: 150_000, cacheExpiresAt: iso(at + 300_000), cacheTtlSeconds: 300, cacheDetailsReported: true }
    : { cacheReadTokens: 0, cacheWriteTokens: 0, cacheDetailsReported: false };
  return {
    type: 'session.usage_record',
    timestamp: iso(at),
    data: { usage: { model: 'claude-opus-5.5', initiator, interactionType: 'conversation-agent', inputTokens: 150_000, outputTokens: 500, ...cache } },
  };
}

/** Yesterday's call reports its cache; today's prompt returns to it with a call that doesn't. */
function appSession(dir: string, { returnReported = false } = {}): Session {
  const file = path.join(dir, 'app', 'events.jsonl');
  writeJsonl(file, [
    { type: 'session.start', timestamp: iso(YESTERDAY), data: { sessionId: 'app-session', startTime: iso(YESTERDAY), selectedModel: 'claude-opus-5.5', remoteSteerable: true } },
    { type: 'user.message', id: 'u1', timestamp: iso(YESTERDAY), data: { content: 'secret prompt one' } },
    appCall(YESTERDAY, 'agent', true),
    { type: 'user.message', id: 'u2', timestamp: iso(TODAY), data: { content: 'secret prompt two' } },
    appCall(TODAY, 'user', returnReported),
  ]);
  const session = parseCLIEventsFile(file, 'ws-app', 'app');
  if (!session) throw new Error('no Copilot App session');
  return session;
}

/** A Claude Code request today that reports cache usage. */
function claudeSessions(dir: string): Session[] {
  const line = { userType: 'external', cwd: '/Users/me/proj', sessionId: 'claude-session', version: '2.0.14', gitBranch: 'main' };
  writeJsonl(path.join(dir, 'projects', '-Users-me-proj', 'claude-session.jsonl'), [
    { parentUuid: null, ...line, type: 'user', uuid: 'c-u1', timestamp: iso(TODAY + 60_000), message: { role: 'user', content: 'secret claude prompt' } },
    {
      parentUuid: 'c-u1', ...line, type: 'assistant', uuid: 'c-a1', timestamp: iso(TODAY + 61_000),
      message: {
        model: 'claude-sonnet-4-5-20250929', id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'secret answer' }],
        stop_reason: 'end_turn', usage: { input_tokens: 10, cache_read_input_tokens: 30_000, cache_creation_input_tokens: 1_000, output_tokens: 20 },
      },
    },
  ]);
  return parseClaudeSessions(path.join(dir, 'projects')).flatMap(result => result.sessions);
}

/** The Prompt Cache data for today only, from the real parsers and analyzer. */
function todayData({ claude = true, returnReported = false } = {}): PromptCacheData {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-engineer-coach-page-cache-'));
  tempDirs.push(dir);
  const sessions = [appSession(dir, { returnReported }), ...(claude ? claudeSessions(dir) : [])];
  const today = toDateStr(TODAY);
  return new PromptCacheAnalyzer(sessions, new Map()).getPromptCache({ fromDate: today, toDate: today });
}

async function page(data: PromptCacheData): Promise<HTMLElement> {
  rpc.mockResolvedValueOnce(data);
  const host = document.createElement('div');
  await renderPromptCache(host, {});
  return host;
}

const RETURNED = 'You came back after the cache expired in 1 of 1 returns (100%).';
const SCOPED = 'No Copilot App call in this range logged cache tokens, so Copilot App cache breaks and misses can\u2019t be measured; only your returns are shown.';

describe('Prompt Cache page when another harness logged cache tokens but Copilot didn\u2019t', () => {
  beforeEach(() => rpc.mockReset());

  it('shows the Copilot return measured against yesterday\u2019s call, and no zero breaks or misses for Copilot', async () => {
    const data = todayData();
    expect(data.harnesses.find(h => h.harness === 'Claude')?.all).not.toBeNull();
    expect(data.harnesses.find(h => h.harness === 'GitHub Copilot App')).toMatchObject({ all: null, breaks: null, requestsWithData: 0 });
    expect(data.attribution).toBeNull();
    expect(data.returnsWithoutCacheData).toEqual({ label: 'Copilot App', harnesses: ['GitHub Copilot App'], returns: 1, expiredReturns: 1, unmeasuredReturns: 0 });

    const host = await page(data);
    // Claude's cache rows give the populated layout.
    expect(host.querySelector('#ctxPromptCacheTitle')).not.toBeNull();
    expect(host.querySelector('#ctxCacheAttribution')).toBeNull();
    expect(host.querySelector('#ctxCacheNoBreaks')).toBeNull();
    const text = host.textContent ?? '';
    expect(text).not.toContain('0 per 100 calls');
    expect(text).not.toContain('No cache breaks in this range');
    expect(text).not.toContain('tokens missed the cache');
    const returns = host.querySelector('#ctxCacheReturnsOnly')?.textContent ?? '';
    expect(returns).toContain(RETURNED);
    expect(returns).toContain(SCOPED);
  });

  it('shows the full attribution once the returning Copilot call reports its cache', async () => {
    const host = await page(todayData({ returnReported: true }));
    expect(host.querySelector('#ctxCacheAttribution')).not.toBeNull();
    expect(host.querySelector('#ctxCacheReturnsOnly')).toBeNull();
    expect(host.querySelector('#ctxCacheReturns')?.textContent).toContain(RETURNED);
  });
});

describe('Prompt Cache page for a range in which no call logged cache tokens', () => {
  beforeEach(() => rpc.mockReset());

  it('still shows the returns its Copilot prompts counted', async () => {
    const host = await page(todayData({ claude: false }));
    expect(host.querySelector('#ctxCacheEmpty')).not.toBeNull();
    expect(host.querySelector('#ctxCacheAttribution')).toBeNull();
    const returns = host.querySelector('#ctxCacheReturnsOnly')?.textContent ?? '';
    expect(returns).toContain(RETURNED);
    expect(returns).toContain(SCOPED);
  });

  it('says when a return\u2019s expiry can\u2019t be measured', async () => {
    const data = todayData({ claude: false });
    data.returnsWithoutCacheData = { label: 'Copilot App and Copilot CLI', harnesses: ['GitHub Copilot App', 'GitHub Copilot CLI'], returns: 0, expiredReturns: 0, unmeasuredReturns: 2 };
    const returns = (await page(data)).querySelector('#ctxCacheReturnsOnly')?.textContent ?? '';
    expect(returns).toContain('2 returns came after a call that didn\u2019t log when its cache expires, so expiry can\u2019t be measured.');
    expect(returns).toContain('No Copilot App or Copilot CLI call in this range logged cache tokens, so Copilot App and Copilot CLI cache breaks and misses can\u2019t be measured');
  });

  it('shows no returns card without any', async () => {
    const data = todayData({ claude: false });
    data.returnsWithoutCacheData = null;
    const host = await page(data);
    expect(host.querySelector('#ctxCacheEmpty')).not.toBeNull();
    expect(host.querySelector('#ctxCacheReturnsOnly')).toBeNull();
  });
});
