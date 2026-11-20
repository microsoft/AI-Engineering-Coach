/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import {
  buildFamilies, buildLanes, buildViewFamilies, createNamer, familiesInsights, filterLanes, formatDuration, NO_LANE_FILTERS,
  peakParallel, prepareTimeline, stepDate, timelineKpis, timelineWindow, unattendedMs, viewInsights, waitsOf,
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
    expect(waitsOf([turn(at(9), 10), turn(at(9, 11), 5)])).toEqual([]);
    expect(waitsOf([turn(at(9), 10), turn(at(9, 40), 5)])).toEqual([[at(9, 10), at(9, 40)]]);
    expect(waitsOf([turn(at(9), 10), turn(at(12), 5)])).toEqual([]);
    // An automated turn keeps the agent busy; only your typed prompt ends the wait.
    expect(waitsOf([turn(at(9), 10), turn(at(9, 20), 30, 'agent'), turn(at(10, 30), 1)])).toEqual([[at(9, 50), at(10, 30)]]);
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
    expect(tips[0]).toContain('Your coordinator “coord” and 3 sessions it started worked 2 h 00 m');
    expect(tips[1]).toBe('Child sessions used 65.0% of the credits. The child “child-b” alone used 30%, with no prompts from you.');
    expect(tips[2]).toContain('waited for you 2 times');
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
    expect(familiesInsights(totals)[1]).toBe('1 of 11 child sessions needed a prompt from you (1 prompt). Filter by Needed you and open the ✋ children to see what their brief was missing.');
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
