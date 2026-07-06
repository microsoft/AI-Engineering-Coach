/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

const sharedMocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  vscodeState: {},
}));

vi.mock('./shared', () => ({
  rpc: sharedMocks.rpc,
  rpcAllSettled: async <T extends readonly unknown[]>(
    calls: { [K in keyof T]: Promise<T[K]> },
    fallbacks: { [K in keyof T]: T[K] },
  ): Promise<T> => {
    const results = await Promise.allSettled(calls);
    return results.map((r, i) => r.status === 'fulfilled' ? r.value : fallbacks[i]) as unknown as T;
  },
  formatNum: (n: number) => String(Math.round(n)),
  COLORS: { blue: '#58a6ff', green: '#3fb950', red: '#f85149', yellow: '#d29922' },
  vscode: {
    getState: () => sharedMocks.vscodeState,
    setState: (state: Record<string, unknown>) => { sharedMocks.vscodeState = state; },
  },
  PROGRESS_ALMOST: 80,
  PROGRESS_STARTED: 10,
}));

vi.mock('./svg-icons', () => ({
  SVG: new Proxy({}, {
    get: (_target, prop) => `<svg data-icon="${String(prop)}"></svg>`,
  }),
}));

import { renderAchievements } from './page-achievements';

describe('renderAchievements', () => {
  beforeEach(() => {
    sharedMocks.rpc.mockReset();
    sharedMocks.vscodeState = {};
    document.body.innerHTML = '<main id="root"></main>';
  });

  it('renders a disabled model achievement when token reporting is disabled', async () => {
    sharedMocks.rpc.mockImplementation((method: string, params?: { pageSize?: number }) => {
      switch (method) {
        case 'getStats':
          return Promise.resolve({ totalSessions: 2, totalRequests: 25, totalWorkspaces: 1 });
        case 'getCodeProduction':
          return Promise.resolve({
            summary: { totalAiLoc: 120, totalUserLoc: 40 },
            byLanguage: { labels: ['TypeScript'] },
          });
        case 'getWorkLifeBalance':
          return Promise.resolve({ maxStreak: 3, weekendReqs: 1, timeDistribution: { lateNight: 2 } });
        case 'getAntiPatterns':
          return Promise.resolve({ totalOccurrences: 0 });
        case 'getHourlyDistribution':
          return Promise.resolve({ hours: [0, 5, 1] });
        case 'getSessions':
          return Promise.resolve({
            total: 2,
            sessions: params?.pageSize === 100
              ? [{ sessionId: 's1', requestCount: 12, firstMessage: 'Refactor a TypeScript service' }]
              : [],
          });
        case 'getDailyActivity':
          return Promise.resolve({ labels: ['2026-06-01'], loc: [120], values: [25], sessions: [2] });
        case 'getConsumption':
          return Promise.reject(new Error('Token reporting is temporarily disabled'));
        case 'getWorkflowOptimization':
          return Promise.resolve({ clusters: [{ id: 'tool-1' }] });
        default:
          return Promise.reject(new Error(`Unexpected RPC: ${method}`));
      }
    });

    const container = document.getElementById('root')!;
    await expect(renderAchievements(container, {})).resolves.toBeUndefined();

    expect(container.textContent).toContain('AI Engineer Roadmap');
    expect(container.textContent).toContain('Model Explorer');
    expect(container.textContent).toContain('Token reporting disabled');
  });
});
