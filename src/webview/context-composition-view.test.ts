/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * @vitest-environment jsdom
 */

import { describe, expect, it, vi } from 'vitest';
import type { CompositionBreakdown, ContextCompositionData, HarnessComposition, WorkspaceComposition } from '../core/types';
import { renderCompositionSection } from './context-composition-view';
import { render } from './render';

vi.mock('./shared', () => ({
  rpc: vi.fn(),
  createChart: vi.fn(),
  destroyChartById: vi.fn(),
  formatNum: (n: number) => String(n),
  harnessColor: () => '#888888',
  COLORS: new Proxy({}, { get: () => '#888888' }),
}));

function breakdown(weighting: 'tokens' | 'requests', samples: number, tools: number): CompositionBreakdown {
  const avgPromptTokens = weighting === 'tokens' ? 50_000 : null;
  const tokens = (pct: number) => (avgPromptTokens == null ? null : Math.round((pct / 100) * avgPromptTokens));
  return {
    slices: [{ category: 'toolDefinitions', pct: tools, tokens: tokens(tools) }, { category: 'messages', pct: 100 - tools, tokens: tokens(100 - tools) }],
    weighting,
    samples,
    avgPromptTokens,
  };
}

function harness(name: string, b: CompositionBreakdown, requestsWithData: number): HarnessComposition {
  return { harness: name, source: 'vscode', breakdown: b, totalRequests: requestsWithData, requestsWithData, sessions: 1, sessionsWithData: 1, toolHeavyPct: 0, avgToolDefinitionTokens: null, maxAvailableTools: null };
}

function workspace(name: string, harnessName: string, b: CompositionBreakdown): WorkspaceComposition {
  return { workspaceId: name, workspaceName: name, source: 'vscode', label: 'VS Code', harnesses: [harnessName], breakdown: b };
}

/** VS Code data where Local Agent recorded prompt sizes (for three of its four requests) and Insiders recorded none. */
function mixed(): ContextCompositionData {
  return {
    sources: [{ source: 'vscode', label: 'VS Code', harnesses: ['Local Agent', 'Local Agent (Insiders)'], breakdown: breakdown('tokens', 3, 40), requestsWithData: 6, toolHeavyPct: 0, avgToolDefinitionTokens: null, maxAvailableTools: null }],
    harnesses: [harness('Local Agent', breakdown('tokens', 3, 40), 4), harness('Local Agent (Insiders)', breakdown('requests', 2, 20), 2)],
    workspaces: [workspace('api', 'Local Agent', breakdown('tokens', 3, 40)), workspace('web', 'Local Agent (Insiders)', breakdown('requests', 2, 20))],
    trend: { labels: [], series: [] },
    systemSegments: [],
    systemSegmentSessions: 0,
    coverage: { requestsWithData: 6, totalRequests: 6, sessionsWithData: 2, totalSessions: 2 },
    toolHeavyThreshold: 50,
  };
}

function show(data: ContextCompositionData): HTMLElement {
  const host = document.createElement('div');
  document.body.replaceChildren(host);
  render(renderCompositionSection(data), host);
  return host;
}

const intro = (host: HTMLElement) => host.querySelector('.ctx-comp-intro')?.textContent ?? '';

describe('context composition weighting labels', () => {
  it('labels each bar by its own weighting when a source mixes sized and unsized requests', () => {
    const host = show(mixed());
    expect(intro(host)).toContain('Shares are weighted by prompt tokens, so larger prompts count more.');
    expect(intro(host)).toContain('Bars marked \u201cequal weight\u201d count each request equally because their requests didn\u2019t record a prompt size.');
    const insiders = host.querySelector('.ctx-comp-row[data-harness="Local Agent (Insiders)"]');
    expect(insiders?.querySelector('.ctx-comp-equal')?.textContent).toBe('equal weight');
    expect(insiders?.querySelector('.ctx-comp-bar')?.getAttribute('aria-label')).toMatch(/^Local Agent \(Insiders\) prompt composition, each request counts equally:/);
    expect(host.querySelector('.ctx-comp-row[data-harness="Local Agent"] .ctx-comp-equal')).toBeNull();
    expect(host.querySelector('.ctx-comp-ws[data-workspace="web"] .ctx-comp-equal')?.textContent).toBe('equal weight');
    expect(host.querySelector('.ctx-comp-ws[data-workspace="api"] .ctx-comp-equal')).toBeNull();
  });

  it('says which requests token-weighted figures leave out', () => {
    const host = show(mixed());
    const chip = host.querySelector('.ctx-comp-kpi');
    expect(chip?.getAttribute('data-tip')).toMatch(/weighted by prompt size\. .* 3 of 6 VS Code requests didn\u2019t record a prompt size and are left out\.$/);
    const tokens = host.querySelector('.ctx-comp-row[data-harness="Local Agent"] .ctx-comp-tokens-avg');
    expect(tokens?.textContent).toBe('\u224850000 tokens per request');
    expect(tokens?.getAttribute('data-tip')).toBe('Average prompt size. 1 request without a recorded prompt size is left out of this bar.');
  });

  it('describes a card where no request recorded a prompt size', () => {
    const data = mixed();
    const unsized = breakdown('requests', 6, 30);
    data.sources[0] = { ...data.sources[0], breakdown: unsized };
    data.harnesses = [harness('Local Agent', breakdown('requests', 4, 35), 4), harness('Local Agent (Insiders)', breakdown('requests', 2, 20), 2)];
    data.workspaces = [workspace('api', 'Local Agent', breakdown('requests', 4, 35))];
    const host = show(data);
    expect(intro(host)).toBe('What fills your prompts, by category. Each request counts equally because prompt sizes were not recorded.');
    expect(host.querySelectorAll('.ctx-comp-row .ctx-comp-equal')).toHaveLength(2);
    expect(host.querySelector('.ctx-comp-kpi')?.getAttribute('data-tip')).toBe('Share of VS Code prompts spent on tool definitions. Each request counts equally because prompt sizes were not recorded.');
  });

  it('adds no equal-weight labels when every bar is token-weighted', () => {
    const data = mixed();
    data.sources[0] = { ...data.sources[0], requestsWithData: 3 };
    data.harnesses = [harness('Local Agent', breakdown('tokens', 3, 40), 3)];
    data.workspaces = [workspace('api', 'Local Agent', breakdown('tokens', 3, 40))];
    const host = show(data);
    expect(intro(host)).toBe('What fills your prompts, by category. Shares are weighted by prompt tokens, so larger prompts count more.');
    expect(host.querySelectorAll('.ctx-comp-equal')).toHaveLength(0);
    expect(host.querySelector('.ctx-comp-kpi')?.getAttribute('data-tip')).not.toContain('left out');
    expect(host.querySelector('.ctx-comp-tokens-avg')?.getAttribute('data-tip')).toBe('Average prompt size');
  });
});
