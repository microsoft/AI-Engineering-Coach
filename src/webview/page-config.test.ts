/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * @vitest-environment jsdom
 */

/* Context Health page tests backed by the real analyzer. The page's RPC calls go through the extension's
 * handlers, as JSON, over Copilot CLI sessions that the real parser reads from events.jsonl fixtures. */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Analyzer } from '../core/analyzer';
import type { ParseResult } from '../core/cache';
import { parseCLIEventsFile } from '../core/parser-vscode-cli';
import type { ConfigHealthData, Session } from '../core/types';
import { getRpcHandler } from './panel-rpc';

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('./shared', () => ({
  rpc: mocks.rpc,
  createChart: vi.fn(),
  destroyChartById: vi.fn(),
  destroyCharts: vi.fn(),
  trackChart: vi.fn(),
  Chart: class {},
  formatNum: (n: number) => String(n),
  harnessColor: () => '#888888',
  COLORS: new Proxy({}, { get: () => '#888888' }),
  PALETTE: ['#888888'],
}));

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-28T12:00:00Z');
const tempDirs: string[] = [];

/** The Context Quality tab opens first; its workspace scan reads the file system, so it gets an empty result. */
const EMPTY_CONFIG_HEALTH: ConfigHealthData = {
  workspaces: [], overallScore: 0, agenticReadiness: { score: 0, signals: [] }, contextProvisionByHarness: {}, suggestions: [], contextAntiPatterns: [],
};

function iso(ts: number): string {
  return new Date(ts).toISOString();
}

/** A one-turn Copilot CLI session from `daysAgo` days before NOW. Builds that record per-call usage
 *  get composition; the parser leaves `promptTokens` null either way. */
function cliSession(daysAgo: number, recordsUsage = true): Session {
  const start = NOW - daysAgo * DAY;
  const events = [
    { type: 'session.start', timestamp: iso(start), data: { sessionId: `cli-${daysAgo}`, startTime: iso(start), selectedModel: 'claude-opus-5.5', copilotVersion: '1.0.102' } },
    { type: 'user.message', id: 'u1', timestamp: iso(start + 60_000), data: { content: 'Refactor the parser' } },
    ...(recordsUsage ? [{
      type: 'session.usage_record',
      data: { usage: { model: 'claude-opus-5.5', inputTokens: 120_000, outputTokens: 500, toolTokenCount: 30_000, availableToolCount: 64, initiator: 'agent', interactionType: 'conversation-agent' } },
    }] : []),
    { type: 'assistant.message', id: 'a1', timestamp: iso(start + 120_000), data: { content: 'Done', outputTokens: 10 } },
  ];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-engineer-coach-page-config-'));
  tempDirs.push(dir);
  const file = path.join(dir, 'events.jsonl');
  fs.writeFileSync(file, events.map(event => JSON.stringify(event)).join('\n') + '\n', 'utf-8');
  const session = parseCLIEventsFile(file, 'cli-ws', 'cli-project');
  if (!session) throw new Error('The Copilot CLI fixture did not parse');
  return session;
}

/** Answers the page's RPC calls like the extension host: JSON in and out of the real handlers. */
function serve(sessions: Session[]): void {
  const analyzer = new Analyzer(sessions, new Map());
  const parsed: ParseResult = { sessions, workspaces: new Map(), editLocIndex: new Map(), sessionSourceIndex: new Map() };
  mocks.rpc.mockReset().mockImplementation(async (method: string, params?: Record<string, unknown>) => {
    if (method === 'getConfigHealth') return EMPTY_CONFIG_HEALTH;
    const handler = getRpcHandler(method);
    if (!handler) throw new Error(`No RPC handler for ${method}`);
    const result: unknown = await handler(analyzer, parsed, JSON.parse(JSON.stringify(params ?? {})) as Record<string, unknown>);
    return JSON.parse(JSON.stringify(result ?? null)) as unknown;
  });
}

/** Opens Context Health and switches to the Context Management tab, like a user would. */
async function openContextManagement(): Promise<HTMLElement> {
  const { renderConfigHealth } = await import('./page-config');
  const host = document.createElement('div');
  document.body.replaceChildren(host);
  await renderConfigHealth(host, {});
  host.querySelector<HTMLButtonElement>('#ctxSubTabMgmt')?.click();
  await vi.waitFor(() => {
    expect(mocks.rpc.mock.calls.some(([method]) => method === 'getContextManagement')).toBe(true);
    const content = host.querySelector('#ctxSubTabContent');
    expect(content?.childElementCount).toBeGreaterThan(0);
    expect(content?.querySelector('.loading-spinner')).toBeNull();
  });
  return host;
}

function rangeButtons(host: HTMLElement): HTMLButtonElement[] {
  return [...host.querySelectorAll<HTMLButtonElement>('#ctxRangeBar .cons-range-btn')];
}

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

beforeEach(() => {
  // Page modules keep the selected tab and range, so each test starts from a fresh page.
  vi.resetModules();
});

afterAll(() => {
  vi.useRealTimers();
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('Context Management range bar with Copilot CLI composition', () => {
  it('opens the range that holds composition recorded without promptTokens', async () => {
    const session = cliSession(60);
    // Real Copilot CLI data: promptTokens stays null and the prompt size is recorded with the composition.
    expect(session.harness).toBe('GitHub Copilot CLI');
    expect(session.requests.map(request => request.promptTokens)).toEqual([null]);
    expect(session.requests[0].promptComposition).toMatchObject({ source: 'copilot-cli', promptTokens: 120_000 });
    serve([session]);

    const host = await openContextManagement();

    // The default month holds nothing, so the page opens "Last 3 months", the only range with data.
    const buttons = rangeButtons(host);
    expect(buttons.map(button => button.textContent)).toEqual(['Last 3 months']);
    expect(buttons[0].classList.contains('active')).toBe(true);
    expect(host.querySelector('.ctx-comp-row[data-harness="GitHub Copilot CLI"] .ctx-comp-bar')).not.toBeNull();
    expect(host.querySelector('.ctx-comp-ws[data-workspace="cli-project"] .ctx-comp-ws-toggle')).not.toBeNull();
    expect(host.textContent).not.toContain('No Session Data');
  });

  it('says the range bar needs per-request tokens or composition when the sessions recorded neither', async () => {
    // An older Copilot CLI build records no per-call usage, so its turns have neither.
    const session = cliSession(5, false);
    expect(session.requests.map(request => [request.promptTokens, request.promptComposition])).toEqual([[null, undefined]]);
    serve([session]);

    const host = await openContextManagement();

    expect(rangeButtons(host)).toEqual([]);
    expect(host.querySelector('#ctxRangeBar')?.textContent?.trim()).toBe(
      'These GitHub Copilot CLI sessions log neither per-turn tokens nor prompt composition (older Copilot CLI and Copilot App builds; newer builds log every model call). Context Management needs one of them to chart utilization and composition. Try a different harness or a more recent range, or view consumption in the Output tab.',
    );
  });
});
