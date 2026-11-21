/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildFamilies, buildLanes, buildViewFamilies, createNamer, familiesInsights, filterLanes, formatDuration, hourTicks, NO_LANE_FILTERS,
  peakParallel, prepareTimeline, sessionWaits, stepDate, timelineKpis, timelineWindow, unattendedMs, verdictText, viewInsights,
  workMs, workSegments,
} from './timeline-model';
import type { TimelineDataset, TimelineSessionRecord, TimelineTurn, TurnSender } from './types/timeline-types';

const MIN = 60_000;
const at = (h: number, m = 0, day = 15) => new Date(2024, 2, day, h, m).getTime();
const turn = (t: number, minutes: number, k: TurnSender = 'you', extra: Partial<TimelineTurn> = {}): TimelineTurn =>
  ({ t, d: minutes * MIN, k, sub: 0, comp: false, cr: 0, tok: 0, ...extra });
const session = (id: string, turns: TimelineTurn[], extra: Partial<TimelineSessionRecord> = {}): TimelineSessionRecord =>
  ({ id, name: id, branch: '', repo: 'shop', harness: 'Copilot App', model: 'm', parent: -1, via: null, turns, ...extra });

/** A coordinator (0) that started two children (1, 2); child 1 started a grandchild (3); a lone session (4). */
function fixture(): TimelineDataset {
  return {
    forkedSessions: 0,
    sessions: [
      session('coord', [turn(at(9), 30, 'you', { cr: 10 }), turn(at(11), 10, 'agent', { cr: 5 })]),
      session('child-a', [turn(at(9, 10), 60, 'agent', { cr: 20, sub: 2 }), turn(at(10, 30), 5, 'you', { cr: 5 })], { parent: 0, via: 'create' }),
      session('child-b', [turn(at(9, 20), 100, 'agent', { cr: 30 })], { parent: 0, via: 'relay' }),
      session('grandchild', [turn(at(9, 40), 20, 'autopilot', { cr: 10 })], { parent: 1, via: 'create' }),
      session('lone', [turn(at(14), 2, 'you', { cr: 20 }), turn(at(15), 1, 'you')], { harness: 'Claude Code', repo: 'docs' }),
    ],
  };
}

