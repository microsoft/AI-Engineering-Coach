/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Edge cases of the Timeline rules, end to end from synthetic Copilot logs: answers as points in time, stops with no
 * result, relays, creation times, sessions that only hold an answer, and families with one active member. */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { formatTimeline } from '../mcp/formatters';
import {
  D17, D18, M, analyzer, at, end, ev, only, prompt, removeTimelineSessions, reply, session, sessionDir, sid, start, view,
} from '../test/timeline-cli';
import type { Analyzer } from './analyzer';
import { buildSummaryExportFromAnalyzer } from './summary-export';
import { buildFamilies, createNamer, intervalsMs, prepareTimeline, sessionWork } from './timeline-model';
import type { Session } from './types';
import type { TimelineTurn } from './types/timeline-types';

afterAll(removeTimelineSessions);
describe('answers are points in time', () => {
  // A question asked at 23:54 and answered at exactly midnight.
  const midnight = () => analyzer(session(1, [prompt(at(17, 23, 50)), start(at(17, 23, 54)), reply(at(17, 23, 55)), end(at(18))]));

  it('counts an answer at midnight on the new day, whatever the range', () => {
    const an = midnight();
    expect([view(an, D18).kpis.answered, view(an, D18, only(D18)).kpis.answered]).toEqual([1, 1]);
    expect(view(an, D18).p.days).toContain(D18);
    expect(buildSummaryExportFromAnalyzer(an, only(D18)).autonomy?.questionsAndPermissionsAnswered).toBe(1);
  });

  it('never says no question was answered on a day with an instant answer', () => {
    const an = analyzer(session(6, [prompt(at(17, 10))]), session(7, [prompt(at(18, 9), 6), start(at(18, 9, 1)), end(at(18, 9, 1)), reply(at(18, 9, 2))]));
    const text = view(an, D18).waits;
    expect(text).not.toContain('no question or permission prompt you answered');
    expect(text).toContain('1 question or permission prompt');
    expect(view(an, D17, { fromDate: D17, toDate: D18 }).p.sessions.length).toBeGreaterThan(0);
  });

  it('dates a family that only has instants at midnight to that day', () => {
    const an = analyzer(session(4, [prompt(at(17, 10))]), session(5, [prompt(at(18), 4)]));
    const family = view(an, D18, only(D18)).fam.families[0];
    expect([family.from, family.to]).toEqual([D18, D18]);
  });
});

describe('stops for you', () => {
  it('ends a question with no result at the next logged event, not at the turn’s end', () => {
    const an = analyzer(session(3, [prompt(at(17, 10)), start(at(17, 10, 1)), reply(at(17, 11, 1))]));
    expect(view(an, D17).kpis.agentMs / M).toBe(1);
  });

  it('does not count a day that holds only an unanswered stop as activity', () => {
    const an = analyzer(session(2, [prompt(at(17, 23)), start(at(17, 23, 54)), reply(at(17, 23, 55)), end(at(19, 0, 30), 'q', 'The question was interrupted.')]));
    const v = view(an, D18, only(D18));
    expect([v.lanes.length, v.fam.totals.sessions]).toEqual([0, 0]);
    expect(formatTimeline(an, only(D18))).toMatchObject({ sessions: 0, note: 'No sessions in this range.' });
  });

  it('keeps another turn of the same session working while one turn waits on you', () => {
    const turn = (s: number, e: number, w?: TimelineTurn['w']): TimelineTurn => ({ t: s, d: e - s, k: 'you', cr: 0, tok: 0, sub: 0, comp: false, ...(w ? { w } : {}) });
    const turns = [turn(at(18, 10), at(18, 10, 15), [{ s: at(18, 10, 3), e: at(18, 10, 13), k: 'question', a: true }]), turn(at(18, 10, 5), at(18, 10, 11))];
    expect(intervalsMs(sessionWork(turns)) / M).toBe(11);
  });

  it('keeps a session that holds only a permission you approved', () => {
    const permissionOnly = session(13, [
      ev('permission.requested', at(18, 9), { requestId: 'p' }),
      ev('permission.completed', at(18, 9) + 2_241, { requestId: 'p', decisionSource: 'human_response', result: { kind: 'approved' } }),
    ]);
    expect(permissionOnly?.requests).toEqual([]);
    const v = view(analyzer(permissionOnly), D18);
    expect([v.lanes.length, v.kpis.waits, v.kpis.answered, v.kpis.waitMs]).toEqual([1, 1, 1, 2_241]);
    // Only the Timeline shows it: the Sessions list stays as it was.
    const an = analyzer(permissionOnly, session(14, [prompt(at(18, 10)), reply(at(18, 10, 1))]));
    expect([an.getSessions(1, 50).total, an.getSessionDetail(sid(13))?.requests]).toEqual([1, []]);
  });
});

