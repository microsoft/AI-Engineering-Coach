/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* The time-based rules count only the turns the user typed; the session-size rules count every turn. */

import { describe, it, expect } from 'vitest';
import { createRequest, createSession } from './parser-shared';
import { runDetectors, runEmitters } from './detector-registry';
import { evaluateExpression } from './dsl/index';
import type { NonHumanKind, Session, SessionRequest, WorkType } from './types';

const WEDNESDAY_NOON = new Date(2026, 0, 14, 12).getTime();
const WEDNESDAY_2AM = new Date(2026, 0, 14, 2).getTime();
const SATURDAY_NOON = new Date(2026, 0, 17, 12).getTime();

let nextId = 0;
function turns(count: number, start: number, stepMs: number, overrides: Partial<SessionRequest> = {}): SessionRequest[] {
  return Array.from({ length: count }, (_, index) => createRequest({
    requestId: `req-${nextId++}`,
    timestamp: start + index * stepMs,
    messageText: 'Refactor the parser so it streams events instead of buffering the file',
    responseText: 'Done.',
    totalElapsed: 5_000,
    ...overrides,
  }));
}

const automated = (kind: NonHumanKind, extra: Partial<SessionRequest> = {}): Partial<SessionRequest> => ({ nonHumanKind: kind, ...extra });

function session(requests: SessionRequest[]): Session {
  requests.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  return createSession({ sessionId: `session-${nextId++}`, workspaceId: 'ws', workspaceName: 'Project', harness: 'GitHub Copilot App', requests });
}

/** The same sessions, as if the user had typed every turn. */
function allTyped(sessions: Session[]): Session[] {
  return sessions.map(s => session(s.requests.map(({ nonHumanKind: _kind, ...request }) => ({ ...request }))));
}

function detect(sessions: Session[], ruleId: string) {
  return runDetectors(sessions.flatMap(s => s.requests), sessions, false).find(pattern => pattern.id === ruleId);
}

function emission(sessions: Session[], ruleId: string) {
  return runEmitters(sessions.flatMap(s => s.requests), sessions, false).get(ruleId);
}

describe('late-night-coding', () => {
  it('counts only the prompts the user typed at night', () => {
    const sessions = [session([...turns(12, WEDNESDAY_2AM, 60_000), ...turns(300, WEDNESDAY_2AM, 1_000, automated('autopilot'))])];
    expect(detect(sessions, 'late-night-coding')?.occurrences).toBe(12);
    expect(emission(sessions, 'late-night-coding')).toMatchObject({ count: 12 });
  });

  it('stays quiet when only automated turns ran at night', () => {
    const sessions = [session([...turns(5, WEDNESDAY_2AM, 60_000), ...turns(300, WEDNESDAY_2AM, 1_000, automated('agent'))])];
    expect(detect(sessions, 'late-night-coding')).toBeUndefined();
    expect(detect(allTyped(sessions), 'late-night-coding')?.occurrences).toBe(305);
  });
});

describe('weekend-overwork', () => {
  it('divides the typed weekend prompts by the typed prompts, not by every turn', () => {
    const sessions = [session([
      ...turns(30, SATURDAY_NOON, 60_000),
      ...turns(50, WEDNESDAY_NOON, 60_000),
      ...turns(500, WEDNESDAY_NOON, 1_000, automated('autopilot')),
      ...turns(300, SATURDAY_NOON, 1_000, automated('agent')),
    ])];
    expect(emission(sessions, 'weekend-overwork')).toMatchObject({ count: 30, total: 80, extra: { weekendReqs: 30, weekdayReqs: 50 } });
    expect(detect(sessions, 'weekend-overwork')?.description).toContain('30 prompts (38%)');
  });

  it('stays quiet when only automated turns ran on the weekend', () => {
    const sessions = [session([...turns(50, WEDNESDAY_NOON, 60_000), ...turns(300, SATURDAY_NOON, 1_000, automated('relayed'))])];
    expect(detect(sessions, 'weekend-overwork')).toBeUndefined();
    expect(emission(sessions, 'weekend-overwork')).toMatchObject({ count: 0, total: 50 });
    expect(detect(allTyped(sessions), 'weekend-overwork')).toBeDefined();
  });
});

