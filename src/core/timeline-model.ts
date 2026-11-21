/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Timeline model: the Day, Week and Families views derived from a `TimelineDataset`. Pure and browser-safe, so the
 * webview recomputes a view instantly when a filter changes, and the analyzer, chat tools and tests share the rules.
 * Every measure is built from intervals over the whole dataset first, then clipped to the range and to the day or week,
 * so a range gives the same per-day values as its days one at a time.
 *
 *   Your input         a prompt you typed, or your answer to a question or a permission prompt (at the time you
 *                      answered; a relayed question counts once, in the session that asked it).
 *   Blocked            a turn stopped on a question or a permission prompt, answered or not. Not agent work.
 *   Agent time         per session, the union of its turns' spans (prompt → last logged agent activity) minus the time
 *                      they were blocked.
 *   Waiting on you     per session, the union of the gaps from the end of its work to your next typed prompt (2–120 min;
 *                      longer gaps are time away) and the questions and permission prompts you answered. Counted on
 *                      the day each wait started; its time counts where it falls.
 *   Unattended         per family: from one of your inputs anywhere in the family, for as long as the family's agent
 *                      work kept running (pauses of at most 2 min don't end it), and never past your next input anywhere in
 *                      the family. All members count, whatever the filters show.
 *   Peak parallel      most sessions doing agent work at once.
 *   Family             a coordinator session and every session it started, directly or through its children. */

import { toDateStr } from './helpers';
import type { TimelineDataset, TimelineSessionRecord, TimelineTurn, TimelineTurnWait } from './types/timeline-types';

export const WAIT_MIN_MS = 2 * 60_000;
export const WAIT_MAX_MS = 120 * 60_000;
/** Waits of this length or more are called long. */
export const LONG_WAIT_MS = 30 * 60_000;
/** Children from which a family counts as a wide fan-out. */
export const WIDE_FAN_OUT = 8;
/** Unattended stretches shorter than this aren't called out. */
const UNATTENDED_CALLOUT_MS = 5 * 60_000;
const MAX_DEPTH = 64;

export type TimelineView = 'day' | 'week' | 'families';

export type Interval = [number, number];

/** A time a session waited on you: after its work, for your next prompt (`idle`), or for your answer. */
export interface TimelineWait {
  start: number;
  end: number;
  kind: 'idle' | TimelineTurnWait['k'];
}

/** Your answer to a question or a permission prompt, when you gave it. */
export interface TimelineAnswer {
  at: number;
  /** When it was asked: equal to `at` for an answer that took no measurable time. */
  start: number;
  /** The wait on you it ended, when one was measured (request to result); absent for an instant answer, and for one
   *  recorded before its request was logged or after its result. */
  waited?: Interval;
  /** Request, result and record all at the same moment: an answer that took no measurable time. */
  instant: boolean;
  kind: TimelineTurnWait['k'];
  /** Counted as an answer: false for a relayed answer the child also logged as its own (one answer, counted there). */
  counted: boolean;
  /** The request it answered, when logged (see `TimelineTurnWait.rid`). */
  rid?: string;
}

export interface PreparedSession extends TimelineSessionRecord {
  index: number;
  /** Index of the family's coordinator (itself for a top-level session). */
  root: number;
  /** 0 for a coordinator or lone session, 1 for a child, 2 for a grandchild… */
  depth: number;
  /** Sessions it started directly. */
  children: number;
  context: TimelineTurn[];
  /** Every turn, context included, in time order. */
  all: TimelineTurn[];
  /** When its agent was working, merged: turn spans minus the time they were blocked. */
  work: Interval[];
  /** Every time it waited on you, in order. */
  waits: TimelineWait[];
  /** The union of `waits`. */
  waiting: Interval[];
  /** Your answers to its questions and permission prompts. */
  answers: TimelineAnswer[];
  /** Gaps of more than 2 h between the end of its work and your next prompt: time away, not waiting. */
  away: Interval[];
}

export interface DayTotals {
  typed: number;
  automated: number;
  agentMs: number;
  waitMs: number;
}

export interface PreparedTimeline {
  sessions: PreparedSession[];
  /** Days with a turn, agent work or waiting on you, in order. */
  days: string[];
  dayTotals: Map<string, DayTotals>;
  /** Sessions per family in the dataset (context records included), keyed by the family's root index. */
  familySize: Map<number, number>;
  /** Each family's unattended stretches over the whole dataset, keyed by its root index. */
  stretches: Map<number, Interval[]>;
  totalCredits: number;
  harnesses: string[];
  forkedSessions: number;
  /** The range: agent work and waits outside it never count. */
  bounds: Interval;
}

/* ---- intervals ---- */

/** Sorted, with overlapping and touching intervals joined. */
export function mergeIntervals(list: readonly Interval[]): Interval[] {
  const sorted = list.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out: Interval[] = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** `spans` minus `holes`, both merged. */
function subtract(spans: readonly Interval[], holes: readonly Interval[]): Interval[] {
  const out: Interval[] = [];
  let j = 0;
  for (const [a, b] of spans) {
    let from = a;
    while (j < holes.length && holes[j][1] <= from) j++;
    for (let k = j; k < holes.length && holes[k][0] < b; k++) {
      if (holes[k][0] > from) out.push([from, holes[k][0]]);
      from = Math.max(from, holes[k][1]);
    }
    if (b > from) out.push([from, b]);
  }
  return out;
}

/** The parts of the intervals inside the window. */
export function clipIntervals(list: readonly Interval[], win: Interval): Interval[] {
  const out: Interval[] = [];
  for (const [a, b] of list) {
    const from = Math.max(a, win[0]);
    const to = Math.min(b, win[1]);
    if (to > from) out.push([from, to]);
  }
  return out;
}

export function intervalsMs(list: readonly Interval[]): number {
  return sum(list, ([a, b]) => b - a);
}

function overlap(a: number, b: number, start: number, end: number): number {
  return Math.max(0, Math.min(b, end) - Math.max(a, start));
}

/** The part of a wait inside the window. */
export function clippedMs(w: TimelineWait, win: Interval): number {
  return overlap(w.start, w.end, win[0], win[1]);
}

/* ---- sessions ---- */

/** When a session's agent was working: the union of its turns' spans, each less the questions and permission prompts
 *  that turn was stopped on, answered or not. Another turn of the same session can keep working meanwhile. Turns without
 *  a logged duration add nothing. */
export function sessionWork(turns: readonly TimelineTurn[]): Interval[] {
  return mergeIntervals(turns.filter(t => t.d > 0)
    .flatMap(t => subtract([[t.t, t.t + t.d]], mergeIntervals((t.w ?? []).map(w => [w.s, w.e] as Interval)))));
}

/** A turn's own agent time and the time it was stopped on a question or a permission prompt (whole turn, not clipped). */
export function turnTimes(t: TimelineTurn): { workMs: number; blockedMs: number } {
  return { workMs: intervalsMs(sessionWork([t])), blockedMs: intervalsMs(mergeIntervals((t.w ?? []).map(w => [w.s, w.e]))) };
}

/** A question or permission prompt you answered that waited on you, from its request to its result (the tool's clock).
 *  One whose answer the harness recorded before the request was even logged has no measurable start: no wait. */
const waitedOnYou = (w: TimelineTurnWait) => w.a && w.e > w.s && (w.at === undefined || w.at >= w.s);

/** A session's waits on you: the gaps from the end of its work (or of a question still open after it) to your next
 *  typed prompt (2–120 min; longer gaps are time away), and the questions and permission prompts you answered. After a
 *  turn without a logged duration, when the work ended is unknown, so no gap is counted until the next timed turn. */
export function sessionWaits(turns: readonly TimelineTurn[], stops: readonly TimelineTurnWait[] = []): { waits: TimelineWait[]; away: Interval[] } {
  const waits: TimelineWait[] = [];
  for (const w of stops) if (waitedOnYou(w)) waits.push({ start: w.s, end: w.e, kind: w.k });
  const away: Interval[] = [];
  let busyUntil = -1;
  for (const t of [...turns].sort((a, b) => a.t - b.t)) {
    if (t.k === 'you' && busyUntil > 0) {
      const gap = t.t - busyUntil;
      if (gap >= WAIT_MIN_MS && gap <= WAIT_MAX_MS) waits.push({ start: busyUntil, end: t.t, kind: 'idle' });
      else if (gap > WAIT_MAX_MS) away.push([busyUntil, t.t]);
    }
    for (const w of t.w ?? []) if (waitedOnYou(w)) waits.push({ start: w.s, end: w.e, kind: w.k });
    busyUntil = t.noDuration ? -1 : Math.max(busyUntil, t.t + t.d, ...(t.w ?? []).map(w => w.e));
  }
  return { waits: waits.sort((a, b) => a.start - b.start), away };
}

/** Your inputs into a session: its typed prompts, and your answers, each once: a relayed answer paired with the child's
 *  own record of it is the same decision, so only the child's counts (an unpaired relay is the only record, and counts). */
function inputsOf(s: PreparedSession): number[] {
  return [...s.all.filter(t => t.k === 'you').map(t => t.t), ...s.answers.filter(a => a.counted).map(a => a.at)];
}

/** The family's unattended stretches: from each of your inputs, through the agent work running at it or starting
 *  within 2 min of the stretch's end so far, up to your next input. */
export function unattendedStretches(inputs: readonly number[], work: readonly Interval[]): Interval[] {
  const sorted = [...new Set(inputs)].sort((a, b) => a - b);
  const out: Interval[] = [];
  let j = 0;
  for (let i = 0; i < sorted.length; i++) {
    const from = sorted[i];
    const until = sorted[i + 1] ?? Infinity;
    while (j < work.length && work[j][1] <= from) j++;
    let reach = from;
    for (let k = j; k < work.length && work[k][0] < until && work[k][0] <= reach + WAIT_MIN_MS; k++) reach = Math.max(reach, work[k][1]);
    reach = Math.min(reach, until);
    if (reach > from) out.push([from, reach]);
  }
  return out;
}

/** How far apart a relayed answer and the child's own answer can be logged and still be the same answer. */
const RELAY_MATCH_MS = 10_000;

/** Whether `d` descends from `s` (a child, grandchild…). */
function descendsFrom(d: PreparedSession, s: PreparedSession, sessions: readonly PreparedSession[]): boolean {
  for (let at = d.parent, steps = 0; at >= 0 && steps < MAX_DEPTH; at = sessions[at].parent, steps++) if (at === s.index) return true;
  return false;
}

/** A relayed answer is also logged by the child that asked, as its own answer to a question. Each relayed answer is
 *  paired, one to one, with such an answer in a session it descends to, and then counts once, in the child. First by
 *  the request both logged (the relay's `request_id`, the child's record of your answer); then, for the rest, nearest
 *  first within 10 s (in real logs, the same second), never with an answer logged for a different request. Unpaired,
 *  the relay is the only record and counts. The relay's target is an app project ID, not a session ID, so without a
 *  request ID the pair is found by family, kind and time, never by time alone. */
function countRelayedAnswersOnce(sessions: readonly PreparedSession[]): void {
  const claimed = new Set<TimelineAnswer>();
  const relays = sessions.flatMap(s => s.answers.filter(x => x.kind === 'relay').map(a => ({ s, a })));
  const candidates = (s: PreparedSession) => sessions.filter(d => d !== s && d.root === s.root && descendsFrom(d, s, sessions))
    .flatMap(d => d.answers.filter(x => x.kind === 'question' && !claimed.has(x)));
  const pair = (a: TimelineAnswer, match: TimelineAnswer | undefined) => {
    if (!match) return false;
    a.counted = false;
    claimed.add(match);
    return true;
  };
  const relayIds = new Set(relays.map(r => r.a.rid).filter(Boolean));
  // An answer known to be for another request: the relay's own ID differs, or another relay logged its ID.
  const otherRequest = (x: TimelineAnswer, a: TimelineAnswer) => !!x.rid && x.rid !== a.rid && (!!a.rid || relayIds.has(x.rid));
  const unpaired = relays.filter(({ s, a }) => !(a.rid && pair(a, candidates(s).find(x => x.rid === a.rid))));
  for (const { s, a } of unpaired) {
    pair(a, candidates(s)
      .filter(x => Math.abs(x.at - a.at) <= RELAY_MATCH_MS && !otherRequest(x, a))
      .sort((x, y) => Math.abs(x.at - a.at) - Math.abs(y.at - a.at))[0]);
  }
}
/** Your answer to a question or permission prompt: when the harness recorded it, else when its result came. Asked at
 *  the request, or at the answer when the answer was recorded first. */
function answerOf(w: TimelineTurnWait): TimelineAnswer {
  const at = w.at ?? w.e;
  const waited = waitedOnYou(w) && at <= w.e ? { waited: [w.s, w.e] as Interval } : {};
  return { at, start: Math.min(w.s, at), ...waited, instant: w.s === w.e && at === w.s, kind: w.k, counted: true, ...(w.rid ? { rid: w.rid } : {}) };
}

/** Links each session to its family, derives its work, waits and inputs, and counts turns, agent time and waiting
 *  per day. */
export function prepareTimeline(data: TimelineDataset): PreparedTimeline {
  const records = data.sessions;
  const bounds: Interval = [data.from ?? -Infinity, data.to ?? Infinity];
  const sessions: PreparedSession[] = records.map((s, index) => {
    const context = s.context ?? [];
    const all = [...context, ...s.turns].sort((a, b) => a.t - b.t);
    const stops = s.stops ?? [];
    const { waits, away } = sessionWaits(all, stops);
    return {
      ...s, index, root: index, depth: 0, children: 0, context, all,
      work: sessionWork(all),
      waits,
      waiting: mergeIntervals(waits.map(w => [w.start, w.end])),
      answers: [...all.flatMap(t => t.w ?? []), ...stops].filter(w => w.a)
        .map((w): TimelineAnswer => answerOf(w)).sort((a, b) => a.at - b.at),
      away,
    };
  });
  for (const s of sessions) {
    let at = s.index;
    let depth = 0;
    while (records[at].parent >= 0 && depth < MAX_DEPTH) {
      at = records[at].parent;
      depth++;
    }
    s.root = at;
    s.depth = depth;
    if (s.parent >= 0) sessions[s.parent].children++;
  }
  countRelayedAnswersOnce(sessions);
  const familySize = new Map<number, number>();
  const members = new Map<number, PreparedSession[]>();
  for (const s of sessions) {
    familySize.set(s.root, (familySize.get(s.root) ?? 0) + 1);
    members.set(s.root, [...(members.get(s.root) ?? []), s]);
  }
  const stretches = new Map<number, Interval[]>();
  for (const [root, list] of members) {
    stretches.set(root, unattendedStretches(list.flatMap(inputsOf), mergeIntervals(list.flatMap(s => s.work))));
  }
  const dayTotals = new Map<string, DayTotals>();
  const totalsOf = (day: string): DayTotals => {
    let totals = dayTotals.get(day);
    if (!totals) dayTotals.set(day, totals = { typed: 0, automated: 0, agentMs: 0, waitMs: 0 });
    return totals;
  };
  let totalCredits = 0;
  const active = sessions.filter(s => !s.ctx);
  for (const s of active) {
    for (const t of s.turns) {
      const totals = totalsOf(toDateStr(t.t));
      if (t.k === 'you') totals.typed++;
      else totals.automated++;
      totalCredits += t.cr;
    }
    for (const [a, b] of clipIntervals(s.work, bounds)) forEachDay(a, b, (day, ms) => { totalsOf(day).agentMs += ms; });
    for (const [a, b] of clipIntervals(s.waiting, bounds)) forEachDay(a, b, (day, ms) => { totalsOf(day).waitMs += ms; });
    // An answer is a point in time: its day is active even when nothing else happened on it.
    for (const a of s.answers) if (a.at >= bounds[0] && a.at < bounds[1]) totalsOf(toDateStr(a.at));
  }
  return {
    sessions,
    days: [...dayTotals.keys()].sort(),
    dayTotals,
    familySize,
    stretches,
    totalCredits,
    harnesses: [...new Set(active.map(s => s.harness))].sort(),
    forkedSessions: data.forkedSessions,
    bounds,
  };
}

/** Splits [a, b) at local midnights (23 or 25 h on daylight-saving days). */
function forEachDay(a: number, b: number, add: (day: string, ms: number) => void): void {
  let from = a;
  while (from < b) {
    const day = toDateStr(from);
    const next = Math.min(b, addDays(dayStart(day), 1));
    if (next <= from) return;
    add(day, next - from);
    from = next;
  }
}

/* ---- windows and navigation ---- */

export function dayStart(date: string): number {
  return new Date(date + 'T00:00:00').getTime();
}

/** `days` calendar days later, at the same local clock time (not `days × 24 h`, which daylight saving breaks). */
export function addDays(ts: number, days: number): number {
  const d = new Date(ts);
  d.setDate(d.getDate() + days);
  return d.getTime();
}

/** Monday 00:00 of the week holding `date`. */
export function weekStart(date: string): number {
  const d = new Date(date + 'T00:00:00');
  d.setDate(d.getDate() - (d.getDay() + 6) % 7);
  return d.getTime();
}

/** The [start, end) of the day or week holding `date`. */
export function timelineWindow(view: 'day' | 'week', date: string): Interval {
  const start = view === 'week' ? weekStart(date) : dayStart(date);
  return [start, addDays(start, view === 'week' ? 7 : 1)];
}

/** The active day `dir` days or weeks from `date`, or null at either end. */
export function stepDate(view: 'day' | 'week', date: string, dir: -1 | 1, days: readonly string[]): string | null {
  if (view === 'week') {
    const [start, end] = timelineWindow('week', date);
    return dir < 0
      ? [...days].reverse().find(d => dayStart(d) < start) ?? null
      : days.find(d => dayStart(d) >= end) ?? null;
  }
  const i = days.indexOf(date);
  if (i < 0) return dir < 0 ? [...days].reverse().find(d => d < date) ?? null : days.find(d => d > date) ?? null;
  return days[i + dir] ?? null;
}

/** Local midnights from `start` up to `end`, one per day (on daylight-saving days the hours between differ). */
export function dayTicks(start: number, end: number): number[] {
  const ticks: number[] = [];
  for (let at = start; at < end && ticks.length < 400; at = addDays(at, 1)) ticks.push(at);
  return ticks;
}

/** Each local full hour from `start` up to `end`, in steps of `step` hours of the clock. */
export function hourTicks(start: number, end: number, step: number): number[] {
  const ticks: number[] = [];
  const d = new Date(start);
  d.setMinutes(0, 0, 0);
  if (d.getTime() < start) d.setHours(d.getHours() + 1);
  for (; d.getTime() < end && ticks.length < 400; d.setTime(d.getTime() + 3_600_000)) {
    if (d.getHours() % step === 0) ticks.push(d.getTime());
  }
  return ticks;
}

/* ---- lanes ---- */

export interface TimelineLane {
  s: PreparedSession;
  /** Turns that started in the window, in time order: what the counts count. */
  turns: TimelineTurn[];
  /** Agent work inside the window, merged: what the lane draws. */
  segments: Interval[];
  typed: number;
  automated: number;
  /** Questions and permission prompts you answered in the window (relayed ones count in the child that asked). */
  answered: number;
  /** Agent time inside the window. */
  agentMs: number;
  /** Time waiting on you inside the window. */
  waitMs: number;
  credits: number;
  tokens: number;
  /** When its activity in the window started. */
  first: number;
  /** When its activity in the window ended. */
  last: number;
  subagents: number;
  /** The session's waits that overlap the window (whole spans; `clippedMs` gives the part inside). */
  waits: TimelineWait[];
  /** Gaps over 2 h before one of your prompts in the window. */
  away: number;
  /** Nearest ancestor shown in the same view, -1 when none is. */
  visibleParent: number;
  /** The window the lane was built for. */
  win: Interval;
}

/** One lane per session with activity in [from, to) (a turn, agent work, waiting on you or an answer), clipped to the
 *  range. Context records never get a lane. */
export function buildLanes(p: PreparedTimeline, from: number, to: number): TimelineLane[] {
  const start = Math.max(from, p.bounds[0]);
  const end = Math.min(to, p.bounds[1]);
  const win: Interval = [start, end];
  const lanes: TimelineLane[] = [];
  if (start >= end) return lanes;
  for (const s of p.sessions) {
    if (s.ctx) continue;
    const turns = s.turns.filter(t => t.t >= start && t.t < end);
    const segments = clipIntervals(s.work, win);
    const waits = s.waits.filter(w => w.start < end && w.end > start);
    const answers = s.answers.filter(a => a.at >= start && a.at < end);
    if (turns.length === 0 && segments.length === 0 && waits.length === 0 && answers.length === 0) continue;
    const typed = turns.filter(t => t.k === 'you').length;
    const waiting = clipIntervals(s.waiting, win);
    const edges = [...turns.map(t => t.t), ...segments.flat(), ...waiting.flat(), ...answers.map(a => a.at)];
    lanes.push({
      s,
      turns,
      segments,
      typed,
      automated: turns.length - typed,
      answered: answers.filter(a => a.counted).length,
      agentMs: intervalsMs(segments),
      waitMs: intervalsMs(waiting),
      credits: sum(turns, t => t.cr),
      tokens: sum(turns, t => t.tok),
      first: Math.min(...edges),
      last: Math.max(...edges),
      subagents: sum(turns, t => t.sub),
      waits,
      away: s.away.filter(([, b]) => b >= start && b < end).length,
      visibleParent: -1,
      win,
    });
  }
  return lanes;
}

export interface LaneFilters {
  /** Short harness label; empty for every harness. */
  harness: string;
  /** Matches the repository or model. */
  query: string;
  onlyFamilies: boolean;
  youTyped: boolean;
  waitedOnYou: boolean;
  usedSubagents: boolean;
  hideOneTurn: boolean;
}

export const NO_LANE_FILTERS: LaneFilters = {
  harness: '', query: '', onlyFamilies: false, youTyped: false, waitedOnYou: false, usedSubagents: false, hideOneTurn: false,
};

export function hasLaneFilters(f: LaneFilters): boolean {
  return f.harness !== '' || f.query.trim() !== '' || f.onlyFamilies || f.youTyped || f.waitedOnYou || f.usedSubagents || f.hideOneTurn;
}

/** The lanes the filters keep. `repoLabel` is the repository as shown (masked or not), so search matches the screen. */
export function filterLanes(
  lanes: readonly TimelineLane[], f: LaneFilters, p: PreparedTimeline, repoLabel: (s: PreparedSession) => string = s => s.repo,
): TimelineLane[] {
  const q = f.query.trim().toLowerCase();
  return lanes.filter(l => (!f.harness || l.s.harness === f.harness)
    && (!q || repoLabel(l.s).toLowerCase().includes(q) || l.s.model.toLowerCase().includes(q))
    && (!f.onlyFamilies || (p.familySize.get(l.s.root) ?? 1) > 1)
    && (!f.youTyped || l.typed > 0)
    && (!f.waitedOnYou || l.waitMs > 0)
    && (!f.usedSubagents || l.subagents > 0)
    && (!f.hideOneTurn || l.turns.length > 1));
}

/* ---- families within a view ---- */

export interface ViewFamily {
  root: number;
  lanes: TimelineLane[];
  /** Lanes in tree order with their depth under the family's top shown session. */
  ordered: { lane: TimelineLane; depth: number }[];
  first: number;
  /** Sessions in the whole family, shown or not. */
  size: number;
  typed: number;
  automated: number;
  answered: number;
  agentMs: number;
  credits: number;
  tokens: number;
  /** The family's longest unattended stretch inside the window, over all its members. */
  unattendedMs: number;
  /** Share of the shown sessions' credits (%). */
  share: number;
  /** Color slot for families of 2+ sessions; -1 for a lone session. */
  color: number;
}

/** The family's longest unattended stretch inside the window. */
export function familyUnattendedMs(p: PreparedTimeline, root: number, win: Interval): number {
  return Math.max(0, ...(p.stretches.get(root) ?? []).map(([a, b]) => overlap(a, b, Math.max(win[0], p.bounds[0]), Math.min(win[1], p.bounds[1]))));
}

/** Most sessions doing agent work at once inside the lanes' window, and when that first happened. */
export function peakParallel(lanes: readonly TimelineLane[]): { count: number; at: number | null } {
  const events: [number, number][] = [];
  for (const l of lanes) for (const [a, b] of l.segments) events.push([a, 1], [b, -1]);
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let current = 0;
  let count = 0;
  let at: number | null = null;
  for (const [time, delta] of events) {
    current += delta;
    if (current > count) {
      count = current;
      at = time;
    }
  }
  return { count, at };
}

/** Groups lanes by family, in order of first activity; a lane's tree parent is its nearest shown ancestor. */
export function buildViewFamilies(lanes: TimelineLane[], p: PreparedTimeline): ViewFamily[] {
  const byRoot = new Map<number, TimelineLane[]>();
  for (const l of lanes) {
    const list = byRoot.get(l.s.root) ?? [];
    list.push(l);
    byRoot.set(l.s.root, list);
  }
  const totalCredits = sum(lanes, l => l.credits);
  const families: ViewFamily[] = [];
  for (const [root, members] of byRoot) {
    const shown = new Map(members.map(l => [l.s.index, l]));
    const kids = new Map<number, TimelineLane[]>();
    for (const l of members) {
      let at = l.s.parent;
      let guard = 0;
      l.visibleParent = -1;
      while (at >= 0 && guard++ < MAX_DEPTH) {
        if (shown.has(at)) {
          l.visibleParent = at;
          break;
        }
        at = p.sessions[at].parent;
      }
      const list = kids.get(l.visibleParent) ?? [];
      list.push(l);
      kids.set(l.visibleParent, list);
    }
    for (const list of kids.values()) list.sort((a, b) => a.first - b.first || a.s.index - b.s.index);
    const ordered: ViewFamily['ordered'] = [];
    const walk = (l: TimelineLane, depth: number): void => {
      ordered.push({ lane: l, depth });
      for (const child of kids.get(l.s.index) ?? []) walk(child, depth + 1);
    };
    for (const top of kids.get(-1) ?? []) walk(top, 0);
    const credits = sum(members, l => l.credits);
    families.push({
      root,
      lanes: members,
      ordered,
      first: Math.min(...members.map(l => l.first)),
      size: p.familySize.get(root) ?? members.length,
      typed: sum(members, l => l.typed),
      automated: sum(members, l => l.automated),
      answered: sum(members, l => l.answered),
      agentMs: sum(members, l => l.agentMs),
      credits,
      tokens: sum(members, l => l.tokens),
      unattendedMs: familyUnattendedMs(p, root, members[0].win),
      share: totalCredits > 0 ? 100 * credits / totalCredits : 0,
      color: -1,
    });
  }
  families.sort((a, b) => a.first - b.first || a.root - b.root);
  let slot = 0;
  for (const f of families) if (f.size > 1) f.color = slot++;
  return families;
}

export interface TimelineKpis {
  sessions: number;
  turns: number;
  typed: number;
  /** Questions and permission prompts you answered. */
  answered: number;
  agentMs: number;
  /** Agent time per typed prompt (ms); null without typed prompts. */
  agentMsPerPrompt: number | null;
  unattendedMs: number;
  /** Waits that started in the window: after a turn (`idleWaits`) or for an answer inside one. */
  waits: number;
  idleWaits: number;
  /** Time waiting on you inside the window. */
  waitMs: number;
  /** Waits that started in the window and lasted 30 min or more. */
  longWaits: number;
  /** Gaps over 2 h before your next prompt: time away, not counted as waiting. */
  away: number;
  peak: { count: number; at: number | null };
  credits: number;
  /** Share of the shown credits in child sessions (%). */
  childCreditShare: number;
  childLanes: number;
}

/** Waits of the lanes that started in their window. */
function startedWaits(lanes: readonly TimelineLane[]): TimelineWait[] {
  const win = lanes[0]?.win ?? [-Infinity, Infinity];
  return lanes.flatMap(l => l.waits).filter(w => w.start >= win[0] && w.start < win[1]);
}

export function timelineKpis(lanes: readonly TimelineLane[], families: readonly ViewFamily[]): TimelineKpis {
  const started = startedWaits(lanes);
  const typed = sum(lanes, l => l.typed);
  const agentMs = sum(lanes, l => l.agentMs);
  const credits = sum(lanes, l => l.credits);
  const children = lanes.filter(l => l.s.parent >= 0);
  return {
    sessions: lanes.length,
    turns: sum(lanes, l => l.turns.length),
    typed,
    answered: sum(lanes, l => l.answered),
    agentMs,
    agentMsPerPrompt: typed > 0 ? agentMs / typed : null,
    unattendedMs: Math.max(0, ...families.map(f => f.unattendedMs)),
    waits: started.length,
    idleWaits: started.filter(w => w.kind === 'idle').length,
    waitMs: sum(lanes, l => l.waitMs),
    longWaits: started.filter(w => w.end - w.start >= LONG_WAIT_MS).length,
    away: sum(lanes, l => l.away),
    peak: peakParallel(lanes),
    credits,
    childCreditShare: credits > 0 ? 100 * sum(children, l => l.credits) / credits : 0,
    childLanes: children.length,
  };
}

/* ---- names ---- */

/** Display names. With `masked`, names say only what the session was, and repositories become letters. */
export interface Namer {
  name(s: PreparedSession): string;
  repo(s: PreparedSession): string;
  branch(s: PreparedSession): string;
  /** The model; with `masked`, a name that isn't a common public model ID becomes a letter (custom names can identify
   *  you). */
  model(s: PreparedSession): string;
}

function letters(n: number): string {
  return (n >= 26 ? letters(Math.floor(n / 26) - 1) : '') + String.fromCharCode(65 + (n % 26));
}

/** Shown for a session that logged no repository or folder. */
export const NO_REPOSITORY = 'no repository';

export function createNamer(p: PreparedTimeline, masked: boolean): Namer {
  const repoCredits = new Map<string, number>();
  for (const s of p.sessions) repoCredits.set(s.repo, (repoCredits.get(s.repo) ?? 0) + sum(s.turns, t => t.cr));
  const repoMask = new Map<string, string>();
  for (const [i, [repo]] of [...repoCredits.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).entries()) repoMask.set(repo, `Repository ${letters(i)}`);
  // A model name can be a deployment you named, even behind a provider's prefix, so every one is masked.
  const modelMask = new Map([...new Set(p.sessions.map(s => s.model).filter(Boolean))].sort().map((m, i) => [m, `Model ${letters(i)}`]));
  return {
    name: s => {
      if (masked) return `${s.parent < 0 ? 'Session' : 'Child session'} ${s.index + 1}`;
      if (s.name) return s.name;
      const first = s.turns[0]?.t ?? s.all[0]?.t;
      const when = first ? new Date(first).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '';
      return `Untitled ${s.harness} session ${s.index + 1}${when ? ' · ' + when : ''}`;
    },
    repo: s => (masked ? repoMask.get(s.repo) ?? 'Repository' : s.repo || NO_REPOSITORY),
    branch: s => (masked ? '' : s.branch),
    model: s => (masked && s.model ? modelMask.get(s.model) ?? 'Model' : s.model),
  };
}

/** What the session was in its family: `coordinator · 3 children`, `child`, `grandchild`, `descendant · depth 3` or
 *  `session`. */
export function roleOf(s: PreparedSession): string {
  if (s.parent < 0) return s.children > 0 ? `coordinator · ${s.children} ${s.children === 1 ? 'child' : 'children'}` : 'session';
  if (s.depth === 1) return 'child';
  return s.depth === 2 ? 'grandchild' : `descendant · depth ${s.depth}`;
}

/* ---- formatting ---- */

/** `2 h 05 m`, `12 min`, `<1 min`. */
export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes >= 60) return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} m`;
  if (ms > 0 && minutes < 1) return '<1 min';
  return `${minutes} min`;
}

/** `8.5 h` above an hour, `12 min` below. */
export function formatHours(ms: number): string {
  const minutes = ms / 60_000;
  if (minutes < 60) return `${Math.round(minutes)} min`;
  return `${(minutes / 60).toFixed(minutes >= 600 ? 0 : 1)} h`;
}

export function formatClock(ts: number): string {
  const d = new Date(ts);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Clock time in a day view, weekday and clock time in a week view. */
export function formatWhen(ts: number, view: 'day' | 'week'): string {
  return view === 'week'
    ? `${new Date(ts).toLocaleDateString(undefined, { weekday: 'short' })} ${formatClock(ts)}`
    : formatClock(ts);
}

/** Whole AI credits, `1,234`. */
export function formatCredits(credits: number): string {
  return Math.round(credits).toLocaleString('en-US');
}

/** A count of things (prompts, sessions), `1,234`. */
export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

function plural(n: number, one: string, many: string): string {
  return `${formatCount(n)} ${n === 1 ? one : many}`;
}

/** `typed 3 prompts into it and answered 2 questions or permission prompts in it`; empty without either. */
function inputWords(typed: number, answered: number, into: string, inside: string): string {
  return [typed > 0 ? `typed ${plural(typed, 'prompt', 'prompts')} into ${into}` : '',
    answered > 0 ? `answered ${plural(answered, 'question or permission prompt', 'questions or permission prompts')} in ${inside}` : '']
    .filter(Boolean).join(' and ');
}

const them = (n: number) => (n === 1 ? 'it' : 'them');

/* ---- coaching callouts (H) ---- */

/** The three findings of a day or week, as plain sentences: only what the logs show. */
export function viewInsights(
  lanes: readonly TimelineLane[], families: readonly ViewFamily[], namer: Namer, period: 'day' | 'week', p?: PreparedTimeline,
): string[] {
  const when = period === 'week' ? 'this week' : 'on this day';
  return [unattendedInsight(families, namer, when, p), creditsInsight(lanes, namer, when), waitsInsight(lanes, when)];
}

function unattendedInsight(families: readonly ViewFamily[], namer: Namer, when: string, p?: PreparedTimeline): string {
  const top = [...families].sort((a, b) => b.unattendedMs - a.unattendedMs)[0];
  if (!top || top.unattendedMs < UNATTENDED_CALLOUT_MS) {
    const unknown = sum(families, f => sum(f.lanes, l => l.turns.filter(t => t.noDuration).length));
    return `No measured stretch of agent work ran more than 5 min after one of your prompts or answers ${when} before it paused or met your next input.`
      + (unknown > 0 ? ` ${plural(unknown, 'turn has', 'turns have')} no logged duration, so ${unknown === 1 ? 'its' : 'their'} work isn’t measured.` : '');
  }
  const rootLane = top.lanes.find(l => l.s.index === top.root);
  const shown = `${formatCount(top.lanes.length)} of ${plural(top.size, 'session', 'sessions')} shown`;
  let who: string;
  if (top.size === 1 && rootLane) who = `your session “${namer.name(rootLane.s)}”`;
  else if (rootLane) who = `the family of your coordinator “${namer.name(rootLane.s)}” (${shown})`;
  else if (p) who = `the family of “${namer.name(p.sessions[top.root])}”, whose coordinator isn’t shown here (${shown})`;
  else who = `a family whose coordinator isn’t shown here (${shown})`;
  return `The longest unattended stretch ${when} was ${formatDuration(top.unattendedMs)}, in ${who}: agent work kept running after one of your prompts or answers, with no pause over 2 min, until it stopped or you gave your next prompt or answer anywhere in the family.`;
}
function creditsInsight(lanes: readonly TimelineLane[], namer: Namer, when: string): string {
  const credits = sum(lanes, l => l.credits);
  const children = lanes.filter(l => l.s.parent >= 0);
  if (credits <= 0) return `No AI credits were logged ${when}. Only Copilot logs credits; other harnesses show time and turns.`;
  if (children.length === 0) {
    return `None of the ${plural(lanes.length, 'session', 'sessions')} shown has a linked parent session, so none of the credits went to child sessions.`;
  }
  const childCredits = sum(children, l => l.credits);
  if (childCredits <= 0) return `The ${plural(children.length, 'child session', 'child sessions')} shown logged no AI credits ${when}.`;
  const big = [...children].sort((a, b) => b.credits - a.credits)[0];
  const input = inputWords(big.typed, big.answered, 'it', 'it');
  return `Child sessions used ${(100 * childCredits / credits).toFixed(1)}% of the credits shown. The child “${namer.name(big.s)}” used ${Math.round(100 * big.credits / credits)}%`
    + (input ? `; you ${input} ${when}.` : `; no prompt or answer from you was recorded in it ${when}.`);
}

function waitsInsight(lanes: readonly TimelineLane[], when: string): string {
  const started = startedWaits(lanes);
  const total = sum(lanes, l => l.waitMs);
  const away = sum(lanes, l => l.away);
  const answered = sum(lanes, l => l.answered);
  const answers = plural(answered, 'question or permission prompt', 'questions or permission prompts');
  if (total <= 0) {
    // Answers here whose wait took no time; those that ended a wait measured before this period; and those recorded
    // with no wait measured at all (before their request was logged, or after its result).
    const here = lanes.flatMap(l => l.s.answers.filter(a => a.counted && a.at >= l.win[0] && a.at < l.win[1]).map(a => ({ a, from: l.win[0] })));
    const instant = here.filter(({ a }) => a.instant).length;
    const earlier = here.filter(({ a, from }) => a.waited && a.waited[0] < from).length;
    const unmeasured = here.length - instant - earlier;
    const how: [number, string][] = [
      [instant, 'took no measurable time'], [earlier, 'ended a wait that began earlier'], [unmeasured, 'had no waiting time measured in this period'],
    ];
    const present = how.filter(([n]) => n > 0);
    const detail = present.length > 1
      ? `: ${present.map(([n, text]) => `${n} ${text}`).join(', and ')}`
      : ` that ${present[0]?.[1] ?? 'took no measurable time'}`;
    const none = `No time waiting on you was measured ${when}: no gap of 2–120 min before your next prompt`
      + (answered > 0 ? `, and you answered ${answers}${detail}.` : ', and no question or permission prompt you answered.');
    return away > 0 ? `${none} ${plural(away, 'longer gap', 'longer gaps')} before your next prompt ${away === 1 ? 'counts' : 'count'} as time away, not waiting.` : none;
  }
  const answeredHere = answered > 0 ? ` You answered ${answers} ${when}.` : '';
  if (started.length === 0) return `Only waits that started earlier ran into this period: ${formatDuration(total)} of waiting on you.${answeredHere}`;
  const idle = started.filter(w => w.kind === 'idle').length;
  const asked = started.length - idle;
  const long = started.filter(w => w.end - w.start >= LONG_WAIT_MS).length;
  const parts = [idle > 0 ? `${plural(idle, 'gap', 'gaps')} of 2–120 min before your next prompt (inferred waits)` : '',
    asked > 0 ? `${plural(asked, 'stop', 'stops')} on a question or permission prompt you answered` : ''].filter(Boolean).join(' and ');
  return `Waiting on you ${when}: ${parts}, ${formatDuration(total)} in total`
    + (long > 0
      ? `; ${plural(long, 'wait', 'waits')} lasted 30 min or more. Answering from the session list, or letting autopilot carry on with routine steps, could shorten such waits.`
      : '.')
    + (answered !== asked ? answeredHere : '');
}
/* ---- families over the whole range ---- */

export type FamilyVerdict = 'alone' | 'needed';

/** What the logs show about each family's children, and one habit to consider. Observations, not causes. */
export const VERDICTS: Record<FamilyVerdict | 'wide', { label: string; habit: string }> = {
  alone: {
    label: 'No input in children',
    habit: 'If this delegation went the way you wanted, its opening prompt could become a prompt file or skill, so the next one starts the same way.',
  },
  needed: {
    label: 'You stepped in',
    habit: 'Open the child sessions marked ✋ to see what you typed or answered there. If the coordinator could have passed that on, you might add it to its brief next time.',
  },
  wide: {
    label: 'Wide fan-out',
    habit: 'You could check whether the child sessions overlap, and whether each one needs its own scope and model.',
  },
};

export interface FamilyNode {
  s: PreparedSession;
  /** Depth below the coordinator. */
  depth: number;
  /** A context record: no activity in range, or hidden by the sidebar filters. Not counted. */
  ctx: boolean;
  typed: number;
  automated: number;
  /** Questions and permission prompts you answered in it. */
  answered: number;
  agentMs: number;
  credits: number;
  tokens: number;
  first: number;
  last: number;
  subagents: number;
}

export interface FamilySummary {
  root: number;
  s: PreparedSession;
  /** Every session of the family in tree order, the coordinator first; context records included (`ctx`). */
  nodes: FamilyNode[];
  /** Sessions in the family, with or without activity in range: what the minimum-size filter counts. */
  members: number;
  /** Counts below are of the sessions with activity in range. */
  sessions: number;
  children: number;
  depth: number;
  fanOut: number;
  /** Distinct repositories of the members with activity in range. */
  repos: number;
  /** The member whose repository the family is shown with: one of those `repos` (the coordinator when active). */
  repoSession: PreparedSession;
  harnesses: string[];
  typed: number;
  coordinatorTyped: number;
  /** The coordinator has activity in range. */
  coordinatorActive: boolean;
  /** Prompts you typed into child sessions. */
  childTyped: number;
  /** Questions and permission prompts you answered in child sessions. */
  childAnswered: number;
  /** Child sessions you typed into or answered in. */
  steppedInto: number;
  automated: number;
  agentMs: number;
  credits: number;
  childCredits: number;
  tokens: number;
  /** Share of all credits in range (%). */
  creditShare: number;
  /** Share of the family's credits in its children (%). */
  childShare: number;
  perChild: number;
  verdict: FamilyVerdict;
  wide: boolean;
  from: string;
  to: string;
  /** The day with most of the family's turns. */
  busiest: string;
  /** 1 for the family that used most credits. */
  rank: number;
}

export interface FamiliesTotals {
  sessions: number;
  families: number;
  sessionsInFamilies: number;
  children: number;
  creditShare: number;
  childCreditShare: number;
  tokenShare: number;
  agentMs: number;
  agentShare: number;
  /** All agent time in range, families or not: the share's denominator (a share of zero is real when it's positive). */
  totalAgentMs: number;
  typed: number;
  automated: number;
  childTyped: number;
  childAnswered: number;
  childrenNeedingYou: number;
  maxDepth: number;
  maxFanOut: number;
  top3Share: number;
  alone: { families: number; creditShare: number; avgCredits: number };
  needed: { families: number; creditShare: number; avgCredits: number };
  wide: { families: number; creditShare: number };
  totalCredits: number;
}

export interface FamiliesOverview {
  families: FamilySummary[];
  totals: FamiliesTotals;
}

function familyNode(s: PreparedSession, depth: number, bounds: Interval): FamilyNode {
  const typed = s.turns.filter(t => t.k === 'you').length;
  const work = clipIntervals(s.work, bounds);
  const answers = s.answers.filter(a => a.counted && a.at >= bounds[0] && a.at < bounds[1]);
  const intervals = [...work, ...clipIntervals(s.waiting, bounds)];
  // Points (turn starts, answers) are dated as they are; an interval ends just before its exclusive end.
  const points = [...s.turns.map(t => t.t), ...answers.map(a => a.at)];
  const starts = [...points, ...intervals.map(([a]) => a)];
  const ends = [...points, ...intervals.map(([a, b]) => Math.max(a, b - 1))];
  return {
    s,
    depth,
    ctx: Boolean(s.ctx),
    typed,
    automated: s.turns.length - typed,
    answered: answers.length,
    agentMs: intervalsMs(work),
    credits: sum(s.turns, t => t.cr),
    tokens: sum(s.turns, t => t.tok),
    first: starts.length ? Math.min(...starts) : 0,
    last: ends.length ? Math.max(...ends) : 0,
    subagents: sum(s.turns, t => t.sub),
  };
}

/** A child session you stepped into: you typed into it, or answered one of its questions or permission prompts. */
export function neededYou(n: Pick<FamilyNode, 'typed' | 'answered'>): boolean {
  return n.typed > 0 || n.answered > 0;
}

function groupBy<K>(sessions: readonly PreparedSession[], key: (s: PreparedSession) => K | null): Map<K, PreparedSession[]> {
  const groups = new Map<K, PreparedSession[]>();
  for (const s of sessions) {
    const k = key(s);
    if (k === null) continue;
    const list = groups.get(k) ?? [];
    list.push(s);
    groups.set(k, list);
  }
  return groups;
}

/** The family's sessions in tree order: each session followed by its children, oldest first. */
function familyNodes(root: PreparedSession, kidsOf: Map<number, PreparedSession[]>, bounds: Interval): FamilyNode[] {
  const nodes: FamilyNode[] = [];
  const walk = (s: PreparedSession, depth: number): void => {
    nodes.push(familyNode(s, depth, bounds));
    const kids = [...(kidsOf.get(s.index) ?? [])].sort((a, b) => (a.all[0]?.t ?? 0) - (b.all[0]?.t ?? 0) || a.index - b.index);
    for (const kid of kids) walk(kid, depth + 1);
  };
  walk(root, 0);
  return nodes;
}

function busiestDayOf(nodes: readonly FamilyNode[]): string {
  const days = new Map<string, number>();
  for (const n of nodes) for (const t of n.s.turns) days.set(toDateStr(t.t), (days.get(toDateStr(t.t)) ?? 0) + 1);
  return [...days.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? '';
}

function summarizeFamily(root: PreparedSession, kidsOf: Map<number, PreparedSession[]>, p: PreparedTimeline): FamilySummary {
  const totalCredits = p.totalCredits;
  const nodes = familyNodes(root, kidsOf, p.bounds);
  const counted = nodes.filter(n => !n.ctx);
  const kids = counted.filter(n => n.depth > 0);
  const credits = sum(counted, n => n.credits);
  const childCredits = sum(kids, n => n.credits);
  const steppedInto = kids.filter(neededYou).length;
  const firsts = counted.map(n => n.first).filter(t => t > 0);
  const lasts = counted.map(n => n.last).filter(t => t > 0);
  const activeKids = (n: FamilyNode) => (kidsOf.get(n.s.index) ?? []).filter(k => !k.ctx).length;
  const coordinator = nodes[0];
  return {
    root: root.index,
    s: root,
    nodes,
    members: nodes.length,
    sessions: counted.length,
    children: kids.length,
    depth: Math.max(0, ...counted.map(n => n.depth)),
    fanOut: Math.max(0, ...nodes.map(activeKids)),
    repos: new Set(counted.map(n => n.s.repo)).size,
    // The repository named first: the coordinator's when it has activity in range, else the first active member's.
    repoSession: (counted[0] ?? coordinator).s,
    harnesses: [...new Set(counted.map(n => n.s.harness))],
    typed: sum(counted, n => n.typed),
    coordinatorTyped: coordinator.ctx ? 0 : coordinator.typed,
    coordinatorActive: !coordinator.ctx,
    childTyped: sum(kids, n => n.typed),
    childAnswered: sum(kids, n => n.answered),
    steppedInto,
    automated: sum(counted, n => n.automated),
    agentMs: sum(counted, n => n.agentMs),
    credits,
    childCredits,
    tokens: sum(counted, n => n.tokens),
    creditShare: totalCredits > 0 ? 100 * credits / totalCredits : 0,
    childShare: credits > 0 ? 100 * childCredits / credits : 0,
    perChild: kids.length > 0 ? childCredits / kids.length : 0,
    verdict: steppedInto > 0 ? 'needed' : 'alone',
    wide: kids.length >= WIDE_FAN_OUT,
    from: firsts.length > 0 ? toDateStr(Math.min(...firsts)) : '',
    to: lasts.length > 0 ? toDateStr(Math.max(...lasts)) : '',
    busiest: busiestDayOf(counted) || (firsts.length > 0 ? toDateStr(Math.min(...firsts)) : ''),
    rank: 0,
  };
}

function familiesTotals(p: PreparedTimeline, families: FamilySummary[]): FamiliesTotals {
  const totalCredits = p.totalCredits;
  const active = p.sessions.filter(s => !s.ctx);
  const totalTokens = sum(active, s => sum(s.turns, t => t.tok));
  const totalAgent = sum(active, s => intervalsMs(clipIntervals(s.work, p.bounds)));
  const share = (part: number, whole: number) => (whole > 0 ? 100 * part / whole : 0);
  const group = (list: FamilySummary[]) => ({
    families: list.length,
    creditShare: sum(list, f => f.creditShare),
    avgCredits: list.length > 0 ? sum(list, f => f.credits) / list.length : 0,
  });
  const wide = families.filter(f => f.wide);
  return {
    sessions: active.length,
    families: families.length,
    sessionsInFamilies: sum(families, f => f.sessions),
    children: sum(families, f => f.children),
    creditShare: share(sum(families, f => f.credits), totalCredits),
    childCreditShare: share(sum(families, f => f.childCredits), totalCredits),
    tokenShare: share(sum(families, f => f.tokens), totalTokens),
    agentMs: sum(families, f => f.agentMs),
    agentShare: share(sum(families, f => f.agentMs), totalAgent),
    totalAgentMs: totalAgent,
    typed: sum(families, f => f.typed),
    automated: sum(families, f => f.automated),
    childTyped: sum(families, f => f.childTyped),
    childAnswered: sum(families, f => f.childAnswered),
    childrenNeedingYou: sum(families, f => f.steppedInto),
    maxDepth: Math.max(0, ...families.map(f => f.depth)),
    maxFanOut: Math.max(0, ...families.map(f => f.fanOut)),
    top3Share: sum(families.slice(0, 3), f => f.creditShare),
    alone: group(families.filter(f => f.verdict === 'alone')),
    needed: group(families.filter(f => f.verdict === 'needed')),
    wide: { families: wide.length, creditShare: sum(wide, f => f.creditShare) },
    totalCredits,
  };
}

/** Every family of two or more sessions with activity in range, ranked by credits, and what they add up to. Members
 *  without activity in range (context records) give the family its structure; they aren't counted. */
export function buildFamilies(p: PreparedTimeline): FamiliesOverview {
  const members = groupBy(p.sessions, s => s.root);
  const kidsOf = groupBy(p.sessions, s => (s.parent >= 0 ? s.parent : null));
  const families = [...members.entries()]
    .filter(([, list]) => list.length > 1 && list.some(s => !s.ctx))
    .map(([root]) => summarizeFamily(p.sessions[root], kidsOf, p))
    .sort((a, b) => b.credits - a.credits || b.agentMs - a.agentMs || b.sessions - a.sessions || a.root - b.root);
  for (const [i, f] of families.entries()) f.rank = i + 1;
  return { families, totals: familiesTotals(p, families) };
}

/** What the logs show about the selected family, in words. */
export function verdictText(f: FamilySummary): string {
  const coordinator = !f.coordinatorActive
    ? 'The coordinator has no activity in this range.'
    : f.coordinatorTyped > 0
      ? `You typed ${plural(f.coordinatorTyped, 'prompt', 'prompts')} into the coordinator.`
      : 'You typed no prompt into the coordinator in this range.';
  const children = f.children === 1 ? 'the child session' : `the ${formatCount(f.children)} child sessions`;
  const base = f.verdict === 'alone'
    ? `No prompt or answer from you was recorded in ${f.children === 0 ? 'any child session' : children} in this range. ${coordinator}`
    : `${formatCount(f.steppedInto)} of ${plural(f.children, 'child session', 'child sessions')} (marked ✋) got input from you: you ${inputWords(f.childTyped, f.childAnswered, them(f.steppedInto), them(f.steppedInto))}. ${coordinator}`;
  if (!f.wide) return base;
  return `${base} It started ${formatCount(f.children)} children` + (f.childCredits > 0 ? `, ${formatCredits(f.perChild)} credits each on average.` : '.');
}

/** What the families add up to, as plain sentences: only what the logs show. */
export function familiesInsights(t: FamiliesTotals): string[] {
  if (t.families === 0) return [];
  const tips: string[] = [];
  const families = (n: number) => plural(n, 'family', 'families');
  const noCredits = 'No AI credits were logged: only Copilot logs credits.';
  if (t.needed.families === 0) {
    tips.push(`No prompt or answer from you was recorded in a child session of ${t.families === 1 ? 'the family' : `any of the ${families(t.families)}`}.`
      + (t.totalCredits > 0 ? ` ${t.families === 1 ? 'It' : 'They'} used ${t.alone.creditShare.toFixed(0)}% of all credits.` : ` ${noCredits}`));
  } else if (t.totalCredits <= 0) {
    tips.push(`You stepped into a child session in ${families(t.needed.families)}; ${formatCount(t.alone.families)} had no input from you in their children. ${noCredits}`);
  } else {
    const needed = `Families where you stepped into a child used ${t.needed.creditShare.toFixed(0)}% of all credits (${families(t.needed.families)}, ${formatCredits(t.needed.avgCredits)} ${formatCredits(t.needed.avgCredits) === '1' ? 'credit' : 'credits'} on average)`;
    tips.push(t.alone.families === 0
      ? `${needed}; every family had input from you in at least one child.`
      : `${needed}; the ${formatCount(t.alone.families)} with no input in ${t.alone.families === 1 ? 'its' : 'their'} children used ${t.alone.creditShare.toFixed(0)}% (${formatCredits(t.alone.avgCredits)} on average).`);
  }
  tips.push(t.childrenNeedingYou > 0
    ? `${formatCount(t.childrenNeedingYou)} of ${plural(t.children, 'child session', 'child sessions')} got input from you: you ${inputWords(t.childTyped, t.childAnswered, them(t.childrenNeedingYou), them(t.childrenNeedingYou))}. Show “${VERDICTS.needed.label}” and open the ✋ children to see where.`
    : t.children === 1 ? 'No prompt or answer from you was recorded in the child session.' : `No prompt or answer from you was recorded in any of the ${formatCount(t.children)} child sessions.`);
  tips.push(t.wide.families > 0
    ? `${plural(t.wide.families, 'family', 'families')} started ${WIDE_FAN_OUT} or more child sessions at any depth (wide fan-out)${t.totalCredits > 0 ? ` and used ${t.wide.creditShare.toFixed(0)}% of all credits` : ''}.`
    : `No family started ${WIDE_FAN_OUT} or more children.`);
  return tips;
}

function sum<T>(items: readonly T[], value: (item: T) => number): number {
  let total = 0;
  for (const item of items) total += value(item);
  return total;
}