describe('timeline model', () => {
  it('places each session in its family with its depth', () => {
    const p = prepareTimeline(fixture());
    expect(p.sessions.map(s => [s.root, s.depth, s.children])).toEqual([[0, 0, 2], [0, 1, 1], [0, 1, 0], [0, 2, 0], [4, 0, 0]]);
    expect(p.familySize.get(0)).toBe(4);
    expect(p.dayTotals.get('2024-03-15')).toMatchObject({ typed: 4, automated: 4 });
    expect(p.totalCredits).toBe(100);
  });

  it('counts a wait from the end of the agent’s work to your next prompt, only from 2 to 120 minutes', () => {
    const waitsOf = (turns: TimelineTurn[]) => sessionWaits(turns).waits.map(w => [w.start, w.end]);
    expect(waitsOf([turn(at(9), 10), turn(at(9, 11), 5)])).toEqual([]);
    expect(waitsOf([turn(at(9), 10), turn(at(9, 40), 5)])).toEqual([[at(9, 10), at(9, 40)]]);
    expect(waitsOf([turn(at(9), 10), turn(at(12), 5)])).toEqual([]);
    expect(sessionWaits([turn(at(9), 10), turn(at(12), 5)]).away).toEqual([[at(9, 10), at(12)]]);
    // An automated turn keeps the agent busy; only your typed prompt ends the wait.
    expect(waitsOf([turn(at(9), 10), turn(at(9, 20), 30, 'agent'), turn(at(10, 30), 1)])).toEqual([[at(9, 50), at(10, 30)]]);
    // Without a logged duration, when the work ended is unknown: no wait until a timed turn says so.
    expect(waitsOf([turn(at(9), 0, 'you', { noDuration: true }), turn(at(10), 5), turn(at(10, 30), 5)])).toEqual([[at(10, 5), at(10, 30)]]);
  });

  it('measures the longest unattended stretch after one prompt, across the family', () => {
    const p = prepareTimeline(fixture());
    const lanes = buildLanes(p, ...timelineWindow('day', '2024-03-15'));
    const family = lanes.filter(l => l.s.root === 0);
    // After the 9:00 prompt, child-b kept working until 11:00, past your next prompt at 10:30.
    expect(formatDuration(unattendedMs(family))).toBe('2 h 00 m');
  });

  it('finds the peak of overlapping agent work and when it started', () => {
    const p = prepareTimeline(fixture());
    const lanes = buildLanes(p, ...timelineWindow('day', '2024-03-15'));
    expect(peakParallel(lanes)).toEqual({ count: 3, at: at(9, 20) });
  });

  it('adds up the KPIs and coaching callouts for the shown sessions', () => {
    const p = prepareTimeline(fixture());
    const lanes = buildLanes(p, ...timelineWindow('day', '2024-03-15'));
    const families = buildViewFamilies(lanes, p);
    const kpis = timelineKpis(lanes, families);
    expect(kpis).toMatchObject({ sessions: 5, turns: 8, typed: 4, waits: 2, longWaits: 1, childLanes: 3, credits: 100, childCreditShare: 65 });
    expect(kpis.agentMsPerPrompt).toBe((228 * MIN) / 4);
    expect(families.map(f => [f.root, f.ordered.map(o => [o.lane.s.id, o.depth])])).toEqual([
      [0, [['coord', 0], ['child-a', 1], ['grandchild', 2], ['child-b', 1]]],
      [4, [['lone', 0]]],
    ]);
    const tips = viewInsights(lanes, families, createNamer(p, false), 'day');
    expect(tips[0]).toContain('Your coordinator “coord” and 3 sessions of its family kept working 2 h 00 m after one of your prompts or answers');
    expect(tips[1]).toBe('Child sessions used 65.0% of the credits shown. The child “child-b” alone used 30%, with no prompt or answer from you.');
    expect(tips[2]).toBe('Agents waited on you 2 times after finishing a turn, 1 h 18 m in total; 1 wait was longer than 30 min. Answer from the session list, or let autopilot carry on with routine steps.');
  });

  it('keeps the tree when a filter hides a parent, under the nearest shown ancestor', () => {
    const p = prepareTimeline(fixture());
    const lanes = filterLanes(buildLanes(p, ...timelineWindow('day', '2024-03-15')), { ...NO_LANE_FILTERS, hideOneTurn: true }, p);
    expect(lanes.map(l => l.s.id)).toEqual(['coord', 'child-a', 'lone']);
    expect(filterLanes(buildLanes(p, ...timelineWindow('day', '2024-03-15')), { ...NO_LANE_FILTERS, youTyped: true, harness: 'Copilot App' }, p)
      .map(l => l.s.id)).toEqual(['coord', 'child-a']);
    expect(filterLanes(buildLanes(p, ...timelineWindow('day', '2024-03-15')), { ...NO_LANE_FILTERS, query: 'DOCS' }, p).map(l => l.s.id)).toEqual(['lone']);
    const grand = buildLanes(p, ...timelineWindow('day', '2024-03-15')).filter(l => l.s.id !== 'child-a');
    buildViewFamilies(grand, p);
    expect(grand.find(l => l.s.id === 'grandchild')?.visibleParent).toBe(0);
  });

  it('judges each family: needed you when you typed into a child, wide from 8 children', () => {
    const data = fixture();
    for (let i = 0; i < 8; i++) data.sessions.push(session(`w${i}`, [turn(at(16, i), 1, 'agent', { cr: 1 })], { parent: 4, via: 'create' }));
    const { families, totals } = buildFamilies(prepareTimeline(data));
    expect(families.map(f => [f.s.id, f.verdict, f.wide, f.children, f.childTyped, f.steppedInto, f.rank])).toEqual([
      ['coord', 'needed', false, 3, 1, 1, 1],
      ['lone', 'alone', true, 8, 0, 0, 2],
    ]);
    expect(totals).toMatchObject({ families: 2, children: 11, childrenNeedingYou: 1, maxDepth: 2, maxFanOut: 8 });
    expect(familiesInsights(totals)[1]).toBe('1 of 11 child sessions needed you: you typed 1 prompt into them. Show Needed you and open the ✋ children to see what their brief was missing.');
  });

  it('dates a family from its first to its last activity', () => {
    const data = fixture();
    data.sessions[1].turns.push(turn(at(9, 0, 18), 5, 'agent'));
    const coord = buildFamilies(prepareTimeline(data)).families[0];
    expect([coord.from, coord.to, coord.busiest]).toEqual(['2024-03-15', '2024-03-18', '2024-03-15']);
  });

  it('masks names, branches and repositories, ranking repositories by credits', () => {
    const p = prepareTimeline(fixture());
    const masked = createNamer(p, true);
    expect([masked.name(p.sessions[0]), masked.name(p.sessions[1]), masked.repo(p.sessions[0]), masked.repo(p.sessions[4])])
      .toEqual(['Session 1', 'Child session 2', 'Repository A', 'Repository B']);
    expect(createNamer(prepareTimeline({ forkedSessions: 0, sessions: [session('x', [turn(at(9), 1)], { name: '' })] }), false).name(prepareTimeline({ forkedSessions: 0, sessions: [session('x', [turn(at(9), 1)], { name: '' })] }).sessions[0]))
      .toMatch(/^Untitled Copilot App session · /);
  });

  it('steps between active days and weeks', () => {
    const days = ['2024-03-04', '2024-03-15', '2024-03-16', '2024-03-27'];
    expect(stepDate('day', '2024-03-15', 1, days)).toBe('2024-03-16');
    expect(stepDate('day', '2024-03-04', -1, days)).toBeNull();
    expect(stepDate('week', '2024-03-15', 1, days)).toBe('2024-03-27');
    expect(stepDate('week', '2024-03-15', -1, days)).toBe('2024-03-04');
    expect(timelineWindow('week', '2024-03-17')[0]).toBe(new Date(2024, 2, 11).getTime());
  });
});

