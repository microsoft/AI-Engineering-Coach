/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Timeline page: Day and Week lanes that show when agents worked and when they waited on you, who sent each turn,
 * and which sessions started which; and a Families view that judges each delegation as a whole. The analyzer sends
 * the range once (`getTimelineData`); every view, filter and the name mask are computed here with the shared model. */

import type { DateFilter, TimelineDataset, TimelineTurn, TurnSender } from '../core/types';
import {
  addDays, buildFamilies, buildLanes, buildViewFamilies, createNamer, dayStart, familiesInsights, filterLanes,
  formatCredits, formatDuration, formatHours, formatWhen, hasLaneFilters, NO_LANE_FILTERS,
  prepareTimeline, roleOf, stepDate, timelineKpis, timelineWindow, verdictText, VERDICTS, viewInsights, weekStart, WIDE_FAN_OUT,
  type FamiliesOverview, type FamilySummary, type LaneFilters, type Namer, type PreparedSession, type PreparedTimeline,
  type TimelineLane, type TimelineView, type ViewFamily,
} from '../core/timeline-model';
import { toDateStr } from '../core/helpers';
import { rpc } from './shared';
import { html, render, type VNode } from './render';
import { consumeNavHint } from './nav-hint';

type Group = 'tree' | 'flat';
type Color = 'family' | 'harness';
type StripMode = 'turns' | 'hours';
type VerdictFilter = 'all' | 'alone' | 'needed' | 'wide';
type FamilySort = 'credits' | 'children' | 'agentMs' | 'childTyped' | 'perChild' | 'recent';

interface TimelineState {
  view: TimelineView;
  date: string;
  group: Group;
  color: Color;
  strip: StripMode;
  /** Selected session (dataset index) on the Day and Week views. */
  selected: number | null;
  /** Session to select and scroll to on the next render, by ID. */
  focusId: string | null;
  collapsed: Set<number>;
  masked: boolean;
  filters: LaneFilters;
  family: number | null;
  familyQuery: string;
  familySort: FamilySort;
  familyMin: number;
  verdict: VerdictFilter;
}

const state: TimelineState = {
  view: 'day', date: '', group: 'tree', color: 'family', strip: 'turns', selected: null, focusId: null,
  collapsed: new Set(), masked: false, filters: { ...NO_LANE_FILTERS }, family: null, familyQuery: '',
  familySort: 'credits', familyMin: 2, verdict: 'all',
};

interface Loaded {
  prepared: PreparedTimeline;
  overview?: FamiliesOverview;
}

let loaded: Loaded | null = null;
let rootEl: HTMLElement | null = null;
let scrollToSelected = false;

const FAMILY_COLORS = ['#3794ff', '#73c991', '#4ec9b0', '#dcdcaa', '#f778ba', '#c586c0', '#79c0ff', '#d18616'];
const LONE_COLOR = '#8b949e';
const HARNESS_COLORS: Record<string, string> = {
  'Copilot App': '#3794ff', 'Copilot CLI': '#79c0ff', 'Claude Code': '#da7756', 'Local Agent': '#73c991',
  'Local Agent (Insiders)': '#4ec9b0', OpenCode: '#f778ba', Codex: '#dcdcaa', Xcode: '#147efb',
};
const VERDICT_COLORS = { alone: '#3fb950', needed: '#d29922', wide: '#f778ba' } as const;
const SENDER_LABEL: Record<TurnSender, string> = {
  you: 'you typed', agent: 'sent by an agent or session', autopilot: 'autopilot continuation', compaction: 'compaction', other: 'system or harness',
};
const SENDER_SHORT: Record<TurnSender, string> = {
  you: '● you', agent: '◆ agent / session', autopilot: '○ autopilot', compaction: '■ compaction', other: '■ system',
};
const LANE_HEIGHT = 40;
const FAMILY_HEIGHT = 30;
const LANES_PAD_TOP = 6;

export async function renderTimeline(container: HTMLElement, currentFilter: DateFilter): Promise<void> {
  render(html`<h1>Timeline</h1><div id="tlx-root" class="tlx"><div class="loading-spinner"></div></div>`, container);
  const root = container.querySelector<HTMLElement>('#tlx-root')!;
  const dataset = await rpc<TimelineDataset>('getTimelineData', { filter: currentFilter });
  if (!root.isConnected) return;
  loaded = { prepared: prepareTimeline(dataset) };
  rootEl = root;
  applyNavHint(consumeNavHint(), loaded.prepared);
  if (!loaded.prepared.days.includes(state.date)) state.date = nearestDay(state.date, loaded.prepared.days);
  draw();
}

/** A date (`YYYY-MM-DD`) from another page, or `view=…&date=…&session=<id>&family=<id>`. */
function applyNavHint(hint: string | undefined, p: PreparedTimeline): void {
  if (!hint) return;
  const params = /^\d{4}-\d{2}-\d{2}$/.test(hint) ? new URLSearchParams({ date: hint }) : new URLSearchParams(hint);
  const view = params.get('view');
  state.view = view === 'week' || view === 'families' ? view : 'day';
  const date = params.get('date');
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) state.date = date;
  const session = p.sessions.find(x => x.id === params.get('session'));
  if (session) {
    state.focusId = session.id;
    if (!date) state.date = busiestDay(session);
  }
  const family = p.sessions.find(x => x.id === params.get('family'));
  if (family) state.family = family.root;
}

function nearestDay(date: string, days: readonly string[]): string {
  if (days.length === 0) return toDateStr(Date.now());
  if (!date) return days[days.length - 1];
  return [...days].reverse().find(d => d <= date) ?? days[0];
}

