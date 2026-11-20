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
  describe('getTimelineData', () => {
    const at = (h: number, m = 0) => new Date(2024, 2, 15, h, m).getTime();
    const ctx = { home: '/home/dev', names: ['dev'] };

    it('sends only counts and timings of the turns in range, oldest session first', () => {
      const session = makeSession({
        sessionId: 's1', harness: 'GitHub Copilot App', workspaceName: 'C:\\Users\\dev\\repos\\shop', repository: undefined,
        requests: [
          makeRequest({ timestamp: at(10), totalElapsed: 600_000, aiCredits: 2.5, loggedTokens: 1000, messageText: 'secret prompt' }),
          makeRequest({ timestamp: at(10, 20), totalElapsed: null, nonHumanKind: 'autopilot', subagentRuns: [{} as never] }),
          makeRequest({ timestamp: new Date(2024, 2, 16, 9).getTime(), nonHumanKind: 'relayed' }),
        ],
      });
      const data = createAnalyzer([session]).getTimelineData({ fromDate: '2024-03-15', toDate: '2024-03-15' }, ctx);
      expect(data.sessions).toHaveLength(1);
      expect(data.sessions[0]).toMatchObject({ id: 's1', repo: 'shop', harness: 'Copilot App', parent: -1, via: null });
      expect(data.sessions[0].turns).toEqual([
        { t: at(10), d: 600_000, k: 'you', sub: 0, comp: false, cr: 2.5, tok: 1000 },
        { t: at(10, 20), d: 0, k: 'autopilot', sub: 1, comp: false, cr: 0, tok: 0, noDuration: true },
      ]);
      expect(JSON.stringify(data)).not.toContain('secret prompt');
    });

    it('links children to the session that created them, and drops parents outside the range', () => {
      const coordinator = makeSession({ sessionId: 'c', childSessionIds: ['k1', 'k2'], requests: [makeRequest({ timestamp: at(9) })] });
      const child = makeSession({ sessionId: 'k1', requests: [makeRequest({ timestamp: at(10), nonHumanKind: 'relayed' })] });
      const relayed = makeSession({ sessionId: 'k3', relaySenderId: 'k1', requests: [makeRequest({ timestamp: at(11) })] });
      const old = makeSession({ sessionId: 'p', childSessionIds: ['late'], requests: [makeRequest({ timestamp: new Date(2024, 2, 1).getTime() })] });
      const late = makeSession({ sessionId: 'late', requests: [makeRequest({ timestamp: at(12) })] });
      const data = createAnalyzer([late, relayed, child, coordinator, old]).getTimelineData({ fromDate: '2024-03-15' }, ctx);
      expect(data.sessions.map(s => [s.id, s.parent, s.via])).toEqual([
        ['c', -1, null], ['k1', 0, 'create'], ['k3', 1, 'relay'], ['late', -1, null],
      ]);
    });

    it('scrubs names and branches, including the personal prefix most branches share', () => {
      const sessions = ['dev2-a', 'dev2-b', 'dev2/c', 'feat/d'].map((branch, i) => makeSession({
        sessionId: `s${i}`, branch, displayName: i === 0 ? 'Review dev2/shop at https://example.com' : undefined,
        requests: [makeRequest({ timestamp: at(9 + i) })],
      }));
      const data = createAnalyzer(sessions).getTimelineData(undefined, ctx);
      expect(data.sessions.map(s => s.branch)).toEqual(['a', 'b', 'c', 'feat/d']);
      expect(data.sessions[0].name).toBe('Review shop at [link]');
    });

    it('counts sessions whose harness logged forks', () => {
      const data = createAnalyzer([makeSession({ forkCount: 2 }), makeSession()]).getTimelineData(undefined, ctx);
      expect(data.forkedSessions).toBe(1);
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
