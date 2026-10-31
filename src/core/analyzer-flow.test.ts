/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect } from 'vitest';
import { FlowAnalyzer } from './analyzer-flow';
import { Session, SessionRequest } from './types/session-types';

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
    messageLength: 12,
    responseLength: 13,
    userCode: [],
    aiCode: [],
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

/** Create a session with rapid follow-ups (deep flow) */
function makeFlowSession(startTs: number, gapSec: number, count: number): Session {
  const requests: SessionRequest[] = [];
  for (let i = 0; i < count; i++) {
    requests.push(makeRequest({
      timestamp: startTs + i * gapSec * 1000,
      totalElapsed: 1000,
    }));
  }
  return makeSession({
    requests,
    creationDate: startTs,
    lastMessageDate: startTs + (count - 1) * gapSec * 1000,
  });
}

function createAnalyzer(sessions: Session[]): FlowAnalyzer {
  return new FlowAnalyzer(sessions, new Map());
}

describe('FlowAnalyzer', () => {
  describe('getFlowState', () => {
    it('returns empty state for no sessions', () => {
      const analyzer = createAnalyzer([]);
      const result = analyzer.getFlowState();
      expect(result.days).toEqual([]);
      expect(result.overallFlowScore).toBe(0);
      expect(result.avgFollowUpSec).toBe(0);
      expect(result.avgBlockMin).toBe(0);
      expect(result.deepFlowDays).toBe(0);
      expect(result.totalDays).toBe(0);
      expect(result.weeklyTrend.labels).toEqual([]);
      expect(result.hourlyFlow).toEqual(Array(24).fill(0));
      // May generate a "low score" suggestion even with no data
      expect(Array.isArray(result.suggestions)).toBe(true);
    });

    it('excludes sessions with fewer than 3 timed requests', () => {
      // FLOW_SESSION_MIN_REQS = 3
      const now = Date.now();
      const session = makeSession({
        requests: [
          makeRequest({ timestamp: now }),
          makeRequest({ timestamp: now + 10000 }),
        ],
        lastMessageDate: now + 10000,
      });
      const analyzer = createAnalyzer([session]);
      const result = analyzer.getFlowState();
      expect(result.days).toHaveLength(0);
    });

    it('computes flow for a deep flow session (rapid follow-ups)', () => {
      const now = new Date('2024-03-15T10:00:00').getTime();
      // 5 requests, 15 sec apart → very rapid
      const session = makeFlowSession(now, 15, 5);
      const analyzer = createAnalyzer([session]);
      const result = analyzer.getFlowState();

      expect(result.days).toHaveLength(1);
      expect(result.totalDays).toBe(1);
      expect(result.overallFlowScore).toBeGreaterThan(0);
      // With 15s gaps, most should be under the 30s threshold
      expect(result.days[0].sessions[0].rapidFollowUpRate).toBeGreaterThan(0.5);
    });

    it('computes flow for a fragmented session (long gaps)', () => {
      const now = new Date('2024-03-15T10:00:00').getTime();
      // 4 requests, 10 min apart → slow
      const session = makeFlowSession(now, 600, 4);
      const analyzer = createAnalyzer([session]);
      const result = analyzer.getFlowState();

      expect(result.days).toHaveLength(1);
      const flowSession = result.days[0].sessions[0];
      // 600s gaps → above threshold, not rapid
      expect(flowSession.rapidFollowUpRate).toBe(0);
      expect(flowSession.flowLabel).toMatch(/fragmented|shallow/);
    });

    it('computes multiple days correctly', () => {
      const day1 = new Date('2024-03-15T10:00:00').getTime();
      const day2 = new Date('2024-03-16T10:00:00').getTime();
      const session1 = makeFlowSession(day1, 20, 5);
      const session2 = makeFlowSession(day2, 20, 5);
      const analyzer = createAnalyzer([session1, session2]);
      const result = analyzer.getFlowState();

      expect(result.days).toHaveLength(2);
      expect(result.totalDays).toBe(2);
    });

    it('builds weekly trend', () => {
      const day1 = new Date('2024-03-11T10:00:00').getTime(); // Monday
      const day2 = new Date('2024-03-18T10:00:00').getTime(); // Next Monday
      const session1 = makeFlowSession(day1, 20, 5);
      const session2 = makeFlowSession(day2, 20, 5);
      const analyzer = createAnalyzer([session1, session2]);
      const result = analyzer.getFlowState();

      expect(result.weeklyTrend.labels.length).toBeGreaterThanOrEqual(1);
      expect(result.weeklyTrend.scores.length).toBe(result.weeklyTrend.labels.length);
    });

    it('builds hourly flow distribution', () => {
      const now = new Date('2024-03-15T14:00:00').getTime(); // 2 PM
      const session = makeFlowSession(now, 20, 5);
      const analyzer = createAnalyzer([session]);
      const result = analyzer.getFlowState();

      expect(result.hourlyFlow).toHaveLength(24);
      expect(result.hourlyFlow[14]).toBeGreaterThan(0); // hour 14
    });

    it('filters by date range', () => {
      const day1 = new Date('2024-03-15T10:00:00').getTime();
      const day2 = new Date('2024-03-20T10:00:00').getTime();
      const session1 = makeFlowSession(day1, 20, 5);
      const session2 = makeFlowSession(day2, 20, 5);
      const analyzer = createAnalyzer([session1, session2]);

      const result = analyzer.getFlowState({ fromDate: '2024-03-19', toDate: '2024-03-21' });
      expect(result.days).toHaveLength(1);
    });

    it('generates suggestions for deep flow', () => {
      const now = new Date('2024-03-15T10:00:00').getTime();
      // Many rapid sessions → deep flow
      const sessions = Array.from({ length: 5 }, (_, i) =>
        makeFlowSession(now + i * 7200000, 10, 10)
      );
      const analyzer = createAnalyzer(sessions);
      const result = analyzer.getFlowState();

      // Should have at least the "peak hour" suggestion
      expect(result.suggestions.length).toBeGreaterThan(0);
    });

    it('generates suggestions for fragmented sessions', () => {
      const now = new Date('2024-03-15T10:00:00').getTime();
      // Many slow sessions → fragmented
      const sessions = Array.from({ length: 10 }, (_, i) =>
        makeFlowSession(now + i * 7200000, 300, 4)
      );
      const analyzer = createAnalyzer(sessions);
      const result = analyzer.getFlowState();

      expect(result.suggestions.length).toBeGreaterThan(0);
    });

    it('excludes sessions with null timestamps', () => {
      const session = makeSession({
        requests: [
          makeRequest({ timestamp: null }),
          makeRequest({ timestamp: null }),
          makeRequest({ timestamp: null }),
        ],
        lastMessageDate: Date.now(),
      });
      const analyzer = createAnalyzer([session]);
      const result = analyzer.getFlowState();
      expect(result.days).toHaveLength(0);
    });

    it('handles sessions spanning work blocks', () => {
      const now = new Date('2024-03-15T09:00:00').getTime();
      // Two sessions on same day, 30 min apart (> FLOW_BLOCK_GAP_MIN=15)
      const session1 = makeFlowSession(now, 20, 5);
      const session2 = makeFlowSession(now + 60 * 60 * 1000, 20, 5); // 1 hour later
      const analyzer = createAnalyzer([session1, session2]);
      const result = analyzer.getFlowState();

      expect(result.days).toHaveLength(1);
      expect(result.days[0].blockCount).toBeGreaterThanOrEqual(1);
    });

    it('measures follow-ups to typed prompts from the end of the work automated turns continued', () => {
      const start = new Date('2024-03-15T10:00:00').getTime();
      const at = (sec: number, elapsedSec: number, nonHumanKind?: 'autopilot') =>
        makeRequest({ timestamp: start + sec * 1000, totalElapsed: elapsedSec * 1000, nonHumanKind });
      const session = makeSession({
        requests: [at(0, 5), at(10, 290, 'autopilot'), at(320, 5), at(330, 270, 'autopilot'), at(610, 5), at(3600, 60, 'autopilot')],
        lastMessageDate: start + 3_660_000,
      });
      const [flow] = createAnalyzer([session]).getFlowState().days[0].sessions;
      expect(flow).toMatchObject({
        requestCount: 3, startTs: start, endTs: start + 610_000, durationMin: 10.2, medianFollowUpSec: 15, rapidFollowUpRate: 1,
      });
    });

    it('leaves out a session with fewer than 3 typed prompts, however many automated turns it has', () => {
      const start = new Date('2024-03-15T10:00:00').getTime();
      const requests = [
        makeRequest({ timestamp: start }),
        ...Array.from({ length: 5 }, (_, i) => makeRequest({ timestamp: start + (i + 1) * 10_000, nonHumanKind: 'agent' })),
        makeRequest({ timestamp: start + 60_000 }),
      ];
      const result = createAnalyzer([makeSession({ requests, lastMessageDate: start + 60_000 })]).getFlowState();
      expect(result.days).toHaveLength(0);
    });
  });
});
