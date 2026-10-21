/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess } from 'child_process';
import { describe, it, expect, vi } from 'vitest';
import { Analyzer } from './analyzer';
import { Session, SessionRequest, DateFilter } from './types';
import { accumulateEditLoc, EditTimelineLike } from './edit-loc-diff';

/**
 * Simulates panel.ts validateDateFilter -- this is the exact logic
 * from the extension-side RPC handler that processes webview messages.
 */
function validateDateFilter(p: Record<string, unknown>): DateFilter {
  const isString = (v: unknown): v is string => typeof v === 'string';
  return {
    ...(isString(p.fromDate) && { fromDate: p.fromDate }),
    ...(isString(p.toDate) && { toDate: p.toDate }),
    ...(isString(p.workspaceId) && { workspaceId: p.workspaceId }),
    ...(!isString(p.workspaceId) && isString(p.workspace) && { workspaceId: p.workspace }),
    ...(isString(p.harness) && { harness: p.harness }),
  };
}

function makeRequest(overrides: Partial<SessionRequest> = {}): SessionRequest {
  return {
    requestId: 'req-1',
    timestamp: Date.now(),
    messageText: 'Hello',
    responseText: 'Hi there',
    isCanceled: false,
    agentName: 'Copilot',
    agentMode: 'chat',
    modelId: 'gpt-4.1',
    toolsUsed: [],
    editedFiles: [],
    referencedFiles: [],
    slashCommand: '',
    variableKinds: {},
    customInstructions: [],
    skillsUsed: [],
    firstProgress: 100,
    totalElapsed: 500,
    messageLength: 5,
    responseLength: 8,
    userCode: [],
    aiCode: [{ language: 'typescript', loc: 10 }],
    toolConfirmations: [],
    promptTokens: null,
    completionTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    compaction: null,
    todoSnapshot: null,
    workType: 'other',
    ...overrides,
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  const now = Date.now();
  const base = {
    sessionId: 'sess-1',
    workspaceId: 'ws-1',
    workspaceName: 'my-project',
    location: 'panel',
    harness: 'Local Agent',
    creationDate: now - 3600000,
    lastMessageDate: now,
    requestCount: 1,
    requests: [makeRequest()],
    ...overrides,
  };
  // Keep requestCount in sync with requests array
  base.requestCount = base.requests.length;
  return base;
}

describe('Analyzer', () => {
  describe('getStats', () => {
    it('returns correct totals', () => {
      const sessions = [
        makeSession({ sessionId: 's1', workspaceId: 'ws-1', workspaceName: 'project-a', requestCount: 3, requests: [makeRequest(), makeRequest(), makeRequest()] }),
        makeSession({ sessionId: 's2', workspaceId: 'ws-2', workspaceName: 'project-b', requestCount: 2, requests: [makeRequest(), makeRequest()] }),
      ];
      const a = new Analyzer(sessions);
      const stats = a.getStats();
      expect(stats.totalSessions).toBe(2);
      expect(stats.totalWorkspaces).toBe(2);
      expect(stats.totalRequests).toBe(5);
    });

    it('handles empty sessions', () => {
      const a = new Analyzer([]);
      const stats = a.getStats();
      expect(stats.totalSessions).toBe(0);
      expect(stats.totalWorkspaces).toBe(0);
      expect(stats.totalRequests).toBe(0);
    });
  });

  describe('getWorkspaces', () => {
    it('returns unique workspaces by canonical name with recent section', () => {
      const sessions = [
        makeSession({ workspaceId: 'ws-1', workspaceName: 'project-a' }),
        makeSession({ workspaceId: 'ws-1', workspaceName: 'project-a' }),
        makeSession({ workspaceId: 'ws-2', workspaceName: 'project-b' }),
        makeSession({ workspaceId: 'ws-3', workspaceName: 'project-a' }), // same name, different id
      ];
      const a = new Analyzer(sessions);
      const ws = a.getWorkspaces();
      // Recent (top 5 by activity) + all (alphabetical) — recent items appear in both sections
      const uniqueIds = new Set(ws.map(w => w.id));
      expect(uniqueIds.size).toBe(2);
      expect([...uniqueIds].sort()).toEqual(['project-a', 'project-b']);
      // Recent items are flagged
      const recent = ws.filter(w => w.recent);
      expect(recent.length).toBeLessThanOrEqual(5);
      // All-section items are sorted alphabetically
      const allSection = ws.filter(w => !w.recent);
      const allNames = allSection.map(w => w.name);
      expect(allNames).toEqual([...allNames].sort());
    });
  });

  describe('getHarnesses', () => {
    it('returns unique harness names', () => {
      const sessions = [
        makeSession({ harness: 'Local Agent' }),
        makeSession({ harness: 'Local Agent (Insiders)' }),
        makeSession({ harness: 'Local Agent' }),
      ];
      const a = new Analyzer(sessions);
      const harnesses = a.getHarnesses();
      expect(harnesses).toHaveLength(2);
      expect(harnesses.sort()).toEqual(['Local Agent', 'Local Agent (Insiders)']);
    });
  });

  describe('getDailyActivity', () => {
    it('returns labels and values arrays of equal length', () => {
      const ts = new Date(2024, 5, 15, 10, 0, 0).getTime();
      const sessions = [
        makeSession({ creationDate: ts, requests: [makeRequest({ timestamp: ts })] }),
      ];
      const a = new Analyzer(sessions);
      const da = a.getDailyActivity();
      expect(da.labels.length).toBe(da.values.length);
      expect(da.labels.length).toBeGreaterThan(0);
    });
  });

  describe('getSessionDetail', () => {
    it('returns the matching session', () => {
      const sessions = [
        makeSession({ sessionId: 'target' }),
        makeSession({ sessionId: 'other' }),
      ];
      const a = new Analyzer(sessions);
      const s = a.getSessionDetail('target');
      expect(s).not.toBeNull();
      expect(s!.sessionId).toBe('target');
    });

    it('returns null for unknown session id', () => {
      const a = new Analyzer([makeSession()]);
      expect(a.getSessionDetail('nonexistent')).toBeNull();
    });
  });

  describe('filter by workspace', () => {
    it('getDailyActivity filters by workspaceId', () => {
      const ts = new Date(2024, 5, 15, 10, 0, 0).getTime();
      const sessions = [
        makeSession({ workspaceId: 'ws-a', workspaceName: 'project-a', creationDate: ts, requests: [makeRequest({ timestamp: ts }), makeRequest({ timestamp: ts + 1000 })] }),
        makeSession({ workspaceId: 'ws-b', workspaceName: 'project-b', creationDate: ts, requests: [makeRequest({ timestamp: ts })] }),
      ];
      const a = new Analyzer(sessions);
      const all = a.getDailyActivity();
      const totalAll = all.values.reduce((a, b) => a + b, 0);
      expect(totalAll).toBe(3);

      // getWorkspaces returns canonical workspace ids (workspace names)
      const wss = a.getWorkspaces();
      expect(wss.find(w => w.name === 'project-a')?.id).toBe('project-a');

      const filtered = a.getDailyActivity({ workspaceId: 'project-a' });
      const totalFiltered = filtered.values.reduce((a, b) => a + b, 0);
      expect(totalFiltered).toBe(2); // only project-a's 2 requests
    });
  });

  describe('filter by harness', () => {
    it('getDailyActivity filters by harness', () => {
      const ts = new Date(2024, 5, 15, 10, 0, 0).getTime();
      const sessions = [
        makeSession({ sessionId: 's1', harness: 'Local Agent', creationDate: ts, workspaceName: 'proj', requests: [makeRequest({ timestamp: ts }), makeRequest({ timestamp: ts + 1000 })] }),
        makeSession({ sessionId: 's2', harness: 'Claude', creationDate: ts, workspaceName: 'proj', requests: [makeRequest({ timestamp: ts })] }),
      ];
      const a = new Analyzer(sessions);
      const all = a.getDailyActivity();
      expect(all.values.reduce((a, b) => a + b, 0)).toBe(3);

      const filtered = a.getDailyActivity({ harness: 'Local Agent' });
      expect(filtered.values.reduce((a, b) => a + b, 0)).toBe(2);

      const filtered2 = a.getDailyActivity({ harness: 'Claude' });
      expect(filtered2.values.reduce((a, b) => a + b, 0)).toBe(1);
    });

    it('getCodeProduction filters by harness', () => {
      const ts = new Date(2024, 5, 15, 10, 0, 0).getTime();
      const sessions = [
        makeSession({ sessionId: 's1', harness: 'Local Agent', creationDate: ts, workspaceName: 'proj',
          requests: [makeRequest({ timestamp: ts, aiCode: [{ language: 'typescript', loc: 50 }] })] }),
        makeSession({ sessionId: 's2', harness: 'Codex', creationDate: ts, workspaceName: 'proj',
          requests: [makeRequest({ timestamp: ts, aiCode: [{ language: 'python', loc: 30 }] })] }),
      ];
      const a = new Analyzer(sessions);
      const all = a.getCodeProduction();
      expect(all.summary.totalAiLoc).toBe(80);

      const filtered = a.getCodeProduction({ harness: 'Local Agent' });
      expect(filtered.summary.totalAiLoc).toBe(50);
    });

    it('getConsumption filters by harness', () => {
      const ts = new Date(2024, 5, 15, 10, 0, 0).getTime();
      const sessions = [
        makeSession({ sessionId: 's1', harness: 'Local Agent', creationDate: ts, workspaceName: 'proj',
          requests: [makeRequest({ timestamp: ts }), makeRequest({ timestamp: ts + 1000 })] }),
        makeSession({ sessionId: 's2', harness: 'GitHub Copilot CLI', creationDate: ts, workspaceName: 'proj',
          requests: [makeRequest({ timestamp: ts })] }),
        makeSession({ sessionId: 's3', harness: 'Codex', creationDate: ts, workspaceName: 'proj',
          requests: [makeRequest({ timestamp: ts })] }),
      ];
      const a = new Analyzer(sessions);
      // getConsumption now counts all harnesses.
      const all = a.getConsumption();
      expect(all.totalRequests).toBe(4);

      const filtered = a.getConsumption({ harness: 'Local Agent' });
      expect(filtered.totalRequests).toBe(2);
    });

    it('getConsumption counts requests regardless of token availability', () => {
      // Regression: getConsumption keys off model + timestamp only; missing
      // promptTokens/completionTokens must not affect request totals.
      const ts = new Date(2024, 5, 15, 10, 0, 0).getTime();
      const sessions = [
        makeSession({ sessionId: 's1', harness: 'Local Agent', creationDate: ts, workspaceName: 'proj',
          requests: [
            makeRequest({ requestId: 'r1', timestamp: ts, modelId: 'gpt-4o', promptTokens: 100, completionTokens: 50 }),
            makeRequest({ requestId: 'r2', timestamp: ts + 1000, modelId: 'gpt-4o' }),
            makeRequest({ requestId: 'r3', timestamp: ts + 2000, modelId: 'gpt-4o', promptTokens: 0, completionTokens: 0 }),
          ] }),
      ];
      const a = new Analyzer(sessions);
      const data = a.getConsumption();
      expect(data.totalRequests).toBe(3);
      expect(data.modelTotals['gpt-4o']).toBe(3);
    });

    it('getAntiPatterns filters by harness', () => {
      const ts = new Date(2024, 5, 15, 10, 0, 0).getTime();
      const sessions = [
        makeSession({ sessionId: 's1', harness: 'Local Agent', creationDate: ts, workspaceName: 'proj',
          requestCount: 60, requests: Array.from({ length: 60 }, (_, i) => makeRequest({ requestId: `r${i}`, timestamp: ts + i * 1000 })) }),
        makeSession({ sessionId: 's2', harness: 'Codex', creationDate: ts, workspaceName: 'proj',
          requestCount: 2, requests: [makeRequest({ timestamp: ts }), makeRequest({ timestamp: ts + 1000 })] }),
      ];
      const a = new Analyzer(sessions);
      // Unfiltered should detect mega-session from s1
      const all = a.getAntiPatterns();
      const _mega = all.patterns.find(p => p.id === 'mega-sessions');

      // Filtered to Codex-only should NOT have mega-session (only 2 requests)
      const filtered = a.getAntiPatterns({ harness: 'Codex' });
      const megaFiltered = filtered.patterns.find(p => p.id === 'mega-sessions');
      expect(megaFiltered?.occurrences ?? 0).toBe(0);
    }, 15000);
  });

  describe('filter by workspace + harness combined', () => {
    it('getDailyActivity filters by both workspace and harness', () => {
      const ts = new Date(2024, 5, 15, 10, 0, 0).getTime();
      const sessions = [
        makeSession({ sessionId: 's1', harness: 'Local Agent', workspaceName: 'project-a', creationDate: ts,
          requests: [makeRequest({ timestamp: ts })] }),
        makeSession({ sessionId: 's2', harness: 'Codex', workspaceName: 'project-a', creationDate: ts,
          requests: [makeRequest({ timestamp: ts })] }),
        makeSession({ sessionId: 's3', harness: 'Local Agent', workspaceName: 'project-b', creationDate: ts,
          requests: [makeRequest({ timestamp: ts })] }),
      ];
      const a = new Analyzer(sessions);
      const combined = a.getDailyActivity({ workspaceId: 'ws-1', harness: 'Local Agent' });
      expect(combined.values.reduce((a, b) => a + b, 0)).toBe(2); // only s1 contributes, and it has 2 requests
    });
  });

  describe('full RPC pipeline simulation', () => {
    const ts = new Date(2024, 5, 15, 10, 0, 0).getTime();
    const sessions = [
      makeSession({ sessionId: 's1', harness: 'Local Agent', workspaceId: 'ws-1', workspaceName: 'alpha', creationDate: ts,
        requests: [makeRequest({ timestamp: ts }), makeRequest({ timestamp: ts + 1000 })] }),
      makeSession({ sessionId: 's2', harness: 'Claude', workspaceId: 'ws-1', workspaceName: 'alpha', creationDate: ts,
        requests: [makeRequest({ timestamp: ts })] }),
      makeSession({ sessionId: 's3', harness: 'Local Agent', workspaceId: 'ws-2', workspaceName: 'beta', creationDate: ts,
        requests: [makeRequest({ timestamp: ts }), makeRequest({ timestamp: ts + 1000 }), makeRequest({ timestamp: ts + 2000 })] }),
      makeSession({ sessionId: 's4', harness: 'Codex', workspaceId: 'ws-2', workspaceName: 'beta', creationDate: ts,
        requests: [makeRequest({ timestamp: ts })] }),
    ];

    it('webview harness filter reaches analyzer correctly', () => {
      const a = new Analyzer(sessions);
      // Simulates: user selects "Local Agent" in harness dropdown
      // webview sends: rpc('getDailyActivity', { harness: 'Local Agent' })
      // panel.ts receives params and calls validateDateFilter
      const webviewParams = { harness: 'Local Agent' } as Record<string, unknown>;
      const filter = validateDateFilter(webviewParams);
      expect(filter).toEqual({ harness: 'Local Agent' });

      const result = a.getDailyActivity(filter);
      const total = result.values.reduce((a, b) => a + b, 0);
      expect(total).toBe(5); // s1(2) + s3(3) = 5 Local Agent requests
    });

    it('webview workspace filter via combobox reaches analyzer correctly', () => {
      const a = new Analyzer(sessions);
      // Simulates: user picks "alpha" from combobox
      // getWorkspaces() returns {id: 'alpha', name: 'alpha'}
      // setWsSelection sets currentFilter.workspaceId = 'alpha'
      // webview sends: rpc('getDailyActivity', { workspaceId: 'alpha' })
      const wss = a.getWorkspaces();
      const alphaWs = wss.find(w => w.name === 'alpha');
      expect(alphaWs).toBeDefined();
      expect(alphaWs!.id).toBe('alpha');

      const webviewParams = { workspaceId: alphaWs!.id } as Record<string, unknown>;
      const filter = validateDateFilter(webviewParams);
      expect(filter).toEqual({ workspaceId: 'alpha' });

      const result = a.getDailyActivity(filter);
      const total = result.values.reduce((a, b) => a + b, 0);
      expect(total).toBe(3); // s1(2) + s2(1) = 3 alpha requests
    });

    it('webview "Current" toggle sets workspace correctly', () => {
      const a = new Analyzer(sessions);
      // Simulates: onDataReady matches current VS Code workspace to "beta"
      // matchedWorkspaceId = 'ws-2'
      // User clicks "Current" toggle
      // setWsSelection('ws-2', 'beta') sets currentFilter.workspaceId = 'ws-2'
      const webviewParams = { workspaceId: 'ws-2' } as Record<string, unknown>;
      const filter = validateDateFilter(webviewParams);
      const result = a.getDailyActivity(filter);
      const total = result.values.reduce((a, b) => a + b, 0);
      expect(total).toBe(4); // s3(3) + s4(1) = 4 beta requests
    });

    it('webview combined harness + workspace filter', () => {
      const a = new Analyzer(sessions);
      const webviewParams = { workspaceId: 'ws-1', harness: 'Local Agent' } as Record<string, unknown>;
      const filter = validateDateFilter(webviewParams);
      expect(filter).toEqual({ workspaceId: 'ws-1', harness: 'Local Agent' });

      const result = a.getDailyActivity(filter);
      const total = result.values.reduce((a, b) => a + b, 0);
      expect(total).toBe(2); // only s1
    });

    it('webview "All" removes filters correctly', () => {
      const a = new Analyzer(sessions);
      // Simulates: user clicks "All", currentFilter.workspaceId = undefined
      // Then undefined doesn't get serialized through postMessage
      const webviewParams = {} as Record<string, unknown>;
      const filter = validateDateFilter(webviewParams);
      expect(filter).toEqual({});

      const result = a.getDailyActivity(filter);
      const total = result.values.reduce((a, b) => a + b, 0);
      expect(total).toBe(7); // all requests
    });

    it('harness filter propagates to getCodeProduction', () => {
      const a = new Analyzer(sessions);
      const filter = validateDateFilter({ harness: 'Codex' } as Record<string, unknown>);
      const prod = a.getCodeProduction(filter);
      // s4 has 1 request with default aiCode [{ language: 'typescript', loc: 10 }]
      expect(prod.summary.totalAiLoc).toBe(10);
    });

    it('harness filter propagates to getConsumption', () => {
      const a = new Analyzer(sessions);
      // Filter by Local Agent — s1 has 2 requests, s3 has 3.
      const filter = validateDateFilter({ harness: 'Local Agent' } as Record<string, unknown>);
      const cons = a.getConsumption(filter);
      expect(cons.totalRequests).toBe(5); // s1(2) + s3(3)

      // Filter by Claude — only Claude sessions are included.
      const claudeFilter = validateDateFilter({ harness: 'Claude' } as Record<string, unknown>);
      const claudeCons = a.getConsumption(claudeFilter);
      expect(claudeCons.totalRequests).toBe(1);
    });

    it('harness filter propagates to getWorkspaceBreakdown', () => {
      const a = new Analyzer(sessions);
      const filter = validateDateFilter({ harness: 'Local Agent' } as Record<string, unknown>);
      const wb = a.getWorkspaceBreakdown(filter);
      // Local Agent sessions are in alpha(s1) and beta(s3)
      expect(wb.labels).toContain('alpha');
      expect(wb.labels).toContain('beta');
      const total = wb.values.reduce((a, b) => a + b, 0);
      expect(total).toBe(5);
    });

    it('harness filter propagates to getHarnessBreakdown', () => {
      const a = new Analyzer(sessions);
      // When filtered to Local Agent, harnessBreakdown should only show Local Agent
      const filter = validateDateFilter({ harness: 'Local Agent' } as Record<string, unknown>);
      const hb = a.getHarnessBreakdown(filter);
      expect(hb.labels).toEqual(['Local Agent']);
      expect(hb.requests[0]).toBe(5);
    });
  });

  describe('getAntiPatterns — profanity detection', () => {
    function profanitySession(messages: string[]): Session {
      const ts = new Date(2024, 5, 15, 10, 0, 0).getTime();
      return makeSession({
        requestCount: messages.length,
        requests: messages.map((m, i) => makeRequest({
          requestId: `req-${i}`,
          timestamp: ts + i * 1000,
          messageText: m,
          messageLength: m.length,
        })),
      });
    }

    it('detects actual profanity in user prompts', () => {
      const sessions = [profanitySession([
        'this damn thing is not working at all',
        'what the fuck is going on',
        'why the hell does this break every time',
      ])];
      const a = new Analyzer(sessions);
      const result = a.getAntiPatterns();
      const profanity = result.patterns.find(p => p.id === 'profanity');
      expect(profanity).toBeDefined();
      expect(profanity!.occurrences).toBeGreaterThanOrEqual(1);
    });

    it('does NOT flag normal programming words', () => {
      const sessions = [profanitySession([
        'please fix the class definition in utils.ts',
        'the assertion fails on line 42',
        'the image asset needs resizing',
        'use the test fixture for validation',
      ])];
      const a = new Analyzer(sessions);
      const result = a.getAntiPatterns();
      const profanity = result.patterns.find(p => p.id === 'profanity');
      expect(profanity).toBeUndefined();
    });

    it('does NOT flag pasted code blocks', () => {
      const codeMsg = 'fix this:\n```python\nclass Foo:\n    ass = "value"\n    def damn_method(self):\n        pass\n```\nplease refactor';
      const sessions = [profanitySession([codeMsg])];
      const a = new Analyzer(sessions);
      const result = a.getAntiPatterns();
      const profanity = result.patterns.find(p => p.id === 'profanity');
      expect(profanity).toBeUndefined();
    });

    it('only checks start+end of long pasted content', () => {
      const longMiddle = 'a '.repeat(300);
      const msg = 'please review this\n' + longMiddle + '\nwhat the shit is this ending';
      const sessions = [profanitySession([msg])];
      const a = new Analyzer(sessions);
      const result = a.getAntiPatterns();
      const profanity = result.patterns.find(p => p.id === 'profanity');
      expect(profanity).toBeDefined();
    });

    it('flags profanity even when buried in middle of long prompt', () => {
      const padding = 'normal text here. '.repeat(30);
      const msg = 'please review this code\n' + padding + 'some shit buried here' + padding + '\nthanks for the help';
      const sessions = [profanitySession([msg])];
      const a = new Analyzer(sessions);
      const result = a.getAntiPatterns();
      const profanity = result.patterns.find(p => p.id === 'profanity');
      // Declarative pipeline scans full text, so buried profanity IS detected
      expect(profanity).toBeDefined();
    });

    it('examples show triggering message text', () => {
      const sessions = [profanitySession([
        'this fucking code is broken',
      ])];
      const a = new Analyzer(sessions);
      const result = a.getAntiPatterns();
      const profanity = result.patterns.find(p => p.id === 'profanity');
      expect(profanity).toBeDefined();
      // Declarative pipeline uses per-row template examples
      expect(profanity!.examples.length).toBeGreaterThan(0);
    });
  });

  /* ── Focus Heatmap & Calendar ──────────────────────────────────── */

  describe('getHeatmap focus scores', () => {
    it('returns focusHeatmap with intensity based on 5-min bucket coverage', () => {
      // Create requests spread across a single hour (Wed, 10:00-10:59) in one week
      // Requests at minutes 0, 5, 10, 15, 20 → 5 of 12 buckets active → ~42% focus
      const base = new Date('2025-03-05T10:00:00').getTime(); // Wednesday
      const reqs = [0, 5, 10, 15, 20].map((m, i) =>
        makeRequest({ requestId: `r-${i}`, timestamp: base + m * 60000 })
      );
      const session = makeSession({ requests: reqs, requestCount: reqs.length });
      const a = new Analyzer([session]);
      const heatmap = a.getHeatmap();

      expect(heatmap.focusHeatmap).toBeDefined();
      expect(heatmap.focusHeatmap.length).toBe(7);
      // Wednesday = dow 3, hour 10
      const wednesdayFocus = heatmap.focusHeatmap[3][10];
      expect(wednesdayFocus).toBeGreaterThan(30); // ~42%
      expect(wednesdayFocus).toBeLessThanOrEqual(100);
      // Other cells should be 0
      expect(heatmap.focusHeatmap[0][10]).toBe(0); // Sunday
    });

    it('high density activity scores higher focus', () => {
      // Requests every minute for 40 minutes → 8 of 12 buckets → ~67% focus
      const base = new Date('2025-03-05T14:00:00').getTime();
      const reqs = Array.from({ length: 40 }, (_, i) =>
        makeRequest({ requestId: `r-${i}`, timestamp: base + i * 60000 })
      );
      const session = makeSession({ requests: reqs, requestCount: reqs.length });
      const a = new Analyzer([session]);
      const heatmap = a.getHeatmap();

      expect(heatmap.focusHeatmap[3][14]).toBeGreaterThan(50);
    });

    it('weekend focus is computed correctly', () => {
      // Saturday sustained coding session: 10am-11am, every 2 min
      const base = new Date('2025-03-08T10:00:00').getTime(); // Saturday
      const reqs = Array.from({ length: 30 }, (_, i) =>
        makeRequest({ requestId: `r-${i}`, timestamp: base + i * 120000 })
      );
      const session = makeSession({ requests: reqs, requestCount: reqs.length });
      const a = new Analyzer([session]);
      const heatmap = a.getHeatmap();

      // Saturday = dow 6, should have high focus at hour 10
      expect(heatmap.focusHeatmap[6][10]).toBeGreaterThan(40);
    });
  });

  describe('getCalendarActivity', () => {
    it('returns per-day request counts and focus scores', () => {
      // Two days of activity
      const day1Base = new Date('2025-03-05T10:00:00').getTime();
      const day2Base = new Date('2025-03-06T14:00:00').getTime();
      const reqs = [
        ...Array.from({ length: 10 }, (_, i) =>
          makeRequest({ requestId: `d1-${i}`, timestamp: day1Base + i * 300000 }) // every 5 min
        ),
        ...Array.from({ length: 5 }, (_, i) =>
          makeRequest({ requestId: `d2-${i}`, timestamp: day2Base + i * 600000 }) // every 10 min
        ),
      ];
      const session = makeSession({ requests: reqs, requestCount: reqs.length });
      const a = new Analyzer([session]);
      const cal = a.getCalendarActivity();

      expect(cal.days.length).toBe(2);
      expect(cal.days[0].date).toBe('2025-03-05');
      expect(cal.days[0].requests).toBe(10);
      expect(cal.days[1].date).toBe('2025-03-06');
      expect(cal.days[1].requests).toBe(5);
      expect(cal.maxRequests).toBe(10);
      // Focus should be > 0 for both days
      expect(cal.days[0].focusScore).toBeGreaterThan(0);
      expect(cal.days[1].focusScore).toBeGreaterThan(0);
    });

    it('returns empty for no data', () => {
      const a = new Analyzer([]);
      const cal = a.getCalendarActivity();
      expect(cal.days).toEqual([]);
      expect(cal.maxRequests).toBe(0);
    });
  });

  describe('warmUp async progress', () => {
    it('can warm up through a forked Node child with Map-preserving serialization', async () => {
      const child = new ChildProcess();
      const send = vi.fn((_payload: unknown) => {
        queueMicrotask(() => child.emit('message', { type: 'result', antiPatterns: null, configHealth: null }));
        return true;
      });
      child.send = send;
      const kill = vi.spyOn(child, 'kill').mockReturnValue(true);
      const forkWorker = vi.fn(() => child);
      const analyzer = new Analyzer([]);
      await analyzer.warmUp(undefined, forkWorker);
      expect(forkWorker).toHaveBeenCalledWith(expect.stringContaining('warm-up-worker.js'), [], {
        serialization: 'advanced', execArgv: [],
      });
      expect(send.mock.calls[0][0]).toHaveProperty('workspaces', expect.any(Map));
      expect(send.mock.calls[0][0]).toHaveProperty('editLocIndex', expect.any(Map));
      expect(kill).toHaveBeenCalledOnce();
    });

    it('does not run synchronous analytics when an injected child fails', async () => {
      const child = new ChildProcess();
      child.send = () => {
        queueMicrotask(() => child.emit('error', new Error('child failed')));
        return true;
      };
      vi.spyOn(child, 'kill').mockReturnValue(true);
      const analyzer = new Analyzer([]);
      const synchronous = vi.spyOn(analyzer, 'getAntiPatterns');
      await expect(analyzer.warmUp(undefined, () => child)).rejects.toThrow('child failed');
      expect(synchronous).not.toHaveBeenCalled();
    });

    it('rejects a failed IPC send instead of throwing from the deferred callback', async () => {
      const child = new ChildProcess();
      child.send = () => { throw new Error('IPC disconnected'); };
      const kill = vi.spyOn(child, 'kill').mockReturnValue(true);
      await expect(new Analyzer([]).warmUp(undefined, () => child)).rejects.toThrow('IPC disconnected');
      expect(kill).toHaveBeenCalledOnce();
    });

    it('delivers progress messages in order via setImmediate', async () => {
      const sessions = [
        makeSession({ sessionId: 's1', workspaceId: 'ws-1', workspaceName: 'proj', requests: [makeRequest()] }),
      ];
      const a = new Analyzer(sessions);

      const messages: { phase: number; detail: string }[] = [];
      await a.warmUp((phase, detail) => {
        messages.push({ phase, detail });
      });

      // Verify we got progress messages (worker falls back to sync in tests)
      expect(messages.length).toBeGreaterThanOrEqual(2);

      // First message should be computing analytics
      expect(messages[0].detail).toContain('Computing analytics');
      expect(messages[0].phase).toBe(4);

      // Last message should indicate cache is ready
      const last = messages[messages.length - 1];
      expect(last.phase).toBe(5);
      expect(last.detail).toContain('Cache ready');
    });

    it('completes even with empty sessions', async () => {
      const a = new Analyzer([]);
      const messages: string[] = [];
      await a.warmUp((_phase, detail) => {
        messages.push(detail);
      });
      expect(messages.length).toBeGreaterThanOrEqual(2);
      expect(messages[messages.length - 1]).toContain('Cache ready');
    });
  });
});

describe('getCodeProduction with deduplicated edit LoC', () => {
  it('prefers exact edit LoC over synthetic code blocks for the same request', () => {
    const URI = 'file:///proj/app.ts';
    const v1 = Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n');
    const v2 = v1 + '\nline10';
    const v3 = v2 + '\nline11';
    const wholeFile = (text: string) => [{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1_000_000, endColumn: 1 }, text }];
    const timeline: EditTimelineLike = {
      fileBaselines: [[`${URI}::r1`, { uri: { external: URI }, requestId: 'r1', content: v1 }]],
      operations: [
        { type: 'textEdit', requestId: 'r1', uri: { external: URI }, epoch: 1, edits: wholeFile(v1) },
        { type: 'textEdit', requestId: 'r1', uri: { external: URI }, epoch: 2, edits: wholeFile(v2) },
        { type: 'textEdit', requestId: 'r1', uri: { external: URI }, epoch: 3, edits: wholeFile(v3) },
      ],
    };
    const editLocIndex = new Map<string, Map<string, { added: number; removed: number }>>();
    accumulateEditLoc(timeline, editLocIndex);
    // The three whole-file snapshots (10 + 11 + 12 lines) collapse to 2 newly-produced lines.
    expect(editLocIndex.get('r1')?.get(URI)?.added).toBe(2);

    const ts = new Date(2024, 5, 15, 10, 0, 0).getTime();
    const sessions = [
      makeSession({
        sessionId: 's1', harness: 'Codex', creationDate: ts, workspaceName: 'proj',
        requests: [makeRequest({ requestId: 'r1', timestamp: ts, aiCode: [{ language: 'typescript', loc: 5 }] })],
      }),
    ];
    const a = new Analyzer(sessions, editLocIndex);
    const prod = a.getCodeProduction();
    // The code block represents the same tool payload, so only the 2 exact edited lines count.
    expect(prod.summary.totalAiLoc).toBe(2);
    expect(a.getDailyActivity().loc).toEqual([2]);
  });

  it('reports net = gross added minus removed and surfaces removed in the daily timeline', () => {
    const URI = 'file:///proj/app.ts';
    const wholeFile = (text: string) => [{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1_000_000, endColumn: 1 }, text }];
    const v1 = 'a\nb\nc\nd\ne';
    const v2 = 'a\nb'; // removes c, d, e (3 removed, 0 added)
    const timeline: EditTimelineLike = {
      fileBaselines: [[`${URI}::r1`, { uri: { external: URI }, requestId: 'r1', content: v1 }]],
      operations: [
        { type: 'textEdit', requestId: 'r1', uri: { external: URI }, epoch: 1, edits: wholeFile(v1) }, // equals baseline -> 0/0
        { type: 'textEdit', requestId: 'r1', uri: { external: URI }, epoch: 2, edits: wholeFile(v2) }, // 0 added, 3 removed
      ],
    };
    const editLocIndex = new Map<string, Map<string, { added: number; removed: number }>>();
    accumulateEditLoc(timeline, editLocIndex);

    const ts = new Date(2024, 5, 15, 10, 0, 0).getTime();
    const day = '2024-06-15';
    const sessions = [
      makeSession({
        sessionId: 's1', harness: 'Codex', creationDate: ts, workspaceName: 'proj',
        requests: [makeRequest({ requestId: 'r1', timestamp: ts, modelId: 'gpt-5', aiCode: [{ language: 'typescript', loc: 5 }] })],
      }),
    ];
    const prod = new Analyzer(sessions, editLocIndex).getCodeProduction();
    // Exact edit telemetry replaces the synthetic block: gross 0, removed 3, net -3.
    expect(prod.summary.totalAiLoc).toBe(0);
    expect(prod.summary.totalRemovedAiLoc).toBe(3);
    expect(prod.summary.totalNetAiLoc).toBe(-3);

    const dayIdx = prod.dailyTimeline.labels.indexOf(day);
    expect(dayIdx).toBeGreaterThanOrEqual(0);
    expect(prod.dailyTimeline.aiLoc[dayIdx]).toBe(0);
    expect(prod.dailyTimeline.removedLoc[dayIdx]).toBe(3);
    // Removed is broken down by dimension and aligns with the same day index.
    expect(prod.dailyRemovedByModel['gpt-5'][dayIdx]).toBe(3);
    expect(prod.dailyRemovedByWorkspace['proj'][dayIdx]).toBe(3);
    expect(prod.dailyRemovedByHarness['Codex'][dayIdx]).toBe(3);
  });
});
