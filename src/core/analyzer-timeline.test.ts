/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect } from 'vitest';
import { TimelineAnalyzer } from './analyzer-timeline';
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

function createAnalyzer(sessions: Session[]): TimelineAnalyzer {
  return new TimelineAnalyzer(sessions, new Map());
}

describe('TimelineAnalyzer', () => {
  describe('getDayTimeline', () => {
    it('returns empty timeline when no sessions', () => {
      const analyzer = createAnalyzer([]);
      const result = analyzer.getDayTimeline();
      expect(result.sessions).toEqual([]);
      expect(result.sessionCount).toBe(0);
    });

    it('returns timeline for today by default', () => {
      const now = Date.now();
      const session = makeSession({
        requests: [
          makeRequest({ timestamp: now - 1000 }),
          makeRequest({ timestamp: now }),
        ],
        lastMessageDate: now,
      });
      const analyzer = createAnalyzer([session]);
      const result = analyzer.getDayTimeline();
      expect(result.sessionCount).toBe(1);
      expect(result.sessions[0].requestCount).toBe(2);
    });

    it('filters to specified date', () => {
      const targetDate = '2024-03-15';
      const ts = new Date('2024-03-15T10:00:00').getTime();
      const session = makeSession({
        requests: [
          makeRequest({ timestamp: ts }),
          makeRequest({ timestamp: ts + 60000 }),
        ],
        lastMessageDate: ts + 60000,
      });
      const analyzer = createAnalyzer([session]);
      const result = analyzer.getDayTimeline(targetDate);
      expect(result.date).toBe(targetDate);
      expect(result.sessionCount).toBe(1);
    });

    it('excludes sessions from other days', () => {
      const targetDate = '2024-03-15';
      const otherTs = new Date('2024-03-14T10:00:00').getTime();
      const session = makeSession({
        requests: [makeRequest({ timestamp: otherTs })],
        lastMessageDate: otherTs,
      });
      const analyzer = createAnalyzer([session]);
      const result = analyzer.getDayTimeline(targetDate);
      expect(result.sessionCount).toBe(0);
    });

    it('computes maxConcurrent correctly', () => {
      const ts = new Date('2024-03-15T10:00:00').getTime();
      const session1 = makeSession({
        sessionId: 's1',
        requests: [
          makeRequest({ timestamp: ts }),
          makeRequest({ timestamp: ts + 60000 }),
        ],
        lastMessageDate: ts + 60000,
      });
      const session2 = makeSession({
        sessionId: 's2',
        requests: [
          makeRequest({ timestamp: ts + 30000 }),
          makeRequest({ timestamp: ts + 90000 }),
        ],
        lastMessageDate: ts + 90000,
      });
      const analyzer = createAnalyzer([session1, session2]);
      const result = analyzer.getDayTimeline('2024-03-15');
      expect(result.maxConcurrent).toBe(2);
    });

    it('provides date navigation', () => {
      const ts1 = new Date('2024-03-14T10:00:00').getTime();
      const ts2 = new Date('2024-03-15T10:00:00').getTime();
      const ts3 = new Date('2024-03-16T10:00:00').getTime();
      const sessions = [
        makeSession({ requests: [makeRequest({ timestamp: ts1 })], lastMessageDate: ts1 }),
        makeSession({ requests: [makeRequest({ timestamp: ts2 })], lastMessageDate: ts2 }),
        makeSession({ requests: [makeRequest({ timestamp: ts3 })], lastMessageDate: ts3 }),
      ];
      const analyzer = createAnalyzer(sessions);
      const result = analyzer.getDayTimeline('2024-03-15');
      expect(result.prevDay).toBe('2024-03-14');
      expect(result.nextDay).toBe('2024-03-16');
      expect(result.firstDay).toBe('2024-03-14');
    });

    it('returns activeDates with counts', () => {
      const ts = new Date('2024-03-15T10:00:00').getTime();
      const session = makeSession({
        requests: [
          makeRequest({ timestamp: ts }),
          makeRequest({ timestamp: ts + 1000 }),
        ],
        lastMessageDate: ts + 1000,
      });
      const analyzer = createAnalyzer([session]);
      const result = analyzer.getDayTimeline('2024-03-15');
      expect(result.activeDates.length).toBeGreaterThan(0);
      expect(result.activeDates[0].count).toBe(2);
    });
  });

  describe('getSessions', () => {
    it('returns empty list for no sessions', () => {
      const analyzer = createAnalyzer([]);
      const result = analyzer.getSessions(1, 10);
      expect(result.total).toBe(0);
      expect(result.sessions).toEqual([]);
    });

    it('paginates correctly', () => {
      const now = Date.now();
      const sessions = Array.from({ length: 5 }, (_, i) =>
        makeSession({ sessionId: `s${i}`, lastMessageDate: now - i * 1000 })
      );
      const analyzer = createAnalyzer(sessions);
      const page1 = analyzer.getSessions(1, 2);
      expect(page1.total).toBe(5);
      expect(page1.sessions).toHaveLength(2);
      expect(page1.page).toBe(1);
      expect(page1.pageSize).toBe(2);

      const page2 = analyzer.getSessions(2, 2);
      expect(page2.sessions).toHaveLength(2);
    });

    it('filters by search term', () => {
      const now = Date.now();
      const sessions = [
        makeSession({ workspaceName: 'my-app', lastMessageDate: now }),
        makeSession({ workspaceName: 'other-project', lastMessageDate: now }),
      ];
      const analyzer = createAnalyzer(sessions);
      const result = analyzer.getSessions(1, 10, undefined, 'my-app');
      expect(result.total).toBe(1);
      expect(result.sessions[0].workspaceName).toBe('my-app');
    });

    it('searches in message text', () => {
      const now = Date.now();
      const sessions = [
        makeSession({
          workspaceName: 'proj',
          requests: [makeRequest({ messageText: 'fix the bug', timestamp: now })],
          lastMessageDate: now,
        }),
        makeSession({
          workspaceName: 'proj2',
          requests: [makeRequest({ messageText: 'add feature', timestamp: now })],
          lastMessageDate: now,
        }),
      ];
      const analyzer = createAnalyzer(sessions);
      const result = analyzer.getSessions(1, 10, undefined, 'bug');
      expect(result.total).toBe(1);
    });
  });

  describe('getSessionDetail', () => {
    it('returns null for unknown session', () => {
      const analyzer = createAnalyzer([]);
      expect(analyzer.getSessionDetail('unknown')).toBeNull();
    });

    it('returns session by id', () => {
      const session = makeSession({ sessionId: 'target' });
      const analyzer = createAnalyzer([session]);
      const result = analyzer.getSessionDetail('target');
      expect(result).not.toBeNull();
      expect(result!.sessionId).toBe('target');
    });
  });

  describe('getWorkLifeBalance', () => {
    it('returns null for no requests', () => {
      const analyzer = createAnalyzer([]);
      expect(analyzer.getWorkLifeBalance()).toBeNull();
    });

    it('computes balance for weekday work hours', () => {
      // Wednesday March 13 2024, 10 AM
      const ts = new Date('2024-03-13T10:00:00').getTime();
      const sessions = [
        makeSession({
          requests: Array.from({ length: 5 }, (_, i) =>
            makeRequest({ timestamp: ts + i * 60000 })
          ),
          lastMessageDate: ts + 4 * 60000,
        }),
      ];
      const analyzer = createAnalyzer(sessions);
      const result = analyzer.getWorkLifeBalance();
      expect(result).not.toBeNull();
      expect(result!.weekdayReqs).toBe(5);
      expect(result!.weekendReqs).toBe(0);
      expect(result!.score).toBeGreaterThan(50);
    });

    it('penalizes weekend work', () => {
      // Saturday March 16 2024, 10 AM
      const satTs = new Date('2024-03-16T10:00:00').getTime();
      // Also some weekday
      const wedTs = new Date('2024-03-13T10:00:00').getTime();
      const sessions = [
        makeSession({
          requests: [
            ...Array.from({ length: 3 }, (_, i) => makeRequest({ timestamp: satTs + i * 60000 })),
            makeRequest({ timestamp: wedTs }),
          ],
          lastMessageDate: satTs + 2 * 60000,
        }),
      ];
      const analyzer = createAnalyzer(sessions);
      const result = analyzer.getWorkLifeBalance();
      expect(result).not.toBeNull();
      expect(result!.weekendReqs).toBe(3);
      expect(result!.weekendRatio).toBeGreaterThan(0.5);
    });

    it('computes streaks', () => {
      const sessions: Session[] = [];
      // 5 consecutive days
      for (let i = 0; i < 5; i++) {
        const ts = new Date(`2024-03-${11 + i}T10:00:00`).getTime();
        sessions.push(makeSession({
          requests: [makeRequest({ timestamp: ts })],
          lastMessageDate: ts,
        }));
      }
      const analyzer = createAnalyzer(sessions);
      const result = analyzer.getWorkLifeBalance();
      expect(result).not.toBeNull();
      expect(result!.maxStreak).toBe(5);
    });

    it('computes weekly trend', () => {
      const ts1 = new Date('2024-03-11T10:00:00').getTime();
      const ts2 = new Date('2024-03-18T10:00:00').getTime();
      const sessions = [
        makeSession({ requests: [makeRequest({ timestamp: ts1 })], lastMessageDate: ts1 }),
        makeSession({ requests: [makeRequest({ timestamp: ts2 })], lastMessageDate: ts2 }),
      ];
      const analyzer = createAnalyzer(sessions);
      const result = analyzer.getWorkLifeBalance();
      expect(result).not.toBeNull();
      expect(result!.weeklyTrend.labels.length).toBeGreaterThanOrEqual(1);
    });

    it('computes time distribution correctly', () => {
      // Late night request (2 AM)
      const lateTs = new Date('2024-03-13T02:00:00').getTime();
      // Work hours (10 AM)
      const workTs = new Date('2024-03-13T10:00:00').getTime();
      const sessions = [
        makeSession({
          requests: [
            makeRequest({ timestamp: lateTs }),
            makeRequest({ timestamp: workTs }),
          ],
          lastMessageDate: workTs,
        }),
      ];
      const analyzer = createAnalyzer(sessions);
      const result = analyzer.getWorkLifeBalance();
      expect(result).not.toBeNull();
      expect(result!.timeDistribution.lateNight).toBe(1);
      expect(result!.timeDistribution.workHours).toBe(1);
    });

    it('measures only the prompts the user typed, and reports the turns it left out', () => {
      const wednesday10am = new Date('2024-03-13T10:00:00').getTime();
      const wednesday2am = new Date('2024-03-13T02:00:00').getTime();
      const saturday = new Date('2024-03-16T10:00:00').getTime();
      const sunday = new Date('2024-03-17T10:00:00').getTime();
      const sessions = [makeSession({
        requests: [
          makeRequest({ timestamp: wednesday2am, nonHumanKind: 'autopilot' }),
          makeRequest({ timestamp: wednesday10am }),
          makeRequest({ timestamp: wednesday10am + 60_000, nonHumanKind: 'subagent' }),
          makeRequest({ timestamp: saturday, nonHumanKind: 'relayed' }),
          makeRequest({ timestamp: sunday, nonHumanKind: 'agent' }),
        ],
        lastMessageDate: sunday,
      })];
      const result = createAnalyzer(sessions).getWorkLifeBalance();
      expect(result).toMatchObject({
        totalRequests: 1, weekdayReqs: 1, weekendReqs: 0, weekendRatio: 0, activeDays: 1, maxStreak: 1,
        timeDistribution: { lateNight: 0, earlyMorning: 0, workHours: 1, evening: 0 },
        turnBasis: { humanTurns: 1, automatedTurns: 4, automatedByKind: { autopilot: 1, subagent: 1, relayed: 1, agent: 1 } },
      });
      expect(result!.weeklyTrend.weekend.reduce((a, b) => a + b, 0)).toBe(0);
    });

    it('returns null when every turn in range is automated', () => {
      const ts = new Date('2024-03-13T02:00:00').getTime();
      const sessions = [makeSession({ requests: [makeRequest({ timestamp: ts, nonHumanKind: 'autopilot' })], lastMessageDate: ts })];
      expect(createAnalyzer(sessions).getWorkLifeBalance()).toBeNull();
    });
  });
});
