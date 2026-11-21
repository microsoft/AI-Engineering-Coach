/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Timeline page: Day and Week lanes that show when agents worked and when they waited on you, who sent each turn,
 * and which sessions started which; and a Families view that judges each delegation as a whole. The analyzer sends
 * the range once (`getTimelineData`); every view, filter and the name mask are computed here with the shared model. */

import type {
  DateFilter, TimelineDataset, TimelineSessionText, TimelineTextSuperseded, TimelineTextTurn, TimelineTextWait, TimelineTurn, TurnSender,
} from '../core/types';
import {
  addDays, buildFamilies, buildLanes, buildViewFamilies, createNamer, waitInWindow, dayStart, dayTicks, familiesInsights, filterLanes,
  formatCount, formatCredits, formatDuration, formatHours, formatWhen, hasLaneFilters, hourTicks, MAX_TEXT_SCOPE_TURNS, neededYou, NO_LANE_FILTERS,
  clipIntervals, clippedMs, intervalsMs, prepareTimeline, roleOf, stepDate, textScope, textTurnFinder, timelineKpis, timelineWindow, turnTimes, verdictText, VERDICTS,
  viewInsights, weekStart, WIDE_FAN_OUT, type Interval,
  type FamiliesOverview, type FamilySummary, type LaneFilters, type Namer, type PreparedSession, type PreparedTimeline,
  type TimelineLane, type TimelinePeriod, type TimelineView, type TimelineWait, type ViewFamily,
} from '../core/timeline-model';
import {
  clampRange, isDate, MAX_RANGE_DAYS, rangeDays, rangeTicks, rangeWindow, shiftDate, stepRange, type DateRange,
} from '../core/timeline-range';
import { FF_TOKEN_REPORTING_ENABLED } from '../core/constants';
import { toDateStr } from '../core/helpers';
import { rpc, vscode } from './shared';
import { html, render, type VNode } from './render';
import { consumeNavHint } from './nav-hint';
import { closePicker, datePicker, pickerOpen, type PickerActions, type PickerInput } from './timeline-date-picker';

type Group = 'tree' | 'flat';
type Color = 'family' | 'harness';
type StripMode = 'turns' | 'hours';
type VerdictFilter = 'all' | 'alone' | 'needed' | 'wide';
type FamilySort = 'credits' | 'children' | 'agentMs' | 'childTyped' | 'perChild' | 'recent';

interface TimelineState {
  view: TimelineView;
  date: string;
  /** The days the Range view shows, both included: kept by dates, so it survives a reload of another date range. */
  range: DateRange | null;
  /** The range picked was longer than the longest drawn, and was cut. */
  rangeCapped: boolean;
  group: Group;
  color: Color;
  strip: StripMode;
  /** Selected session (session ID) on the Day and Week views. IDs, not dataset indices, so a selection survives a
   *  reload with another date range. */
  selected: string | null;
  /** Session to select and scroll to on the next render, by ID. */
  focusId: string | null;
  /** Collapsed families, by their coordinator's session ID. */
  collapsed: Set<string>;
  masked: boolean;
  filters: LaneFilters;
  /** Selected family on the Families view, by its coordinator's session ID. */
  family: string | null;
  familyQuery: string;
  familySort: FamilySort;
  familyMin: number;
  verdict: VerdictFilter;
  /** Show prompts and questions in the detail panel (kept in the webview state; null until read). */
  showText: boolean | null;
  /** The prompt, question or wait highlighted in the detail panel (`t:<time>`, `w:<kind>:<start>`, `i:<start>`). */
  textFocus: string | null;
  /** When the highlighted wait ended: tells apart two of a kind that began together. */
  textFocusEnd: number | null;
}

const state: TimelineState = {
  view: 'day', date: '', range: null, rangeCapped: false, group: 'tree', color: 'family', strip: 'turns', selected: null, focusId: null,
  collapsed: new Set(), masked: false, filters: { ...NO_LANE_FILTERS }, family: null, familyQuery: '',
  familySort: 'credits', familyMin: 2, verdict: 'all', showText: null, textFocus: null, textFocusEnd: null,
};

interface Loaded {
  prepared: PreparedTimeline;
  overview?: FamiliesOverview;
}

let loaded: Loaded | null = null;
let rootEl: HTMLElement | null = null;
let scrollToSelected = false;
let scrollToText = false;

/** The text behind each opened lane, by session ID: read once per load, on demand. */
type TextEntry = { status: 'loading' } | { status: 'ready'; text: TimelineSessionText } | { status: 'missing' } | { status: 'tooMany'; turns: number };
const texts = new Map<string, TextEntry>();
/** The read of the lane whose details show now (`sessionId|from|to`). */
let shownTextKey: string | null = null;
const SHOW_TEXT_KEY = 'timelineShowText';

const FAMILY_COLORS = ['#3794ff', '#2ea043', '#14a38b', '#bf8700', '#db61a2', '#a371f7', '#0969da', '#d18616'];
const LONE_COLOR = '#8b949e';
const HARNESS_COLORS: Record<string, string> = {
  'Copilot App': '#3794ff', 'Copilot CLI': '#0969da', 'Claude Code': '#da7756', 'Local Agent': '#2ea043',
  'Local Agent (Insiders)': '#14a38b', OpenCode: '#db61a2', Codex: '#bf8700', Xcode: '#147efb',
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
  texts.clear();
  // A highlight belongs to the click that made it, not to the next load.
  state.textFocus = null;
  state.textFocusEnd = null;
  scrollToText = false;
  closePicker();
  state.showText ??= (vscode.getState() as Record<string, unknown> | null)?.[SHOW_TEXT_KEY] !== false;
  rootEl = root;
  root.replaceChildren();
  applyNavHint(consumeNavHint() ?? firstLoadLink(), loaded.prepared);
  // A picked date stays, with or without activity, while it's within the loaded days; else the nearest active day.
  const [lo, hi] = selectable(loaded.prepared);
  if (!isDate(state.date) || state.date < lo || state.date > hi) {
    state.date = nearestDay(state.date, loaded.prepared.days, loaded.prepared.bounds[0]);
  }
  keepRange(loaded.prepared);
  draw();
}

const VIEW_KEY = 'timelineView';
let restored = false;

/** On the page's first load in this webview: the view in the address (`#view=…`), else the one last shown. */
function firstLoadLink(): string | undefined {
  if (restored) return undefined;
  restored = true;
  const hash = typeof location === 'undefined' ? '' : location.hash;
  if (hash.startsWith('#view=')) return hash.slice(1);
  const saved = (vscode.getState() as Record<string, unknown> | null)?.[VIEW_KEY];
  return typeof saved === 'string' ? saved : undefined;
}

/** The view as a link: `view=day&date=…`, `view=week&date=…`, `view=range&from=…&to=…` or `view=families`. */
function viewLink(): string {
  if (state.view === 'range' && state.range) return `view=range&from=${state.range.from}&to=${state.range.to}`;
  return state.view === 'families' ? 'view=families' : `view=${state.view}&date=${state.date}`;
}

/** Keeps the view in the webview's state and the address, by dates, so a reload or a copied link opens it again. */
function saveView(): void {
  const link = viewLink();
  const saved = vscode.getState();
  const prev = saved && typeof saved === 'object' ? saved as Record<string, unknown> : {};
  if (prev[VIEW_KEY] !== link) vscode.setState({ ...prev, [VIEW_KEY]: link });
  if (typeof location === 'undefined' || location.hash === '#' + link) return;
  try {
    history.replaceState(history.state, '', '#' + link);
  } catch {
    // A host that doesn't allow it keeps the view in its state only.
  }
}

/** The first and last day that can be shown: the loaded range, or its first and last active day when it's open-ended. */
function selectable(p: PreparedTimeline): [string, string] {
  const first = p.days[0] || state.date || toDateStr(Date.now());
  const last = p.days[p.days.length - 1] ?? first;
  return [Number.isFinite(p.bounds[0]) ? toDateStr(p.bounds[0]) : first, Number.isFinite(p.bounds[1]) ? toDateStr(p.bounds[1] - 1) : last];
}

/** The range shown when the Range view opens with none: the week shown, else the 7 days to the day shown. */
function defaultRange(p: PreparedTimeline): DateRange {
  const [lo, hi] = selectable(p);
  const date = state.date || hi;
  const [from, to] = state.view === 'week' ? [toDateStr(weekStart(date)), shiftDate(toDateStr(weekStart(date)), 6)] : [shiftDate(date, -6), date];
  return clampRange(from, to, lo, hi)?.range ?? { from: lo, to: hi };
}

/** Keeps the range within the loaded days (another sidebar range was loaded); the Range view always has one. */
function keepRange(p: PreparedTimeline): void {
  const [lo, hi] = selectable(p);
  if (state.range) state.range = clampRange(state.range.from, state.range.to, lo, hi)?.range ?? null;
  if (state.view === 'range' && !state.range) state.range = defaultRange(p);
}

/** The period the lanes are drawn for: the Families view keeps the last one. */
function period(): TimelinePeriod {
  return state.view === 'families' ? 'day' : state.view;
}

/** The [start, end) of the day, the week or the range shown. */
function windowOf(view: TimelinePeriod): Interval {
  return view === 'range' && state.range ? rangeWindow(state.range) : timelineWindow(view === 'week' ? 'week' : 'day', state.date);
}

/** `this day`, `this week`, `in this range`. */
function thisPeriod(view: TimelinePeriod): string {
  return view === 'range' ? 'in this range' : `this ${view}`;
}

function setView(view: TimelineView): void {
  if (view === 'range' && !state.range && loaded) state.range = defaultRange(loaded.prepared);
  closePicker();
  update({ view, rangeCapped: false });
}

/** The previous or next period: the day or week with activity, or the range moved by its own length. */
function stepped(p: PreparedTimeline, dir: -1 | 1): Partial<TimelineState> | null {
  if (state.view === 'families') return null;
  if (state.view === 'range') {
    const [lo, hi] = selectable(p);
    const range = state.range && stepRange(state.range, dir, lo, hi);
    return range ? { range, date: range.to, rangeCapped: false } : null;
  }
  const date = stepDate(state.view, state.date, dir, p.days);
  return date ? { date } : null;
}

