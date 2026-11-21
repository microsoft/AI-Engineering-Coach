/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Custom ranges: the calendar math, and a range read end to end from synthetic Copilot logs, which must equal its days
 * put together and the summary export of the same dates, also over a daylight-saving change. */

import { afterAll, describe, expect, it } from 'vitest';
import { analyzer, end, prompt, removeTimelineSessions, reply, session, start } from '../test/timeline-cli';
import { buildSummaryExportFromAnalyzer } from './summary-export';
import { buildLanes, buildViewFamilies, prepareTimeline, timelineKpis, timelineWindow, type TimelineKpis } from './timeline-model';
import {
  clampRange, isDate, MAX_RANGE_DAYS, monthCells, quickRange, rangeDays, rangeTicks, rangeWindow, shiftDate, shiftDateByMonths, shiftMonth,
  stepRange, type DateRange,
} from './timeline-range';
import type { Analyzer } from './analyzer';

afterAll(removeTimelineSessions);

/** Runs `body` with the machine in `zone`, whatever zone the test runs in. */
function inZone(zone: string, body: () => void): void {
  const saved = process.env.TZ;
  process.env.TZ = zone;
  try {
    body();
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
}

describe('date ranges', () => {
  it('reads only real dates', () => {
    expect(['2026-11-17', '2026-02-29', '2028-02-29', '2026-13-01', '17/11/2026', 20261117].map(isDate)).toEqual([true, false, true, false, false, false]);
  });

  it('orders, keeps within the loaded days and cuts a range to its longest', () => {
    expect(clampRange('2026-11-20', '2026-11-17', '2026-11-01', '2026-11-30')).toEqual({ range: { from: '2026-11-17', to: '2026-11-20' }, capped: false });
    expect(clampRange('2026-10-20', '2026-12-20', '2026-11-01', '2026-11-30')?.range).toEqual({ from: '2026-11-01', to: '2026-11-30' });
    expect(clampRange('2026-10-01', '2026-10-20', '2026-11-01', '2026-11-30')).toBeNull();
    const long = clampRange('2026-01-01', '2026-12-31', '2026-01-01', '2026-12-31');
    expect([long?.capped, long && rangeDays(long.range)]).toEqual([true, MAX_RANGE_DAYS]);
  });

  it('steps a range by its own length, stops at the loaded days keeping its length, then no further', () => {
    const r: DateRange = { from: '2026-11-10', to: '2026-11-12' };
    expect(stepRange(r, 1, '2026-11-01', '2026-11-30')).toEqual({ from: '2026-11-13', to: '2026-11-15' });
    expect(stepRange(r, -1, '2026-11-01', '2026-11-30')).toEqual({ from: '2026-11-07', to: '2026-11-09' });
    expect(stepRange({ from: '2026-11-27', to: '2026-11-29' }, 1, '2026-11-01', '2026-11-30')).toEqual({ from: '2026-11-28', to: '2026-11-30' });
    expect(stepRange({ from: '2026-11-28', to: '2026-11-30' }, 1, '2026-11-01', '2026-11-30')).toBeNull();
    expect(stepRange({ from: '2026-11-01', to: '2026-11-03' }, -1, '2026-11-01', '2026-11-30')).toBeNull();
  });

  it('makes the quick picks end on the given day', () => {
    expect(quickRange('last7', '2026-11-17')).toEqual({ from: '2026-11-11', to: '2026-11-17' });
    expect(rangeDays(quickRange('last30', '2026-03-01'))).toBe(30);
    expect(quickRange('month', '2026-11-17')).toEqual({ from: '2026-11-01', to: '2026-11-17' });
  });

  it('lays a month out in six Monday-to-Sunday weeks', () => {
    const cells = monthCells('2026-02');
    expect([cells.length, cells[0], cells[6], cells[41]]).toEqual([42, '2026-01-26', '2026-02-01', '2026-03-08']);
    expect([shiftMonth('2026-12', 1), shiftMonth('2026-01', -1), shiftDateByMonths('2026-01-31', 1), shiftDateByMonths('2026-03-15', -1)])
      .toEqual(['2027-01', '2025-12', '2026-02-28', '2026-02-15']);
  });

  it('draws few enough ticks for any length: hours over 2–3 days, days, every other day, then Mondays', () => {
    const ticks = (from: string, days: number) => rangeTicks(...rangeWindow({ from, to: shiftDate(from, days - 1) }));
    expect(ticks('2026-11-16', 2).map(([, label]) => label).filter(l => l.endsWith(':00'))).toEqual(['6:00', '12:00', '18:00', '6:00', '12:00', '18:00']);
    expect(ticks('2026-11-16', 10)).toHaveLength(10);
    expect(ticks('2026-11-01', 30)).toHaveLength(15);
    const quarter = ticks('2026-09-01', MAX_RANGE_DAYS);
    expect([quarter.length <= 14, quarter.every(([t]) => new Date(t).getDay() === 1)]).toEqual([true, true]);
  });

  // Each zone with its own transitions, whatever the machine's zone.
  for (const [zone, spring, autumn] of [['Europe/Berlin', '2026-03-29', '2026-10-25'], ['America/New_York', '2026-03-08', '2026-11-01']] as const) {
    it(`steps whole calendar days over daylight-saving changes in ${zone}`, () => inZone(zone, () => {
      for (const [day, hours] of [[spring, 3 * 24 - 1], [autumn, 3 * 24 + 1]] as const) {
        const r = { from: shiftDate(day, -1), to: shiftDate(day, 1) };
        const [a, b] = rangeWindow(r);
        // Its days, put end to end, are exactly the range.
        const days = [r.from, day, r.to].map(d => timelineWindow('day', d));
        expect([rangeDays(r), (b - a) / 3_600_000, days[0][0] === a && days[0][1] === days[1][0] && days[1][1] === days[2][0] && days[2][1] === b])
          .toEqual([3, hours, true]);
      }
    }));
  }
});

const ADDITIVE = ['agentMs', 'waitMs', 'waits', 'idleWaits', 'longWaits', 'answered', 'typed', 'turns'] as const;

function kpisOf(an: Analyzer, [from, to]: [number, number]): TimelineKpis {
  const p = prepareTimeline(an.getTimelineData());
  const lanes = buildLanes(p, from, to);
  return timelineKpis(lanes, buildViewFamilies(lanes, p));
}

/** The range's additive values next to the sum of its days, and the summary export of the same dates. */
function compare(an: Analyzer, r: DateRange) {
  const whole = kpisOf(an, rangeWindow(r));
  const days = Array.from({ length: rangeDays(r) }, (_, i) => kpisOf(an, timelineWindow('day', shiftDate(r.from, i))));
  const sum = Object.fromEntries(ADDITIVE.map(k => [k, days.reduce((n, d) => n + d[k], 0)]));
  const out = buildSummaryExportFromAnalyzer(an, { fromDate: r.from, toDate: r.to }).autonomy;
  return {
    whole: Object.fromEntries(ADDITIVE.map(k => [k, whole[k]])), sum,
    exported: [out?.typedTurns, out?.automatedTurns, out?.agentHours, out?.waitsOnYou, out?.questionsAndPermissionsAnswered, out?.waitHours],
    expected: [whole.typed, whole.turns - whole.typed, Math.round(whole.agentMs / 360_000) / 10, whole.waits, whole.answered, Math.round(whole.waitMs / 360_000) / 10],
  };
}

describe('a custom range of days', () => {
  it('equals its days put together and the summary export of the same dates', () => {
    const t = (day: number, h: number, m = 0) => new Date(2026, 10, day, h, m).getTime();
    const an = analyzer(
      session(1, [prompt(t(16, 22)), reply(t(16, 23, 30)), prompt(t(17, 0, 20)), start(t(17, 0, 25)), end(t(17, 0, 40)), reply(t(17, 1))]),
      session(2, [prompt(t(17, 23), 1), reply(t(18, 2))]),
      session(3, [prompt(t(18, 10)), reply(t(18, 10, 30)), prompt(t(18, 11)), reply(t(18, 11, 5))]),
    );
    const c = compare(an, { from: '2026-11-16', to: '2026-11-18' });
    expect(c.whole).toEqual(c.sum);
    expect(c.whole.agentMs).toBeGreaterThan(0);
    expect(c.exported).toEqual(c.expected);
    // A range inside it: the same rules, cut at its own midnights.
    const inner = compare(an, { from: '2026-11-17', to: '2026-11-18' });
    expect([inner.whole, inner.exported]).toEqual([inner.sum, inner.expected]);
  });

  for (const [zone, day] of [['Europe/Berlin', 29], ['America/New_York', 8]] as const) {
    it(`equals its days put together over the spring change in ${zone}`, () => inZone(zone, () => {
      const t = (d: number, h: number, m = 0) => new Date(2026, 2, d, h, m).getTime();
      const an = analyzer(
        session(11, [prompt(t(day - 1, 23)), reply(t(day, 4))]),
        session(12, [prompt(t(day, 1, 30)), reply(t(day, 3, 30)), prompt(t(day, 4)), reply(t(day, 4, 10))]),
      );
      const date = `2026-03-${String(day).padStart(2, '0')}`;
      const r = { from: shiftDate(date, -1), to: shiftDate(date, 1) };
      const c = compare(an, r);
      expect([c.whole, c.exported]).toEqual([c.sum, c.expected]);
      // 23:00 to 04:00 across the skipped hour is 4 h of work, and 1:30 to 3:30 is one.
      expect(c.whole.agentMs).toBe((4 + 1 + 1 / 6) * 3_600_000);
    }));
  }
});