describe('relays and links', () => {
  it('counts a relayed answer no other session logged', () => {
    const an = analyzer(
      session(8, [prompt(at(17, 10)), reply(at(17, 10, 1))]),
      session(9, [prompt(at(18, 9), 8), start(at(18, 9, 1), 'r', 'relay_session_input'), end(at(18, 9, 3), 'r', '{"outcome":"answered_here"}'), reply(at(18, 9, 4))]),
    );
    expect(view(an, D18, only(D18)).fam.families[0].verdict).toBe('needed');
  });

  it('counts a relayed answer once, in the child that logged the same answer', () => {
    const an = analyzer(
      session(16, [prompt(at(18, 9)), start(at(18, 9, 2), 'r', 'relay_session_input'), end(at(18, 9, 5), 'r', '{"outcome":"answered_here"}'), reply(at(18, 9, 6))]),
      session(17, [prompt(at(18, 9, 1), 16), start(at(18, 9, 2)), end(at(18, 9, 5)), reply(at(18, 9, 7))]),
    );
    const v = view(an, D18);
    expect([v.kpis.answered, v.fam.families[0].childAnswered]).toEqual([1, 1]);
  });

  it('keeps a child’s creation time when its parent opens it again later', () => {
    const child = sid(12);
    const created = at(17, 14, 1);
    const an = analyzer(
      session(11, [prompt(at(17, 14)), start(created, 'c', 'create_session'), end(created + 200, 'c', `Created session 'X' (id: ${child})`), reply(created + 1000),
        start(created + 10 * M, 'o', 'open_pr_session'), end(created + 10 * M + 20, 'o', `Opened PR. Session ${child} is ready`), reply(created + 10 * M + 1000)]),
      session(12, [prompt(created + 300), reply(created + 1000)]),
    );
    expect(view(an, D17).kpis.childLanes).toBe(1);
  });
});

describe('families with one active member', () => {
  it('lists a known family even when only one of its members has activity in the range', () => {
    const an = analyzer(session(14, [prompt(at(17, 10)), reply(at(17, 10, 5))]), session(15, [prompt(at(18, 9), 14), reply(at(18, 9, 30))]));
    const family = view(an, D18, only(D18)).fam.families[0];
    expect([family.sessions, family.members]).toEqual([1, 2]);
  });
});