/** A date (`YYYY-MM-DD`) from another page, or `view=…&date=…&session=<id>&family=<id>`, or `view=range&from=…&to=…`. */
function applyNavHint(hint: string | undefined, p: PreparedTimeline): void {
  if (!hint) return;
  hint = hint.replace(/^#/, '');
  const params = /^\d{4}-\d{2}-\d{2}$/.test(hint) ? new URLSearchParams({ date: hint }) : new URLSearchParams(hint);
  const view = params.get('view');
  state.view = view === 'week' || view === 'families' || view === 'range' ? view : 'day';
  if (state.view === 'range') {
    const [from, to] = [params.get('from'), params.get('to')];
    const [lo, hi] = selectable(p);
    const picked = isDate(from) && isDate(to) ? clampRange(from, to, lo, hi) : null;
    // A range with no loaded day opens the Day view instead.
    if (picked) Object.assign(state, { range: picked.range, rangeCapped: picked.capped, date: picked.range.to });
    else state.view = 'day';
  }
  const date = params.get('date');
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) state.date = date;
  const session = p.sessions.find(x => x.id === params.get('session') && !x.ctx);
  if (session) {
    state.focusId = session.id;
    if (!date) state.date = busiestDay(session);
  }
  const family = p.sessions.find(x => x.id === params.get('family'));
  if (family) {
    state.family = p.sessions[family.root].id;
    // A deep link to a family shows it, whatever was filtered before.
    Object.assign(state, { verdict: 'all', familyMin: 2, familyQuery: '' });
  }
  if (session || family) state.filters = { ...NO_LANE_FILTERS };
}

/** The active day at or before `date`; with no active day, the range's first day (or today, for an open range). */
function nearestDay(date: string, days: readonly string[], rangeStart = -Infinity): string {
  if (days.length === 0) return toDateStr(Number.isFinite(rangeStart) ? rangeStart : Date.now());
  if (!date) return days[days.length - 1];
  return [...days].reverse().find(d => d <= date) ?? days[0];
}

/** The day with most of the session's turns in range; without one, the first day of its work, waiting or answers in
 *  range, so a session with only an answer opens where it has a lane. */
function busiestDay(s: PreparedSession): string {
  const counts = new Map<string, number>();
  for (const t of s.turns) counts.set(toDateStr(t.t), (counts.get(toDateStr(t.t)) ?? 0) + 1);
  const bounds = loaded?.prepared.bounds ?? [-Infinity, Infinity];
  const first = [...clipIntervals(s.work, bounds), ...clipIntervals(s.waiting, bounds)].map(([a]) => a)
    .concat(s.answers.filter(x => x.counted).map(x => x.at).filter(t => t >= bounds[0] && t < bounds[1])).sort((a, b) => a - b)[0];
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0]
    ?? (first !== undefined ? toDateStr(first) : state.date);
}

/** The session has a lane in the window: a turn, work, waiting or an answer in it. */
function activeIn(s: PreparedSession, win: Interval): boolean {
  if (s.ctx) return false;
  const [a, b] = win;
  return s.turns.some(t => t.t >= a && t.t < b) || clipIntervals(s.work, win).length > 0
    || s.waits.some(w => w.start < b && w.end > a) || s.answers.some(x => x.counted && x.at >= a && x.at < b);
}

function draw(): void {
  if (!rootEl?.isConnected || !loaded) return;
  render(page(loaded), rootEl);
  saveView();
  if (scrollToSelected) {
    scrollToSelected = false;
    requestAnimationFrame(() => rootEl?.querySelector('.tlx-lane.sel, .frow.sel')?.scrollIntoView({ block: 'center' }));
  }
  const focus = scrollToText && state.textFocus ? rootEl.querySelector('#tlxText .tx-item.focus') : null;
  if (focus) {
    scrollToText = false;
    requestAnimationFrame(() => focus.scrollIntoView({ block: 'nearest' }));
  }
}

function update(change: Partial<TimelineState>): void {
  // A highlighted prompt or wait belongs to the click that chose it: another lane, or this one opened again, has none.
  if (change.selected !== undefined && !('textFocus' in change)) {
    change = { ...change, textFocus: null, textFocusEnd: null };
    scrollToText = false;
  }
  Object.assign(state, change);
  draw();
}

/** Masking also clears both searches: what you typed is often a real repository or session name. */
function setMasked(masked: boolean): void {
  update(masked ? { masked, filters: { ...state.filters, query: '' }, familyQuery: '' } : { masked });
}

/** Activates a click-only row from the keyboard (Enter or Space). */
function onActivate(go: () => void): (e: KeyboardEvent) => void {
  return e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    go();
  };
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
  if (!p.sessions.some(s => !s.ctx)) {
    return html`<p class="muted tlx-empty">No sessions in this range. Pick a longer range, or another workspace or harness.</p>` as VNode;
  }
  const namer = createNamer(p, state.masked);
  const ctx = state.view === 'families' ? null : viewContext(p, namer);
  return html`
    ${toolbar(p)}
    ${rangeNote()}
    ${ctx ? filterBar(p, ctx) : null}
    <div class="tlx-view">${ctx ? timelineView(ctx) : familiesView(data, namer)}</div>
    <p class="tlx-foot">Agent time is, for each turn, the time from its prompt to its last logged agent activity, less the time that
      turn was stopped on a question or a permission prompt; then merged per session, so turns that overlap count once. Waiting on you counts the
      gaps from the end of a session’s work to your next prompt (2 to 120 min, both included) and the questions and permission prompts you
      answered (from the request to its result; none when your answer was recorded before the request), once per session where they overlap;
      an answer is dated by Copilot’s record of it when
      logged; permissions a policy decided aren’t counted. A Range is whole days, from the first day’s midnight to the midnight after
      the last, measured by the same rules as a day, so its time and counts are those of its days added up. A turn counts as yours when the harness marked it as neither automated nor sent by another session.
      Credits are the AI credits Copilot logged; other harnesses show time and turns. A session’s parent is the session whose
      create_session, open_pr_session or open_issue_session call returned its ID, else the parent Codex and OpenCode log, else the
      session that relayed its first message. The lanes, cards and callouts show counts, timings, model, harness and repository names and
      the session names you gave (never automatic titles, nor a name that repeats your first prompt or its first words). Show prompts and questions, in a lane’s
      details, reads that session’s prompts, questions, answers and permission requests again from its log on this machine when you open
      the lane; links, email addresses, secret-like tokens, your home folder and your names are replaced, and nothing of it leaves this page.
      Mask names hides names, branches, repositories, model names, search text and that text on this page only, not the sidebar.</p>` as VNode;
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
  const [lo, hi] = selectable(p);
  let label: string;
  if (families) {
    label = `All families · ${shortDate(p.days[0])} – ${shortDate(p.days[p.days.length - 1], true)}`;
  } else if (state.view === 'range' && state.range) {
    const { from, to } = state.range;
    const n = rangeDays(state.range);
    const start = from === to ? '' : `${shortDate(from, from.slice(0, 4) !== to.slice(0, 4))} – `;
    label = `${start}${shortDate(to, true)} · ${n} ${n === 1 ? 'day' : 'days'}`;
  } else if (state.view === 'week') {
    const start = weekStart(state.date);
    label = `${shortDate(toDateStr(start))} – ${new Date(addDays(start, 6)).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}`;
  } else {
    label = new Date(state.date + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  }
  const prev = stepped(p, -1);
  const next = stepped(p, 1);
  const unit = state.view === 'week' ? 'week' : state.view === 'range' ? 'range' : 'day';
  const input: PickerInput = {
    view: period(), date: state.date, range: state.range, lo, hi, today: toDateStr(Date.now()), activity: dayActivity(p), label,
  };
  const actions: PickerActions = {
    pickDate: date => update({ date, view: state.view === 'range' ? 'day' : state.view }),
    pickRange: (range, capped) => update({ view: 'range', range, date: range.to, rangeCapped: capped }),
  };
  return html`
    <div class="tlx-bar">
      <div class="tlx-date">
        <button type="button" id="tlxPrev" aria-label=${'Previous ' + unit} disabled=${!prev} onClick=${() => prev && update(prev)}>‹</button>
        ${families ? html`<span id="tlxDateLabel">${label}</span>` : datePicker(input, actions)}
        <button type="button" id="tlxNext" aria-label=${'Next ' + unit} disabled=${!next} onClick=${() => next && update(next)}>›</button>
      </div>
      ${segment<TimelineView>('tlxView', [['day', 'Day'], ['week', 'Week'], ['range', 'Range'], ['families', 'Families']], state.view, setView)}
      <span class=${'tlx-seg-l' + (families ? ' disabled' : '')}>Group</span>
      ${segment<Group>('tlxGroup', [['tree', 'Session tree'], ['flat', 'Flat']], state.group, v => update({ group: v }), families)}
      <span class=${'tlx-seg-l' + (families ? ' disabled' : '')}>Color</span>
      ${segment<Color>('tlxColor', [['family', 'Family'], ['harness', 'Harness']], state.color, v => update({ color: v }), families)}
      <label class="tlx-mask" title="Hide session names, branches, repositories and search text on this page, for example before taking a screenshot">
        <input type="checkbox" id="tlxMask" checked=${state.masked} onChange=${(e: Event) => setMasked((e.target as HTMLInputElement).checked)} />
        Mask names
      </label>
    </div>` as VNode;
}

/** A day's activity for the calendar: none, or a third of the busiest day's turns, two thirds, or more. */
function dayActivity(p: PreparedTimeline): PickerInput['activity'] {
  const turns = (d: string) => {
    const x = p.dayTotals.get(d);
    return x ? x.typed + x.automated : 0;
  };
  const max = Math.max(1, ...p.days.map(turns));
  return date => {
    const x = p.dayTotals.get(date);
    if (!x) return { level: 0, text: 'no activity' };
    const n = x.typed + x.automated;
    const level = n === 0 ? 1 : n <= max / 3 ? 1 : n <= 2 * max / 3 ? 2 : 3;
    return { level, text: `${formatCount(n)} ${n === 1 ? 'turn' : 'turns'} (${formatCount(x.typed)} typed) · ${(x.agentMs / 3.6e6).toFixed(1)} agent-hours` };
  };
}