function busiestDay(s: PreparedSession): string {
  const counts = new Map<string, number>();
  for (const t of s.turns) counts.set(toDateStr(t.t), (counts.get(toDateStr(t.t)) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? state.date;
}

function draw(): void {
  if (!rootEl?.isConnected || !loaded) return;
  render(page(loaded), rootEl);
  if (scrollToSelected) {
    scrollToSelected = false;
    requestAnimationFrame(() => rootEl?.querySelector('.tlx-lane.sel, .frow.sel')?.scrollIntoView({ block: 'center' }));
  }
}

function update(change: Partial<TimelineState>): void {
  Object.assign(state, change);
  draw();
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function shortDate(date: string | undefined, year = false): string {
  if (!date) return '';
  return new Date(date + 'T00:00:00').toLocaleDateString(undefined, year ? { day: 'numeric', month: 'short', year: 'numeric' } : { day: 'numeric', month: 'short' });
}

/* ---- page ---- */

function page(data: Loaded): VNode {
  const p = data.prepared;
  if (p.sessions.length === 0) {
    return html`<p class="muted tlx-empty">No sessions in this range. Pick a longer range, or another workspace or harness.</p>` as VNode;
  }
  const namer = createNamer(p, state.masked);
  const ctx = state.view === 'families' ? null : viewContext(p, namer);
  return html`
    ${toolbar(p)}
    ${ctx ? filterBar(p, ctx) : null}
    <div class="tlx-view">${ctx ? timelineView(ctx) : familiesView(data, namer)}</div>
    <p class="tlx-foot">Agent time runs from a prompt to the turn’s last assistant message, so it includes time a turn waited on a question.
      Credits are the AI credits Copilot logged; other harnesses show time and turns. A session’s parent is the session whose
      create_session, open_pr_session or open_issue_session call returned its ID, else the session that relayed its first message, or the
      parent Codex and OpenCode log. Only counts, timings, model and harness names and the session names your harness logged are shown,
      never prompt text. Use Mask names before sharing a screenshot.</p>` as VNode;
}

function segment<T extends string>(id: string, options: [T, string][], current: T, onPick: (v: T) => void, disabled = false): VNode {
  return html`
    <span class=${'tlx-seg' + (disabled ? ' disabled' : '')} id=${id} role="group">
      ${options.map(([value, text]) => html`<button type="button" data-value=${value} class=${value === current ? 'on' : ''}
        aria-pressed=${value === current ? 'true' : 'false'} disabled=${disabled} onClick=${() => onPick(value)}>${text}</button>`)}
    </span>` as VNode;
}

function toolbar(p: PreparedTimeline): VNode {
  const families = state.view === 'families';
  let label: string;
  let prev: string | null = null;
  let next: string | null = null;
  if (families) {
    label = `All families · ${shortDate(p.days[0])} – ${shortDate(p.days[p.days.length - 1], true)}`;
  } else if (state.view === 'week') {
    const start = weekStart(state.date);
    label = `${shortDate(toDateStr(start))} – ${new Date(addDays(start, 6)).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}`;
    prev = stepDate('week', state.date, -1, p.days);
    next = stepDate('week', state.date, 1, p.days);
  } else {
    label = new Date(state.date + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    prev = stepDate('day', state.date, -1, p.days);
    next = stepDate('day', state.date, 1, p.days);
  }
  const unit = state.view === 'week' ? 'week' : 'day';
  return html`
    <div class="tlx-bar">
      <div class="tlx-date">
        <button type="button" id="tlxPrev" aria-label=${'Previous ' + unit} disabled=${!prev} onClick=${() => prev && update({ date: prev })}>‹</button>
        <span id="tlxDateLabel">${label}</span>
        <button type="button" id="tlxNext" aria-label=${'Next ' + unit} disabled=${!next} onClick=${() => next && update({ date: next })}>›</button>
      </div>
      ${segment<TimelineView>('tlxView', [['day', 'Day'], ['week', 'Week'], ['families', 'Families']], state.view, v => update({ view: v }))}
      <span class=${'tlx-seg-l' + (families ? ' disabled' : '')}>Group</span>
      ${segment<Group>('tlxGroup', [['tree', 'Session tree'], ['flat', 'Flat']], state.group, v => update({ group: v }), families)}
      <span class=${'tlx-seg-l' + (families ? ' disabled' : '')}>Color</span>
      ${segment<Color>('tlxColor', [['family', 'Family'], ['harness', 'Harness']], state.color, v => update({ color: v }), families)}
      <label class="tlx-mask" title="Hide session names, branches and repositories, for example before taking a screenshot">
        <input type="checkbox" id="tlxMask" checked=${state.masked} onChange=${(e: Event) => update({ masked: (e.target as HTMLInputElement).checked })} />
        Mask names
      </label>
    </div>` as VNode;
}

function filterBar(p: PreparedTimeline, ctx: ViewContext): VNode {
  const f = state.filters;
  const set = (change: Partial<LaneFilters>) => update({ filters: { ...state.filters, ...change } });
  const check = (id: string, key: 'onlyFamilies' | 'youTyped' | 'waitedOnYou' | 'usedSubagents' | 'hideOneTurn', text: string) => html`
    <label><input type="checkbox" id=${id} checked=${f[key]} onChange=${(e: Event) => set({ [key]: (e.target as HTMLInputElement).checked })} /> ${text}</label>`;
  const filtered = ctx.lanes.length !== ctx.all;
  return html`
    <div class="tlx-filters" role="search" aria-label="Filter sessions">
      <label>Filter <select id="tlxHarness" aria-label="Harness" onChange=${(e: Event) => set({ harness: (e.target as HTMLSelectElement).value })}>
        <option value="" selected=${f.harness === ''}>All harnesses</option>
        ${p.harnesses.map(h => html`<option value=${h} selected=${f.harness === h}>${h}</option>`)}
      </select></label>
      <input type="search" id="tlxQuery" placeholder="Repository or model…" aria-label="Repository or model" value=${f.query}
        onInput=${(e: Event) => set({ query: (e.target as HTMLInputElement).value })} />
      ${check('tlxOnlyFamilies', 'onlyFamilies', 'only session families')}
      ${check('tlxYouTyped', 'youTyped', 'you typed in it')}
      ${check('tlxWaited', 'waitedOnYou', 'waited on you')}
      ${check('tlxSubagents', 'usedSubagents', 'used sub-agents')}
      ${check('tlxHideOne', 'hideOneTurn', 'hide one-turn sessions')}
      <button type="button" class="tlx-btn tlx-btn-quiet" id="tlxClear" disabled=${!hasLaneFilters(f)}
        onClick=${() => update({ filters: { ...NO_LANE_FILTERS } })}>Clear</button>
      <span class="tlx-count" id="tlxCount">${ctx.lanes.length} of ${ctx.all} sessions shown${filtered ? ' · KPIs, callouts and the impact table use the shown sessions' : ''}</span>
    </div>` as VNode;
}

/* ---- day and week ---- */

interface ViewContext {
  p: PreparedTimeline;
  namer: Namer;
  view: 'day' | 'week';
  /** Sessions in the window before the filters. */
  all: number;
  lanes: TimelineLane[];
  families: ViewFamily[];
  familyOf: Map<number, ViewFamily>;
  r0: number;
  r1: number;
  ticks: [number, string][];
}

function pct(ctx: ViewContext, t: number): number {
  return 100 * (Math.max(ctx.r0, Math.min(ctx.r1, t)) - ctx.r0) / (ctx.r1 - ctx.r0);
}

function trackRange(lanes: TimelineLane[], view: 'day' | 'week', start: number, end: number): Pick<ViewContext, 'r0' | 'r1' | 'ticks'> {
  if (view === 'week') {
    const ticks: [number, string][] = [];
    for (let t = start; t < end; t = addDays(t, 1)) ticks.push([t, new Date(t).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })]);
    return { r0: start, r1: end, ticks };
  }
  if (lanes.length === 0) return { r0: start, r1: end, ticks: [] };
  const lo = Math.min(...lanes.map(l => l.first));
  const hi = Math.min(end, Math.max(...lanes.map(l => l.last)));
  let from = Math.max(0, Math.floor((lo - start) / 3.6e6) - 1);
  let to = Math.min(24, Math.ceil((hi - start) / 3.6e6) + 1);
  while (to - from < 4 && !(from === 0 && to === 24)) {
    if (from > 0) from--;
    if (to < 24) to++;
  }
  const step = to - from > 12 ? 2 : 1;
  const ticks: [number, string][] = [];
  for (let h = from; h <= to; h += step) ticks.push([start + h * 3.6e6, `${h}:00`]);
  return { r0: start + from * 3.6e6, r1: start + to * 3.6e6, ticks };
}

function viewContext(p: PreparedTimeline, namer: Namer): ViewContext {
  const view = state.view === 'week' ? 'week' : 'day';
  const [start, end] = timelineWindow(view, state.date);
  const all = buildLanes(p, start, end);
  const lanes = filterLanes(all, state.filters, p, s => namer.repo(s));
  const families = buildViewFamilies(lanes, p);
  const familyOf = new Map<number, ViewFamily>();
  for (const f of families) for (const l of f.lanes) familyOf.set(l.s.index, f);
  if (state.focusId) {
    const focus = lanes.find(l => l.s.id === state.focusId);
    if (focus) {
      state.selected = focus.s.index;
      if (state.collapsed.has(focus.s.root)) state.collapsed = new Set([...state.collapsed].filter(r => r !== focus.s.root));
      scrollToSelected = true;
    }
    state.focusId = null;
  }
  if (lanes.length > 0 && !lanes.some(l => l.s.index === state.selected)) {
    state.selected = [...lanes].sort((a, b) => b.credits - a.credits || b.agentMs - a.agentMs)[0].s.index;
  }
  return { p, namer, view, all: all.length, lanes, families, familyOf, ...trackRange(lanes, view, start, end) };
}

function kpiCard(value: string, label: string, sub: string, color?: string): VNode {
  return html`
    <div class="ctx-comp-kpi" style=${color ? `border-top:4px solid ${color}` : ''}>
      <div class="ctx-comp-kpi-value">${value}</div><div class="ctx-comp-kpi-label">${label}</div><div class="ctx-comp-kpi-sub">${sub}</div>
    </div>` as VNode;
}

function timelineView(ctx: ViewContext): VNode {
  const { p, view, lanes, families } = ctx;
  if (lanes.length === 0) {
    return html`${dayStrip(p, view)}
      <div class="tlx-empty">${ctx.all > 0
        ? html`No session matches these filters. <button type="button" class="tlx-btn" onClick=${() => update({ filters: { ...NO_LANE_FILTERS } })}>Clear filters</button>`
        : `No sessions in this ${view}.`}</div>` as VNode;
  }
  const kpis = timelineKpis(lanes, families);
  const insights = viewInsights(lanes, families, ctx.namer, view);
  const hours = (ms: number) => `${(ms / 3.6e6).toFixed(1)} h`;
  return html`
    <div class="ctx-cache-tips tlx-insights" id="tlxInsights" role="note">
      <div class="ctx-cache-tips-title">What happened ${view === 'week' ? 'this week' : `on ${state.date}`}</div>
      ${insights.map(t => html`<div class="ctx-cache-tip">• ${t}</div>`)}
    </div>
    <div class="ctx-comp-kpis tlx-kpis" id="tlxKpis">
      ${kpiCard(hours(kpis.agentMs), 'Agent time', `sum over ${kpis.sessions} ${kpis.sessions === 1 ? 'session' : 'sessions'}`)}
      ${kpiCard(`${kpis.typed} of ${kpis.turns}`, 'Turns you typed', `${kpis.turns ? Math.round(100 * kpis.typed / kpis.turns) : 0}% · the rest automated`)}
      ${kpiCard(kpis.agentMsPerPrompt == null ? '—' : `${Math.round(kpis.agentMsPerPrompt / 60_000)} min`, 'Agent time per prompt', `${hours(kpis.agentMs)} ÷ ${kpis.typed} typed ${kpis.typed === 1 ? 'prompt' : 'prompts'}`)}
      ${kpiCard(formatDuration(kpis.unattendedMs), 'Longest unattended', 'one family, after 1 prompt')}
      ${kpiCard(formatDuration(kpis.waitMs), 'Waiting on you', `${kpis.waits} ${kpis.waits === 1 ? 'wait' : 'waits'} · ${kpis.longWaits} over 30 min`)}
      ${kpiCard(String(kpis.peak.count), 'Peak parallel agents', kpis.peak.at != null && kpis.peak.count > 0 ? `at ${formatWhen(kpis.peak.at, view)}` : '—')}
    </div>
    ${dayStrip(p, view)}
    ${legend(view)}
    ${lanesPanel(ctx)}
    <div class="tlx-grid">
      ${impactPanel(ctx, kpis.childLanes, kpis.childCreditShare)}
      ${detailPanel(ctx)}
    </div>` as VNode;
}

function dayStrip(p: PreparedTimeline, view: 'day' | 'week'): VNode {
  const hours = state.strip === 'hours';
  const value = (d: string) => {
    const x = p.dayTotals.get(d)!;
    return hours ? x.agentMs / 3.6e6 : x.typed + x.automated;
  };
  const max = Math.max(1e-9, ...p.days.map(value));
  const week = view === 'week' ? timelineWindow('week', state.date) : null;
  const today = p.dayTotals.get(state.date) ?? { typed: 0, automated: 0, agentMs: 0 };
  return html`
    <div class="tlx-strip" id="tlxStrip">
      <div class="tlx-strip-head">
        <span><b>${hours ? 'Agent hours per day' : 'Turns per day'}</b> · ${hours ? 'agent working time' : 'you vs automated'} · ${p.days[0]} → ${p.days[p.days.length - 1]} · click a day</span>
        ${segment<StripMode>('tlxStripMode', [['turns', 'Turns'], ['hours', 'Agent hours']], state.strip, v => update({ strip: v }))}
      </div>
      <div class="tlx-strip-bars">
        ${p.days.map(d => {
          const x = p.dayTotals.get(d)!;
          const inWeek = week != null && dayStart(d) >= week[0] && dayStart(d) < week[1];
          const tip = `${d}: ${x.typed} typed · ${x.automated} automated · ${(x.agentMs / 3.6e6).toFixed(1)} agent-hours`;
          return html`<button type="button" class=${'d' + (d === state.date ? ' sel' : '') + (inWeek ? ' inwk' : '')} data-day=${d} title=${tip} aria-label=${tip}
            onClick=${() => update({ date: d })}>
            ${hours
              ? html`<i class="h" style=${`height:${(x.agentMs / 3.6e6 / max) * 64}px`}></i>`
              : html`<i class="you" style=${`height:${(x.typed / max) * 64}px`}></i><i class="auto" style=${`height:${(x.automated / max) * 64}px`}></i>`}
          </button>`;
        })}
      </div>
      <div class="tlx-lg">
        ${hours ? html`<span><i class="sw h"></i>agent hours</span>`
          : html`<span><i class="sw you"></i>prompts you typed</span><span><i class="sw auto"></i>automated: agents, relays, autopilot</span>`}
        <span class="tlx-lg-end">${state.date}: ${today.typed} typed · ${today.automated} automated · ${(today.agentMs / 3.6e6).toFixed(1)} agent-hours</span>
      </div>
    </div>` as VNode;
}

function legend(view: 'day' | 'week'): VNode {
  return html`
    <div class="tlx-lg tlx-legend">
      <span><i class="sw work"></i>agent working</span>
      <span><i class="sw wait"></i>waiting on you</span>
      <span><i class="mk you static"></i>you typed</span>
      <span><i class="mk agent static"></i>sent by an agent or session</span>
      <span><i class="mk autopilot static"></i>autopilot</span>
      <span><i class="mk other static"></i>system / compaction</span>
      <span><b class="sub static">n</b>sub-agent runs</span>
      <span><i class="conn-sw"></i>created child session</span>
      <span class="tlx-lg-end">click a lane for details · click a family header to collapse · ← → change ${view} · ↑ ↓ change lane</span>
    </div>` as VNode;
}

function familyColor(f: ViewFamily | undefined): string {
  return f && f.color >= 0 ? FAMILY_COLORS[f.color % FAMILY_COLORS.length] : LONE_COLOR;
}

function laneColor(ctx: ViewContext, l: TimelineLane): string {
  return state.color === 'harness' ? HARNESS_COLORS[l.s.harness] ?? LONE_COLOR : familyColor(ctx.familyOf.get(l.s.index));
}

function sessionTip(s: PreparedSession, namer: Namer, p: PreparedTimeline): string {
  const typed = s.turns.filter(t => t.k === 'you').length;
  const agent = s.turns.reduce((a, t) => a + t.d, 0);
  const credits = s.turns.reduce((a, t) => a + t.cr, 0);
  const when = (t: number) => new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const parent = s.parent >= 0 ? p.sessions[s.parent] : null;
  const branch = namer.branch(s);
  return [
    namer.name(s),
    parent ? `${s.depth === 1 ? 'Child' : 'Grandchild'} of “${namer.name(parent)}”` : capitalize(roleOf(s)),
    `${namer.repo(s)}${branch ? ' · branch ' + branch : ''}`,
    `${s.harness}${s.model ? ' · ' + s.model : ''}`,
    s.turns.length ? `${when(s.turns[0].t)} → ${when(s.turns[s.turns.length - 1].t)}` : '',
    `${typed} typed · ${s.turns.length - typed} automated · ${formatHours(agent)} agent`,
    `${formatCredits(credits)} credits in range`,
    s.via === 'relay' ? 'started by a relayed message' : '',
  ].filter(Boolean).join('\n');
}

function turnTip(ctx: ViewContext, s: PreparedSession, t: TimelineTurn): string {
  return [
    `${formatWhen(t.t, ctx.view)} · ${SENDER_LABEL[t.k]}`,
    `${ctx.namer.repo(s)} · ${s.harness}`,
    `Agent worked ${t.d >= 60_000 ? formatDuration(t.d) : '<1 min'}`,
    t.sub ? `${t.sub} sub-agent ${t.sub === 1 ? 'run' : 'runs'}` : '',
    t.comp ? 'context compacted' : '',
  ].filter(Boolean).join('\n');
}

function laneRow(ctx: ViewContext, l: TimelineLane, depth: number): VNode {
  const s = l.s;
  const color = laneColor(ctx, l);
  const tree = state.group === 'tree' && depth > 0 ? '   '.repeat(depth - 1) + '└─ ' : '';
  const detail = [
    roleOf(s), ctx.namer.repo(s), s.via === 'relay' ? 'started by relay' : null,
    s.parent >= 0 && l.visibleParent < 0 && state.group === 'tree' ? `parent on another ${ctx.view}` : null,
    `${l.typed} you · ${l.automated} automated · ${formatDuration(l.agentMs)}`,
  ].filter(Boolean).join(' · ');
  const markKind = (k: TurnSender) => (k === 'you' || k === 'agent' || k === 'autopilot' ? k : 'other');
  return html`
    <div class=${'tlx-lane' + (s.index === state.selected ? ' sel' : '')} data-lane=${s.index} data-session=${s.id}
      onClick=${() => update({ selected: s.index })}>
      <div class="tlx-lbl" title=${sessionTip(s, ctx.namer, ctx.p)}>
        <span class="tree">${tree}</span><span class="dot" style=${`background:${color}`}></span>
        <div class="t"><b class="nm">${ctx.namer.name(s)}</b><span class="chip">${s.harness}</span><span class="chip">${s.model || '—'}</span><small>${detail}</small></div>
      </div>
      <div class="tlx-trk">
        ${ctx.ticks.map(([x]) => html`<div class="grid" style=${`left:${pct(ctx, x)}%`}></div>`)}
        ${l.waits.map(([a, b]) => html`<div class="wait" title=${`Waiting on you ${formatDuration(b - a)}`} style=${`left:${pct(ctx, a)}%;width:${pct(ctx, b) - pct(ctx, a)}%`}></div>`)}
        ${l.turns.filter(t => t.d > 0).map(t => html`<div class="seg" style=${`left:${pct(ctx, t.t)}%;width:${Math.max(0.15, pct(ctx, t.t + t.d) - pct(ctx, t.t))}%;background:${color}`}></div>`)}
        ${l.turns.map(t => html`<div class=${'mk ' + markKind(t.k)} data-sender=${t.k} title=${turnTip(ctx, s, t)} style=${`left:${pct(ctx, t.t)}%`}></div>`)}
        ${l.turns.filter(t => t.sub > 0).map(t => html`<div class="sub" style=${`left:${pct(ctx, t.t + t.d / 2)}%`}>${t.sub}</div>`)}
      </div>
    </div>` as VNode;
}

function familyHeader(ctx: ViewContext, f: ViewFamily): VNode {
  const multi = f.lanes.length > 1;
  const collapsed = state.collapsed.has(f.root);
  const top = ctx.p.sessions[f.root];
  const toggle = () => {
    if (!multi) return;
    const next = new Set(state.collapsed);
    if (collapsed) next.delete(f.root);
    else next.add(f.root);
    update({ collapsed: next });
  };
  return html`
    <div class="tlx-fam" data-family=${f.root} onClick=${toggle} aria-expanded=${multi ? String(!collapsed) : undefined}>
      <div><span class="caret">${multi ? (collapsed ? '▸' : '▾') : ''}</span><b class="nm">${ctx.namer.name(top)}</b>
        <span class="muted"> · ${ctx.namer.repo(top)} · ${f.lanes.length} ${f.lanes.length === 1 ? 'session' : 'sessions'}</span>
        ${f.size > f.lanes.length ? html` <span class="ext">(${f.size} in family)</span>` : null}</div>
      <div class="roll">
        <span><b>${f.typed}</b> you · <b>${f.automated}</b> automated</span>
        <span><b>${formatDuration(f.agentMs)}</b> agent</span>
        <span><b>${formatCredits(f.credits)}</b> cr</span>
        <span><i class="share" style=${`width:${Math.max(2, f.share * 1.6)}px;background:${familyColor(f)}`}></i><b>${f.share.toFixed(1)}%</b> of credits</span>
      </div>
    </div>` as VNode;
}

function lanesPanel(ctx: ViewContext): VNode {
  const rows: VNode[] = [];
  const centre = new Map<number, number>();
  const children: TimelineLane[] = [];
  let y = LANES_PAD_TOP;
  const addLane = (l: TimelineLane, depth: number) => {
    rows.push(laneRow(ctx, l, depth));
    centre.set(l.s.index, y + LANE_HEIGHT / 2);
    if (state.group === 'tree' && l.visibleParent >= 0) children.push(l);
    y += LANE_HEIGHT;
  };
  if (state.group === 'flat') {
    for (const l of [...ctx.lanes].sort((a, b) => a.first - b.first)) addLane(l, 0);
  } else {
    for (const f of ctx.families) {
      rows.push(familyHeader(ctx, f));
      y += FAMILY_HEIGHT;
      if (f.lanes.length > 1 && state.collapsed.has(f.root)) continue;
      for (const { lane, depth } of f.ordered) addLane(lane, depth);
    }
  }
  const forks = ctx.p.forkedSessions > 0
    ? `${ctx.p.forkedSessions} ${ctx.p.forkedSessions === 1 ? 'session reports' : 'sessions report'} forks, but no harness logs which session a fork came from, so forks aren’t drawn yet.`
    : 'Forked sessions appear here as a branch from their source session once a harness logs the fork. None of your harnesses logs one yet.';
  return html`
    <div class=${'tlx-lanes' + (ctx.view === 'week' ? ' wk' : '')} id="tlxLanes">
      ${rows}
      ${children.map(l => {
        const top = centre.get(l.visibleParent);
        const bottom = centre.get(l.s.index);
        if (top == null || bottom == null) return null;
        const from = top + 6;
        const color = laneColor(ctx, l);
        return html`<div class="conn" aria-hidden="true" style=${`left:calc(var(--tl-label) + 12px + (100% - var(--tl-label) - 24px) * ${(pct(ctx, l.first) / 100).toFixed(4)});top:${from}px;height:${Math.max(4, bottom - 7 - from)}px;color:${color};border-color:${color}`}></div>`;
      })}
      <div class="tlx-axis">${ctx.ticks.map(([x, label]) => html`<span style=${`left:${pct(ctx, x)}%`}>${label}</span>`)}</div>
      <div class="tlx-fork">${forks}</div>
    </div>` as VNode;
}

function impactPanel(ctx: ViewContext, childLanes: number, childShare: number): VNode {
  const rows = [...ctx.families].sort((a, b) => b.credits - a.credits || b.agentMs - a.agentMs);
  const max = Math.max(0.1, ...rows.map(f => f.share));
  const select = (f: ViewFamily) => {
    const top = f.lanes.find(l => l.s.index === f.root) ?? [...f.lanes].sort((a, b) => b.credits - a.credits)[0];
    const next = new Set(state.collapsed);
    next.delete(f.root);
    scrollToSelected = true;
    update({ collapsed: next, selected: top.s.index });
  };
  return html`
    <div class="tlx-panel" id="tlxImpact">
      <h4>Impact by session family</h4>
      <p class="note">A coordinator and the sessions it started, ${ctx.view === 'week' ? 'this week' : state.date}. Credits are logged AI credits. Click a row to select it.</p>
      <table>
        <thead><tr><th>Family</th><th class="num">You / auto</th><th class="num">Agent time</th><th class="num">Unattended</th><th class="num">Credits</th><th>Share</th></tr></thead>
        <tbody>${rows.map(f => html`
          <tr class="click" data-family=${f.root} onClick=${() => select(f)}>
            <td><span class="fdot" style=${`background:${familyColor(f)}`}></span><b>${ctx.namer.name(ctx.p.sessions[f.root])}</b>
              <small>${f.lanes.length > 1 ? `${f.lanes.length} sessions · ${f.lanes.filter(l => l.s.parent >= 0).length} started by an agent` : '1 session'}</small></td>
            <td class="num">${f.typed} / ${f.automated}</td>
            <td class="num">${formatDuration(f.agentMs)}</td>
            <td class="num">${f.unattendedMs >= 60_000 ? formatDuration(f.unattendedMs) : '—'}</td>
            <td class="num">${formatCredits(f.credits)}</td>
            <td><i class="bar" style=${`width:${Math.max(2, f.share / max * 110)}px;background:${familyColor(f)}`}></i>${f.share.toFixed(1)}%</td>
          </tr>`)}
        </tbody>
      </table>
      <p class="note tlx-note-end">Child sessions: ${childLanes} of ${ctx.lanes.length} lanes, ${childShare.toFixed(1)}% of the credits. Unattended = longest stretch the family’s agents worked after one of your prompts.</p>
    </div>` as VNode;
}

function goLink(text: string, onGo: () => void, id?: string): VNode {
  return html`<a href="#" id=${id} onClick=${(e: Event) => { e.preventDefault(); onGo(); }}>${text}</a>` as VNode;
}

function detailPanel(ctx: ViewContext): VNode {
  const l = ctx.lanes.find(x => x.s.index === state.selected);
  if (!l) return html`<div class="tlx-panel" id="tlxDetail"></div>` as VNode;
  const s = l.s;
  const parent = s.parent >= 0 ? ctx.p.sessions[s.parent] : null;
  const firstChild = ctx.p.sessions.filter(x => x.parent === s.index).sort((a, b) => (a.turns[0]?.t ?? 0) - (b.turns[0]?.t ?? 0))[0];
  const totalCredits = ctx.lanes.reduce((a, x) => a + x.credits, 0);
  const branch = ctx.namer.branch(s);
  const role = parent ? `${s.depth === 1 ? 'Child' : 'Grandchild'} of “${ctx.namer.name(parent)}”` : capitalize(roleOf(s));
  const origin = s.via === 'relay' ? ' · started by a relayed message' : s.via === 'harness' ? ' · started by its parent agent' : s.parent >= 0 ? ' · created by its parent' : '';
  const familyHasMany = (ctx.p.familySize.get(s.root) ?? 1) > 1;
  const tokens = l.tokens >= 1e5 ? `${(l.tokens / 1e6).toFixed(1)}M tokens` : l.tokens > 0 ? `${Math.round(l.tokens / 1000)}k tokens` : 'no tokens logged';
  return html`
    <div class="tlx-panel" id="tlxDetail" aria-live="polite">
      <div class="dr-head"><div>
        <h4 id="tlxDetailName">${ctx.namer.name(s)}</h4>
        <p class="note dr-role">${role} · ${ctx.namer.repo(s)}${branch ? ` · branch ${branch}` : ''}</p>
        <p class="note">${s.harness} · ${s.model || 'model not logged'} · ${formatWhen(l.first, ctx.view)}–${formatWhen(l.last, ctx.view)}${origin}</p>
      </div><span class="chip chip-sel">selected</span></div>
      <div class="dr-kpis">
        <div><b>${l.typed} / ${l.automated}</b><span>you / automated</span></div>
        <div><b>${formatDuration(l.agentMs)}</b><span>agent time</span></div>
        <div><b>${formatCredits(l.credits)} cr</b><span>${totalCredits > 0 ? `${(100 * l.credits / totalCredits).toFixed(1)}% of the ${ctx.view}` : 'no credits logged'}</span></div>
        <div><b>${l.subagents}</b><span>sub-agent runs</span></div>
      </div>
      <div class="dr-turns"><table>
        <thead><tr><th>Time</th><th>Sent by</th><th class="num">Agent worked</th><th class="num">Sub-agents</th></tr></thead>
        <tbody>${l.turns.map(t => html`<tr>
          <td>${formatWhen(t.t, ctx.view)}</td>
          <td><span class=${'who-' + (t.k === 'compaction' ? 'other' : t.k)}>${SENDER_SHORT[t.k]}</span>${t.comp ? html` <span class="chip">compaction</span>` : null}</td>
          <td class="num">${t.d >= 60_000 ? formatDuration(t.d) : '<1 min'}</td>
          <td class="num">${t.sub || ''}</td></tr>`)}
        </tbody></table></div>
      <p class="note tlx-note-end">${l.turns.length} ${l.turns.length === 1 ? 'turn' : 'turns'} · ${tokens} · no prompt text is shown</p>
      <div class="dr-links">
        ${parent ? goLink('Open parent session ›', () => openSession(parent.index), 'tlxOpenParent') : null}
        ${firstChild ? goLink('Open first child ›', () => openSession(firstChild.index), 'tlxOpenChild') : null}
        ${familyHasMany ? goLink('Show family in Families ›', () => { scrollToSelected = true; update({ view: 'families', family: s.root, verdict: 'all' }); }, 'tlxShowFamily') : null}
        <a href="#" data-page="config-health" data-nav-hint="prompt-cache">Context Health › Prompt Cache ›</a>
        <a href="#" data-page="config-health" data-nav-hint="token-types">Token Types ›</a>
      </div>
    </div>` as VNode;
}

/** Shows a session on the Day view, on its busiest day when it isn't in the current window. */
function openSession(index: number): void {
  if (!loaded) return;
  const s = loaded.prepared.sessions[index];
  const view = state.view === 'week' ? 'week' : 'day';
  const [start, end] = timelineWindow(view, state.date);
  if (state.view === 'families' || !s.turns.some(t => t.t >= start && t.t < end)) {
    state.date = busiestDay(s);
    if (state.view === 'families') state.view = 'day';
  }
  state.focusId = s.id;
  state.filters = { ...NO_LANE_FILTERS };
  draw();
}

/* ---- families ---- */

function verdictBadge(kind: keyof typeof VERDICT_COLORS): VNode {
  return html`<span class="vb" style=${`--c:${VERDICT_COLORS[kind]}`}>${VERDICTS[kind].label}</span>` as VNode;
}

function shownFamilies(o: FamiliesOverview, namer: Namer): FamilySummary[] {
  const q = state.familyQuery.trim().toLowerCase();
  const key = state.familySort;
  const sortValue = (f: FamilySummary): number => (key === 'agentMs' ? f.agentMs : key === 'children' ? f.children
    : key === 'childTyped' ? f.childTyped : key === 'perChild' ? f.perChild : f.credits);
  return o.families
    .filter(f => (!q || f.nodes.some(n => namer.repo(n.s).toLowerCase().includes(q) || namer.name(n.s).toLowerCase().includes(q)))
      && f.sessions >= state.familyMin
      && (state.verdict === 'all' || (state.verdict === 'wide' ? f.wide : f.verdict === state.verdict)))
    .sort((a, b) => (key === 'recent' ? b.to.localeCompare(a.to) || b.credits - a.credits : sortValue(b) - sortValue(a)));
}

function familiesView(data: Loaded, namer: Namer): VNode {
  data.overview ??= buildFamilies(data.prepared);
  const o = data.overview;
  const t = o.totals;
  if (o.families.length === 0) {
    return html`<div class="howto" id="tlxNoFamilies"><div class="howto-t">No session families in this range</div>
      <p class="howto-l">A family is a coordinator session and the child sessions it started for you, for example with create_session in the
      Copilot App, or sub-agent threads in Codex and OpenCode. None of the ${t.sessions} sessions in this range started another session.</p></div>` as VNode;
  }
  if (state.family == null || !o.families.some(f => f.root === state.family)) state.family = o.families[0].root;
  const shown = shownFamilies(o, namer);
  const chip = (id: VerdictFilter, label: string, n: number, share: number, color: string) => html`
    <button type="button" class=${'vf' + (state.verdict === id ? ' on' : '')} data-verdict=${id} style=${`--c:${color}`} aria-pressed=${state.verdict === id ? 'true' : 'false'}
      onClick=${() => update({ verdict: id })}><b>${label}</b><span>${n} ${n === 1 ? 'family' : 'families'} · ${share.toFixed(0)}% of credits</span></button>`;
  const sorts: [FamilySort, string][] = [['credits', 'Credits'], ['children', 'Child sessions'], ['agentMs', 'Agent time'], ['childTyped', 'Prompts into children'], ['perChild', 'Credits per child'], ['recent', 'Most recent']];
  const showCumulative = state.familySort === 'credits' && state.verdict === 'all' && !state.familyQuery.trim();
  let cumulative = 0;
  return html`
    <div class="howto">
      <div class="howto-t">How to read Families</div>
      <p class="howto-l">A <b>family</b> is one piece of work you delegated: a <b>coordinator</b> session you talked to, plus the <b>child sessions</b> it started for you.
        Each row is one family, so you can judge the delegation as a whole instead of ${t.sessionsInFamilies} separate sessions.</p>
      <div class="howto-g">
        <div><b>1 · What did it cost?</b><span>Rows are ranked by AI credits. The bar is the family’s share of all your credits; together these families used ${Math.round(t.creditShare)}%.</span></div>
        <div><b>2 · Did the agents finish on their own?</b><span>${verdictBadge('alone')} no prompt from you in any child. ${verdictBadge('needed')} you had to step into a child: the brief was missing something.</span></div>
        <div><b>3 · Was splitting the work worth it?</b><span>${verdictBadge('wide')} ${WIDE_FAN_OUT} or more children. Compare credits per child and how many children needed you.</span></div>
      </div>
      <p class="howto-l howto-end">Select a family to see each session by name, the verdict and one habit to try. Click a session to open it on the Timeline.</p>
    </div>
    <div class="ctx-cache-tips tlx-insights" id="tlxFamilyInsights" role="note">
      <div class="ctx-cache-tips-title">What your families tell you</div>
      ${familiesInsights(t).map(tip => html`<div class="ctx-cache-tip">• ${tip}</div>`)}
    </div>
    <div class="ctx-comp-kpis tlx-kpis" id="tlxFamilyKpis">
      ${kpiCard(String(t.families), 'Delegated pieces of work', `${t.sessionsInFamilies} of ${t.sessions} sessions belong to one`, '#3794ff')}
      ${kpiCard(String(t.children), 'Child sessions', `${t.children - t.childrenNeedingYou} finished without a prompt from you`, '#b180d7')}
      ${kpiCard(`${Math.round(t.creditShare)}%`, 'Of all AI credits', `${Math.round(t.childCreditShare)}% in the child sessions alone`, '#cf222e')}
      ${kpiCard(`${(t.agentMs / 3.6e6).toFixed(0)} h`, 'Agent time', `${Math.round(t.agentShare)}% of all agent time`, '#f0883e')}
      ${kpiCard(String(t.childTyped), 'Prompts you typed into children', `out of ${formatCredits(t.typed)} you typed in families`, '#d29922')}
      ${kpiCard(`${t.top3Share.toFixed(0)}%`, 'Credits in the top 3', 'the biggest delegations dominate', '#8b949e')}
    </div>
    <div class="vfs" role="group" aria-label="Filter by verdict">
      ${chip('all', 'All families', t.families, t.creditShare, '#8b949e')}
      ${chip('alone', VERDICTS.alone.label, t.alone.families, t.alone.creditShare, VERDICT_COLORS.alone)}
      ${chip('needed', VERDICTS.needed.label, t.needed.families, t.needed.creditShare, VERDICT_COLORS.needed)}
      ${chip('wide', VERDICTS.wide.label, t.wide.families, t.wide.creditShare, VERDICT_COLORS.wide)}
    </div>
    <div class="tlx-filters">
      <input type="search" id="tlxFamilyQuery" placeholder="Search session name or repository…" aria-label="Search families" value=${state.familyQuery}
        onInput=${(e: Event) => update({ familyQuery: (e.target as HTMLInputElement).value })} />
      <label>Sort <select id="tlxFamilySort" onChange=${(e: Event) => update({ familySort: (e.target as HTMLSelectElement).value as FamilySort })}>
        ${sorts.map(([value, label]) => html`<option value=${value} selected=${state.familySort === value}>${label}</option>`)}
      </select></label>
      <label>Min sessions <select id="tlxFamilyMin" onChange=${(e: Event) => update({ familyMin: Number((e.target as HTMLSelectElement).value) })}>
        ${[2, 3, 5, 10].map(n => html`<option value=${n} selected=${state.familyMin === n}>${n}</option>`)}
      </select></label>
      <span class="tlx-count" id="tlxFamilyCount">${shown.length} of ${o.families.length} families · ${shown.reduce((a, f) => a + f.creditShare, 0).toFixed(1)}% of all credits</span>
    </div>
    <div class="fx-main">
      <div class="flist" id="tlxFamilyList" role="list">
        ${shown.length === 0 ? html`<div class="tlx-empty">No family matches these filters.</div>` : html`
          <div class="fam-head"><span></span><span>Delegated work · biggest child sessions</span><span>Verdict</span><span>Agent</span><span>Credits · share of all</span></div>
          ${shown.map(f => { cumulative += f.creditShare; return familyRow(f, namer, o, showCumulative ? cumulative : null); })}`}
      </div>
      ${familyAside(o, namer, data.prepared)}
    </div>` as VNode;
}

function familyRow(f: FamilySummary, namer: Namer, o: FamiliesOverview, cumulative: number | null): VNode {
  const kids = f.nodes.filter(n => n.depth > 0);
  const biggest = [...kids].sort((a, b) => b.credits - a.credits).slice(0, 3);
  const topShare = o.families[0]?.creditShare || 1;
  const pick = () => update({ family: f.root });
  return html`
    <div class=${'frow' + (f.root === state.family ? ' sel' : '')} role="listitem" tabindex="0" data-family=${f.root}
      onClick=${pick} onKeyDown=${(e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } }}>
      <div class="fr-rank">#${f.rank}</div>
      <div class="fr-main">
        <div class="fr-name">${namer.name(f.s)}</div>
        <div class="fr-sub">${namer.repo(f.s)}${f.repos > 1 ? ` + ${f.repos - 1} more ${f.repos > 2 ? 'repositories' : 'repository'}` : ''} · ${shortDate(f.from)}${f.to !== f.from ? '–' + shortDate(f.to) : ''} · ${f.children} child ${f.children === 1 ? 'session' : 'sessions'}</div>
        <div class="fr-kids">${biggest.map(n => html`<span class=${n.typed ? 'kt' : ''} title=${n.typed ? 'you typed into this child' : ''}>↳ ${namer.name(n.s)}</span>`)}
          ${kids.length > 3 ? html`<span class="more">+${kids.length - 3} more</span>` : null}</div>
      </div>
      <div class="fr-v">${verdictBadge(f.verdict)}${f.wide ? verdictBadge('wide') : null}
        <small>${f.childTyped ? `you stepped into ${f.steppedInto} of ${f.children}` : 'children needed no prompt'}</small></div>
      <div class="fr-n"><b>${formatHours(f.agentMs)}</b><small>agent time</small></div>
      <div class="fr-c"><div><b>${formatCredits(f.credits)}</b> cr <span>${f.creditShare.toFixed(1)}%</span></div>
        <i style=${`width:${Math.max(2, f.creditShare / topShare * 100)}%`}></i>
        ${cumulative != null ? html`<small>running total ${cumulative.toFixed(0)}%</small>` : null}</div>
    </div>` as VNode;
}

function familyAside(o: FamiliesOverview, namer: Namer, p: PreparedTimeline): VNode {
  const f = o.families.find(x => x.root === state.family);
  if (!f) return html`<aside class="fx-aside" id="tlxFamilyDetail"></aside>` as VNode;
  const branch = namer.branch(f.s);
  const openDay = () => {
    const collapsed = new Set(state.collapsed);
    collapsed.delete(f.root);
    update({ view: 'day', date: f.busiest, group: 'tree', focusId: f.s.id, filters: { ...NO_LANE_FILTERS }, collapsed });
  };
  const when = (t: number) => new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  return html`
    <aside class="fx-aside" id="tlxFamilyDetail" aria-live="polite">
      <div class="fa-rank">#${f.rank} of ${o.families.length} by credits</div>
      <h2>${namer.name(f.s)}</h2>
      <p class="meta">${namer.repo(f.s)}${branch ? ` · branch ${branch}` : ''} · ${shortDate(f.from)}${f.to !== f.from ? '–' + shortDate(f.to) : ''} · ${f.harnesses.join(', ')}</p>
      <div class="verdict" style=${`--c:${VERDICT_COLORS[f.verdict]}`}>
        ${verdictBadge(f.verdict)}${f.wide ? verdictBadge('wide') : null}
        <p>${verdictText(f)}</p>
        <p class="habit"><b>Try next time:</b> ${VERDICTS[f.verdict].habit}${f.wide ? ' ' + VERDICTS.wide.habit : ''}</p>
      </div>
      <div class="dr-kpis">
        <div><b>${formatCredits(f.credits)}</b><span>credits · ${f.creditShare.toFixed(1)}% of all</span></div>
        <div><b>${formatHours(f.agentMs)}</b><span>agent time</span></div>
        <div><b>${f.typed} / ${f.automated}</b><span>you typed / automated</span></div>
        <div><b>${formatCredits(f.perChild)}</b><span>credits per child · ${Math.round(f.childShare)}% in children</span></div>
      </div>
      <p class="fa-open"><button type="button" class="tlx-btn" id="tlxOpenFamilyDay" onClick=${openDay}>Open on the Timeline, ${shortDate(f.busiest)} ›</button>
        <span class="muted">its busiest day</span></p>
      <table class="ftable">
        <thead><tr><th>Session · ${f.sessions}</th><th class="num">You typed</th><th class="num">Agent</th><th class="num">Credits</th></tr></thead>
        <tbody>${f.nodes.map(n => html`
          <tr class="click" data-session=${n.s.id} onClick=${() => openSession(n.s.index)} title=${sessionTip(n.s, namer, p)}>
            <td><div class="tn" style=${`padding-left:${n.depth * 16}px`}>${n.depth ? html`<span class="tree">└ </span>` : null}${namer.name(n.s)}</div>
              <small style=${`padding-left:${n.depth * 16 + (n.depth ? 14 : 0)}px`}>${n.depth === 0 ? 'coordinator' : n.depth === 1 ? 'child' : 'grandchild'}${namer.repo(n.s) !== namer.repo(f.s) ? ' · ' + namer.repo(n.s) : ''}${n.first ? ' · ' + when(n.first) : ''}${n.s.via === 'relay' ? ' · started by relay' : ''}</small></td>
            <td class="num">${n.depth > 0 && n.typed ? html`<span class="hand" title="you stepped in">✋ ${n.typed}</span>` : n.typed}<small>${n.automated} auto</small></td>
            <td class="num">${formatHours(n.agentMs)}</td>
            <td class="num">${formatCredits(n.credits)}<i class="mbar" style=${`width:${f.credits ? 100 * n.credits / f.credits : 0}%`}></i></td>
          </tr>`)}
        </tbody>
      </table>
      <p class="note">✋ = you typed into this child · click a session to open it on the Timeline</p>
    </aside>` as VNode;
}

/* ---- keyboard: ← → change day or week, ↑ ↓ change lane or family ---- */

function onKeyDown(e: KeyboardEvent): void {
  if (!rootEl?.isConnected || !loaded) return;
  const target = e.target as HTMLElement | null;
  if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    if (state.view === 'families') return;
    e.preventDefault();
    const next = stepDate(state.view, state.date, e.key === 'ArrowLeft' ? -1 : 1, loaded.prepared.days);
    if (next) update({ date: next });
    return;
  }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  const dir = e.key === 'ArrowDown' ? 1 : -1;
  if (state.view === 'families') {
    const rows = [...rootEl.querySelectorAll<HTMLElement>('.frow')];
    const at = rows.findIndex(r => Number(r.dataset.family) === state.family);
    const next = rows[Math.max(0, Math.min(rows.length - 1, at + dir))];
    if (next) {
      scrollToSelected = true;
      update({ family: Number(next.dataset.family) });
    }
    return;
  }
  const lanes = [...rootEl.querySelectorAll<HTMLElement>('.tlx-lane')];
  const at = lanes.findIndex(l => Number(l.dataset.lane) === state.selected);
  const next = lanes[Math.max(0, Math.min(lanes.length - 1, at + dir))];
  if (next) {
    update({ selected: Number(next.dataset.lane) });
    next.scrollIntoView({ block: 'nearest' });
  }
}

if (typeof document !== 'undefined') document.addEventListener('keydown', onKeyDown);
