/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect } from 'vitest';
import { TimelineAnalyzer } from './analyzer-timeline';
import { buildFamilies, buildLanes, buildViewFamilies, prepareTimeline, timelineKpis, timelineWindow } from './timeline-model';
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

    it('links children to the session that created them, keeping a parent outside the range as context', () => {
      const coordinator = makeSession({ sessionId: 'c', childSessionIds: ['k1', 'k2'], requests: [makeRequest({ timestamp: at(9) })] });
      const child = makeSession({ sessionId: 'k1', requests: [makeRequest({ timestamp: at(10), nonHumanKind: 'relayed' })] });
      const relayed = makeSession({ sessionId: 'k3', relaySenderId: 'k1', requests: [makeRequest({ timestamp: at(11) })] });
      const old = makeSession({ sessionId: 'p', childSessionIds: ['late'], requests: [makeRequest({ timestamp: new Date(2024, 2, 1).getTime() })] });
      const late = makeSession({ sessionId: 'late', requests: [makeRequest({ timestamp: at(12) })] });
      const data = createAnalyzer([late, relayed, child, coordinator, old]).getTimelineData({ fromDate: '2024-03-15' }, ctx);
      expect(data.sessions.map(s => [s.id, s.parent, s.via, s.ctx ?? false, s.turns.length])).toEqual([
        ['c', -1, null, false, 1], ['k1', 0, 'create', false, 1], ['k3', 1, 'relay', false, 1], ['late', 4, 'create', false, 1], ['p', -1, null, true, 0],
      ]);
      expect(data.sessions[4].context?.map(t => t.t)).toEqual([new Date(2024, 2, 1).getTime()]);
    });

    it('scrubs names, and removes a branch prefix only for a signed-in handle', () => {
      const sessions = ['dev2-a', 'dev2-b', 'dev2/c', 'feat/d', 'vscode/e'].map((branch, i) => makeSession({
        sessionId: `s${i}`, branch, displayName: i === 0 ? 'Review dev2/shop at https://example.com' : undefined,
        workspaceName: i === 4 ? 'C:\\Users\\dev2\\dev2' : 'shop',
        requests: [makeRequest({ timestamp: at(9 + i), userWaits: i === 1 ? [{ start: at(10, 1), end: at(10, 3), kind: 'question', answered: true }] : undefined })],
      }));
      const data = createAnalyzer(sessions).getTimelineData(undefined, { ...ctx, names: [...ctx.names, 'dev2', 'vscode'], handles: ['dev2', 'vscode'] });
      expect(data.sessions.map(s => s.branch)).toEqual(['a', 'b', 'c', 'feat/d', 'vscode/e']);
      expect(data.sessions[0].name).toBe('Review shop at [link]');
      // A repository that is only the user's name is shown as such, never as "unknown".
      expect(data.sessions.map(s => s.repo)).toEqual(['shop', 'shop', 'shop', 'shop', 'personal repository']);
      expect(data.sessions[1].turns[0].w).toEqual([{ s: at(10, 1), e: at(10, 3), k: 'question', a: true }]);
    });

    it('counts sessions whose harness logged forks', () => {
      const data = createAnalyzer([makeSession({ forkCount: 2 }), makeSession()]).getTimelineData(undefined, ctx);
      expect(data.forkedSessions).toBe(1);
    });

    it('marks a fork with its source, or says the source isn’t in these logs', () => {
      const src = makeSession({ sessionId: 'src', harness: 'Codex', requests: [makeRequest({ timestamp: at(9) })] });
      const fork = makeSession({ sessionId: 'fork', harness: 'Codex', forkedFromId: 'src', inheritedTurns: 1, requests: [makeRequest({ timestamp: at(11) })] });
      const orphan = makeSession({ sessionId: 'orphan', harness: 'Codex', forkedFromId: 'gone', requests: [makeRequest({ timestamp: at(12) })] });
      const tied = makeSession({ sessionId: 'tied', harness: 'Claude', forkSourceAmbiguous: true, inheritedTurns: 2, requests: [makeRequest({ timestamp: at(13) })] });
      const data = createAnalyzer([src, fork, orphan, tied]).getTimelineData(undefined, ctx);
      const byId = new Map(data.sessions.map(s => [s.id, s]));
      expect(byId.get('fork')).toMatchObject({ fork: data.sessions.indexOf(byId.get('src')!), forkSource: 'loaded', inheritedTurns: 1, parent: -1 });
      expect(byId.get('orphan')).toMatchObject({ fork: -1, forkSource: 'missing' });
      // Several loaded sessions hold its copied history equally: not "missing" (G6).
      expect(byId.get('tied')).toMatchObject({ fork: -1, forkSource: 'ambiguous', inheritedTurns: 2 });
      expect(byId.get('src')?.fork).toBeUndefined();
    });

    it('never uses an Xcode conversation title as the repository', () => {
      const s = makeSession({ harness: 'Xcode', workspaceName: 'Fix the login bug in my app', repository: undefined, requests: [makeRequest({ timestamp: at(9) })] });
      expect(createAnalyzer([s]).getTimelineData(undefined, ctx).sessions[0].repo).toBe('');
    });

    it('counts the sub-agent launches each harness records', () => {
      const claude = makeSession({ harness: 'Claude', requests: [makeRequest({ timestamp: at(9), agentName: 'Claude', toolsUsed: ['Agent', 'Read', 'Task'] })] });
      const codex = makeSession({ harness: 'Codex', requests: [makeRequest({ timestamp: at(10), agentName: 'Codex', toolsUsed: ['spawn_agent', 'wait_agent', 'shell'] })] });
      expect(createAnalyzer([claude, codex]).getTimelineData(undefined, ctx).sessions.map(s => s.turns[0].sub)).toEqual([2, 1]);
    });

    it('keeps every member of a shown family, also one the harness filter hides, as context', () => {
      const coordinator = makeSession({ sessionId: 'c', harness: 'GitHub Copilot App', childSessionIds: ['k'], childSessionCreatedAt: { k: at(9, 5) }, requests: [makeRequest({ timestamp: at(9) })] });
      const child = makeSession({ sessionId: 'k', harness: 'Claude', requests: [makeRequest({ timestamp: at(9, 6), nonHumanKind: 'relayed' })] });
      const data = createAnalyzer([coordinator, child]).getTimelineData({ harness: 'Claude' }, ctx);
      expect(data.sessions.map(s => [s.id, s.parent, s.ctx ?? false, s.created])).toEqual([['k', 1, false, at(9, 5)], ['c', -1, true, undefined]]);
    });

    it('adds the first turn after the range as context, so a wait it ends is counted', () => {
      const s = makeSession({ sessionId: 'a', requests: [makeRequest({ timestamp: at(23, 30), totalElapsed: 60_000 }), makeRequest({ timestamp: new Date(2024, 2, 16, 0, 30).getTime() })] });
      const data = createAnalyzer([s]).getTimelineData({ fromDate: '2024-03-15', toDate: '2024-03-15' }, ctx);
      expect([data.sessions[0].turns.length, data.sessions[0].context?.map(t => t.t)]).toEqual([1, [new Date(2024, 2, 16, 0, 30).getTime()]]);
    });

    it('keeps the work and waits that cross into the range start, counted only inside it', () => {
      const ts = (d: number, h: number, m = 0) => new Date(2026, 2, d, h, m).getTime();
      const sessions = [
        // 23:00–23:30 on the 15th, then your next prompt at 0:30 on the 16th: half the wait is in range.
        makeSession({ sessionId: 'a', requests: [makeRequest({ timestamp: ts(15, 23), totalElapsed: 30 * 60_000 }), makeRequest({ timestamp: ts(16, 0, 30), totalElapsed: 60_000 })] }),
        // One turn from 23:50 to 0:30: only its 30 minutes on the 16th count.
        makeSession({ sessionId: 'b', requests: [makeRequest({ timestamp: ts(15, 23, 50), totalElapsed: 40 * 60_000, nonHumanKind: 'agent' })] }),
      ];
      const data = createAnalyzer(sessions).getTimelineData({ fromDate: '2026-03-16', toDate: '2026-03-16' }, ctx);
      expect([data.from, data.to]).toEqual([ts(16, 0), ts(17, 0)]);
      expect(data.sessions.map(s => [s.id, s.turns.length, s.context?.length])).toEqual([['b', 0, 1], ['a', 1, 1]]);
      const p = prepareTimeline(data);
      const lanes = buildLanes(p, ...timelineWindow('week', '2026-03-16'));
      const kpis = timelineKpis(lanes, buildViewFamilies(lanes, p));
      expect(kpis).toMatchObject({ turns: 1, typed: 1, waits: 0, waitMs: 30 * 60_000, agentMs: 31 * 60_000 });
      expect([...p.dayTotals.keys()]).toEqual(['2026-03-16']);
      expect(buildFamilies(p).totals.sessions).toBe(2);
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