describe('fourth review: provenance, attestation and activity', () => {
  const perm = (t: number, id: string) => ev('permission.requested', t, { requestId: id });
  const allow = (t: number, id: string) => ev('permission.completed', t, { requestId: id, decisionSource: 'human_response', result: { kind: 'approved' } });

  it('labels a session that only holds a permission by its own client metadata (B1)', () => {
    writeFileSync(join(sessionDir(40), 'workspace.yaml'), 'client_name: github/cli\nname: Fixture name\nuser_named: true\nbranch: feature/example\n');
    // Both clients log `remoteSteerable`; only the sidecar names the CLI.
    const s = session(40, [perm(at(18, 8, 1), 'x'), allow(at(18, 8, 1) + 100, 'x')], at(18, 8), { remoteSteerable: false });
    expect([s?.harness, s?.requests.length, s?.displayName]).toEqual(['GitHub Copilot CLI', 0, 'Fixture name']);
    const an = analyzer(s);
    const lanes = (harness: string) => view(an, D18, { ...only(D18), harness }).lanes.length;
    expect([view(an, D18, only(D18)).lanes.length, lanes('GitHub Copilot CLI'), lanes('GitHub Copilot App')]).toEqual([1, 1, 0]);
  });

  it('does not let an unrelated permission elsewhere absorb a child’s relayed answer (B3)', () => {
    const an = analyzer(
      session(41, [prompt(at(18, 8)), reply(at(18, 8, 1))]),
      session(42, [prompt(at(18, 9), 41), start(at(18, 9, 1), 'r', 'relay_session_input'), end(at(18, 9, 3), 'r', '{"outcome":"answered_here"}'), reply(at(18, 9, 4))]),
      session(43, [prompt(at(18, 9)), perm(at(18, 9, 2), 'p'), allow(at(18, 9, 3) + 5000, 'p'), reply(at(18, 9, 4))]),
    );
    const v = view(an, D18, only(D18));
    expect([v.kpis.answered, v.fam.families[0].verdict]).toEqual([2, 'needed']);
  });

  it('counts a relay the same in the whole range and in its own day (B3)', () => {
    const an = analyzer(
      session(44, [prompt(at(17, 23, 50)), start(at(17, 23, 56), 'r', 'relay_session_input'), end(at(18) - 2000, 'r', '{"outcome":"answered_here"}'), reply(at(18) - 1000)]),
      session(45, [prompt(at(18)), perm(at(18) + 1000, 'p'), allow(at(18) + 3000, 'p'), reply(at(18) + 5000)]),
    );
    expect([view(an, D17).kpis.answered, view(an, D17, only(D17)).kpis.answered]).toEqual([1, 1]);
  });

  it('does not count a day that only lies inside an unanswered stop, even when a reply follows it (B4)', () => {
    const an = analyzer(session(46, [prompt(at(17, 23)), start(at(17, 23, 1)), end(at(19, 0, 10), 'q', 'The question was interrupted.'), reply(at(19, 0, 12))]));
    const v = view(an, D18, only(D18));
    expect([v.lanes.length, v.fam.totals.sessions]).toEqual([0, 0]);
    expect(formatTimeline(an, only(D18))).toMatchObject({ sessions: 0 });
    expect(buildSummaryExportFromAnalyzer(an, only(D18)).autonomy ?? null).toBeNull();
  });

  it('dates an answer known only from its human_response record at that record’s time (B5)', () => {
    const an = analyzer(session(47, [prompt(at(17, 23, 55)), start(at(17, 23, 57), 'late'), ev('hook.start', at(17, 23, 58), {}),
      ev('human_response.recorded', at(18) + M, { toolCallId: 'late' }), reply(at(18) + 2 * M)]));
    expect([view(an, D17).kpis.answered, view(an, D18).kpis.answered]).toEqual([0, 1]);
  });
});

describe('fourth review: wording and links', () => {
  it('says an answer ended a wait that began earlier, not that it took no time, when the day holds only its end (B13)', () => {
    const an = analyzer(session(52, [prompt(at(17, 23, 50)), start(at(17, 23, 58)), reply(at(17, 23, 58) + 1000), end(at(18))]));
    const v = view(an, D18, only(D18));
    expect([v.kpis.answered, v.kpis.waitMs]).toEqual([1, 0]);
    expect(v.waits).toContain('ended a wait that began earlier');
    expect(v.waits).not.toContain('no measurable time');
    const instant = analyzer(session(53, [prompt(at(18, 9)), start(at(18, 9, 1)), end(at(18, 9, 1)), reply(at(18, 9, 2))]));
    expect(view(instant, D18).waits).toContain('took no measurable time');
  });

  it('does not take a session that existed before it was opened for a new child (B6)', () => {
    const an = analyzer(
      session(48, [prompt(at(18, 13)), start(at(18, 13, 1), 'reuse', 'open_pr_session'), end(at(18, 13, 1) + 100, 'reuse', `Opened PR. Session ${sid(49)} is ready`)]),
      session(49, [prompt(at(18, 13, 1) - 20_000), reply(at(18, 13, 2))]),
    );
    expect(view(an, D18).kpis.childLanes).toBe(0);
  });

  it('links a session create_session made, timed by the app’s request, even when the call is logged when it completes (B6)', () => {
    const asked = at(18, 14);
    const an = analyzer(
      session(50, [prompt(at(18, 13, 59)), ev('external_tool.requested', asked, { toolName: 'create_session', toolCallId: 'c' }),
        start(asked + 100_000, 'c', 'create_session'), end(asked + 100_100, 'c', `Created session 'X' (id: ${sid(51)})`), reply(asked + 101_000)]),
      session(51, [prompt(asked + 1_000), reply(asked + 60_000)]),
    );
    expect(view(an, D18).kpis.childLanes).toBe(1);
  });
});

