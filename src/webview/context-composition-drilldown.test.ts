/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionContextDetail, WorkspaceContextSessionsData } from '../core/types';
import { attachCompositionDrilldown } from './context-composition-drilldown';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), destroyChartById: vi.fn(), createChart: vi.fn() }));
vi.mock('./shared', () => ({
  rpc: mocks.rpc,
  destroyChartById: mocks.destroyChartById,
  createChart: mocks.createChart,
  formatNum: (n: number) => String(n),
  harnessColor: () => '#888888',
  COLORS: new Proxy({}, { get: () => '#888888' }),
}));

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void };

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  let reject: (error: Error) => void = () => {};
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
}

function session(sessionId: string, source: 'copilot-cli' | 'vscode' = 'copilot-cli'): SessionContextDetail {
  return {
    sessionId,
    date: '2026-09-30',
    harness: source === 'vscode' ? 'Local Agent' : 'GitHub Copilot CLI',
    requestCount: 2,
    requestsWithTokens: 0,
    avgPromptTokens: 0,
    maxPromptTokens: 0,
    avgUtilization: 0,
    peakUtilization: 0,
    contextWindow: 0,
    compactionCount: 0,
    tokenCurve: [null, null],
    saturation: 0,
    costEfficiency: null,
    verdict: 'optimal',
    events: [],
    requestQueries: ['first', 'second'],
    hasPerRequestTokens: false,
    composition: {
      source,
      breakdown: { slices: [{ category: 'toolDefinitions', pct: 10, tokens: 30_000 }, { category: 'conversation', pct: 90, tokens: 270_000 }], weighting: 'tokens', samples: 2, avgPromptTokens: 300_000 },
      perRequest: [{ toolDefinitions: 10, conversation: 90 }, null],
      systemSegments: [],
      toolCount: null,
      toolTokens: null,
      compactions: [],
    },
  };
}

function response(...sessions: SessionContextDetail[]): WorkspaceContextSessionsData {
  return { workspaceName: 'infra', estimatedContextWindow: 0, thresholds: { optimalUtilization: 50, limitedUtilization: 80, adaptive: false, sampleSize: 0 }, sessions };
}

/** One workspace row as the composition card renders it, wired to the drill-down. */
function setup(): { toggle: HTMLButtonElement; panel: HTMLElement } {
  const root = document.createElement('section');
  root.innerHTML = `<div class="ctx-comp-ws" data-workspace="infra" data-source="copilot-cli">
    <button type="button" class="ctx-comp-ws-toggle" aria-expanded="false">Sessions</button>
    <div class="ctx-comp-ws-sessions" hidden></div>
  </div>`;
  document.body.replaceChildren(root);
  attachCompositionDrilldown(root, { fromDate: '2026-09-01' });
  return { toggle: root.querySelector<HTMLButtonElement>('.ctx-comp-ws-toggle')!, panel: root.querySelector<HTMLElement>('.ctx-comp-ws-sessions')! };
}

const listed = (panel: HTMLElement) => [...panel.querySelectorAll<HTMLButtonElement>('.ctx-comp-ws-session')];

/** Open, close and reopen the workspace, so the first load is superseded by the second. */
function reopenWhileLoading(): { first: Deferred<WorkspaceContextSessionsData>; second: Deferred<WorkspaceContextSessionsData>; panel: HTMLElement } {
  const first = deferred<WorkspaceContextSessionsData>();
  const second = deferred<WorkspaceContextSessionsData>();
  mocks.rpc.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const { toggle, panel } = setup();
  toggle.click();
  toggle.click();
  toggle.click();
  return { first, second, panel };
}

beforeEach(() => {
  mocks.rpc.mockReset();
  mocks.destroyChartById.mockReset();
  mocks.createChart.mockReset();
});

describe('composition workspace drill-down', () => {
  it('asks for sessions by request overlap and lists only the row\u2019s source', async () => {
    mocks.rpc.mockResolvedValueOnce(response(session('cli'), session('vs', 'vscode')));
    const { toggle, panel } = setup();
    toggle.click();
    expect(mocks.rpc).toHaveBeenCalledWith('getWorkspaceContextSessions', { workspaceId: 'infra', filter: { fromDate: '2026-09-01' }, rangeMatch: 'requests' });
    await flush();
    expect(listed(panel).map(button => button.dataset.sessionId)).toEqual(['cli']);
  });

  it('shows an error when the current load fails', async () => {
    mocks.rpc.mockRejectedValueOnce(new Error('RPC timeout'));
    const { toggle, panel } = setup();
    toggle.click();
    await flush();
    expect(panel.textContent).toContain('Could not load sessions.');
  });
});

describe('composition workspace drill-down with stale responses', () => {
  it('ignores a failure from a load the user closed and reopened', async () => {
    const { first, second, panel } = reopenWhileLoading();
    second.resolve(response(session('s1')));
    await flush();
    expect(listed(panel)).toHaveLength(1);
    first.reject(new Error('RPC timeout'));
    await flush();
    expect(panel.textContent).not.toContain('Could not load sessions.');
    expect(listed(panel)).toHaveLength(1);
  });

  it('ignores a late response from a superseded load instead of resetting the open session', async () => {
    const { first, second, panel } = reopenWhileLoading();
    second.resolve(response(session('s1')));
    await flush();
    listed(panel)[0].click();
    expect(listed(panel)[0].getAttribute('aria-expanded')).toBe('true');
    first.resolve(response(session('s1'), session('s2')));
    await flush();
    expect(listed(panel)).toHaveLength(1);
    expect(listed(panel)[0].getAttribute('aria-expanded')).toBe('true');
  });

  it('ignores a response that arrives after the page re-rendered the section', async () => {
    const pending = deferred<WorkspaceContextSessionsData>();
    mocks.rpc.mockReturnValueOnce(pending.promise);
    const { toggle, panel } = setup();
    toggle.click();
    document.body.replaceChildren();
    mocks.destroyChartById.mockClear();
    pending.resolve(response(session('s1')));
    await flush();
    expect(listed(panel)).toHaveLength(0);
    // Rendering would also tear down the drill-down chart that the live page now owns.
    expect(mocks.destroyChartById).not.toHaveBeenCalled();
  });
});
