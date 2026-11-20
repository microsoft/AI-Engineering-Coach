/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Timeline model: the Day, Week and Families views derived from a `TimelineDataset`. Pure and browser-safe, so the
 * webview recomputes a view instantly when a filter changes, and the analyzer, chat tools and tests share the rules.
 *
 *   Agent time         sum of the turns' `totalElapsed` (prompt → last assistant message; includes time a turn
 *                      waited on a question).
 *   Waiting on you     per session: from the end of the agent's work to your next typed prompt, 2–120 min.
 *   Unattended         per family: from one of your prompts to the end of the agent work the family started before your
 *                      next prompt. A turn can't outlast your next prompt in its own session, so work that runs past it
 *                      is in another session of the family, one you didn't prompt.
 *   Peak parallel      most turns whose agent time overlapped.
 *   Family             a coordinator session and every session it started, directly or through its children. */

import { toDateStr } from './helpers';
import type { TimelineDataset, TimelineSessionRecord, TimelineTurn } from './types/timeline-types';

export const WAIT_MIN_MS = 2 * 60_000;
export const WAIT_MAX_MS = 120 * 60_000;
export const LONG_WAIT_MS = 30 * 60_000;
/** Children from which a family counts as a wide fan-out. */
export const WIDE_FAN_OUT = 8;
/** Unattended stretches shorter than this aren't called out. */
const UNATTENDED_CALLOUT_MS = 5 * 60_000;
const MAX_DEPTH = 64;

export type TimelineView = 'day' | 'week' | 'families';

export interface PreparedSession extends TimelineSessionRecord {
  index: number;
  /** Index of the family's coordinator (itself for a top-level session). */
  root: number;
  /** 0 for a coordinator or lone session, 1 for a child, 2 for a grandchild… */
  depth: number;
  /** Sessions it started directly. */
  children: number;
}

export interface DayTotals {
  typed: number;
  automated: number;
  agentMs: number;
}

export interface PreparedTimeline {
  sessions: PreparedSession[];
  /** Days with at least one turn, in order. */
  days: string[];
  dayTotals: Map<string, DayTotals>;
  /** Sessions per family, keyed by the family's root index. */
  familySize: Map<number, number>;
  totalCredits: number;
  harnesses: string[];
  forkedSessions: number;
}

/** Links each session to its family and counts turns per day. */
export function prepareTimeline(data: TimelineDataset): PreparedTimeline {
  const records = data.sessions;
  const sessions: PreparedSession[] = records.map((s, index) => ({ ...s, index, root: index, depth: 0, children: 0 }));
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
  const familySize = new Map<number, number>();
  const dayTotals = new Map<string, DayTotals>();
  let totalCredits = 0;
  for (const s of sessions) {
    familySize.set(s.root, (familySize.get(s.root) ?? 0) + 1);
    for (const t of s.turns) {
      const day = toDateStr(t.t);
      const totals = dayTotals.get(day) ?? { typed: 0, automated: 0, agentMs: 0 };
      if (t.k === 'you') totals.typed++;
      else totals.automated++;
      totals.agentMs += t.d;
      dayTotals.set(day, totals);
      totalCredits += t.cr;
    }
  }
  return {
    sessions,
    days: [...dayTotals.keys()].sort(),
    dayTotals,
    familySize,
    totalCredits,
    harnesses: [...new Set(sessions.map(s => s.harness))].sort(),
    forkedSessions: data.forkedSessions,
  };
}

/* ---- windows and navigation ---- */