describe('fifth review: your answer’s own clock (C1)', () => {
  const human = (t: number, id = 'q') => ev('human_response.recorded', t, { toolCallId: id, requestId: 'u', response: { answer: 'Yes' } });
  const mid = at(18);
  const answeredOn = (an: Analyzer) => [view(an, D17, only(D17)).kpis.answered, view(an, D18, only(D18)).kpis.answered];

  it('dates an answer by the human record, not by the result logged after midnight', () => {
    const an = analyzer(session(60, [prompt(mid - 65 * M), start(mid - 60 * M), human(mid - 1000), end(mid + 1000), reply(mid + 6000)]));
    expect(answeredOn(an)).toEqual([1, 0]);
  });

  it('dates an answer recorded before its request was even logged by the record', () => {
    const an = analyzer(session(61, [prompt(mid - 65 * M), human(mid - 1000), start(mid + 1000), end(mid + 1000), reply(mid + 6000)]));
    expect(answeredOn(an)).toEqual([1, 0]);
  });

  it('ends an unattended stretch at the recorded answer, not at a later zero-length result', () => {
    const t = at(18, 1);
    const an = analyzer(session(62, [prompt(t), human(t + 5 * M), start(t + 10 * M), end(t + 10 * M), reply(t + 20 * M)]));
    expect(view(an, D18).kpis.unattendedMs).toBe(15 * M);
  });

  it('does not count as waiting a question whose answer was recorded before it was asked, and still counts the answer', () => {
    const t = at(18, 9);
    const an = analyzer(session(63, [prompt(t), human(t + M), start(t + 2 * M), end(t + 5 * M), reply(t + 6 * M)]));
    const v = view(an, D18);
    expect([v.kpis.answered, v.kpis.waits, v.kpis.waitMs]).toEqual([1, 0, 0]);
    // The stop still isn't agent work.
    expect(v.kpis.agentMs).toBe(3 * M);
  });

  it('keeps a measured wait on the tool’s clock when the answer falls inside it', () => {
    const t = at(18, 9);
    const an = analyzer(session(64, [prompt(t), start(t + M), human(t + 4 * M), end(t + 4 * M + 500), reply(t + 6 * M)]));
    expect([view(an, D18).kpis.waits, view(an, D18).kpis.waitMs]).toEqual([1, 3 * M + 500]);
  });

  it('puts a child’s answer, its family’s verdict, the chat tool and the export on the date of the human record', () => {
    const parent = session(65, [prompt(mid - 80 * M), reply(mid - 79 * M)]);
    const child = session(66, [prompt(mid - 65 * M, 65), start(mid - M), human(mid - 1000), end(mid + 1000), reply(mid + 1500)]);
    const surfaces = (day: string) => {
      const an = analyzer(parent, child);
      const f = buildFamilies(prepareTimeline(an.getTimelineData(only(day)))).totals;
      const chat = formatTimeline(an, only(day), day) as { day?: { questionsAndPermissionsAnswered?: number } };
      const exported = buildSummaryExportFromAnalyzer(an, only(day)).autonomy;
      return [f.childAnswered, f.needed.families, chat.day?.questionsAndPermissionsAnswered ?? 0,
        exported?.questionsAndPermissionsAnswered ?? 0, exported?.childSessionsWithYourInput ?? 0];
    };
    expect([surfaces(D17), surfaces(D18)]).toEqual([[1, 1, 1, 1, 1], [0, 0, 0, 0, 0]]);
  });
});
describe('fifth review: relays paired by request (C7)', () => {
  const relay = (t: number, id: string, requestId: string) => [
    ev('tool.execution_start', t - 1000, { toolName: 'relay_session_input', toolCallId: id, arguments: { request_id: requestId } }),
    end(t, id, '{"outcome":"answered_in_session"}'),
  ];
  const human = (t: number, id: string, requestId: string) => ev('human_response.recorded', t, { toolCallId: id, requestId, response: { answer: 'Yes' } });

  it('pairs each relay with the child answer for the same request before trying the nearest one', () => {
    const t = at(18, 10);
    const an = analyzer(
      session(70, [prompt(t - 2 * M), ...relay(t, 'r1', 'one'), ...relay(t + 9000, 'r2', 'two'), reply(t + 10_000)]),
      session(71, [prompt(t - M, 70), start(t - 10_000, 'a'), human(t - 9000, 'a', 'one'), end(t - 9000, 'a'), reply(t - 8900)]),
      session(72, [prompt(t - M + 1, 70), start(t - 500, 'b'), human(t, 'b', 'two'), end(t, 'b'), reply(t + 100)]),
    );
    expect(view(an, D18).kpis.answered).toBe(2);
  });

  it('still pairs a relay that logged no request ID by time', () => {
    const t = at(18, 11);
    const an = analyzer(
      session(73, [prompt(t - 2 * M), start(t - 1000, 'r', 'relay_session_input'), end(t, 'r', '{"outcome":"answered_in_session"}'), reply(t + 1000)]),
      session(74, [prompt(t - M, 73), start(t - 500, 'a'), end(t, 'a'), reply(t + 100)]),
    );
    expect(view(an, D18).kpis.answered).toBe(1);
  });

  it('does not pair a relay with a child answer logged for a different request', () => {
    const t = at(18, 12);
    const an = analyzer(
      session(75, [prompt(t - 2 * M), ...relay(t, 'r', 'one'), reply(t + 1000)]),
      session(76, [prompt(t - M, 75), start(t - 500, 'a'), human(t, 'a', 'other'), end(t, 'a'), reply(t + 100)]),
    );
    expect(view(an, D18).kpis.answered).toBe(2);
  });
});
describe('fifth review: when a parent requested its child (C2)', () => {
  it('draws the connector from the earlier of the parent’s two records, whichever order they are logged in', () => {
    const asked = at(18, 15);
    const child = sid(78);
    const an = analyzer(
      session(77, [prompt(asked - M), start(asked, 'c', 'create_session'),
        ev('external_tool.requested', asked + 31_000, { toolName: 'create_session', toolCallId: 'c' }),
        end(asked + 31_001, 'c', `Created session 'X' (id: ${child})`), reply(asked + 32_000)]),
      session(78, [prompt(asked + 32_000), reply(asked + 60_000)]),
    );
    const s = an.getTimelineData().sessions.find(x => x.id === child);
    expect([s?.via, s?.created]).toEqual(['create', asked]);
  });
});
describe('fifth review: one repository basis (C8)', () => {
  it('names the same repository in the Families row and the chat tool when the coordinator is outside the range', () => {
    const repo = (s: Session | null, name: string) => (s ? { ...s, repository: name } : null);
    const an = analyzer(
      repo(session(80, [prompt(at(16, 9)), reply(at(16, 9, 5))]), 'coordinator-repo'),
      repo(session(81, [prompt(at(18, 9), 80), reply(at(18, 9, 30))]), 'first-child-repo'),
      repo(session(82, [prompt(at(18, 10), 80), reply(at(18, 10, 5))]), 'second-child-repo'),
    );
    const p = prepareTimeline(an.getTimelineData(only(D18)));
    const family = buildFamilies(p).families[0];
    const namer = createNamer(p, true);
    const chat = formatTimeline(an, only(D18)) as { families?: { top?: { repository: string; repositories: number }[] } };
    expect(chat.families?.top?.[0]).toMatchObject({ repository: namer.repo(family.repoSession), repositories: 2 });
    expect(namer.repo(family.repoSession)).not.toBe(namer.repo(family.s));
  });
});
// Sixth review: one input per decision, half-open ranges, answers kept by their own time.
const mid6 = at(18);
const t6 = mid6 + 60 * M;
const human6 = (time: number, id: string, requestId: string) => ev('human_response.recorded', time, { toolCallId: id, requestId, response: { answer: 'Yes' } });
const relayStart6 = (time: number, id: string, requestId: string) => ev('tool.execution_start', time, { toolName: 'relay_session_input', toolCallId: id, arguments: { request_id: requestId } });
const perm6 = (time: number, id: string) => ev('permission.requested', time, { requestId: id });
const decided6 = (time: number, id: string) => ev('permission.completed', time, { requestId: id, decisionSource: 'human_response', result: { kind: 'approved' } });
const record6 = (time: number, id: string) => ev('human_response.recorded', time, { requestId: id, response: { answer: 'Yes' } });
function surfaces6(an: Analyzer, day: string) {
  const v = view(an, day, only(day));
  const chat = formatTimeline(an, only(day), day) as { sessions?: number; day?: { questionsAndPermissionsAnswered?: number } };
  return [v.p.sessions.filter(s => !s.ctx).length, v.lanes.length, v.kpis.answered, chat.sessions ?? 0, buildSummaryExportFromAnalyzer(an, only(day)).autonomy ?? null];
}