/** Says when a picked range was cut to the longest drawn, and that a long one is dense. */
function rangeNote(): VNode | null {
  if (state.view !== 'range' || !state.range) return null;
  const n = rangeDays(state.range);
  const parts = [
    state.rangeCapped ? `Ranges are cut to ${MAX_RANGE_DAYS} days, so this one ends on ${state.range.to}.` : '',
    n > 31 ? `Over ${n} days the lanes are dense: pick fewer days to tell single turns apart.` : '',
  ].filter(Boolean);
  return parts.length ? html`<p class="note tlx-range-note" id="tlxRangeNote" role="status">${parts.join(' ')}</p>` as VNode : null;
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
      <input type="search" id="tlxQuery" placeholder=${state.masked ? 'Search is off while names are masked' : 'Repository or model…'} aria-label="Repository or model"
        value=${state.masked ? '' : f.query} disabled=${state.masked}
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
  view: TimelinePeriod;
  /** Sessions in the window before the filters. */
  all: number;
  /** Their indices: a parent among them but not shown was hidden by a filter. */
  inWindow: Set<number>;
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

function trackRange(lanes: TimelineLane[], view: TimelinePeriod, start: number, end: number): Pick<ViewContext, 'r0' | 'r1' | 'ticks'> {
  // A range of two days or more is drawn whole, its ticks spaced for its length; a one-day range like a day.
  if (view === 'range' && end - start > 26 * 3.6e6) return { r0: start, r1: end, ticks: rangeTicks(start, end) };
  if (view === 'week') {
    return { r0: start, r1: end, ticks: dayTicks(start, end).map(t => [t, new Date(t).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })]) };
  }
  if (lanes.length === 0) return { r0: start, r1: end, ticks: [] };
  // Whole local hours around the activity, read from the clock so a daylight-saving day (23 or 25 h) labels right.
  const hour = (t: number, dir: -1 | 1) => {
    const d = new Date(t);
    if (dir > 0 && (d.getMinutes() || d.getSeconds() || d.getMilliseconds())) d.setHours(d.getHours() + 1);
    d.setMinutes(0, 0, 0);
    return d.getTime();
  };
  const lo = Math.min(...lanes.map(l => l.first));
  const hi = Math.min(end, Math.max(...lanes.map(l => l.last)));
  let r0 = Math.max(start, hour(lo, -1) - 3.6e6);
  let r1 = Math.min(end, hour(hi, 1) + 3.6e6);
  while (r1 - r0 < 4 * 3.6e6 && (r0 > start || r1 < end)) {
    if (r0 > start) r0 = Math.max(start, r0 - 3.6e6);
    if (r1 < end) r1 = Math.min(end, r1 + 3.6e6);
  }
  const step = r1 - r0 > 12 * 3.6e6 ? 2 : 1;
  const ticks = hourTicks(r0, r1 + 1, step).map((t): [number, string] => [t, `${new Date(t).getHours()}:00`]);
  return { r0, r1, ticks };
}

function viewContext(p: PreparedTimeline, namer: Namer): ViewContext {
  const view = period();
  const [start, end] = windowOf(view);
  const all = buildLanes(p, start, end);
  const lanes = filterLanes(all, state.filters, p, s => namer.repo(s));
  const families = buildViewFamilies(lanes, p);
  const familyOf = new Map<number, ViewFamily>();
  for (const f of families) for (const l of f.lanes) familyOf.set(l.s.index, f);
  const rootId = (l: TimelineLane) => p.sessions[l.s.root].id;
  if (state.focusId) {
    const focus = lanes.find(l => l.s.id === state.focusId);
    if (focus) {
      state.selected = focus.s.id;
      if (state.collapsed.has(rootId(focus))) state.collapsed = new Set([...state.collapsed].filter(r => r !== rootId(focus)));
      scrollToSelected = true;
    }
    state.focusId = null;
  }
  // The selection stays on a row you can see: not filtered out, not inside a collapsed family.
  const visible = state.group === 'flat' ? lanes
    : lanes.filter(l => !(state.collapsed.has(rootId(l)) && (familyOf.get(l.s.index)?.lanes.length ?? 1) > 1));
  if (!visible.some(l => l.s.id === state.selected)) {
    state.selected = [...visible].sort((a, b) => b.credits - a.credits || b.agentMs - a.agentMs || a.s.index - b.s.index)[0]?.s.id ?? null;
  }
  return {
    p, namer, view, all: all.length, inWindow: new Set(all.map(l => l.s.index)), lanes, families, familyOf, ...trackRange(lanes, view, start, end),
  };
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
  const insights = viewInsights(lanes, families, ctx.namer, view, p);
  const hours = (ms: number) => `${(ms / 3.6e6).toFixed(1)} h`;
  const asked = kpis.waits - kpis.idleWaits;
  const typedShare = kpis.turns ? `${Math.round(100 * kpis.typed / kpis.turns)}% from you · ${formatCount(kpis.turns - kpis.typed)} automated` : 'no turn started here';
  return html`
    <div class="ctx-cache-tips tlx-insights" id="tlxInsights" role="note">
      <div class="ctx-cache-tips-title">What happened ${view === 'week' ? 'this week' : view === 'range' && state.range ? `from ${state.range.from} to ${state.range.to}` : `on ${state.date}`}</div>
      ${insights.map(t => html`<div class="ctx-cache-tip">• ${t}</div>`)}
    </div>
    <div class="ctx-comp-kpis tlx-kpis" id="tlxKpis">
      ${kpiCard(hours(kpis.agentMs), 'Agent time', `over ${formatCount(kpis.sessions)} ${kpis.sessions === 1 ? 'session' : 'sessions'} · questions and permissions left out`)}
      ${kpiCard(kpis.turns ? `${formatCount(kpis.typed)} of ${formatCount(kpis.turns)}` : '—', 'Turns you typed', typedShare)}
      ${kpiCard(kpis.agentMsPerPrompt == null ? '—' : `${Math.round(kpis.agentMsPerPrompt / 60_000)} min`, 'Agent time per prompt', `${hours(kpis.agentMs)} ÷ ${formatCount(kpis.typed)} typed ${kpis.typed === 1 ? 'prompt' : 'prompts'}`)}
      ${kpiCard(formatDuration(kpis.unattendedMs), 'Longest unattended', 'in one family, from one of your inputs until its work stopped or your next input')}
      ${kpiCard(formatDuration(kpis.waitMs), 'Waiting on you', `${formatCount(kpis.waits)} ${kpis.waits === 1 ? 'wait' : 'waits'} started${asked ? ` (${formatCount(asked)} on a question or permission)` : ''} · ${formatCount(kpis.longWaits)} of 30 min or more`)}
      ${kpiCard(String(kpis.peak.count), 'Peak parallel sessions', kpis.peak.at != null && kpis.peak.count > 0 ? `doing agent work at ${formatWhen(kpis.peak.at, view)}` : '—')}
    </div>
    ${dayStrip(p, view)}
    ${legend(view)}
    ${lanesPanel(ctx)}
    <div class="tlx-grid">
      ${impactPanel(ctx, kpis.childLanes, kpis.childCreditShare)}
      ${detailPanel(ctx)}
    </div>` as VNode;
}

function dayStrip(p: PreparedTimeline, view: TimelinePeriod): VNode {
  const hours = state.strip === 'hours';
  const value = (d: string) => {
    const x = p.dayTotals.get(d)!;
    return hours ? x.agentMs / 3.6e6 : x.typed + x.automated;
  };
  const max = Math.max(1e-9, ...p.days.map(value));
  // The week or range shown is highlighted; in a range, a click opens that day.
  const span = view === 'day' ? null : windowOf(view);
  const shown = view === 'range' && state.range ? p.days.filter(d => d >= state.range!.from && d <= state.range!.to) : [state.date];
  const today = shown.reduce((a, d) => {
    const x = p.dayTotals.get(d);
    return x ? { typed: a.typed + x.typed, automated: a.automated + x.automated, agentMs: a.agentMs + x.agentMs } : a;
  }, { typed: 0, automated: 0, agentMs: 0 });
  const which = view === 'range' && state.range ? `Range ${state.range.from} → ${state.range.to}` : `Selected day ${state.date}`;
  return html`
    <div class="tlx-strip" id="tlxStrip">
      <div class="tlx-strip-head">
        <span><b>${hours ? 'Agent hours per day' : 'Turns per day'}</b> · ${hours ? 'agent working time' : 'you vs automated'} · every session in range, before filters · ${p.days[0]} → ${p.days[p.days.length - 1]} · click a day</span>
        ${segment<StripMode>('tlxStripMode', [['turns', 'Turns'], ['hours', 'Agent hours']], state.strip, v => update({ strip: v }))}
      </div>
      <div class="tlx-strip-bars">
        ${p.days.map(d => {
          const x = p.dayTotals.get(d)!;
          const inWeek = span != null && dayStart(d) >= span[0] && dayStart(d) < span[1];
          const tip = `${d}: ${x.typed} typed · ${x.automated} automated · ${(x.agentMs / 3.6e6).toFixed(1)} agent-hours · ${formatDuration(x.waitMs)} waiting on you`;
          return html`<button type="button" class=${'d' + (d === state.date ? ' sel' : '') + (inWeek ? ' inwk' : '')} data-day=${d} title=${tip} aria-label=${tip}
            onClick=${() => update(view === 'range' ? { view: 'day', date: d } : { date: d })}>
            ${hours
              ? html`<i class="h" style=${`height:${(x.agentMs / 3.6e6 / max) * 64}px`}></i>`
              : html`<i class="you" style=${`height:${(x.typed / max) * 64}px`}></i><i class="auto" style=${`height:${(x.automated / max) * 64}px`}></i>`}
          </button>`;
        })}
      </div>
      <div class="tlx-lg">
        ${hours ? html`<span><i class="sw h"></i>agent hours</span>`
          : html`<span><i class="sw you"></i>prompts you typed</span><span><i class="sw auto"></i>automated: agents, relays, autopilot</span>`}
        <span class="tlx-lg-end">${which}: ${today.typed} typed · ${today.automated} automated · ${(today.agentMs / 3.6e6).toFixed(1)} agent-hours</span>
      </div>
    </div>` as VNode;
}

