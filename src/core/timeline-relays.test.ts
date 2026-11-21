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