describe('sixth review: one input per decision, half-open ranges', () => {

  it('ends an unattended stretch once for a relayed answer and the child’s own record of it (E1)', () => {
    for (const [i, relayAt] of [[90, t6 + 14 * M], [92, t6 + M]] as const) {
      const an = analyzer(
        session(i, [prompt(t6), relayStart6(relayAt, 'relay', `same-${i}`), end(t6 + 15 * M, 'relay', '{"outcome":"answered_in_session"}'), reply(t6 + 30 * M)]),
        session(i + 1, [prompt(t6 + 100, i), start(t6 + 5 * M - 1, 'own'), human6(t6 + 5 * M, 'own', `same-${i}`), end(t6 + 5 * M, 'own'), reply(t6 + 30 * M)]),
      );
      expect([view(an, D18).kpis.answered, view(an, D18).kpis.unattendedMs]).toEqual([1, 25 * M]);
    }
  });

  it('does not make a day active with a stop that only ends at its midnight after an answer the day before (E2)', () => {
    const an = analyzer(session(94, [perm6(mid6 - M, 'p'), record6(mid6 - 1000, 'p'), decided6(mid6, 'p')]));
    expect(surfaces6(an, D18)).toEqual([0, 0, 0, 0, null]);
  });

  it('does not make the days between an answer and a later replayed request active (E2)', () => {
    const an = analyzer(session(95, [ev('session.info', mid6 - 2 * 86_400_000, {}), record6(mid6 - 86_400_001, 'p2'), perm6(mid6 + 86_400_000 + 1000, 'p2'), decided6(mid6 + 86_400_000 + 1001, 'p2')]));
    expect(surfaces6(an, D18).slice(0, 4)).toEqual([0, 0, 0, 0]);
  });

});