function legend(view: TimelinePeriod): VNode {
  return html`
    <div class="tlx-lg tlx-legend">
      <span><i class="sw work"></i>agent working</span>
      <span><i class="sw wait"></i>waiting for your next prompt</span>
      <span><i class="sw wait ask"></i>waiting for your answer</span>
      <span><i class="mk you static"></i>you typed</span>
      <span><i class="mk agent static"></i>sent by an agent or session</span>
      <span><i class="mk autopilot static"></i>autopilot</span>
      <span><i class="mk other static"></i>system / compaction</span>
      <span><b class="sub static">n</b>sub-agent launches in the turn</span>
      <span><i class="conn-sw"></i>linked child session (drawn from when its parent requested it, when logged, else its first activity shown)</span>
      <span class="tlx-lg-end">click a lane for details · click a family header to collapse · ← → change ${view} · ↑ ↓ change lane (lanes focused)</span>
    </div>` as VNode;
}

function familyColor(f: ViewFamily | undefined): string {
  return f && f.color >= 0 ? FAMILY_COLORS[f.color % FAMILY_COLORS.length] : LONE_COLOR;
}

function laneColor(ctx: ViewContext, l: TimelineLane): string {
  return state.color === 'harness' ? HARNESS_COLORS[l.s.harness] ?? LONE_COLOR : familyColor(ctx.familyOf.get(l.s.index));
}

/** `Child of “X”`, `Grandchild · parent “X”`: the role, with the direct parent. */
function roleWithParent(s: PreparedSession, namer: Namer, p: PreparedTimeline): string {
  const parent = s.parent >= 0 ? p.sessions[s.parent] : null;
  if (!parent) return capitalize(roleOf(s));
  return s.depth === 1 ? `Child of “${namer.name(parent)}”` : `${capitalize(roleOf(s))} · parent “${namer.name(parent)}”`;
}

function sessionTip(s: PreparedSession, namer: Namer, p: PreparedTimeline): string {
  const typed = s.turns.filter(t => t.k === 'you').length;
  const agent = intervalsMs(clipIntervals(s.work, p.bounds));
  const credits = s.turns.reduce((a, t) => a + t.cr, 0);
  const when = (t: number) => new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const branch = namer.branch(s);
  return [
    namer.name(s),
    roleWithParent(s, namer, p),
    `${namer.repo(s)}${branch ? ' · branch ' + branch : ''}`,
    `${s.harness}${s.model ? ' · ' + namer.model(s) : ''}`,
    s.ctx ? 'not counted under the current range or sidebar selection'
      : s.turns.length ? `turns in range ${when(s.turns[0].t)} → ${when(s.turns[s.turns.length - 1].t)}` : 'no turn started in range',
    `${typed} typed · ${s.turns.length - typed} automated · ${formatHours(agent)} agent in range`,
    `${formatCredits(credits)} credits in range`,
    s.via === 'relay' ? 'started by a relayed message' : '',
  ].filter(Boolean).join('\n');
}

function turnTip(ctx: ViewContext, s: PreparedSession, t: TimelineTurn): string {
  const { workMs, blockedMs } = turnTimes(t);
  const asks = t.w?.length ?? 0;
  return [
    `${formatWhen(t.t, ctx.view)} · ${SENDER_LABEL[t.k]}`,
    `${ctx.namer.repo(s)} · ${s.harness}`,
    t.noDuration ? 'Agent time not logged' : `Agent worked ${formatDuration(workMs)} in this turn`,
    asks ? `Stopped ${formatDuration(blockedMs)} on ${asks} ${asks === 1 ? 'question or permission prompt' : 'questions or permission prompts'}` : '',
    t.sub ? `${t.sub} sub-agent ${t.sub === 1 ? 'launch' : 'launches'} recorded` : '',
    t.comp ? 'context compacted' : '',
  ].filter(Boolean).join('\n');
}

const WAIT_WHAT: Record<TimelineWait['kind'], string> = {
  idle: 'for your next prompt', question: 'on a question you answered', relay: 'on a child session’s question it relayed to you',
  permission: 'on a permission prompt you answered',
};

function waitTip(ctx: ViewContext, w: TimelineWait, win: Interval): string {
  const whole = w.end - w.start;
  const inside = clippedMs(w, win);
  return `Waiting on you ${WAIT_WHAT[w.kind]}: ${formatDuration(whole)}${inside < whole ? `, ${formatDuration(inside)} of it ${thisPeriod(ctx.view)}` : ''}`;
}

/** Why a child's parent isn't drawn right above it. */
function parentNote(ctx: ViewContext, l: TimelineLane): string | null {
  if (l.s.parent < 0 || state.group !== 'tree' || l.visibleParent === l.s.parent) return null;
  const parent = ctx.p.sessions[l.s.parent];
  const why = ctx.inWindow.has(parent.index) ? 'parent hidden by a filter'
    : parent.ctx ? 'parent outside this range or the sidebar selection'
      : `parent not active ${thisPeriod(ctx.view)}`;
  return l.visibleParent >= 0 ? `${why} · linked to its nearest shown ancestor` : why;
}

/** `fork of “X”` for a session forked from another (Codex, Claude Code). */
function forkNote(ctx: ViewContext, s: PreparedSession): string | null {
  if (s.fork === undefined) return null;
  const where = s.forkSource === 'missing' ? 'left out' : s.forkSource === 'ambiguous' ? 'counted in the sessions that hold them' : 'counted in the source';
  const copied = s.inheritedTurns ? ` · ${formatCount(s.inheritedTurns)} copied ${s.inheritedTurns === 1 ? 'turn' : 'turns'} ${where}` : '';
  if (s.fork >= 0) return `fork of “${ctx.namer.name(ctx.p.sessions[s.fork])}”${copied}`;
  if (s.forkSource === 'ambiguous') return `fork: its source can't be told from these logs, as several sessions hold its copied history` + copied;
  return (s.forkSource === 'missing' ? 'fork of a session not in these logs' : 'fork of a session outside this range') + copied;
}
function laneRow(ctx: ViewContext, l: TimelineLane, depth: number): VNode {
  const s = l.s;
  const color = laneColor(ctx, l);
  const tree = state.group === 'tree' && depth > 0 ? '   '.repeat(depth - 1) + '└─ ' : '';
  const detail = [
    roleOf(s), ctx.namer.repo(s), s.via === 'relay' ? 'started by relay' : null,
    parentNote(ctx, l),
    forkNote(ctx, s),
    `${l.typed} you · ${l.automated} automated · ${formatDuration(l.agentMs)}`,
  ].filter(Boolean).join(' · ');
  const markKind = (k: TurnSender) => (k === 'you' || k === 'agent' || k === 'autopilot' ? k : 'other');
  // Everything drawn is clipped to the plotted range first, so a bar is as long as the time it stands for.
  const plot: Interval = [Math.max(l.win[0], ctx.r0), Math.min(l.win[1], ctx.r1)];
  const span = ([a, b]: Interval) => `left:${pct(ctx, a)}%;width:${pct(ctx, b) - pct(ctx, a)}%`;
  const select = () => {
    update({ selected: s.id });
    rootEl?.querySelector<HTMLElement>('#tlxLanes')?.focus({ preventScroll: true });
  };
  return html`
    <div class=${'tlx-lane' + (s.id === state.selected ? ' sel' : '')} data-lane=${s.index} data-session=${s.id}
      aria-current=${s.id === state.selected ? 'true' : undefined} onClick=${select}>
      <div class="tlx-lbl" title=${sessionTip(s, ctx.namer, ctx.p)}>
        <span class="tree">${tree}</span><span class="dot" style=${`background:${color}`}></span>
        <div class="t"><b class="nm">${ctx.namer.name(s)}</b><span class="chip">${s.harness}</span><span class="chip">${ctx.namer.model(s) || '—'}</span><small>${detail}</small></div>
      </div>
      <div class="tlx-trk">
        ${ctx.ticks.map(([x]) => html`<div class="grid" style=${`left:${pct(ctx, x)}%`}></div>`)}
        ${l.waits.map(w => {
          const [part] = clipIntervals([[w.start, w.end]], plot);
          const key = w.kind === 'idle' ? `i:${w.start}` : `w:${w.kind}:${w.start}`;
          const open = (e?: Event) => {
            e?.stopPropagation();
            // Shown text only: a highlight set while it is hidden would turn up, stale, when it shows again.
            const shown = !!state.showText && !state.masked;
            scrollToText = shown;
            update({ selected: s.id, textFocus: shown ? key : null, textFocusEnd: shown ? w.end : null });
          };
          const tip = waitTip(ctx, w, l.win);
          return part ? html`<div class=${'wait' + (w.kind === 'idle' ? '' : ' ask')} data-wait=${w.kind} data-wait-at=${key}
            role="button" tabindex="0" aria-label=${tip} title=${tip + (state.showText && !state.masked ? '\nClick to read it in the details' : '')}
            style=${span(part)} onClick=${open} onKeyDown=${onActivate(open)}></div>` : null;
        })}
        ${clipIntervals(l.segments, plot).map(part => html`<div class="seg" title=${`Agent working ${formatDuration(part[1] - part[0])} (bars are at least 1 px wide, so a very short one can look longer)`} style=${`${span(part)};background:${color}`}></div>`)}
        ${l.turns.map(t => html`<div class=${'mk ' + markKind(t.k)} data-sender=${t.k} title=${turnTip(ctx, s, t)} style=${`left:${pct(ctx, t.t)}%`}></div>`)}
        ${l.turns.filter(t => t.sub > 0).map(t => html`<div class="sub" title=${`${t.sub} sub-agent ${t.sub === 1 ? 'launch' : 'launches'} recorded in the turn that started here`} style=${`left:${pct(ctx, t.t)}%`}>${t.sub}</div>`)}
      </div>
    </div>` as VNode;
}

