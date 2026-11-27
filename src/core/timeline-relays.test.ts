/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* A relayed answer is the same decision as the child's own record of it, in every range: end to end from synthetic
 * Copilot logs. */

import { afterAll, describe, expect, it } from 'vitest';
import { formatTimeline } from '../mcp/formatters';
import { D17, D18, M, analyzer, end, ev, only, prompt, removeTimelineSessions, reply, session, start, view } from '../test/timeline-cli';
import type { Analyzer } from './analyzer';
import { buildSummaryExportFromAnalyzer } from './summary-export';
import { buildFamilies, buildLanes, buildViewFamilies, prepareTimeline, timelineKpis, timelineWindow } from './timeline-model';
import type { DateFilter } from './types';

afterAll(removeTimelineSessions);
describe('seventh review: a relayed decision stays one input whatever the range (G1, G2)', () => {
  const mid = new Date(2026, 10, 18).getTime();
  const human = (time: number, id: string, requestId: string) => ev('human_response.recorded', time, { toolCallId: id, requestId, response: { answer: 'Yes' } });
  const relay = (time: number, id: string, requestId?: string) => ev('tool.execution_start', time, { toolName: 'relay_session_input', toolCallId: id, ...(requestId ? { arguments: { request_id: requestId } } : {}) });
  const day = (an: Analyzer, d: string, f?: DateFilter) => {
    const v = view(an, d, f);
    return [v.kpis.answered, v.kpis.unattendedMs];
  };

  // The child answers before midnight (and, in some cases, gets a typed prompt after it); its parent delivers the same
  // decision after midnight; both work on to 00:30.
  const cases = [
    { n: 110, answer: -5 * M, relayStart: -6 * M, relayEnd: 3 * M, typedAfter: -3 * M, withId: true },
    { n: 120, answer: -5 * M, relayStart: -6 * M, relayEnd: 3 * M, typedAfter: 0, withId: true },
    { n: 130, answer: -5000, relayStart: -6000, relayEnd: 2000, typedAfter: -3000, withId: true },
    { n: 140, answer: -5000, relayStart: -6000, relayEnd: 2000, typedAfter: -3000, withId: false },
    { n: 150, answer: -5000, relayStart: -6000, relayEnd: 2000, typedAfter: 0, withId: false },
  ];
  it.each(cases)('gives one answer, on the child’s day, in every range and surface (case $n)', ({ n, answer, relayStart, relayEnd, typedAfter, withId }) => {
    const parent = session(n, [prompt(mid - 20 * M), relay(mid + relayStart, 'relay', withId ? 'request' : undefined),
      end(mid + relayEnd, 'relay', '{"outcome":"answered_in_session"}'), reply(mid + 30 * M)]);
    const child = session(n + 1, [prompt(mid - 19 * M, n), start(mid + answer - 1000, 'child'), human(mid + answer, 'child', 'request'), end(mid + answer, 'child'),
      reply(mid + answer + 100), ...(typedAfter ? [prompt(mid + typedAfter)] : []), reply(mid + 30 * M)]);
    const an = analyzer(parent, child);
    const chat = formatTimeline(an, only(D18), D18) as { day?: { questionsAndPermissionsAnswered?: number } };
    expect([day(an, D18), day(an, D18, only(D18)), chat.day?.questionsAndPermissionsAnswered ?? 0,
      buildSummaryExportFromAnalyzer(an, only(D18)).autonomy?.questionsAndPermissionsAnswered ?? 0]).toEqual([[0, 30 * M], [0, 30 * M], 0, 0]);
    expect([view(an, D17, only(D17)).kpis.answered, view(an, D17, { fromDate: D17, toDate: D18 }).kpis.answered]).toEqual([1, 1]);
    const p = prepareTimeline(an.getTimelineData({ fromDate: D17, toDate: D18 }));
    expect(timelineKpis(buildLanes(p, ...timelineWindow('week', D18)), buildViewFamilies(buildLanes(p, ...timelineWindow('week', D18)), p)).answered).toBe(1);
  });

  it('keeps a nested family’s verdict for the day the relay delivered the child’s answer (G1)', () => {
    const top = session(160, [prompt(mid - 25 * M), reply(mid + 30 * M)]);
    const parent = session(161, [prompt(mid - 20 * M, 160), relay(mid - 6 * M, 'relay', 'request'), end(mid + 3 * M, 'relay', '{"outcome":"answered_in_session"}'), reply(mid + 30 * M)]);
    const child = session(162, [prompt(mid - 19 * M, 161), start(mid - 5 * M - 1000, 'child'), human(mid - 5 * M, 'child', 'request'), end(mid - 5 * M, 'child'),
      reply(mid - 5 * M + 100), prompt(mid - 3 * M), reply(mid + 30 * M)]);
    const an = analyzer(top, parent, child);
    const totals = buildFamilies(prepareTimeline(an.getTimelineData(only(D18)))).totals;
    expect([totals.childAnswered, totals.needed.families, buildSummaryExportFromAnalyzer(an, only(D18)).autonomy?.childSessionsWithYourInput ?? 0]).toEqual([0, 0, 0]);
  });

  it('does not open a day for a relay that only delivered an answer given the day before (G2)', () => {
    const parent = session(170, [ev('session.info', mid - 20 * M, {}), relay(mid + 1000, 'delivery', 'r170'), end(mid + 1000, 'delivery', '{"outcome":"answered_in_session"}')]);
    const child = session(171, [prompt(mid - 4 * M, 170), start(mid - 1100, 'direct'), human(mid - 1000, 'direct', 'r170'), end(mid - 1000, 'direct'), reply(mid - 900)]);
    const an = analyzer(parent, child);
    const v = view(an, D18, only(D18));
    const chat = formatTimeline(an, only(D18), D18) as { sessions?: number };
    expect([v.p.sessions.filter(s => !s.ctx).length, v.p.days, v.lanes.length, chat.sessions ?? 0, buildSummaryExportFromAnalyzer(an, only(D18)).autonomy ?? null])
      .toEqual([0, [], 0, 0, null]);
  });
});
describe('eighth review: a paired relay keeps its blocked time in every range (H1, H2)', () => {
  const mid = new Date(2026, 10, 18).getTime();
  const human = (time: number, id: string, requestId: string) => ev('human_response.recorded', time, { toolCallId: id, requestId, response: { answer: 'Yes' } });
  const relay = (time: number, id: string, requestId: string) => ev('tool.execution_start', time, { toolName: 'relay_session_input', toolCallId: id, arguments: { request_id: requestId } });
  const two: DateFilter = { fromDate: D17, toDate: D18 };
  // The coordinator is stopped on the relay from 23:46 to 00:14; the child's answer, recorded at 00:13:59, is the decision.
  const pair = () => analyzer(
    session(200, [prompt(mid - 20 * M), relay(mid - 14 * M, 'r', 'req'), end(mid + 14 * M, 'r', '{"outcome":"answered_in_session"}')]),
    session(201, [prompt(mid - 19 * M, 200), start(mid + 13 * M, 'q'), human(mid + 14 * M - 1000, 'q', 'req'), end(mid + 14 * M - 1000, 'q'), reply(mid + 14 * M)]),
  );
  const minutes = (an: Analyzer, f: DateFilter, day: string) =>
    (formatTimeline(an, f, day) as { day?: { waitsOnUser?: { minutes?: number } } }).day?.waitsOnUser?.minutes;

  it('gives the same waiting, lanes and answers for a Day opened fresh or from a wider range, in the browser and the chat tool', () => {
    const an = pair();
    const fresh = view(an, D18, only(D18));
    const wide = view(an, D18, two);
    expect([fresh.kpis.waitMs, fresh.lanes.length, fresh.kpis.answered]).toEqual([wide.kpis.waitMs, wide.lanes.length, wide.kpis.answered]);
    // Both sessions waited on the one question: the coordinator from 00:00 and the child from 00:13.
    expect([fresh.lanes.length, fresh.kpis.answered]).toEqual([2, 1]);
    expect(minutes(an, only(D18), D18)).toBe(Math.round(fresh.kpis.waitMs / M));
  });

  it('adds the days up to the range: waiting to the millisecond, and the exports', () => {
    const an = pair();
    const days = view(an, D17, only(D17)).kpis.waitMs + view(an, D18, only(D18)).kpis.waitMs;
    const p = prepareTimeline(an.getTimelineData(two));
    const week = buildLanes(p, ...timelineWindow('week', D18));
    expect(timelineKpis(week, buildViewFamilies(week, p)).waitMs).toBe(days);
    const hours = (f: DateFilter) => buildSummaryExportFromAnalyzer(an, f).autonomy?.waitHours ?? 0;
    expect(Math.abs(hours(only(D17)) + hours(only(D18)) - hours(two))).toBeLessThanOrEqual(0.1);
    expect(hours(two)).toBe(Math.round(days / 360_000) / 10);
  });

  it('keeps two relays with the same times as two decisions when only one was delivered by a child (H2)', () => {
    const t = mid + 10 * 60 * M;
    const an = analyzer(
      session(210, [prompt(t), relay(t + M, 'r1', 'one'), end(t + 3 * M, 'r1', '{"outcome":"answered_in_session"}'),
        relay(t + M, 'r2', 'two'), end(t + 3 * M, 'r2', '{"outcome":"answered_here"}'), reply(t + 4 * M)]),
      session(211, [prompt(t + 10, 210), start(t + 2 * M, 'q'), human(t + 3 * M - 500, 'q', 'one'), end(t + 3 * M - 500, 'q'), reply(t + 3 * M)]),
    );
    expect(view(an, D18).kpis.answered).toBe(2);
  });
});
describe('ninth review: a stop before the first prompt in every range (I1)', () => {
  const mid = new Date(2026, 10, 18).getTime();
  const two: DateFilter = { fromDate: D17, toDate: D18 };
  const ask = (time: number) => ev('permission.requested', time, { requestId: 'p' });
  const decide = (time: number) => ev('permission.completed', time, { requestId: 'p', decisionSource: 'human_response', result: { kind: 'approved' } });
  // The permission is asked at `asked`, decided at `decided`, and the session's first prompt only comes after it.
  const run = (i: number, asked: number, decided: number) =>
    analyzer(session(i, [ask(asked), decide(decided), prompt(decided + M), reply(decided + 2 * M)], asked - 1000));
  const sameDay = (an: Analyzer, day: string) => {
    const fresh = view(an, day, only(day)).kpis;
    const wide = view(an, day, two).kpis;
    return [[fresh.waitMs, fresh.waits, fresh.sessions], [wide.waitMs, wide.waits, wide.sessions]];
  };

  it('counts the part of the wait before midnight on the earlier day, opened fresh or from a wider range, in chat and the export', () => {
    const an = run(220, mid - 90_000, mid + 30_000);
    const [fresh, wide] = sameDay(an, D17);
    expect(fresh).toEqual(wide);
    expect(fresh).toEqual([90_000, 1, 1]);
    const chat = formatTimeline(an, only(D17), D17) as { observed?: { sessions?: number }; day?: { sessions?: number } };
    expect([chat.observed?.sessions, chat.day?.sessions, buildSummaryExportFromAnalyzer(an, only(D17)).autonomy?.waitsOnYou]).toEqual([1, 1, 1]);
    const p = prepareTimeline(an.getTimelineData(two));
    const week = buildLanes(p, ...timelineWindow('week', D18));
    expect(timelineKpis(week, buildViewFamilies(week, p)).waitMs).toBe(view(an, D17, only(D17)).kpis.waitMs + view(an, D18, only(D18)).kpis.waitMs);
  });

  it('keeps the whole wait on the earlier day when it was decided before midnight, and none when it was asked at midnight', () => {
    const before = run(221, mid - 3 * M, mid - M);
    expect(sameDay(before, D17)).toEqual([[2 * M, 1, 1], [2 * M, 1, 1]]);
    const atMidnight = run(222, mid, mid + M);
    expect(sameDay(atMidnight, D17)).toEqual([[0, 0, 0], [0, 0, 0]]);
  });
});