describe('time the agent waited on you inside a turn', () => {
  const asked = (s: number, e: number, k: 'question' | 'permission' = 'question') => ({ s, e, k });

  it('leaves questions and permission prompts out of agent time and counts them as waiting on you', () => {
    const t = turn(at(10), 60, 'you', { w: [asked(at(10, 10), at(10, 40)), asked(at(10, 50), at(10, 52), 'permission')] });
    expect(workSegments(t)).toEqual([[at(10), at(10, 10)], [at(10, 40), at(10, 50)], [at(10, 52), at(11)]]);
    expect(workMs(t)).toBe(28 * MIN);
    expect(sessionWaits([t]).waits.map(w => w.kind)).toEqual(['question', 'permission']);
    const p = prepareTimeline({ forkedSessions: 0, sessions: [session('a', [t])] });
    const lanes = buildLanes(p, ...timelineWindow('day', '2024-03-15'));
    expect(timelineKpis(lanes, buildViewFamilies(lanes, p))).toMatchObject({ agentMs: 28 * MIN, waits: 2, idleWaits: 0, waitMs: 32 * MIN, answered: 2 });
    expect(p.dayTotals.get('2024-03-15')?.agentMs).toBe(28 * MIN);
  });

  it('keeps a wait that outlasts the turn’s last message, by its own timestamps', () => {
    const t = turn(at(10), 10, 'agent', { w: [asked(at(10, 5), at(10, 40), 'permission')] });
    expect(workSegments(t)).toEqual([[at(10), at(10, 5)]]);
    expect(sessionWaits([t]).waits).toEqual([{ start: at(10, 5), end: at(10, 40), kind: 'permission' }]);
  });

  it('does not count a session waiting on a question as a parallel agent', () => {
    const p = prepareTimeline({
      forkedSessions: 0, sessions: [
        session('a', [turn(at(9), 120, 'you', { w: [asked(at(9, 10), at(10, 50))] })]),
        session('b', [turn(at(9, 30), 60, 'you')]),
      ],
    });
    expect(peakParallel(buildLanes(p, ...timelineWindow('day', '2024-03-15'))).count).toBe(1);
  });

  it('restarts the unattended stretch at your answer', () => {
    const p = prepareTimeline({ forkedSessions: 0, sessions: [session('a', [turn(at(9), 120, 'you', { w: [asked(at(9, 30), at(10))] })])] });
    expect(formatDuration(unattendedMs(buildLanes(p, ...timelineWindow('day', '2024-03-15'))))).toBe('1 h 00 m');
  });

  it('ends the unattended stretch when no agent is working', () => {
    const p = prepareTimeline({ forkedSessions: 0, sessions: [session('a', [turn(at(9), 10), turn(at(9, 11), 4, 'agent'), turn(at(9, 40), 10, 'agent')])] });
    expect(formatDuration(unattendedMs(buildLanes(p, ...timelineWindow('day', '2024-03-15'))))).toBe('15 min');
  });

  it('counts an answered question in a child as needing you, and says so', () => {
    const data: TimelineDataset = {
      forkedSessions: 0, sessions: [
        session('coord', [turn(at(9), 10, 'you', { cr: 5 })]),
        session('kid', [turn(at(9, 5), 30, 'agent', { cr: 5, w: [asked(at(9, 10), at(9, 20), 'permission')] })], { parent: 0, via: 'create' }),
      ],
    };
    const { families, totals } = buildFamilies(prepareTimeline(data));
    expect(families[0]).toMatchObject({ verdict: 'needed', childTyped: 0, childAnswered: 1, steppedInto: 1 });
    expect(verdictText(families[0])).toBe('You answered 1 question or permission prompt in 1 of 1 child sessions (marked ✋): they needed more than the coordinator’s brief.');
    expect(familiesInsights(totals)[1]).toContain('you answered 1 question or permission prompt in them');
  });
});

