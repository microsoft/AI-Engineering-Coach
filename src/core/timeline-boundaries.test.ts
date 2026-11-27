/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Window, day-boundary and input rules end to end: Copilot event logs → parser → analyzer → Timeline model and export.
 * Each case is a small synthetic log written to a temp dir. */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Analyzer } from './analyzer';
import { parseCLIEventsFile } from './parser-vscode-cli';
import { buildSummaryExportFromAnalyzer } from './summary-export';
import {
  buildFamilies, buildLanes, buildViewFamilies, createNamer, hourTicks, prepareTimeline, timelineKpis, timelineWindow,
  verdictText, viewInsights,
} from './timeline-model';
import type { DateFilter, Session } from './types';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aec-timeline-bounds-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }));

const M = 60_000;
const DAY = '2026-11-17';
const NEXT = '2026-11-18';
const when = (h: number, m: number, d = 17) => new Date(2026, 10, d, h, m).getTime();
const sid = (i: number) => 'abcd0000-0000-4000-8000-' + String(i).padStart(12, '0');
type Ev = { type: string; timestamp: string; data: Record<string, unknown> };
const ev = (type: string, t: number, data: Record<string, unknown>): Ev => ({ type, timestamp: new Date(t).toISOString(), data });
const user = (t: number, relayedFrom?: number) => ev('user.message', t, {
  content: 'Fixture',
  ...(relayedFrom ? { transformedContent: `<cross_session_message>\nfrom_session_id: ${sid(relayedFrom)}\n</cross_session_message>\nFixture` } : {}),
});
const reply = (t: number) => ev('assistant.message', t, { content: 'OK' });
const question = (t: number, e: number, result = 'User selected: Yes') => [
  ev('tool.execution_start', t, { toolCallId: 'q' + t, toolName: 'ask_user' }),
  ev('tool.execution_complete', e, { toolCallId: 'q' + t, success: true, result: { content: result } }),
];
const permission = (t: number, e: number) => [
  ev('permission.requested', t, { requestId: 'p' + t }),
  ev('permission.completed', e, { requestId: 'p' + t, decisionSource: 'human_response', result: { kind: 'approved' } }),
];

function session(i: number, events: Ev[]): Session {
  const dir = path.join(root, sid(i));
  fs.mkdirSync(dir, { recursive: true });
  const all = [ev('session.start', when(0, 0), { sessionId: sid(i) }), ...events.sort((a, b) => a.timestamp.localeCompare(b.timestamp))];
  const file = path.join(dir, 'events.jsonl');
  fs.writeFileSync(file, all.map(x => JSON.stringify(x)).join('\n'));
  const parsed = parseCLIEventsFile(file, 'ws', 'synthetic');
  if (!parsed) throw new Error('fixture did not parse');
  return parsed;
}

const analyzer = (...sessions: Session[]) => new Analyzer(sessions, new Map());
const model = (an: Analyzer, f?: DateFilter) => prepareTimeline(an.getTimelineData(f));
function kpis(an: Analyzer, date: string, view: 'day' | 'week' = 'day', f?: DateFilter) {
  const p = model(an, f);
  const lanes = buildLanes(p, ...timelineWindow(view, date));
  return timelineKpis(lanes, buildViewFamilies(lanes, p));
}
const families = (an: Analyzer) => buildFamilies(model(an));
const only = (date: string): DateFilter => ({ fromDate: date, toDate: date });

describe('Timeline windows', () => {
  it('counts a family stretch that crosses midnight on both days, and the whole of it in the week', () => {
    const an = analyzer(session(1, [user(when(23, 50)), reply(when(23, 59))]), session(2, [user(when(23, 59), 1), reply(when(3, 0, 18))]));
    expect(kpis(an, DAY).unattendedMs / M).toBe(10);
    expect(kpis(an, NEXT).unattendedMs / M).toBe(180);
    expect(kpis(an, DAY, 'week').unattendedMs / M).toBe(190);
    // A range of the second day alone keeps the coordinator as context: the same 180 min, and the child is a child.
    expect(kpis(an, NEXT, 'day', only(NEXT)).unattendedMs / M).toBe(180);
    expect(kpis(an, NEXT, 'day', only(NEXT)).childLanes).toBe(1);
  });

  it('splits a wait that crosses midnight between the days, whatever the range', () => {
    const an = analyzer(session(3, [user(when(23, 35)), reply(when(23, 40)), user(when(0, 30, 18)), reply(when(0, 32, 18))]));
    expect(kpis(an, DAY).waitMs / M).toBe(20);
    expect(kpis(an, DAY, 'day', only(DAY)).waitMs / M).toBe(20);
    expect(buildSummaryExportFromAnalyzer(an, only(DAY)).autonomy?.waitHours).toBe(0.3);
    expect(kpis(an, NEXT, 'day', only(NEXT)).waitMs / M).toBe(30);
  });

  it('shows a day that holds only a wait', () => {
    const an = analyzer(session(4, [user(when(23, 50)), ...permission(when(23, 52), when(0, 30, 18)), reply(when(23, 55))]));
    expect(kpis(an, NEXT).waitMs / M).toBe(30);
    expect(kpis(an, NEXT, 'day', only(NEXT)).waitMs / M).toBe(30);
    expect(model(an).days).toContain(NEXT);
  });

  it('gives the same per-day values for a range as for its days one at a time', () => {
    const an = analyzer(
      session(16, [user(when(22, 0)), reply(when(23, 30)), user(when(0, 20, 18)), ...question(when(0, 25, 18), when(0, 40, 18)), reply(when(1, 0, 18))]),
      session(17, [user(when(23, 0), 16), reply(when(2, 0, 18))]),
    );
    const range: DateFilter = { fromDate: DAY, toDate: NEXT };
    for (const date of [DAY, NEXT]) {
      const a = kpis(an, date, 'day', range);
      const b = kpis(an, date, 'day', only(date));
      expect([b.agentMs, b.waitMs, b.unattendedMs, b.answered, b.typed]).toEqual([a.agentMs, a.waitMs, a.unattendedMs, a.answered, a.typed]);
    }
  });

  // Each zone with its own transitions, whatever the machine's zone; the next day has 24 hours again.
  for (const [zone, spring, autumn] of [['Europe/Berlin', '2026-03-29', '2026-10-25'], ['America/New_York', '2026-03-08', '2026-11-01']] as const) {
    it(`has 23 and 25 hours on daylight-saving days in ${zone}`, () => {
      const saved = process.env.TZ;
      process.env.TZ = zone;
      try {
        for (const [date, hours] of [[spring, 23], [autumn, 25], ['2026-07-01', 24]] as const) {
          const [a, b] = timelineWindow('day', date);
          expect([date, (b - a) / 3_600_000, hourTicks(a, b, 1).length]).toEqual([date, hours, hours]);
        }
      } finally {
        if (saved === undefined) delete process.env.TZ;
        else process.env.TZ = saved;
      }
    });
  }
});

