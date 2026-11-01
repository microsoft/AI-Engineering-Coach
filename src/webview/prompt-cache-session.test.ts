/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * @vitest-environment jsdom
 */

/* Prompt Cache session rows and their detail panels. Codex logs only session totals, so its sessions say so instead
 * of claiming they made no model calls. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CacheSessionSummary, SessionTimelineData } from '../core/types';
import { attachSessionToggles, renderSessionList } from './prompt-cache-session';
import { render } from './render';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock('./shared', () => ({
  rpc,
  Chart: class {},
  trackChart: vi.fn(),
  createChart: vi.fn(),
  destroyChartById: vi.fn(),
  formatNum: (n: number) => n.toLocaleString('en-US'),
  harnessColor: () => '#888888',
  COLORS: new Proxy({}, { get: () => '#888888' }),
}));

afterEach(() => {
  rpc.mockReset();
  document.body.replaceChildren();
});

function summary(harness: string, reporting: CacheSessionSummary['reporting'], calls: number): CacheSessionSummary {
  return {
    sessionId: `${harness}-1`, date: '2026-10-20', workspaceName: 'alpha', harness, reporting, calls,
    hitPct: 90, breaks: null, rebuiltTokens: null, misses: 20_000, topCause: null, sparkline: [],
  };
}

function mount(sessions: CacheSessionSummary[]): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  render(renderSessionList(sessions, 'Sessions'), host);
  return host;
}

const CALL_COUNT = /\b\d[\d,]* calls?\b/;

describe('Prompt Cache session list', () => {
  it('says a Codex session has session totals instead of claiming it made no model calls', () => {
    const host = mount([summary('Codex', 'per-session', 0), summary('Claude', 'per-call', 64)]);
    const [codex, claude] = [...host.querySelectorAll('.ctx-cache-session-toggle')].map(row => row.textContent ?? '');
    expect(codex).toContain('session totals');
    expect(codex).not.toMatch(CALL_COUNT);
    expect(claude).toContain('64 calls');
  });
});

describe('Prompt Cache session detail', () => {
  it('shows a Codex session\u2019s totals without a count of model calls', async () => {
    const data: SessionTimelineData = {
      sessionId: 'Codex-1', harness: 'Codex', unit: 'requests', timeline: null,
      cache: {
        reporting: 'per-session',
        main: { calls: 0, input: 200_000, cacheRead: 180_000, cacheWrite: 0, uncached: 20_000, hitPct: 90, writePct: 0, uncachedPct: 10 },
        subagents: null, compaction: null, breaks: [], omittedBreaks: 0,
      },
    };
    rpc.mockResolvedValueOnce(data);
    const host = mount([summary('Codex', 'per-session', 0)]);
    attachSessionToggles(host);
    host.querySelector<HTMLButtonElement>('.ctx-cache-session-toggle')?.click();
    await vi.waitFor(() => expect(host.querySelector('.ctx-cache-session-detail')).not.toBeNull());
    const values = host.querySelector('.ctx-cache-session-detail .ctx-comp-values')?.textContent ?? '';
    expect(values).toBe('Main agent: 90% hit over 200,000 tokens');
    expect(rpc).toHaveBeenCalledWith('getSessionTimeline', { sessionId: 'Codex-1' });
  });

  it('keeps the count of model calls for harnesses that log every call', async () => {
    const data: SessionTimelineData = {
      sessionId: 'Claude-1', harness: 'Claude', unit: 'requests', timeline: null,
      cache: {
        reporting: 'per-call',
        main: { calls: 64, input: 3_000_000, cacheRead: 2_730_000, cacheWrite: 255_000, uncached: 15_000, hitPct: 91, writePct: 8.5, uncachedPct: 0.5 },
        subagents: null, compaction: null, breaks: [], omittedBreaks: 0,
      },
    };
    rpc.mockResolvedValueOnce(data);
    const host = mount([summary('Claude', 'per-call', 64)]);
    attachSessionToggles(host);
    host.querySelector<HTMLButtonElement>('.ctx-cache-session-toggle')?.click();
    await vi.waitFor(() => expect(host.querySelector('.ctx-cache-session-detail')).not.toBeNull());
    expect(host.querySelector('.ctx-cache-session-detail .ctx-comp-values')?.textContent).toBe('Main agent: 91% hit over 64 calls, 3,000,000 tokens');
  });
});