describe('day and week boundaries', () => {
  /** A wait from 23:30 to 0:30 in one session, and a turn from 23:50 to 0:30 in another, across the night of the 15th. */
  function night(): TimelineDataset {
    return {
      forkedSessions: 0,
      sessions: [session('a', [turn(at(23), 30), turn(at(0, 30, 16), 5)]), session('b', [turn(at(23, 50), 40, 'agent')])],
    };
  }

  it('clips waits and agent time to each day, so the days add up to the week', () => {
    const p = prepareTimeline(night());
    const kpisOf = (view: 'day' | 'week', date: string) => {
      const lanes = buildLanes(p, ...timelineWindow(view, date));
      return timelineKpis(lanes, buildViewFamilies(lanes, p));
    };
    const [d15, d16, week] = [kpisOf('day', '2024-03-15'), kpisOf('day', '2024-03-16'), kpisOf('week', '2024-03-15')];
    expect([d15.waitMs, d16.waitMs, week.waitMs]).toEqual([30 * MIN, 30 * MIN, 60 * MIN]);
    expect([d15.waits, d16.waits, week.waits]).toEqual([1, 0, 1]);
    expect(d15.agentMs + d16.agentMs).toBe(week.agentMs);
    expect([p.dayTotals.get('2024-03-15')?.agentMs, p.dayTotals.get('2024-03-16')?.agentMs]).toEqual([40 * MIN, 35 * MIN]);
    // The turn that started on the 15th is drawn on the 16th but counted on the 15th.
    const lane16 = buildLanes(p, ...timelineWindow('day', '2024-03-16')).find(l => l.s.id === 'b')!;
    expect([lane16.turns.length, lane16.carried.length, lane16.agentMs]).toEqual([0, 1, 30 * MIN]);
  });

  describe('on a daylight-saving day', () => {
    const tz = process.env.TZ;
    beforeAll(() => { process.env.TZ = 'Europe/Berlin'; });
    afterAll(() => { if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz; });

    it('has 23 hours and labels them by the clock', () => {
      const [start, end] = timelineWindow('day', '2024-03-31');
      expect((end - start) / 3.6e6).toBe(23);
      const hours = hourTicks(start, end, 1).map(t => new Date(t).getHours());
      expect(hours.slice(0, 4)).toEqual([0, 1, 3, 4]);
      expect(hours).toHaveLength(23);
    });
  });
});

describe('conditional coaching sentences', () => {
  it('calls long gaps time away instead of claiming no agent waited', () => {
    const p = prepareTimeline({ forkedSessions: 0, sessions: [session('a', [turn(at(9), 10), turn(at(13), 5)])] });
    const lanes = buildLanes(p, ...timelineWindow('day', '2024-03-15'));
    expect(viewInsights(lanes, buildViewFamilies(lanes, p), createNamer(p, false), 'day')[2])
      .toBe('No agent waited 2–120 min for your next prompt or on a question; 1 gap was longer than 2 h, counted as time away rather than waiting.');
  });

  it('names the coordinator when it is not shown, and words the stretch for its children', () => {
    const p = prepareTimeline(fixture());
    const lanes = buildLanes(p, ...timelineWindow('day', '2024-03-15')).filter(l => l.s.id === 'child-a');
    const tip = viewInsights(lanes, buildViewFamilies(lanes, p), createNamer(p, false), 'day', p)[0];
    expect(tip).toContain('The child session “child-a” of the coordinator “coord” (not shown here) kept working 5 min');
  });

  it('says clearer briefs are the biggest lever only when the families that needed you cost more', () => {
    const lever = (needed: number, alone: number) => familiesInsights({
      ...buildFamilies(prepareTimeline(fixture())).totals,
      totalCredits: 100, needed: { families: 1, creditShare: needed, avgCredits: needed }, alone: { families: 1, creditShare: alone, avgCredits: alone },
    })[0];
    expect(lever(60, 20)).toContain('Clearer briefs are the biggest lever.');
    expect(lever(20, 60)).not.toContain('Clearer briefs');
    const alone = buildFamilies(prepareTimeline({ ...fixture(), sessions: fixture().sessions.map(s => ({ ...s, turns: s.turns.filter(t => s.parent < 0 || t.k !== 'you') })) }));
    expect(familiesInsights(alone.totals)[0]).toMatch(/^The family worked alone: no child session needed a prompt or answer from you\./);
    expect(verdictText(alone.families[0])).toMatch(/^All 3 child sessions needed no prompt or answer from you\./);
  });
});