export function dayStart(date: string): number {
  return new Date(date + 'T00:00:00').getTime();
}

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
export function timelineWindow(view: 'day' | 'week', date: string): [number, number] {
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

/* ---- lanes ---- */

export type Interval = [number, number];

export interface TimelineLane {
  s: PreparedSession;
  turns: TimelineTurn[];
  typed: number;
  automated: number;
  agentMs: number;
  credits: number;
  tokens: number;
  first: number;
  /** End of the last turn's agent time. */
  last: number;
  subagents: number;
  waits: Interval[];
  /** Nearest ancestor shown in the same view, -1 when none is. */
  visibleParent: number;
}

/** Gaps where the agent had finished and waited for your next typed prompt (2–120 min), in time order. */
export function waitsOf(turns: readonly TimelineTurn[]): Interval[] {
  const waits: Interval[] = [];
  let busyUntil = -1;
  for (const t of [...turns].sort((a, b) => a.t - b.t)) {
    if (t.k === 'you' && busyUntil > 0) {
      const gap = t.t - busyUntil;
      if (gap >= WAIT_MIN_MS && gap <= WAIT_MAX_MS) waits.push([busyUntil, t.t]);
    }
    busyUntil = Math.max(busyUntil, t.t + t.d);
  }
  return waits;
}

/** One lane per session with a turn in [start, end). */
export function buildLanes(p: PreparedTimeline, start: number, end: number): TimelineLane[] {
  const lanes: TimelineLane[] = [];
  for (const s of p.sessions) {
    const turns = s.turns.filter(t => t.t >= start && t.t < end);
    if (turns.length === 0) continue;
    const typed = turns.filter(t => t.k === 'you').length;
    lanes.push({
      s,
      turns,
      typed,
      automated: turns.length - typed,
      agentMs: sum(turns, t => t.d),
      credits: sum(turns, t => t.cr),
      tokens: sum(turns, t => t.tok),
      first: turns[0].t,
      last: Math.max(...turns.map(t => t.t + t.d)),
      subagents: sum(turns, t => t.sub),
      waits: waitsOf(turns),
      visibleParent: -1,
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
    && (!f.waitedOnYou || l.waits.length > 0)
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
  /** Sessions in the whole family over the range, shown or not. */
  size: number;
  typed: number;
  automated: number;
  agentMs: number;
  credits: number;
  tokens: number;
  unattendedMs: number;
  /** Share of the shown sessions' credits (%). */
  share: number;
  /** Color slot for families of 2+ sessions in the range; -1 for a lone session. */
  color: number;
}

/** The longest stretch from one of your prompts to the end of the agent work started before your next prompt (ms).
 *  Work started in that window counts to its end: it can only outlast your next prompt in a session you didn't prompt. */
export function unattendedMs(lanes: readonly TimelineLane[]): number {
  const turns = lanes.flatMap(l => l.turns).sort((a, b) => a.t - b.t);
  const prompts = turns.filter(t => t.k === 'you').map(t => t.t);
  let best = 0;
  for (let i = 0; i < prompts.length; i++) {
    const until = prompts[i + 1] ?? Infinity;
    for (const t of turns) {
      if (t.t >= prompts[i] && t.t < until && t.d > 0) best = Math.max(best, t.t + t.d - prompts[i]);
    }
  }
  return best;
}

/** Most turns whose agent time overlapped, and when that first happened. */
export function peakParallel(lanes: readonly TimelineLane[]): { count: number; at: number | null } {
  const events: [number, number][] = [];
  for (const l of lanes) {
    for (const t of l.turns) {
      if (t.d > 0) events.push([t.t, 1], [t.t + t.d, -1]);
    }
  }
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
    for (const list of kids.values()) list.sort((a, b) => a.first - b.first);
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
      agentMs: sum(members, l => l.agentMs),
      credits,
      tokens: sum(members, l => l.tokens),
      unattendedMs: unattendedMs(members),
      share: totalCredits > 0 ? 100 * credits / totalCredits : 0,
      color: -1,
    });
  }
  families.sort((a, b) => a.first - b.first);
  let slot = 0;
  for (const f of families) if (f.size > 1) f.color = slot++;
  return families;
}

export interface TimelineKpis {
  sessions: number;
  turns: number;
  typed: number;
  agentMs: number;
  /** Agent time per typed prompt (ms); null without typed prompts. */
  agentMsPerPrompt: number | null;
  unattendedMs: number;
  waits: number;
  waitMs: number;
  longWaits: number;
  peak: { count: number; at: number | null };
  credits: number;
  /** Share of the shown credits in child sessions (%). */
  childCreditShare: number;
  childLanes: number;
}

export function timelineKpis(lanes: readonly TimelineLane[], families: readonly ViewFamily[]): TimelineKpis {
  const waits = lanes.flatMap(l => l.waits);
  const typed = sum(lanes, l => l.typed);
  const agentMs = sum(lanes, l => l.agentMs);
  const credits = sum(lanes, l => l.credits);
  const children = lanes.filter(l => l.s.parent >= 0);
  return {
    sessions: lanes.length,
    turns: sum(lanes, l => l.turns.length),
    typed,
    agentMs,
    agentMsPerPrompt: typed > 0 ? agentMs / typed : null,
    unattendedMs: Math.max(0, ...families.map(f => f.unattendedMs)),
    waits: waits.length,
    waitMs: sum(waits, ([a, b]) => b - a),
    longWaits: waits.filter(([a, b]) => b - a >= LONG_WAIT_MS).length,
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
}

function letters(n: number): string {
  return (n >= 26 ? letters(Math.floor(n / 26) - 1) : '') + String.fromCharCode(65 + (n % 26));
}

export function createNamer(p: PreparedTimeline, masked: boolean): Namer {
  const repoCredits = new Map<string, number>();
  for (const s of p.sessions) repoCredits.set(s.repo, (repoCredits.get(s.repo) ?? 0) + sum(s.turns, t => t.cr));
  const repoMask = new Map<string, string>();
  for (const [i, [repo]] of [...repoCredits.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).entries()) repoMask.set(repo, `Repository ${letters(i)}`);
  return {
    name: s => {
      if (masked) return `${s.parent < 0 ? 'Session' : 'Child session'} ${s.index + 1}`;
      if (s.name) return s.name;
      const first = s.turns[0]?.t;
      const when = first ? new Date(first).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '';
      return `Untitled ${s.harness} session${when ? ' · ' + when : ''}`;
    },
    repo: s => (masked ? repoMask.get(s.repo) ?? 'Repository' : s.repo || 'unknown'),
    branch: s => (masked ? '' : s.branch),
  };
}

/** What the session was in its family: `coordinator · 3 children`, `child`, `grandchild` or `session`. */
export function roleOf(s: PreparedSession): string {
  if (s.parent < 0) return s.children > 0 ? `coordinator · ${s.children} ${s.children === 1 ? 'child' : 'children'}` : 'session';
  return s.depth === 1 ? 'child' : 'grandchild';
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

export function formatCredits(credits: number): string {
  return Math.round(credits).toLocaleString('en-US');
}

/* ---- coaching callouts (H) ---- */

/** The three findings of a day or week, as plain sentences. */
export function viewInsights(
  lanes: readonly TimelineLane[], families: readonly ViewFamily[], namer: Namer, period: 'day' | 'week',
): string[] {
  const when = period === 'week' ? 'this week' : 'on this day';
  const tips: string[] = [];
  const top = [...families].sort((a, b) => b.unattendedMs - a.unattendedMs)[0];
  if (top && top.unattendedMs >= UNATTENDED_CALLOUT_MS) {
    const name = namer.name(top.lanes.find(l => l.s.index === top.root)?.s ?? top.lanes[0].s);
    const others = top.lanes.length - 1;
    tips.push((others > 0
      ? `Your coordinator “${name}” and ${others} ${others === 1 ? 'session' : 'sessions'} it started kept working ${formatDuration(top.unattendedMs)} after one of your prompts, with no further prompt into the sessions doing that work (${top.typed} typed, ${top.automated} automated turns).`
      : `Your session “${name}” kept working ${formatDuration(top.unattendedMs)} after one of your prompts, with no further input from you.`)
      + ' Reuse the brief that made this work.');
  } else {
    tips.push(`No agent worked more than 5 min on its own after one of your prompts ${when}.`);
  }
  const credits = sum(lanes, l => l.credits);
  const children = lanes.filter(l => l.s.parent >= 0);
  if (credits <= 0) {
    tips.push(`No AI credits were logged ${when}. Only Copilot logs credits; other harnesses show time and turns.`);
  } else if (children.length > 0) {
    const share = 100 * sum(children, l => l.credits) / credits;
    const big = [...children].sort((a, b) => b.credits - a.credits)[0];
    tips.push(`Child sessions used ${share.toFixed(1)}% of the credits. The child “${namer.name(big.s)}” alone used ${Math.round(100 * big.credits / credits)}%`
      + (big.typed > 0
        ? `, and you typed ${big.typed} ${big.typed === 1 ? 'prompt' : 'prompts'} into it directly: open it to see why it needed you.`
        : ', with no prompts from you.'));
  } else {
    tips.push(`No session started another one ${when}; all ${lanes.length} ${lanes.length === 1 ? 'session was' : 'sessions were'} started by you.`);
  }
  const waits = lanes.flatMap(l => l.waits);
  if (waits.length > 0) {
    const long = waits.filter(([a, b]) => b - a >= LONG_WAIT_MS).length;
    tips.push(`Agents finished and waited for you ${waits.length} ${waits.length === 1 ? 'time' : 'times'}, ${formatDuration(sum(waits, ([a, b]) => b - a))} in total`
      + (long > 0
        ? `; ${long} ${long === 1 ? 'wait was' : 'waits were'} longer than 30 min. Answer from the session list, or let autopilot carry on with routine steps.`
        : '.'));
  } else {
    tips.push('Agents never waited on you for more than 2 min.');
  }
  return tips;
}

/* ---- families over the whole range ---- */

export type FamilyVerdict = 'alone' | 'needed';

export const VERDICTS: Record<FamilyVerdict | 'wide', { label: string; habit: string }> = {
  alone: {
    label: 'Worked alone',
    habit: 'Reuse this brief: copy the coordinator’s opening prompt into a prompt file or skill, so the next delegation starts the same way.',
  },
  needed: {
    label: 'Needed you',
    habit: 'Open the child sessions you stepped into (marked ✋) and note what was missing. Put that context, files or acceptance criteria into the coordinator’s brief next time.',
  },
  wide: {
    label: 'Wide fan-out',
    habit: 'Check whether the child sessions overlap. Give each one a narrow scope and the cheapest model that works.',
  },
};

export interface FamilyNode {
  s: PreparedSession;
  /** Depth below the coordinator. */
  depth: number;
  typed: number;
  automated: number;
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
  /** Every session of the family in tree order, the coordinator first. */
  nodes: FamilyNode[];
  sessions: number;
  children: number;
  depth: number;
  fanOut: number;
  repos: number;
  harnesses: string[];
  typed: number;
  coordinatorTyped: number;
  /** Prompts you typed into child sessions. */
  childTyped: number;
  /** Child sessions you typed into. */
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
  typed: number;
  automated: number;
  childTyped: number;
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

function familyNode(s: PreparedSession, depth: number): FamilyNode {
  const typed = s.turns.filter(t => t.k === 'you').length;
  return {
    s,
    depth,
    typed,
    automated: s.turns.length - typed,
    agentMs: sum(s.turns, t => t.d),
    credits: sum(s.turns, t => t.cr),
    tokens: sum(s.turns, t => t.tok),
    first: s.turns[0]?.t ?? 0,
    last: Math.max(0, ...s.turns.map(t => t.t + t.d)),
    subagents: sum(s.turns, t => t.sub),
  };
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
function familyNodes(root: PreparedSession, kidsOf: Map<number, PreparedSession[]>): FamilyNode[] {
  const nodes: FamilyNode[] = [];
  const walk = (s: PreparedSession, depth: number): void => {
    nodes.push(familyNode(s, depth));
    const kids = [...(kidsOf.get(s.index) ?? [])].sort((a, b) => (a.turns[0]?.t ?? 0) - (b.turns[0]?.t ?? 0));
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

function summarizeFamily(root: PreparedSession, kidsOf: Map<number, PreparedSession[]>, totalCredits: number): FamilySummary {
  const nodes = familyNodes(root, kidsOf);
  const kids = nodes.filter(n => n.depth > 0);
  const credits = sum(nodes, n => n.credits);
  const childCredits = sum(kids, n => n.credits);
  const childTyped = sum(kids, n => n.typed);
  const firsts = nodes.map(n => n.first).filter(t => t > 0);
  const lasts = nodes.map(n => n.s.turns[n.s.turns.length - 1]?.t ?? 0).filter(t => t > 0);
  return {
    root: root.index,
    s: root,
    nodes,
    sessions: nodes.length,
    children: kids.length,
    depth: Math.max(...nodes.map(n => n.depth)),
    fanOut: Math.max(0, ...nodes.map(n => kidsOf.get(n.s.index)?.length ?? 0)),
    repos: new Set(nodes.map(n => n.s.repo)).size,
    harnesses: [...new Set(nodes.map(n => n.s.harness))],
    typed: sum(nodes, n => n.typed),
    coordinatorTyped: nodes[0].typed,
    childTyped,
    steppedInto: kids.filter(n => n.typed > 0).length,
    automated: sum(nodes, n => n.automated),
    agentMs: sum(nodes, n => n.agentMs),
    credits,
    childCredits,
    tokens: sum(nodes, n => n.tokens),
    creditShare: totalCredits > 0 ? 100 * credits / totalCredits : 0,
    childShare: credits > 0 ? 100 * childCredits / credits : 0,
    perChild: kids.length > 0 ? childCredits / kids.length : 0,
    verdict: childTyped > 0 ? 'needed' : 'alone',
    wide: kids.length >= WIDE_FAN_OUT,
    from: firsts.length > 0 ? toDateStr(Math.min(...firsts)) : '',
    to: lasts.length > 0 ? toDateStr(Math.max(...lasts)) : '',
    busiest: busiestDayOf(nodes),
    rank: 0,
  };
}

function familiesTotals(p: PreparedTimeline, families: FamilySummary[]): FamiliesTotals {
  const totalCredits = p.totalCredits;
  const totalTokens = sum(p.sessions, s => sum(s.turns, t => t.tok));
  const totalAgent = sum(p.sessions, s => sum(s.turns, t => t.d));
  const share = (part: number, whole: number) => (whole > 0 ? 100 * part / whole : 0);
  const group = (list: FamilySummary[]) => ({
    families: list.length,
    creditShare: sum(list, f => f.creditShare),
    avgCredits: list.length > 0 ? sum(list, f => f.credits) / list.length : 0,
  });
  const wide = families.filter(f => f.wide);
  return {
    sessions: p.sessions.length,
    families: families.length,
    sessionsInFamilies: sum(families, f => f.sessions),
    children: sum(families, f => f.children),
    creditShare: share(sum(families, f => f.credits), totalCredits),
    childCreditShare: share(sum(families, f => f.childCredits), totalCredits),
    tokenShare: share(sum(families, f => f.tokens), totalTokens),
    agentMs: sum(families, f => f.agentMs),
    agentShare: share(sum(families, f => f.agentMs), totalAgent),
    typed: sum(families, f => f.typed),
    automated: sum(families, f => f.automated),
    childTyped: sum(families, f => f.childTyped),
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

/** Every family of two or more sessions in range, ranked by credits, and what they add up to. */
export function buildFamilies(p: PreparedTimeline): FamiliesOverview {
  const members = groupBy(p.sessions, s => s.root);
  const kidsOf = groupBy(p.sessions, s => (s.parent >= 0 ? s.parent : null));
  const families = [...members.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([root]) => summarizeFamily(p.sessions[root], kidsOf, p.totalCredits))
    .sort((a, b) => b.credits - a.credits || b.agentMs - a.agentMs || b.sessions - a.sessions);
  for (const [i, f] of families.entries()) f.rank = i + 1;
  return { families, totals: familiesTotals(p, families) };
}
/** The verdict in words, for the selected family. */
export function verdictText(f: FamilySummary): string {
  const base = f.verdict === 'alone'
    ? `All ${f.children} child ${f.children === 1 ? 'session' : 'sessions'} finished without a prompt from you. You typed ${f.coordinatorTyped} ${f.coordinatorTyped === 1 ? 'prompt' : 'prompts'}, all in the coordinator.`
    : `You typed ${f.childTyped} ${f.childTyped === 1 ? 'prompt' : 'prompts'} directly into ${f.steppedInto} of ${f.children} child sessions (marked ✋). Those children couldn’t finish from the brief alone.`;
  return f.wide ? `${base} It fanned out to ${f.children} children at ${formatCredits(f.perChild)} credits each.` : base;
}

/** What the families add up to, as plain sentences. */
export function familiesInsights(t: FamiliesTotals): string[] {
  if (t.families === 0) return [];
  const tips: string[] = [];
  if (t.totalCredits > 0) {
    tips.push(`Families where you had to step into a child used ${t.needed.creditShare.toFixed(0)}% of all credits (${t.needed.families} ${t.needed.families === 1 ? 'family' : 'families'}, ${formatCredits(t.needed.avgCredits)} credits on average), against ${t.alone.creditShare.toFixed(0)}% for the ${t.alone.families} that worked alone (${formatCredits(t.alone.avgCredits)} on average). Clearer briefs are the biggest lever.`);
  } else {
    tips.push(`${t.needed.families} ${t.needed.families === 1 ? 'family needed' : 'families needed'} you in a child session and ${t.alone.families} worked alone. No AI credits were logged: only Copilot logs credits.`);
  }
  tips.push(`${t.childrenNeedingYou} of ${t.children} child sessions needed a prompt from you (${t.childTyped} ${t.childTyped === 1 ? 'prompt' : 'prompts'}). Filter by Needed you and open the ✋ children to see what their brief was missing.`);
  tips.push(t.wide.families > 0
    ? `${t.wide.families} wide ${t.wide.families === 1 ? 'fan-out' : 'fan-outs'} (${WIDE_FAN_OUT}+ children) used ${t.wide.creditShare.toFixed(0)}% of all credits. Check them for children doing overlapping work.`
    : `No family started ${WIDE_FAN_OUT} or more children.`);
  return tips;
}

function sum<T>(items: readonly T[], value: (item: T) => number): number {
  let total = 0;
  for (const item of items) total += value(item);
  return total;
}
