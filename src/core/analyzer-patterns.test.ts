/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect } from 'vitest';
import { PatternsAnalyzer } from './analyzer-patterns';
import { Session, SessionRequest } from './types/session-types';
import type { PatternContribution } from './types/analytics-types';
import { getDetectorGroupCounts } from './detector-registry';
import { isoWeek } from './helpers';

function makeRequest(overrides: Partial<SessionRequest> = {}): SessionRequest {
  return {
    requestId: 'req-' + Math.random().toString(36).slice(2, 8),
    timestamp: Date.now(),
    messageText: 'test message',
    responseText: 'test response',
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
    totalElapsed: 2000,
    messageLength: 50,
    responseLength: 100,
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
  const base: Session = {
    sessionId: 'sess-' + Math.random().toString(36).slice(2, 8),
    workspaceId: 'ws-1',
    workspaceName: 'my-project',
    location: '/projects/my-project',
    harness: 'Local Agent',
    creationDate: now - 3600000,
    lastMessageDate: now,
    requestCount: 1,
    requests: [makeRequest()],
    ...overrides,
  };
  base.requestCount = base.requests.length;
  return base;
}

function createAnalyzer(
  sessions: Session[],
  editLocIndex = new Map<string, Map<string, { added: number; removed: number }>>(),
): PatternsAnalyzer {
  return new PatternsAnalyzer(sessions, editLocIndex);
}

describe('PatternsAnalyzer', () => {
  it.each([undefined, { harness: 'Claude' }])('scores native contributions without changing unrelated scores or detector budgets (%j)', filter => {
    const timestamp = Date.parse('2026-09-30T12:00:00Z');
    const analyzer = createAnalyzer([makeSession({
      requests: [makeRequest({ timestamp })], creationDate: timestamp, lastMessageDate: timestamp, harness: 'Claude',
    })]);
    const baseline = analyzer.getAntiPatterns(filter);
    const week = isoWeek(new Date(timestamp));
    const contribution: PatternContribution = {
      patterns: [{
        id: 'native-code-review', name: 'Native code review', severity: 'high', group: 'code-review',
        description: 'Recorded code review check.', occurrences: 4,
        suggestion: 'Review the recorded changes.', examples: [], details: [],
        weeklyHist: { labels: [week], counts: [4] },
      }],
      weekly: [{ week, group: 'code-review', severity: 'high', occurrences: 4 }],
    };
    const result = analyzer.getAntiPatterns(filter, contribution);
    const counts = getDetectorGroupCounts(!!filter?.harness);
    const previous = baseline.groupScores.find(row => row.group === 'code-review')!;
    const patterns = result.patterns.filter(row => row.group === 'code-review');
    const penalty = patterns.reduce((sum, row) => sum + ({ high: 12, medium: 7, low: 3 })[row.severity], 0);
    expect(result.groupScores.find(row => row.group === 'code-review')).toMatchObject({
      score: Math.max(0, Math.round(100 * (1 - penalty / ((counts['code-review'] || 8) * 12)))),
      patternCount: previous.patternCount + 1,
    });
    const weekly = baseline.weeklyScores.series.find(row => row.group === 'code-review')!;
    expect(result.weeklyScores.series.find(row => row.group === 'code-review')!.scores).toEqual(
      weekly.scores.map(score => Math.max(0, Math.round(score - 100 / (counts['code-review'] || 8)))),
    );
    expect(result.weeklyTrend.counts[0]).toBe((baseline.weeklyTrend.counts[0] ?? 0) + 4);
    expect(result.totalOccurrences).toBe(baseline.totalOccurrences + 4);
    expect(result.groupScores.filter(row => row.group !== 'code-review')).toEqual(
      baseline.groupScores.filter(row => row.group !== 'code-review'),
    );
    expect(result.weeklyScores.series.filter(row => row.group !== 'code-review')).toEqual(
      baseline.weeklyScores.series.filter(row => row.group !== 'code-review'),
    );
    expect(result).not.toHaveProperty('curiosityTier');
  });

  describe('getRecommendations', () => {
    it('returns empty for no sessions', () => {
      const analyzer = createAnalyzer([]);
      const result = analyzer.getRecommendations();
      expect(result).toEqual([]);
    });

    it('returns all recommendation checks', () => {
      const now = Date.now();
      const sessions = [
        makeSession({
          requests: [makeRequest({ timestamp: now })],
          lastMessageDate: now,
        }),
      ];
      const analyzer = createAnalyzer(sessions);
      const result = analyzer.getRecommendations();
      expect(result.length).toBe(12);
      const ids = result.map(r => r.checkId);
      expect(ids).toContain('model-switch');
      expect(ids).toContain('model-task-align');
      expect(ids).toContain('planning-mode');
      expect(ids).toContain('context-flush');
      expect(ids).toContain('slash-commands');
      expect(ids).toContain('feature-usage');
      expect(ids).toContain('parallelism');
      expect(ids).toContain('cancellation');
      expect(ids).toContain('tool-diversity');
      expect(ids).toContain('response-time');
      expect(ids).toContain('file-refs');
      expect(ids).toContain('session-length');
    });

    it('gives high model diversity score for multiple models', () => {
      const now = Date.now();
      const requests = [
        makeRequest({ timestamp: now, modelId: 'gpt-4.1' }),
        makeRequest({ timestamp: now + 1000, modelId: 'claude-sonnet-4' }),
        makeRequest({ timestamp: now + 2000, modelId: 'gpt-4.1-mini' }),
        makeRequest({ timestamp: now + 3000, modelId: 'gemini-2.5-pro' }),
      ];
      const sessions = [makeSession({ requests, lastMessageDate: now + 3000 })];
      const analyzer = createAnalyzer(sessions);
      const result = analyzer.getRecommendations();
      const modelCheck = result.find(r => r.checkId === 'model-switch')!;
      expect(modelCheck.score).toBe(100);
    });

    it('gives low score for single model usage', () => {
      const now = Date.now();
      const requests = [
        makeRequest({ timestamp: now, modelId: 'gpt-4.1' }),
        makeRequest({ timestamp: now + 1000, modelId: 'gpt-4.1' }),
      ];
      const sessions = [makeSession({ requests, lastMessageDate: now + 1000 })];
      const analyzer = createAnalyzer(sessions);
      const result = analyzer.getRecommendations();
      const modelCheck = result.find(r => r.checkId === 'model-switch')!;
      expect(modelCheck.score).toBeLessThanOrEqual(50);
    });

    it('detects high cancellation rate', () => {
      const now = Date.now();
      const requests = Array.from({ length: 10 }, (_, i) =>
        makeRequest({ timestamp: now + i * 1000, isCanceled: i < 5 })
      );
      const sessions = [makeSession({ requests, lastMessageDate: now + 9000 })];
      const analyzer = createAnalyzer(sessions);
      const result = analyzer.getRecommendations();
      const cancelCheck = result.find(r => r.checkId === 'cancellation')!;
      expect(cancelCheck.score).toBeLessThan(100);
    });

    it('detects good slash command usage', () => {
      const now = Date.now();
      const requests = Array.from({ length: 10 }, (_, i) =>
        makeRequest({ timestamp: now + i * 1000, slashCommand: i < 3 ? 'fix' : '' })
      );
      const sessions = [makeSession({ requests, lastMessageDate: now + 9000 })];
      const analyzer = createAnalyzer(sessions);
      const result = analyzer.getRecommendations();
      const slashCheck = result.find(r => r.checkId === 'slash-commands')!;
      expect(slashCheck.score).toBeGreaterThan(10);
    });

    it('detects long sessions', () => {
      const now = Date.now();
      const requests = Array.from({ length: 35 }, (_, i) =>
        makeRequest({ timestamp: now + i * 1000 })
      );
      const sessions = [makeSession({ requests, lastMessageDate: now + 34000 })];
      const analyzer = createAnalyzer(sessions);
      const result = analyzer.getRecommendations();
      const sessionCheck = result.find(r => r.checkId === 'context-flush')!;
      expect(sessionCheck.score).toBeLessThan(100);
    });

    it('detects good tool diversity', () => {
      const now = Date.now();
      const tools = ['terminal', 'file_search', 'web_search', 'edit_file', 'read_file', 'grep', 'git', 'browser'];
      const requests = tools.map((tool, i) =>
        makeRequest({ timestamp: now + i * 1000, toolsUsed: [tool] })
      );
      const sessions = [makeSession({ requests, lastMessageDate: now + 7000 })];
      const analyzer = createAnalyzer(sessions);
      const result = analyzer.getRecommendations();
      const toolCheck = result.find(r => r.checkId === 'tool-diversity')!;
      expect(toolCheck.score).toBe(100);
    });

    it('detects good file context usage', () => {
      const now = Date.now();
      const requests = Array.from({ length: 10 }, (_, i) =>
        makeRequest({ timestamp: now + i * 1000, referencedFiles: i < 5 ? ['file.ts'] : [] })
      );
      const sessions = [makeSession({ requests, lastMessageDate: now + 9000 })];
      const analyzer = createAnalyzer(sessions);
      const result = analyzer.getRecommendations();
      const fileCheck = result.find(r => r.checkId === 'file-refs')!;
      expect(fileCheck.score).toBeGreaterThan(40);
    });
  });

  describe('getAntiPatterns', () => {
    it('returns anti-pattern data structure', () => {
      const now = Date.now();
      const sessions = [
        makeSession({
          requests: [makeRequest({ timestamp: now })],
          lastMessageDate: now,
        }),
      ];
      const analyzer = createAnalyzer(sessions);
      const result = analyzer.getAntiPatterns();
      expect(result).toHaveProperty('patterns');
      expect(result).toHaveProperty('totalOccurrences');
      expect(result).toHaveProperty('weeklyTrend');
      expect(result).toHaveProperty('groupScores');
      expect(result).toHaveProperty('weeklyScores');
    });

    it('returns group scores for all practice groups', () => {
      const now = Date.now();
      const sessions = [
        makeSession({
          requests: [makeRequest({ timestamp: now })],
          lastMessageDate: now,
        }),
      ];
      const analyzer = createAnalyzer(sessions);
      const result = analyzer.getAntiPatterns();
      const groups = result.groupScores.map(g => g.group);
      expect(groups).toContain('prompt-quality');
      expect(groups).toContain('session-hygiene');
      expect(groups).toContain('code-review');
      expect(groups).toContain('tool-mastery');
    });

    it('handles empty sessions', () => {
      const analyzer = createAnalyzer([]);
      const result = analyzer.getAntiPatterns();
      expect(result.patterns).toEqual([]);
      expect(result.totalOccurrences).toBe(0);
    });
  });

  describe('getProjectOverview', () => {
    it('returns empty for no sessions', () => {
      const analyzer = createAnalyzer([]);
      const result = analyzer.getProjectOverview();
      expect(result.projects).toEqual([]);
    });

    it('groups by workspace and computes metrics', () => {
      const ts = new Date('2024-03-15T10:00:00').getTime();
      const sessions = [
        makeSession({
          workspaceName: 'project-x',
          requests: [
            makeRequest({ timestamp: ts, editedFiles: ['src/main.ts', 'src/app.ts'], aiCode: [{ language: 'typescript', loc: 50 }] }),
            makeRequest({ timestamp: ts + 7200000 }), // 2 hours later
          ],
          lastMessageDate: ts + 7200000,
        }),
      ];
      const analyzer = createAnalyzer(sessions);
      const result = analyzer.getProjectOverview();
      expect(result.projects).toHaveLength(1);
      expect(result.projects[0].workspaceName).toBe('project-x');
      expect(result.projects[0].estimatedHours).toBeGreaterThan(0);
      expect(result.projects[0].estimatedLoc).toBeGreaterThan(0);
    });

    it('uses exact edit LoC instead of adding synthetic tool code blocks', () => {
      const ts = new Date('2024-03-15T10:00:00').getTime();
      const request = makeRequest({
        requestId: 'exact',
        timestamp: ts,
        aiCode: [{ language: 'typescript', loc: 50 }],
      });
      const sessions = [makeSession({ workspaceName: 'project-x', requests: [request] })];
      const editLocIndex = new Map([
        ['exact', new Map([['file:///src/main.ts', { added: 4, removed: 2 }]])],
      ]);

      const result = createAnalyzer(sessions, editLocIndex).getProjectOverview();

      expect(result.projects[0].estimatedLoc).toBe(4);
    });

    it('determines time pattern', () => {
      // Weekend requests
      const satTs = new Date('2024-03-16T10:00:00').getTime(); // Saturday
      const sunTs = new Date('2024-03-17T10:00:00').getTime(); // Sunday
      const sessions = [
        makeSession({
          workspaceName: 'weekend-project',
          requests: [
            makeRequest({ timestamp: satTs }),
            makeRequest({ timestamp: sunTs }),
          ],
          lastMessageDate: sunTs,
        }),
      ];
      const analyzer = createAnalyzer(sessions);
      const result = analyzer.getProjectOverview();
      expect(result.projects[0].timePattern).toContain('weekend');
    });
  });

  describe('getFilteredRequests / getFilteredSessions', () => {
    it('exposes filtered requests', () => {
      const now = Date.now();
      const sessions = [
        makeSession({
          requests: [makeRequest({ timestamp: now })],
          lastMessageDate: now,
        }),
      ];
      const analyzer = createAnalyzer(sessions);
      expect(analyzer.getFilteredRequests().length).toBe(1);
    });

    it('exposes filtered sessions', () => {
      const now = Date.now();
      const sessions = [makeSession({ lastMessageDate: now })];
      const analyzer = createAnalyzer(sessions);
      expect(analyzer.getFilteredSessions().length).toBe(1);
    });

    it('applies date filter', () => {
      const ts1 = new Date('2024-03-10T10:00:00').getTime();
      const ts2 = new Date('2024-03-20T10:00:00').getTime();
      const sessions = [
        makeSession({ requests: [makeRequest({ timestamp: ts1 })], lastMessageDate: ts1 }),
        makeSession({ requests: [makeRequest({ timestamp: ts2 })], lastMessageDate: ts2 }),
      ];
      const analyzer = createAnalyzer(sessions);
      const filtered = analyzer.getFilteredSessions({ fromDate: '2024-03-15' });
      expect(filtered).toHaveLength(1);
    });
  });
});