describe('Timeline inputs and blocking', () => {
  it('counts a wait that outlasts its turn, then the gap to the next prompt, as one occupied span', () => {
    const an = analyzer(session(5, [user(when(10, 0)), ...permission(when(10, 1), when(10, 15)), reply(when(10, 2)), user(when(10, 20)), reply(when(10, 21))]));
    expect(kpis(an, DAY).waitMs / M).toBe(19);
  });

  it('counts an answer on the day you gave it', () => {
    const an = analyzer(session(6, [user(when(10, 0)), reply(when(10, 1))]),
      session(7, [user(when(23, 55), 6), ...question(when(23, 58), when(0, 5, 18)), reply(when(0, 10, 18))]));
    expect(kpis(an, DAY).answered).toBe(0);
    expect(kpis(an, NEXT).answered).toBe(1);
  });

  it('counts an answer logged in the same millisecond as its question', () => {
    const an = analyzer(session(8, [user(when(10, 0)), reply(when(10, 1))]),
      session(9, [user(when(10, 0), 8), ...question(when(10, 0), when(10, 0)), reply(when(10, 1))]));
    expect(families(an).totals.childrenNeedingYou).toBe(1);
  });

  it('counts overlapping requests one by one, and their time once', () => {
    const an = analyzer(session(10, [user(when(10, 0)), reply(when(10, 1))]),
      session(11, [user(when(10, 0), 10), ...question(when(10, 1), when(10, 10)), ...permission(when(10, 3), when(10, 7)), reply(when(10, 12))]));
    expect(families(an).totals.childAnswered).toBe(2);
    expect(kpis(an, DAY).waitMs / M).toBe(9);
  });

  it('treats an interrupted question as blocked, not as work or an answer', () => {
    const an = analyzer(session(12, [user(when(10, 0)), ...question(when(10, 1), when(12, 1), 'The question was interrupted before the user answered.'), reply(when(12, 2))]));
    expect(kpis(an, DAY).agentMs / M).toBe(2);
    expect(kpis(an, DAY).answered).toBe(0);
  });

  it('ends an unattended stretch at your next input anywhere in the family', () => {
    const an = analyzer(
      session(18, [user(when(9, 0)), reply(when(11, 0))]),
      session(19, [user(when(9, 1), 18), ...question(when(9, 30), when(9, 40)), reply(when(11, 0))]),
    );
    // 9:00 → the answer in the child at 9:40, then 9:40 → 11:00.
    expect(kpis(an, DAY).unattendedMs / M).toBe(80);
  });
});

describe('Timeline copy', () => {
  it('does not read a cause into permission-only input', () => {
    const an = analyzer(session(13, [user(when(10, 0)), reply(when(10, 1))]),
      session(14, [user(when(10, 2), 13), ...permission(when(10, 3), when(10, 6)), reply(when(10, 7))]));
    const text = verdictText(families(an).families[0]);
    expect(text).not.toContain('needed more than');
    expect(text).toContain('answered 1 question or permission prompt');
  });

  it('calls a 30 min wait long, not longer than 30 min', () => {
    const an = analyzer(session(15, [user(when(10, 0)), reply(when(10, 2)), user(when(10, 32)), reply(when(10, 33))]));
    const p = model(an);
    const lanes = buildLanes(p, ...timelineWindow('day', DAY));
    const [, , waits] = viewInsights(lanes, buildViewFamilies(lanes, p), createNamer(p, true), 'day', p);
    expect(waits).not.toContain('longer than 30');
    expect(waits).toContain('1 wait lasted 30 min or more');
  });
});