describe('sixth review: answers kept by their own time', () => {
  it('counts an answer recorded before its own turn’s prompt in a one-day query as in the whole range (E3)', () => {
    const an = analyzer(session(96, [prompt(mid6 + 1000), human6(mid6 - 1000, 'late', 'r2'), start(mid6 + 1200, 'late'), end(mid6 + 1200, 'late'), reply(mid6 + 2000)]));
    expect([view(an, D17).kpis.answered, view(an, D17, only(D17)).kpis.answered]).toEqual([1, 1]);
  });

  it('keeps an answer recorded after its result and a later prompt, on every surface (E3)', () => {
    const coordinator = session(97, [prompt(mid6 - 8 * M), reply(mid6 - 7 * M), prompt(mid6 + 3 * M), reply(mid6 + 4 * M)]);
    const child = session(98, [prompt(mid6 - 4 * M, 97), start(mid6 - 3 * M, 'first'), end(mid6 - 2 * M, 'first'), reply(mid6 - 90_000), prompt(mid6 - M), reply(mid6 - 1000),
      human6(mid6 + 1000, 'first', 'r4'), prompt(mid6 + M, 97), reply(mid6 + 2 * M)]);
    const an = analyzer(coordinator, child);
    const totals = buildFamilies(prepareTimeline(an.getTimelineData(only(D18)))).totals;
    const chat = formatTimeline(an, only(D18), D18) as { day?: { questionsAndPermissionsAnswered?: number } };
    expect([view(an, D18).kpis.answered, view(an, D18, only(D18)).kpis.answered, totals.childrenNeedingYou, totals.needed.families,
      chat.day?.questionsAndPermissionsAnswered, buildSummaryExportFromAnalyzer(an, only(D18)).autonomy?.questionsAndPermissionsAnswered]).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it('says an answer had no waiting time measured, not that it took none, when it was recorded before its question (E7)', () => {
    const an = analyzer(session(99, [prompt(at(18, 9)), human6(at(18, 9, 1), 'q', 'r'), start(at(18, 9, 3)), end(at(18, 9, 3)), reply(at(18, 9, 4))]));
    expect(view(an, D18).waits).toContain('had no waiting time measured in this period');
    expect(view(an, D18).waits).not.toContain('no measurable time');
  });

  it('does not say an answer recorded after midnight ended a wait that had already ended the day before (E7)', () => {
    const an = analyzer(session(100, [prompt(mid6 - 10 * M), start(mid6 - 5 * M), end(mid6 - 2 * M), reply(mid6 - M), human6(mid6 + 1000, 'q', 'r')]));
    const waits = view(an, D18, only(D18)).waits;
    expect(waits).toContain('had no waiting time measured in this period');
    expect(waits).not.toContain('ended a wait');
  });
});
