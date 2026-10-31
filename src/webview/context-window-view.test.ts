/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * @vitest-environment jsdom
 */

import { describe, expect, it, vi } from 'vitest';
import type { SessionContextDetail, WorkspaceContextScore } from '../core/types';
import { Analyzer } from '../core/analyzer';
import { createRequest, createSession } from '../core/parser-shared';
import { CONTEXT_WINDOW_DEFAULT } from '../core/constants';

vi.mock('./shared', () => ({ formatNum: (n: number) => `${Math.round(n / 1000)}K` }));

import { render } from './render';
import { utilizationSeries, windowFootnote, windowNote, windowTag } from './context-window-view';

function detail(overrides: Partial<SessionContextDetail>): SessionContextDetail {
  return {
    sessionId: 's', date: '2026-10-30', harness: 'GitHub Copilot CLI', requestCount: 2, requestsWithTokens: 2,
    avgPromptTokens: 0, maxPromptTokens: 0, avgUtilization: 0, peakUtilization: 0, contextWindow: 160_000,
    compactionCount: 0, tokenCurve: [100_000, 150_000], saturation: 0, costEfficiency: null, verdict: 'optimal',
    events: [], requestQueries: ['a', 'b'], hasPerRequestTokens: true, windowSource: 'mixed', turnLimits: [968_000, null],
    ...overrides,
  };
}

function workspace(harness: string, windowSource: WorkspaceContextScore['windowSource']): WorkspaceContextScore {
  return {
    workspaceId: harness, workspaceName: harness, harness, sessionCount: 1, requestsWithTokens: 5, avgPromptTokens: 0,
    maxPromptTokens: 0, avgUtilization: 0, peakUtilization: 0, saturation: 0, compactionCount: 0, costEfficiency: null,
    score: 80, verdict: 'optimal', windowSource,
  };
}

function rendered(children: ReturnType<typeof windowFootnote>): HTMLElement {
  const host = document.createElement('div');
  render(children, host);
  return host;
}

describe('context-window labels', () => {
  it('measures a mixed session\u2019s turns against their own limit, else the session\u2019s estimate', () => {
    expect(utilizationSeries(detail({}), 128_000)).toEqual([10.3, 93.8]);
    // Estimated sessions use their own estimate, like their row; the workspace's window is only a fallback.
    expect(utilizationSeries(detail({ windowSource: 'estimated', turnLimits: undefined }), 200_000)).toEqual([62.5, 93.8]);
    expect(utilizationSeries(detail({ windowSource: 'estimated', turnLimits: undefined, contextWindow: 0 }), 200_000)).toEqual([50, 75]);
  });

  it('charts an estimated session with turns that peaked above their last prompt like its row', () => {
    const turn = (n: number, last: number, peak: number) => createRequest({
      requestId: `r${n}`, messageText: 'm', responseText: 'r', timestamp: Date.UTC(2026, 9, 28, 10, n), promptTokens: last, completionTokens: 100,
      contextUsage: { lastPromptTokens: last, peakPromptTokens: peak, contextLimit: null, calls: 3 },
    });
    const session = createSession({ sessionId: 's', workspaceId: 'ws', workspaceName: 'ws', harness: 'Claude', requests: [turn(1, 30_000, 200_000), turn(2, 30_000, 30_000)] });
    const data = new Analyzer([session]).getWorkspaceContextSessions('ws');
    const [row] = data.sessions;
    // The workspace's window comes from last prompts only; the session's includes the 200K peak (224K).
    expect(data.estimatedContextWindow).toBe(CONTEXT_WINDOW_DEFAULT);
    expect(row).toMatchObject({ windowSource: 'estimated', contextWindow: 224_000, avgUtilization: 13.4, peakUtilization: 13.4 });
    expect(utilizationSeries(row, data.estimatedContextWindow)).toEqual([13.4, 13.4]);
  });

  it('says which turns reported their limit in the session header', () => {
    expect(windowNote(detail({}))).toBe(' \u00b7 context limit reported for some turns; the others use an estimated 160K');
    expect(windowNote(detail({ windowSource: 'reported', contextWindow: 968_000 }))).toBe(' \u00b7 context limit 968K (reported)');
    expect(windowNote(detail({ windowSource: 'estimated' }))).toBe('');
    expect(rendered(windowTag('mixed')).textContent).toBe('mixed limits');
  });

  it('tells where a Copilot CLI or Copilot App session shows its context timeline', () => {
    const cli = rendered(windowFootnote([workspace('GitHub Copilot App', 'reported'), workspace('Local Agent', 'estimated')]));
    expect(cli.querySelector('.ctx-window-note')?.textContent).toContain('report their context limit');
    expect(cli.querySelector('.ctx-timeline-hint')?.textContent).toContain('click its workspace, then the session');

    const codex = rendered(windowFootnote([workspace('Codex', 'reported')]));
    expect(codex.querySelector('.ctx-window-note')).not.toBeNull();
    expect(codex.querySelector('.ctx-timeline-hint')).toBeNull();

    expect(rendered(windowFootnote([workspace('Local Agent', 'estimated')])).textContent).toBe('');
  });
});