function familyHeader(ctx: ViewContext, f: ViewFamily): VNode {
  const multi = f.lanes.length > 1;
  const top = ctx.p.sessions[f.root];
  const collapsed = state.collapsed.has(top.id);
  const toggle = () => {
    if (!multi) return;
    const next = new Set(state.collapsed);
    if (collapsed) next.delete(top.id);
    else next.add(top.id);
    update({ collapsed: next });
  };
  return html`
    <div class="tlx-fam" data-family=${top.id} onClick=${toggle} role=${multi ? 'button' : undefined} tabindex=${multi ? '0' : undefined}
      onKeyDown=${multi ? onActivate(toggle) : undefined} aria-expanded=${multi ? String(!collapsed) : undefined}>
      <div><span class="caret">${multi ? (collapsed ? '▸' : '▾') : ''}</span><b class="nm">${ctx.namer.name(top)}</b>
        <span class="muted"> · ${ctx.namer.repo(top)} · ${f.lanes.length} ${f.lanes.length === 1 ? 'session' : 'sessions'} shown</span>
        ${f.size > f.lanes.length ? html` <span class="ext">(${f.size} in family)</span>` : null}</div>
      <div class="roll">
        <span><b>${f.typed}</b> you · <b>${f.automated}</b> automated</span>
        <span><b>${formatDuration(f.agentMs)}</b> agent</span>
        <span><b>${formatCredits(f.credits)}</b> cr</span>
        ${ctx.families.some(x => x.credits > 0)
          ? html`<span>${f.share > 0 ? html`<i class="share" style=${`width:${f.share * 1.6}px;background:${familyColor(f)}`}></i>` : null}<b>${f.share.toFixed(1)}%</b> of credits shown</span>`
          : html`<span>— of credits</span>`}
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
      if (f.lanes.length > 1 && state.collapsed.has(ctx.p.sessions[f.root].id)) continue;
      for (const { lane, depth } of f.ordered) addLane(lane, depth);
    }
  }
  const linkedForks = ctx.p.sessions.filter(s => !s.ctx && s.fork !== undefined).length;
  const forks = [
    linkedForks > 0
      ? `${linkedForks} ${linkedForks === 1 ? 'session in range is a fork' : 'sessions in range are forks'} of another session, marked “fork of” on the lane: Codex logs a fork’s source, and Claude Code forks are found from the turns they copied. Copied turns count once, in the source, and a fork isn’t part of a family.`
      : 'No fork was found in range: Codex logs a fork’s source, and Claude Code forks are found from the turns they copy.',
    ctx.p.forkedSessions > 0
      ? `${ctx.p.forkedSessions} Copilot ${ctx.p.forkedSessions === 1 ? 'session reports' : 'sessions report'} forks (fork_count), but their logs name no source session, so they aren’t linked.`
      : 'Copilot logs only a fork count, with no source session, so Copilot forks aren’t linked.',
  ].join(' ');
  return html`
    <div class=${'tlx-lanes' + (ctx.view !== 'day' && ctx.r1 - ctx.r0 > 26 * 3.6e6 ? ' wk' : '')} id="tlxLanes" tabindex="0" aria-label="Session lanes: ↑ ↓ change lane, ← → change day, week or range">
      ${rows}
      ${children.map(l => {
        const top = centre.get(l.visibleParent);
        const bottom = centre.get(l.s.index);
        if (top == null || bottom == null) return null;
        const from = top + 6;
        const color = laneColor(ctx, l);
        return html`<div class="conn" aria-hidden="true" style=${`left:calc(var(--tl-label) + 12px + (100% - var(--tl-label) - 24px) * ${(pct(ctx, Math.max(ctx.r0, l.s.created ?? l.first)) / 100).toFixed(4)});top:${from}px;height:${Math.max(4, bottom - 7 - from)}px;color:${color};border-color:${color}`}></div>`;
      })}
      <div class="tlx-axis">${ctx.ticks.map(([x, label]) => html`<span style=${`left:${pct(ctx, x)}%`}>${label}</span>`)}</div>
      <div class="tlx-fork">${forks}</div>
    </div>` as VNode;
}

function impactPanel(ctx: ViewContext, childLanes: number, childShare: number): VNode {
  const rows = [...ctx.families].sort((a, b) => b.credits - a.credits || b.agentMs - a.agentMs || a.root - b.root);
  const max = Math.max(0, ...rows.map(f => f.share));
  const anyCredits = rows.some(f => f.credits > 0);
  const select = (f: ViewFamily) => {
    const top = f.lanes.find(l => l.s.index === f.root) ?? [...f.lanes].sort((a, b) => b.credits - a.credits || a.s.index - b.s.index)[0];
    const next = new Set(state.collapsed);
    next.delete(ctx.p.sessions[f.root].id);
    scrollToSelected = true;
    update({ collapsed: next, selected: top.s.id });
  };
  return html`
    <div class="tlx-panel" id="tlxImpact">
      <h4>Impact by session family</h4>
      <p class="note">A coordinator and the sessions it started, ${ctx.view === 'day' ? state.date : thisPeriod(ctx.view)}. Credits are logged AI credits;
        bars compare each family with the largest. Click a row to select the coordinator, or the family’s top session shown when the
        coordinator isn’t.</p>
      <table>
        <thead><tr><th>Family</th><th class="num">You / auto</th><th class="num">Agent time</th><th class="num">Unattended</th><th class="num">Credits</th><th>Share</th></tr></thead>
        <tbody>${rows.map(f => html`
          <tr class="click" data-family=${ctx.p.sessions[f.root].id} tabindex="0" onClick=${() => select(f)} onKeyDown=${onActivate(() => select(f))}>
            <td><span class="fdot" style=${`background:${familyColor(f)}`}></span><b>${ctx.namer.name(ctx.p.sessions[f.root])}</b>
              <small>${f.lanes.length > 1 ? `${f.lanes.length} sessions · ${f.lanes.filter(l => l.s.parent >= 0).length} with a parent session` : '1 session'}</small></td>
            <td class="num">${f.typed} / ${f.automated}</td>
            <td class="num">${formatDuration(f.agentMs)}</td>
            <td class="num">${f.unattendedMs > 0 ? formatDuration(f.unattendedMs) : '—'}</td>
            <td class="num">${formatCredits(f.credits)}</td>
            <td>${anyCredits
              ? html`${f.share > 0 ? html`<i class="bar" style=${`width:${f.share / max * 110}px;background:${familyColor(f)}`}></i>` : null}${f.share.toFixed(1)}%`
              : '—'}</td>
          </tr>`)}
        </tbody>
      </table>
      <p class="note tlx-note-end">Child sessions: ${childLanes} of ${ctx.lanes.length} lanes${anyCredits ? `, ${childShare.toFixed(1)}% of the credits` : ', no credits logged'}.
        Unattended = the family’s longest stretch of agent work after one of your prompts or answers, until the work stopped or your
        next input anywhere in the family.</p>
    </div>` as VNode;
}

function goLink(text: string, onGo: () => void, id?: string): VNode {
  return html`<a href="#" id=${id} onClick=${(e: Event) => { e.preventDefault(); onGo(); }}>${text}</a>` as VNode;
}

/** `7 tokens`, `12k tokens`, `1.3M tokens`. */
function formatTokens(n: number): string {
  if (n <= 0) return 'no tokens logged';
  if (n < 1000) return `${formatCount(n)} ${n === 1 ? 'token' : 'tokens'}`;
  return n >= 1e5 ? `${(n / 1e6).toFixed(1)}M tokens` : `${Math.round(n / 1000)}k tokens`;
}

/** What a lane with no turn start in the window shows: work or waiting that began earlier, or, in a session that logged
 *  no turn at all, the questions or permission prompts you answered. Each part only when the logs show it. */
function noTurnNote(ctx: ViewContext, l: TimelineLane): string {
  const [from] = l.win;
  const workEarlier = l.s.work.some(([a, b]) => a < from && b > from);
  const waitEarlier = l.waits.some(w => w.start < from && w.end > from);
  const parts = [
    l.agentMs > 0 ? `${formatDuration(l.agentMs)} of agent work${workEarlier ? ' from a turn that began earlier' : ''}` : '',
    l.waitMs > 0 ? `${formatDuration(l.waitMs)} of waiting on you${waitEarlier ? ' that began earlier' : ''}` : '',
    l.answered > 0 ? `${formatCount(l.answered)} ${l.answered === 1 ? 'question or permission prompt' : 'questions or permission prompts'} you answered` : '',
  ].filter(Boolean);
  const shows = parts.length ? `the lane shows ${parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0]}` : 'nothing was measured in it';
  return l.s.all.length === 0
    ? `This session logged no turn, only stops for you: ${shows}.`
    : `No turn started ${thisPeriod(ctx.view)}: ${shows}.`;
}

function detailPanel(ctx: ViewContext): VNode {
  const l = ctx.lanes.find(x => x.s.id === state.selected);
  if (!l) return html`<div class="tlx-panel" id="tlxDetail"><p class="note">Select a lane to see its turns.</p></div>` as VNode;
  const s = l.s;
  const parent = s.parent >= 0 ? ctx.p.sessions[s.parent] : null;
  const firstChild = ctx.p.sessions.filter(x => x.parent === s.index && !x.ctx).sort((a, b) => (a.all[0]?.t ?? 0) - (b.all[0]?.t ?? 0))[0];
  const totalCredits = ctx.lanes.reduce((a, x) => a + x.credits, 0);
  const branch = ctx.namer.branch(s);
  const origin = s.via === 'relay' ? ' · started by a relayed message' : s.via === 'harness' ? ' · started by its parent agent' : s.parent >= 0 ? ' · created by its parent' : '';
  const familyHasMany = (ctx.p.familySize.get(s.root) ?? 1) > 1;
  const when = (t: number) => new Date(t).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const fork = forkNote(ctx, s);
  return html`
    <div class="tlx-panel" id="tlxDetail" aria-live="polite">
      <div class="dr-head"><div>
        <h4 id="tlxDetailName">${ctx.namer.name(s)}</h4>
        <p class="note dr-role">${roleWithParent(s, ctx.namer, ctx.p)} · ${ctx.namer.repo(s)}${branch ? ` · branch ${branch}` : ''}</p>
        <p class="note">${s.harness} · ${ctx.namer.model(s) || 'model not logged'} · ${when(l.first)} – ${when(l.last)}${origin}${fork ? ` · ${fork}` : ''}</p>
      </div><span class="chip chip-sel">selected</span></div>
      <div class="dr-kpis">
        <div><b>${l.typed} / ${l.automated}</b><span>you / automated</span></div>
        <div><b>${formatDuration(l.agentMs)}</b><span>agent time ${thisPeriod(ctx.view)}</span></div>
        <div><b>${formatCredits(l.credits)} cr</b><span>${totalCredits > 0 ? `${(100 * l.credits / totalCredits).toFixed(1)}% of the ${ctx.view === 'range' ? 'range' : ctx.view}` : 'no credits logged'}</span></div>
        <div><b>${l.subagents}</b><span>sub-agent launches</span></div>
      </div>
      ${l.turns.length === 0
        ? html`<p class="note">${noTurnNote(ctx, l)}</p>`
        : html`<div class="dr-turns"><table>
        <thead><tr><th>Time</th><th>Sent by</th><th class="num">Agent worked</th><th class="num">Stopped for you</th><th class="num">Sub-agents</th></tr></thead>
        <tbody>${l.turns.map(t => {
          const times = turnTimes(t);
          return html`<tr>
          <td>${formatWhen(t.t, ctx.view)}</td>
          <td><span class=${'who-' + (t.k === 'compaction' ? 'other' : t.k)}>${SENDER_SHORT[t.k]}</span>${t.comp ? html` <span class="chip">compaction</span>` : null}</td>
          <td class="num">${t.noDuration ? '—' : formatDuration(times.workMs)}</td>
          <td class="num">${t.w?.length ? formatDuration(times.blockedMs) : ''}</td>
          <td class="num">${t.sub || ''}</td></tr>`;
        })}
        </tbody></table></div>`}
      <p class="note tlx-note-end">${l.turns.length} ${l.turns.length === 1 ? 'turn' : 'turns'} started ${thisPeriod(ctx.view)} · ${formatTokens(l.tokens)} ·
        rows are whole turns, the cards above only ${thisPeriod(ctx.view)}</p>
      ${textSection(ctx, l)}
      <div class="dr-links">
        ${parent && !parent.ctx ? goLink('Open parent session ›', () => openSession(parent.index), 'tlxOpenParent') : null}
        ${parent?.ctx ? html`<span class="muted">parent outside this range or the sidebar selection</span>` : null}
        ${s.fork !== undefined && s.fork >= 0 ? goLink('Open fork source ›', () => openSession(s.fork!), 'tlxOpenForkSource') : null}
        ${firstChild ? goLink('Open first child ›', () => openSession(firstChild.index), 'tlxOpenChild') : null}
        ${familyHasMany ? goLink('Show family in Families ›', () => {
          scrollToSelected = true;
          update({ view: 'families', family: ctx.p.sessions[s.root].id, verdict: 'all', familyMin: 2, familyQuery: '' });
        }, 'tlxShowFamily') : null}
        <a href="#" data-page="config-health" data-nav-hint="prompt-cache">Context Health › Prompt Cache ›</a>
        ${FF_TOKEN_REPORTING_ENABLED ? html`<a href="#" data-page="config-health" data-nav-hint="token-types">Token Types ›</a>` : null}
      </div>
    </div>` as VNode;
}

/* ---- prompts and questions (detail panel, local only) ---- */

const TURN_TITLE: Record<TurnSender, string> = {
  you: 'You typed', agent: 'Sent by an agent or session', autopilot: 'Autopilot continuation', compaction: 'Compaction', other: 'System or harness message',
};
const ASK_TITLE: Record<TimelineTextWait['k'], string> = {
  question: 'The agent asked you', relay: 'A child session’s question, relayed to you', permission: 'Permission prompt',
};
const DECISIONS: Record<string, string> = {
  approved: 'approved', 'approved-for-location': 'approved for this location', 'approved-for-session': 'approved for the session',
  'denied-interactively-by-user': 'denied by you', 'denied-no-approval-rule-and-could-not-request-from-user': 'denied: no rule allowed it and you couldn’t be asked',
};

function setShowText(on: boolean): void {
  const saved: unknown = vscode.getState();
  vscode.setState({ ...(saved && typeof saved === 'object' ? saved : {}), [SHOW_TEXT_KEY]: on });
  update({ showText: on });
}

/** The lane's text, read once per load and window: the first call starts the request and redraws when it answers. The
 *  request names what the lane shows (its window, its turns and the turn before each wait for your next prompt), so
 *  the read returns that and nothing more. */
function sessionText(l: TimelineLane): TextEntry {
  const key = `${l.s.id}|${l.win[0]}|${l.win[1]}`;
  shownTextKey = key;
  const known = texts.get(key);
  if (known) return known;
  const entry: TextEntry = { status: 'loading' };
  texts.set(key, entry);
  // A read the Timeline reloaded under (the map was cleared, and the lane read again) is dropped.
  const settle = (next: TextEntry) => {
    if (texts.get(key) !== entry) return;
    texts.set(key, next);
    draw();
  };
  // A read dropped for a newer one is forgotten, and read again if its lane is the one shown.
  const superseded = () => {
    if (texts.get(key) !== entry) return;
    texts.delete(key);
    if (shownTextKey === key) draw();
  };
  const scope = textScope(l.win, [...l.turns, ...l.waits.flatMap(w => (w.after ? [w.after] : []))]);
  if (scope.turns.length > MAX_TEXT_SCOPE_TURNS) {
    const tooMany: TextEntry = { status: 'tooMany', turns: scope.turns.length };
    texts.set(key, tooMany);
    return tooMany;
  }
  rpc<TimelineSessionText | TimelineTextSuperseded | null>('getTimelineSessionText', { sessionId: l.s.id, scope })
    .then(text => (text && 'superseded' in text ? superseded() : settle(text ? { status: 'ready', text } : { status: 'missing' })))
    .catch(() => settle({ status: 'missing' }));
  return entry;
}

function textItem(key: string, head: string, body: (VNode | null)[], focus = state.textFocus === key): VNode {
  return html`<div class=${'tx-item' + (focus ? ' focus' : '')} data-text-at=${key}>
    <div class="tx-head">${head}</div>${body}</div>` as VNode;
}

function quote(text: string | undefined, cls = 'tx-body'): VNode | null {
  return text ? html`<div class=${cls}>${text}</div>` as VNode : null;
}

function earlier(label: string, text: string | undefined, open = false): VNode | null {
  return text ? html`<details class="tx-more" open=${open}><summary>${label}</summary><div class="tx-body">${text}</div></details>` as VNode : null;
}

/** A time in the detail panel: with its date when it falls outside the shown day or week (a wait that began earlier). */
function textTime(ctx: ViewContext, t: number, win: Interval): string {
  if (t >= win[0] && t < win[1]) return formatWhen(t, ctx.view);
  return new Date(t).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function turnItem(ctx: ViewContext, t: TimelineTurn, tt: TimelineTextTurn | undefined): VNode {
  const kind = tt?.k ?? t.k;
  const hidden = kind === 'compaction' || kind === 'other';
  return textItem(`t:${t.t}${t.id ? `:${t.id}` : ''}`, `${formatWhen(t.t, ctx.view)} · ${TURN_TITLE[t.k]}`, [
    // The agent's reply to a harness message is its own words, and can be the last it said before it needed you.
    tt?.prompt ? quote(tt.prompt) : html`<p class="note">${hidden ? 'The message that started it isn’t shown: it is a summary or a harness message, not an instruction.' : 'No message text was logged.'}</p>` as VNode,
    earlier('End of the agent’s reply in this turn', tt?.reply),
  ]);
}

function askItem(ctx: ViewContext, w: TimelineTextWait, win: Interval, focus: boolean): VNode {
  // Timed to Copilot's record of your answer when it logged one, else to the result.
  const answered = w.at ?? w.e;
  const took = answered >= w.s ? `after ${formatDuration(answered - w.s)}` : 'before the request was logged';
  const status = w.k === 'permission'
    ? (w.a ? `decided by you ${took}` : 'no record that you decided it')
    : (w.a ? `you answered ${took}` : 'not answered: interrupted, or no answer logged');
  const decision = w.answer ? DECISIONS[w.answer] ?? w.answer : '';
  return textItem(`w:${w.k}:${w.s}`, `${textTime(ctx, w.s, win)} · ${ASK_TITLE[w.k]} · ${status}`, w.k === 'permission' ? [
    w.tool ? html`<div class="tx-meta">Requested · ${w.tool}</div>` as VNode : null,
    quote(w.ask, 'tx-body tx-code'),
    w.intention ? html`<div class="tx-meta">The agent’s reason: ${w.intention}</div>` as VNode : null,
    decision ? html`<div class="tx-answer"><b>Decision</b> ${decision}</div>` as VNode : null,
  ] : [
    earlier('What the agent said before it asked', w.before, true),
    quote(w.ask) ?? html`<p class="note">The question’s text wasn’t logged.</p>` as VNode,
    w.choices?.length ? html`<ul class="tx-choices">${w.choices.map(c => html`<li>${c}</li>`)}</ul>` as VNode : null,
    w.answer ? html`<div class="tx-answer"><b>${w.k === 'relay' ? 'Your reply' : 'Your answer'}</b> ${w.answer}</div>` as VNode : null,
  ], focus);
}

/** The questions or permission prompts a click on a hatched wait highlights: those of its kind and start, and of them
 *  the one that ended when it did, when two began together. */
function focusedAsks(asks: readonly TimelineTextWait[]): Set<TimelineTextWait> {
  const same = asks.filter(w => `w:${w.k}:${w.s}` === state.textFocus);
  const exact = same.filter(w => w.e === state.textFocusEnd);
  return new Set(exact.length ? exact : same);
}

/** The prompts that started this window's turns, what each question or permission prompt asked and what you answered,
 *  and each wait for your next prompt with the message it followed: local text, read when the lane is opened. */
function textSection(ctx: ViewContext, l: TimelineLane): VNode {
  const on = !!state.showText && !state.masked;
  const toggle = html`<label class="tlx-text-toggle"><input type="checkbox" id="tlxShowText" checked=${on} disabled=${state.masked}
    onChange=${(e: Event) => setShowText((e.target as HTMLInputElement).checked)} /> Show prompts and questions</label>`;
  const wrap = (...body: (VNode | null)[]) => html`<div class="tlx-text" id="tlxText">${toggle}${body}</div>` as VNode;
  if (state.masked) return wrap(html`<p class="note">Hidden while names are masked.</p>` as VNode);
  if (!on) return wrap();
  const entry = sessionText(l);
  if (entry.status === 'loading') return wrap(html`<p class="note">Reading this session’s log…</p>` as VNode);
  if (entry.status === 'missing') return wrap(html`<p class="note">This session’s log couldn’t be read again, so its text isn’t available.</p>` as VNode);
  if (entry.status === 'tooMany') {
    return wrap(html`<p class="note">This lane lists ${formatCount(entry.turns)} turns here, more than the ${formatCount(MAX_TEXT_SCOPE_TURNS)} whose text can be read at once. Pick fewer days to read its prompts and questions.</p>` as VNode);
  }
  const { text } = entry;
  const [from, to] = l.win;
  const textOf = textTurnFinder(text.turns);
  const asks = text.waits.filter(w => waitInWindow(w, from, to));
  const focused = focusedAsks(asks);
  const items: [number, VNode][] = [
    ...l.turns.map(t => [t.t, turnItem(ctx, t, textOf(t))] as [number, VNode]),
    ...asks.map(w => [w.s, askItem(ctx, w, l.win, focused.has(w))] as [number, VNode]),
    ...l.waits.filter(w => w.kind === 'idle').map(w => {
      const before = w.after && textOf(w.after);
      return [w.start, textItem(`i:${w.start}`, `${textTime(ctx, w.start, l.win)} · Waited ${formatDuration(w.end - w.start)} for your next prompt`, [
        before?.k === 'compaction' ? html`<p class="note">It followed a compaction, whose summary isn’t shown.</p>` as VNode
          : earlier('End of the agent’s reply before the wait', before?.reply, true) ?? html`<p class="note">No agent reply was logged before it.</p>` as VNode,
      ])] as [number, VNode];
    }),
  ];
  items.sort((a, b) => a[0] - b[0]);
  const prompts = l.turns.filter(t => textOf(t)?.prompt).length;
  return wrap(
    html`<p class="note">${prompts} ${prompts === 1 ? 'prompt' : 'prompts'}${asks.length ? ` and ${asks.length} ${asks.length === 1 ? 'question or permission prompt' : 'questions or permission prompts'}` : ''} ${thisPeriod(ctx.view)},
      read again from the session’s log on this machine. Links, email addresses, secret-like tokens, your home folder and your names are replaced;
      long text is cut.</p>` as VNode,
    items.length ? html`<div class="tx-list">${items.map(([, node]) => node)}</div>` as VNode : null,
  );
}

/** Shows a session on the Day view (or the current Week), on its busiest day when it has no lane in the current window.
 *  The Range view stays when it holds the day asked for or, with none asked, when the session has a lane in it. */
function openSession(index: number, date?: string): void {
  if (!loaded) return;
  const s = loaded.prepared.sessions[index];
  if (s.ctx) return;
  if (state.view === 'range' && state.range) {
    const { from, to } = state.range;
    const keep = date ? date >= from && date <= to : activeIn(s, rangeWindow(state.range));
    if (date) state.date = date;
    if (!keep) Object.assign(state, { view: 'day', date: date ?? busiestDay(s) });
  } else {
    if (date) state.date = date;
    else if (state.view === 'families' || !activeIn(s, windowOf(period()))) state.date = busiestDay(s);
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
      && f.members >= state.familyMin
      && (state.verdict === 'all' || (state.verdict === 'wide' ? f.wide : f.verdict === state.verdict)))
    .sort((a, b) => (key === 'recent' ? b.to.localeCompare(a.to) || b.credits - a.credits : sortValue(b) - sortValue(a)) || a.rank - b.rank);
}

/** `12%`, or — when no credits were logged. */
function shareText(share: number, totalCredits: number, digits = 0): string {
  return totalCredits > 0 ? `${share.toFixed(digits)}%` : '—';
}

function familiesView(data: Loaded, namer: Namer): VNode {
  data.overview ??= buildFamilies(data.prepared);
  const o = data.overview;
  const t = o.totals;
  if (o.families.length === 0) {
    return html`<div class="howto" id="tlxNoFamilies"><div class="howto-t">No session families in this range</div>
      <p class="howto-l">A family is a coordinator session and the child sessions it started for you, for example with create_session in the
      Copilot App, or sub-agent threads in Codex and OpenCode. No parent–child link was found among the ${t.sessions} ${t.sessions === 1 ? 'session' : 'sessions'} in this range.</p></div>` as VNode;
  }
  const shown = shownFamilies(o, namer);
  // The selection stays on a family in the list; with an empty list, nothing is selected.
  if (!shown.some(f => f.s.id === state.family)) state.family = shown[0]?.s.id ?? null;
  const credits = t.totalCredits;
  const chip = (id: VerdictFilter, label: string, n: number, share: number, color: string) => html`
    <button type="button" class=${'vf' + (state.verdict === id ? ' on' : '')} data-verdict=${id} style=${`--c:${color}`} aria-pressed=${state.verdict === id ? 'true' : 'false'}
      onClick=${() => update({ verdict: id })}><b>${label}</b><span>${n} ${n === 1 ? 'family' : 'families'} · ${shareText(share, credits)} of credits</span></button>`;
  const sorts: [FamilySort, string][] = [['credits', 'Credits'], ['children', 'Child sessions'], ['agentMs', 'Agent time'], ['childTyped', 'Prompts into children'], ['perChild', 'Credits per child'], ['recent', 'Most recent']];
  const showCumulative = credits > 0 && state.familySort === 'credits' && state.verdict === 'all' && !state.familyQuery.trim() && state.familyMin === 2;
  const top = Math.min(3, t.families);
  let cumulative = 0;
  return html`
    <div class="howto">
      <div class="howto-t">How to read Families</div>
      <p class="howto-l">A <b>family</b> is a <b>coordinator</b> session plus the <b>child sessions</b> it started, directly or through its children,
        as linked in your logs. Each row is one family, so you can look at a delegation as a whole instead of ${t.sessionsInFamilies} separate sessions.</p>
      <div class="howto-g">
        <div><b>1 · What did it cost?</b><span>Rows are ranked by logged AI credits. The bar compares the family with the top one; the number is its share of all your credits. Together these families used ${shareText(t.creditShare, credits)}.</span></div>
        <div><b>2 · Did you step in?</b><span>${verdictBadge('alone')} no prompt or answer from you was recorded in any child. ${verdictBadge('needed')} you typed into a child, or answered its question or permission prompt.</span></div>
        <div><b>3 · How wide was it?</b><span>${verdictBadge('wide')} ${WIDE_FAN_OUT} or more child sessions at any depth, shown on top of the other verdict. Compare credits per child.</span></div>
      </div>
      <p class="howto-l howto-end">Select a family to see each session by name, what the logs show about it and one habit to consider. Click a session to open it on the Timeline.</p>
    </div>
    <div class="ctx-cache-tips tlx-insights" id="tlxFamilyInsights" role="note">
      <div class="ctx-cache-tips-title">What your families show</div>
      ${familiesInsights(t).map(tip => html`<div class="ctx-cache-tip">• ${tip}</div>`)}
    </div>
    <div class="ctx-comp-kpis tlx-kpis" id="tlxFamilyKpis">
      ${kpiCard(formatCount(t.families), 'Session families', `${formatCount(t.sessionsInFamilies)} of ${formatCount(t.sessions)} sessions belong to one`, '#3794ff')}
      ${kpiCard(formatCount(t.children), 'Child sessions', `${formatCount(t.children - t.childrenNeedingYou)} with no prompt or answer from you`, '#b180d7')}
      ${kpiCard(shareText(t.creditShare, credits), 'Of all AI credits', credits > 0 ? `${Math.round(t.childCreditShare)}% in the child sessions alone` : 'no credits logged: only Copilot logs them', '#cf222e')}
      ${kpiCard(formatHours(t.agentMs), 'Agent time', t.totalAgentMs > 0 ? `${Math.round(t.agentShare)}% of all agent time` : 'no agent time measured', '#f0883e')}
      ${kpiCard(formatCount(t.childTyped), 'Prompts you typed into children', `out of ${formatCount(t.typed)} you typed in families${t.childAnswered ? `, plus ${formatCount(t.childAnswered)} ${t.childAnswered === 1 ? 'answer' : 'answers'} in children` : ''}`, '#d29922')}
      ${kpiCard(shareText(t.top3Share, credits), `Credits in the top ${top}`, `of ${formatCount(t.families)} ${t.families === 1 ? 'family' : 'families'}, by credits`, '#8b949e')}
    </div>
    <div class="vfs" role="group" aria-label="Filter by verdict">
      ${chip('all', 'All families', t.families, t.creditShare, '#8b949e')}
      ${chip('alone', VERDICTS.alone.label, t.alone.families, t.alone.creditShare, VERDICT_COLORS.alone)}
      ${chip('needed', VERDICTS.needed.label, t.needed.families, t.needed.creditShare, VERDICT_COLORS.needed)}
      ${chip('wide', VERDICTS.wide.label, t.wide.families, t.wide.creditShare, VERDICT_COLORS.wide)}
    </div>
    <div class="tlx-filters">
      <input type="search" id="tlxFamilyQuery" placeholder=${state.masked ? 'Search is off while names are masked' : 'Search session name or repository…'}
        aria-label="Search families" value=${state.masked ? '' : state.familyQuery} disabled=${state.masked}
        onInput=${(e: Event) => update({ familyQuery: (e.target as HTMLInputElement).value })} />
      <label>Sort <select id="tlxFamilySort" onChange=${(e: Event) => update({ familySort: (e.target as HTMLSelectElement).value as FamilySort })}>
        ${sorts.map(([value, label]) => html`<option value=${value} selected=${state.familySort === value}>${label}</option>`)}
      </select></label>
      <label>Min sessions <select id="tlxFamilyMin" onChange=${(e: Event) => update({ familyMin: Number((e.target as HTMLSelectElement).value) })}>
        ${[2, 3, 5, 10].map(n => html`<option value=${n} selected=${state.familyMin === n}>${n}</option>`)}
      </select></label>
      <span class="tlx-count" id="tlxFamilyCount">${shown.length} of ${o.families.length} families${credits > 0 ? ` · ${shown.reduce((a, f) => a + f.creditShare, 0).toFixed(1)}% of all credits` : ''}</span>
    </div>
    <div class="fx-main">
      <div class="flist" id="tlxFamilyList" role="list">
        ${shown.length === 0 ? html`<div class="tlx-empty">No family matches these filters.</div>` : html`
          <div class="fam-head"><span></span><span>Family · biggest child sessions</span><span>Verdict</span><span>Agent</span><span>Credits · share of all</span></div>
          ${shown.map(f => { cumulative += f.creditShare; return familyRow(f, namer, o, showCumulative ? cumulative : null); })}`}
      </div>
      ${familyAside(o, namer, data.prepared)}
    </div>` as VNode;
}

function familyRow(f: FamilySummary, namer: Namer, o: FamiliesOverview, cumulative: number | null): VNode {
  const kids = f.nodes.filter(n => n.depth > 0 && !n.ctx);
  const biggest = [...kids].sort((a, b) => b.credits - a.credits || a.s.index - b.s.index).slice(0, 3);
  const topShare = o.families[0]?.creditShare ?? 0;
  const credits = o.totals.totalCredits;
  const pick = () => update({ family: f.s.id });
  return html`
    <div class=${'frow' + (f.s.id === state.family ? ' sel' : '')} role="listitem" tabindex="0" data-family=${f.s.id}
      aria-current=${f.s.id === state.family ? 'true' : undefined} onClick=${pick} onKeyDown=${onActivate(pick)}>
      <div class="fr-rank">#${f.rank}</div>
      <div class="fr-main">
        <div class="fr-name">${namer.name(f.s)}</div>
        <div class="fr-sub">${familyRepos(f, namer)} · ${shortDate(f.from)}${f.to !== f.from ? '–' + shortDate(f.to) : ''} · ${f.children} child ${f.children === 1 ? 'session' : 'sessions'}</div>
        <div class="fr-kids">${biggest.map(n => html`<span class=${neededYou(n) ? 'kt' : ''} title=${neededYou(n) ? 'you typed into this child or answered its question or permission prompt' : ''}>↳ ${namer.name(n.s)}</span>`)}
          ${kids.length > 3 ? html`<span class="more">+${kids.length - 3} more</span>` : null}</div>
      </div>
      <div class="fr-v">${verdictBadge(f.verdict)}${f.wide ? verdictBadge('wide') : null}
        <small>${f.steppedInto ? `you stepped into ${f.steppedInto} of ${f.children}` : 'no input in children recorded'}</small></div>
      <div class="fr-n"><b>${formatHours(f.agentMs)}</b><small>agent time</small></div>
      <div class="fr-c"><div><b>${formatCredits(f.credits)}</b> cr <span>${shareText(f.creditShare, credits, 1)}</span></div>
        <i style=${`width:${topShare > 0 ? f.creditShare / topShare * 100 : 0}%`}></i>
        ${cumulative != null ? html`<small>running total ${cumulative.toFixed(0)}%</small>` : null}</div>
    </div>` as VNode;
}

/** The family's repositories, on one basis everywhere (row, detail and chat): those its members active in range used,
 *  the coordinator's first when it is one of them. */
function familyRepos(f: FamilySummary, namer: Namer): string {
  return `${namer.repo(f.repoSession)}${f.repos > 1 ? ` + ${f.repos - 1} more ${f.repos > 2 ? 'repositories' : 'repository'}` : ''}`;
}

/** The node's role in its family. */
function nodeRole(depth: number): string {
  if (depth === 0) return 'coordinator';
  if (depth === 1) return 'child';
  return depth === 2 ? 'grandchild' : `descendant · depth ${depth}`;
}

function familyAside(o: FamiliesOverview, namer: Namer, p: PreparedTimeline): VNode {
  const f = o.families.find(x => x.s.id === state.family);
  if (!f) return html`<aside class="fx-aside" id="tlxFamilyDetail"><p class="note">Select a family to see its sessions.</p></aside>` as VNode;
  const branch = namer.branch(f.s);
  // On the busiest day, the coordinator if it has a lane there, else the family's member with most turns that day.
  const onBusiest = f.nodes.filter(n => !n.ctx && activeIn(n.s, timelineWindow('day', f.busiest)));
  const turnsThatDay = (n: (typeof f.nodes)[number]) => n.s.turns.filter(t => toDateStr(t.t) === f.busiest).length;
  const focus = onBusiest.find(n => n.depth === 0) ?? [...onBusiest].sort((a, b) => turnsThatDay(b) - turnsThatDay(a) || a.s.index - b.s.index)[0];
  const openDay = () => {
    if (!focus) return;
    const collapsed = new Set(state.collapsed);
    collapsed.delete(f.s.id);
    update({ view: 'day', date: f.busiest, group: 'tree', focusId: focus.s.id, filters: { ...NO_LANE_FILTERS }, collapsed });
  };
  const when = (t: number) => new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const credits = o.totals.totalCredits;
  return html`
    <aside class="fx-aside" id="tlxFamilyDetail" aria-live="polite">
      <div class="fa-rank">#${f.rank} of ${o.families.length} by credits</div>
      <h2>${namer.name(f.s)}</h2>
      <p class="meta">${familyRepos(f, namer)}${branch && f.repoSession === f.s ? ` · branch ${branch}` : ''} · ${shortDate(f.from)}${f.to !== f.from ? '–' + shortDate(f.to) : ''} · ${f.harnesses.join(', ')}</p>
      <div class="verdict" style=${`--c:${VERDICT_COLORS[f.verdict]}`}>
        ${verdictBadge(f.verdict)}${f.wide ? verdictBadge('wide') : null}
        <p>${verdictText(f)}</p>
        <p class="habit"><b>Something to try:</b> ${VERDICTS[f.verdict].habit}${f.wide ? ' ' + VERDICTS.wide.habit : ''}</p>
      </div>
      <div class="dr-kpis">
        <div><b>${formatCredits(f.credits)}</b><span>credits · ${shareText(f.creditShare, credits, 1)} of all</span></div>
        <div><b>${formatHours(f.agentMs)}</b><span>agent time</span></div>
        <div><b>${formatCount(f.typed)} / ${formatCount(f.automated)}</b><span>you typed / automated</span></div>
        <div><b>${formatCredits(f.perChild)}</b><span>credits per child · ${f.credits > 0 ? `${Math.round(f.childShare)}% in children` : 'no credits logged'}</span></div>
      </div>
      ${f.busiest && focus ? html`<p class="fa-open"><button type="button" class="tlx-btn" id="tlxOpenFamilyDay" onClick=${openDay}>Open on the Timeline, ${shortDate(f.busiest)} ›</button>
        <span class="muted">${f.nodes.some(n => !n.ctx && n.s.turns.some(t => toDateStr(t.t) === f.busiest)) ? 'the day with most of its turns' : 'its first day with work, waiting or an answer in this range'}</span></p>` : null}
      <table class="ftable">
        <thead><tr><th>Session · ${f.sessions} in range</th><th class="num">You typed</th><th class="num">Agent</th><th class="num">Credits</th></tr></thead>
        <tbody>${f.nodes.map(n => {
          const open = () => openSession(n.s.index);
          return html`
          <tr class=${n.ctx ? 'ctx' : 'click'} data-session=${n.s.id} tabindex=${n.ctx ? undefined : '0'} onClick=${n.ctx ? undefined : open}
            onKeyDown=${n.ctx ? undefined : onActivate(open)} title=${sessionTip(n.s, namer, p)}>
            <td><div class="tn" style=${`padding-left:${n.depth * 16}px`}>${n.depth ? html`<span class="tree">└ </span>` : null}${namer.name(n.s)}</div>
              <small style=${`padding-left:${n.depth * 16 + (n.depth ? 14 : 0)}px`}>${nodeRole(n.depth)}${namer.repo(n.s) !== namer.repo(f.repoSession) ? ' · ' + namer.repo(n.s) : ''}${n.ctx ? ' · not in this range or sidebar selection' : n.first ? ' · ' + when(n.first) : ''}${n.s.via === 'relay' ? ' · started by relay' : ''}</small></td>
            <td class="num">${n.depth > 0 && neededYou(n) ? html`<span class="hand" title=${`you typed ${n.typed} ${n.typed === 1 ? 'prompt' : 'prompts'} and answered ${n.answered} ${n.answered === 1 ? 'question or permission prompt' : 'questions or permission prompts'}`}>✋ ${n.typed}</span>` : n.typed}<small>${n.answered ? `${n.answered} answered · ` : ''}${n.automated} auto</small></td>
            <td class="num">${formatHours(n.agentMs)}</td>
            <td class="num">${formatCredits(n.credits)}<i class="mbar" style=${`width:${f.credits ? 100 * n.credits / f.credits : 0}%`}></i></td>
          </tr>`;
        })}
        </tbody>
      </table>
      <p class="note">✋ = you typed into this child or answered its question or permission prompt · click a session to open it on the Timeline</p>
    </aside>` as VNode;
}

/* ---- keyboard: ← → change day, week or range, ↑ ↓ change lane or family ---- */

/** Keys a focused control uses itself: text fields, lists, buttons, links and editable content. */
function ownsKeys(el: HTMLElement): boolean {
  return /^(INPUT|SELECT|TEXTAREA|BUTTON|A)$/.test(el.tagName) || el.isContentEditable;
}

function onKeyDown(e: KeyboardEvent): void {
  if (!rootEl?.isConnected || !loaded) return;
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  const target = e.target instanceof HTMLElement ? e.target : null;
  if ((target && ownsKeys(target)) || pickerOpen()) return;
  // Only when the Timeline has focus (or nothing does): elsewhere, such as the sidebar, the keys keep their own use.
  const inTimeline = !target || target === document.body || rootEl.contains(target);
  if (!inTimeline) return;
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    if (state.view === 'families') return;
    e.preventDefault();
    const next = stepped(loaded.prepared, e.key === 'ArrowLeft' ? -1 : 1);
    if (next) update(next);
    return;
  }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  // ↑ ↓ move within the lanes or the family list, when one of them has focus; elsewhere they scroll the page.
  const list = target?.closest<HTMLElement>(state.view === 'families' ? '#tlxFamilyList' : '#tlxLanes');
  if (!list) return;
  e.preventDefault();
  const dir = e.key === 'ArrowDown' ? 1 : -1;
  if (state.view === 'families') {
    const rows = [...list.querySelectorAll<HTMLElement>('.frow')];
    const at = rows.findIndex(r => r.dataset.family === state.family);
    const next = rows[Math.max(0, Math.min(rows.length - 1, at + dir))];
    if (next) {
      scrollToSelected = true;
      update({ family: next.dataset.family ?? null });
      rootEl.querySelector<HTMLElement>('.frow.sel')?.focus({ preventScroll: true });
    }
    return;
  }
  const lanes = [...list.querySelectorAll<HTMLElement>('.tlx-lane')];
  const at = lanes.findIndex(l => l.dataset.session === state.selected);
  const next = lanes[Math.max(0, Math.min(lanes.length - 1, at + dir))];
  if (next) {
    update({ selected: next.dataset.session ?? null });
    next.scrollIntoView({ block: 'nearest' });
  }
}

if (typeof document !== 'undefined') document.addEventListener('keydown', onKeyDown);