describe('broken-flow-state', () => {
  /** Four typed prompts 10 minutes apart; after each, autopilot works for about 100 s in 10 s turns. */
  function day(dayOffset: number): Session {
    const start = new Date(2026, 0, 12 + dayOffset, 10).getTime();
    const requests: SessionRequest[] = [];
    for (let block = 0; block < 4; block++) {
      const typedAt = start + block * 600_000;
      requests.push(...turns(1, typedAt, 0), ...turns(10, typedAt + 10_000, 10_000, automated('autopilot')));
    }
    return session(requests);
  }

  it('measures pauses before typed prompts from the end of the automated work', () => {
    const sessions = Array.from({ length: 5 }, (_, index) => day(index));
    expect(evaluateExpression('flowScoreStats(allSessions, 3, 30000)', { allSessions: sessions }))
      .toEqual({ fragmentedDays: 5, totalDays: 5, avgScore: 0, lowScoreRate: 1 });
    expect(emission(sessions, 'broken-flow-state')).toMatchObject({ count: 5, total: 5 });
    expect(detect(sessions, 'broken-flow-state')).toBeDefined();
  });

  it('stays as before when the user typed every turn', () => {
    const sessions = allTyped(Array.from({ length: 5 }, (_, index) => day(index)));
    expect(evaluateExpression('flowScoreStats(allSessions, 3, 30000)', { allSessions: sessions }))
      .toEqual({ fragmentedDays: 0, totalDays: 5, avgScore: 96, lowScoreRate: 0 });
    expect(detect(sessions, 'broken-flow-state')).toBeUndefined();
  });

  it('needs the minimum number of typed prompts, however many automated turns ran', () => {
    const start = new Date(2026, 0, 12, 10).getTime();
    const sessions = [session([...turns(2, start, 600_000), ...turns(40, start + 10_000, 10_000, automated('agent'))])];
    expect(evaluateExpression('flowScoreStats(allSessions, 3, 30000)', { allSessions: sessions })).toMatchObject({ totalDays: 0 });
  });
});

describe('speed-accept', () => {
  const bigAnswer = { aiCode: [{ language: 'typescript', loc: 50 }] };

  /** A prompt answered with 50 lines of code, then a turn 3 s after the answer ended. */
  function pairs(next: Partial<SessionRequest>): Session[] {
    return Array.from({ length: 6 }, (_, index) => {
      const start = WEDNESDAY_NOON + index * 3_600_000;
      return session([...turns(1, start, 0, bigAnswer), ...turns(1, start + 8_000, 0, next)]);
    });
  }

  it('counts a typed message sent right after a large answer', () => {
    expect(evaluateExpression('adjacentPairCount(allSessions, 20, 15000)', { allSessions: pairs({}) })).toEqual({ count: 6, avgLoc: 50, avgGap: 3 });
    expect(detect(pairs({}), 'speed-accept')).toBeDefined();
  });

  it('leaves out an automated turn sent right after a large answer', () => {
    for (const kind of ['autopilot', 'agent', 'system'] as const) {
      expect(evaluateExpression('adjacentPairCount(allSessions, 20, 15000)', { allSessions: pairs(automated(kind)) })).toMatchObject({ count: 0 });
      expect(detect(pairs(automated(kind)), 'speed-accept')).toBeUndefined();
    }
  });

  it('counts a typed message sent right after a large answer to an automated turn', () => {
    const sessions = Array.from({ length: 6 }, (_, index) => {
      const start = WEDNESDAY_NOON + index * 3_600_000;
      return session([...turns(1, start, 0, automated('autopilot', bigAnswer)), ...turns(1, start + 8_000, 0)]);
    });
    expect(evaluateExpression('adjacentPairCount(allSessions, 20, 15000)', { allSessions: sessions })).toMatchObject({ count: 6 });
  });
});

describe('session-size rules count every turn', () => {
  it('mega-sessions counts automated turns in the session length', () => {
    const sessions = [session([...turns(5, WEDNESDAY_NOON, 60_000), ...turns(60, WEDNESDAY_NOON, 1_000, automated('subagent'))])];
    expect(detect(sessions, 'mega-sessions')?.occurrences).toBe(1);
    expect(detect(allTyped(sessions), 'mega-sessions')?.occurrences).toBe(1);
  });

  it('session-drift counts the work types of automated turns', () => {
    const workTypes: WorkType[] = ['feature', 'bug fix', 'docs', 'test'];
    const sessions = Array.from({ length: 4 }, (_, index) => session([
      ...turns(1, WEDNESDAY_NOON + index * 3_600_000, 0, { workType: 'feature' }),
      ...workTypes.map((workType, turn) => turns(1, WEDNESDAY_NOON + index * 3_600_000 + (turn + 1) * 60_000, 0, automated('agent', { workType }))[0]),
    ]));
    expect(detect(sessions, 'session-drift')?.occurrences).toBe(4);
    expect(detect(allTyped(sessions), 'session-drift')?.occurrences).toBe(4);
  });
});
