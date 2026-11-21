/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Edge cases of the Timeline rules, end to end from synthetic Copilot logs: answers as points in time, stops with no
 * result, relays, creation times, sessions that only hold an answer, and families with one active member. */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Analyzer } from './analyzer';
import { parseCLIEventsFile } from './parser-vscode-cli';
import { buildSummaryExportFromAnalyzer } from './summary-export';
import {
  buildFamilies, buildLanes, buildViewFamilies, createNamer, intervalsMs, prepareTimeline, sessionWork, timelineKpis, timelineWindow,
  viewInsights,
} from './timeline-model';
import { formatTimeline } from '../mcp/formatters';
import type { DateFilter, Session } from './types';
import type { TimelineTurn } from './types/timeline-types';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aec-timeline-edges-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }));

const M = 60_000;
const D17 = '2026-11-17';
const D18 = '2026-11-18';
const at = (day: number, h = 0, m = 0) => new Date(2026, 10, day, h, m).getTime();
const sid = (i: number) => 'ed9e0000-0000-4000-8000-' + String(i).padStart(12, '0');
type Ev = { type: string; timestamp: string; data: Record<string, unknown> };
const ev = (type: string, t: number, data: Record<string, unknown>): Ev => ({ type, timestamp: new Date(t).toISOString(), data });
const prompt = (t: number, from?: number) => ev('user.message', t, {
  content: 'Fixture',
  ...(from ? { transformedContent: `<cross_session_message>\nfrom_session_id: ${sid(from)}\n</cross_session_message>\nFixture` } : {}),
});
const reply = (t: number) => ev('assistant.message', t, { content: 'Done' });
const start = (t: number, id = 'q', toolName = 'ask_user') => ev('tool.execution_start', t, { toolName, toolCallId: id });
const end = (t: number, id = 'q', content = 'User selected: Yes') => ev('tool.execution_complete', t, { toolCallId: id, success: true, result: { content } });

function session(i: number, events: Ev[], startAt = events[0] ? Date.parse(events[0].timestamp) : at(17), start: Record<string, unknown> = {}): Session | null {
  const dir = path.join(root, sid(i));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'events.jsonl');
  fs.writeFileSync(file, [ev('session.start', startAt, { sessionId: sid(i), ...start }), ...events].map(x => JSON.stringify(x)).join('\n'));
  return parseCLIEventsFile(file, 'ws', 'fixture');
}

const analyzer = (...sessions: (Session | null)[]) => new Analyzer(sessions.filter((s): s is Session => s !== null), new Map());
function view(an: Analyzer, day: string, f?: DateFilter) {
  const p = prepareTimeline(an.getTimelineData(f));
  const lanes = buildLanes(p, ...timelineWindow('day', day));
  const families = buildViewFamilies(lanes, p);
  return { p, lanes, kpis: timelineKpis(lanes, families), fam: buildFamilies(p), waits: viewInsights(lanes, families, createNamer(p, true), 'day', p)[2] };
}
const only = (day: string): DateFilter => ({ fromDate: day, toDate: day });

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
    const dir = path.join(root, sid(40));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'workspace.yaml'), 'client_name: github/cli\nname: Fixture name\nuser_named: true\nbranch: feature/example\n');
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
