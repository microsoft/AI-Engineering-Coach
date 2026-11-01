/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * @vitest-environment jsdom
 */

/* The Prompt Cache page when a Copilot CLI or Copilot App call in range logged no cache tokens, but a prompt you sent
 * there returned to an earlier call: the page shows that return on its own card, measured against the call it returned
 * to, which can be outside the range. It claims no cache breaks or misses for that harness and adds its returns to no
 * other harness's figures, whatever other harnesses logged. Synthetic logs go through the real parsers and analyzer. */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PromptCacheData, Session } from '../core/types';
import { parseClaudeSessions } from '../core/parser-claude';
import { PromptCacheAnalyzer } from '../core/analyzer-prompt-cache';
import { toDateStr } from '../core/helpers';
import { TODAY, YESTERDAY, copilotSession, returnedAfterExpiryWithoutCacheData, returnedToday } from '../test/copilot-cache-sessions';
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

const iso = (ms: number): string => new Date(ms).toISOString();

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop() as string, { recursive: true, force: true });
});

function writeJsonl(file: string, lines: object[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map(line => JSON.stringify(line)).join('\n') + '\n', 'utf-8');
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
function todaysData(build: (dir: string) => Session[]): PromptCacheData {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-engineer-coach-page-cache-'));
  tempDirs.push(dir);
  const today = toDateStr(TODAY);
  return new PromptCacheAnalyzer(build(dir), new Map()).getPromptCache({ fromDate: today, toDate: today });
}

/** Yesterday's Copilot App call reports its cache, and today's prompt returns to it with a call that reports it
 *  (`returnReported`) or doesn't. Claude Code reports its cache today unless `claude` is false. */
function todayData({ claude = true, returnReported = false } = {}): PromptCacheData {
  return todaysData(dir => [
    copilotSession(dir, 'app-session', true, [{ at: YESTERDAY, reported: true }, { at: TODAY, reported: returnReported }]),
    ...(claude ? claudeSessions(dir) : []),
  ]);
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

describe('Prompt Cache page with Copilot CLI and Copilot App returns in one range', () => {
  beforeEach(() => rpc.mockReset());

  it.each<[string, string, boolean]>([
    ['Copilot CLI', 'Copilot App', false],
    ['Copilot App', 'Copilot CLI', true],
  ])('keeps the %s attribution\u2019s returns its own, and shows the %s returns on their own card', async (measured, apart, measuredIsApp) => {
    const host = await page(todaysData(dir => [
      returnedToday(dir, 'measured', measuredIsApp),
      returnedAfterExpiryWithoutCacheData(dir, 'apart', !measuredIsApp),
    ]));
    expect(host.querySelector('#ctxCacheAttribution h4')?.textContent).toContain(`Why the cache broke \u00b7 ${measured} \u00b7`);
    expect(host.querySelector('#ctxCacheReturns')?.textContent).toContain('You came back after the cache expired in 0 of 1 returns (0%).');
    const card = host.querySelector('#ctxCacheReturnsOnly')?.textContent ?? '';
    expect(card).toContain(`Cache lifetime and expiry \u00b7 ${apart}`);
    expect(card).toContain(RETURNED);
    expect(card).toContain(`No ${apart} call in this range logged cache tokens, so ${apart} cache breaks and misses can\u2019t be measured`);
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
