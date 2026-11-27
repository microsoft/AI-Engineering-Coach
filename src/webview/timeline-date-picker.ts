/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* The Timeline's date picker: the toolbar's date is a button that opens a calendar. Pick a day (the Day view, or the
 * week holding it), or two days for a custom range; days with activity carry a dot, and days outside the loaded range
 * can't be picked. Keyboard: arrows move a day or a week, Page Up/Down a month, Home/End to the week's ends, Enter
 * picks, Esc closes; focus stays inside while it's open and returns to the button. Moving around the calendar redraws
 * only the picker, not the page's lanes; picking a day or a range hands it to the page. */

import { Component, createRef } from 'preact';
import type { TimelinePeriod } from '../core/timeline-model';
import {
  clampRange, monthCells, monthOf, QUICK_RANGES, quickRange, shiftDate, shiftDateByMonths, shiftMonth, MAX_RANGE_DAYS, type DateRange,
} from '../core/timeline-range';
import { html, type VNode } from './render';

export interface PickerInput {
  view: TimelinePeriod;
  /** The day shown (Day), or one in the week shown (Week). */
  date: string;
  /** The range shown on the Range view. */
  range: DateRange | null;
  /** The first and last day that can be picked: the loaded range. */
  lo: string;
  hi: string;
  today: string;
  /** Activity of a day, 0 (none) to 3, and its description. */
  activity: (date: string) => { level: 0 | 1 | 2 | 3; text: string };
  /** The toolbar's text for what is shown. */
  label: string;
}

export interface PickerActions {
  pickDate(date: string): void;
  pickRange(range: DateRange, capped: boolean): void;
}

type Mode = 'date' | 'range';

const ui = {
  open: false,
  mode: 'date' as Mode,
  month: '',
  focus: '',
  /** The first day picked for a range, until the last one is. */
  anchor: null as string | null,
  /** Move focus after the picker's next draw: to the focused day, or back to the button. */
  focusDay: false,
  focusButton: false,
  /** Focus was in the calendar before this draw: it stays there if what held it is gone or disabled. */
  keepFocus: false,
};

export function pickerOpen(): boolean {
  return ui.open;
}

/** Closes the calendar (a reload, another view). */
export function closePicker(): void {
  ui.open = false;
  ui.anchor = null;
}

const within = (d: string, lo: string, hi: string) => (d < lo ? lo : d > hi ? hi : d);

/** Draws the picker on the page again on its own, while you move around the calendar. */
let shown: (() => void) | null = null;

function redraw(): void {
  ui.keepFocus = !!document.activeElement?.closest('#tlxCal');
  shown?.();
}

function open(input: PickerInput): void {
  ui.open = true;
  ui.mode = input.view === 'range' ? 'range' : 'date';
  ui.focus = within(input.view === 'range' && input.range ? input.range.from : input.date, input.lo, input.hi);
  ui.month = monthOf(ui.focus);
  ui.anchor = null;
  ui.focusDay = true;
  redraw();
}

function close(): void {
  closePicker();
  ui.focusButton = true;
  redraw();
}

/** Keeps the open calendar inside the window: on a narrow panel it moves left, under the date it belongs to. */
function fitCalendar(root: Element): void {
  const cal = root.querySelector<HTMLElement>('#tlxCal');
  if (!cal) return;
  cal.style.left = '';
  const over = cal.getBoundingClientRect().right - (document.documentElement.clientWidth - 8);
  if (over > 0) cal.style.left = `-${Math.min(over, cal.getBoundingClientRect().left - 8)}px`;
}

/** Moves focus after a draw, and keeps the calendar in view. */
function afterDraw(root: Element): void {
  fitCalendar(root);
  if (ui.focusDay) {
    ui.focusDay = false;
    root.querySelector<HTMLElement>(`#tlxCal button[data-date="${ui.focus}"]`)?.focus();
  }
  if (ui.focusButton) {
    ui.focusButton = false;
    root.querySelector<HTMLElement>('#tlxDateLabel')?.focus();
  }
  // A month button disabled at the first or last loaded month drops focus: it goes to the month's day reached by Tab.
  // Chromium moves focus off a control that turns disabled only at its next frame, so one still on it has lost it too.
  if (ui.keepFocus) {
    ui.keepFocus = false;
    const active = document.activeElement;
    const lost = !active?.closest('#tlxCal') || (active instanceof HTMLButtonElement && active.disabled);
    if (ui.open && lost) root.querySelector<HTMLElement>('#tlxCal button[data-date][tabindex="0"]')?.focus();
  }
}

function pick(input: PickerInput, actions: PickerActions, day: string): void {
  if (ui.mode === 'date') {
    closePicker();
    ui.focusButton = true;
    actions.pickDate(day);
    return;
  }
  if (!ui.anchor) {
    ui.anchor = day;
    ui.focus = day;
    ui.focusDay = true;
    redraw();
    return;
  }
  const picked = clampRange(ui.anchor, day, input.lo, input.hi);
  closePicker();
  ui.focusButton = true;
  if (picked) actions.pickRange(picked.range, picked.capped);
  else redraw();
}

/** The day the arrow, Page or Home/End key moves focus to, or null for another key. */
function moved(key: string, from: string): string | null {
  const weekday = (new Date(from + 'T00:00:00').getDay() + 6) % 7;
  switch (key) {
    case 'ArrowLeft': return shiftDate(from, -1);
    case 'ArrowRight': return shiftDate(from, 1);
    case 'ArrowUp': return shiftDate(from, -7);
    case 'ArrowDown': return shiftDate(from, 7);
    case 'PageUp': return shiftDateByMonths(from, -1);
    case 'PageDown': return shiftDateByMonths(from, 1);
    case 'Home': return shiftDate(from, -weekday);
    case 'End': return shiftDate(from, 6 - weekday);
    default: return null;
  }
}

function onKeyDown(e: KeyboardEvent, input: PickerInput): void {
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    close();
    return;
  }
  if (e.key === 'Tab') {
    // Focus stays inside the calendar while it's open.
    const dialog = (e.currentTarget as HTMLElement);
    const items = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]):not([tabindex="-1"])')];
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = e.shiftKey ? (at <= 0 ? items.length - 1 : at - 1) : (at < 0 || at === items.length - 1 ? 0 : at + 1);
    e.preventDefault();
    items[next].focus();
    return;
  }
  const day = (e.target as HTMLElement).dataset?.date;
  if (!day || e.altKey || e.ctrlKey || e.metaKey) return;
  const to = moved(e.key, day);
  if (!to) return;
  e.preventDefault();
  e.stopPropagation();
  ui.focus = within(to, input.lo, input.hi);
  ui.month = monthOf(ui.focus);
  ui.focusDay = true;
  redraw();
}

/** The days to highlight: the shown day, week or range, or the range being picked. */
function highlighted(input: PickerInput): [string, string] | null {
  if (ui.mode === 'range') {
    if (ui.anchor) return ui.anchor <= ui.focus ? [ui.anchor, ui.focus] : [ui.focus, ui.anchor];
    return input.view === 'range' && input.range ? [input.range.from, input.range.to] : null;
  }
  if (input.view === 'week') {
    const weekday = (new Date(input.date + 'T00:00:00').getDay() + 6) % 7;
    return [shiftDate(input.date, -weekday), shiftDate(input.date, 6 - weekday)];
  }
  return input.view === 'day' ? [input.date, input.date] : null;
}

/** What the calendar's parts share while it's drawn. */
interface Cal {
  input: PickerInput;
  actions: PickerActions;
  /** The one day reached by Tab. */
  tabDay: string;
  span: [string, string] | null;
}

function dayCell(c: Cal, day: string): VNode {
  const { input, span } = c;
  const outside = day < input.lo || day > input.hi;
  const { level, text } = input.activity(day);
  const on = span !== null && day >= span[0] && day <= span[1];
  const ends = span !== null && (day === span[0] || day === span[1]);
  const name = new Date(day + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const cls = ['tlx-cal-d', monthOf(day) !== ui.month ? 'other' : '', on ? 'in' : '', ends ? 'end' : '', day === input.today ? 'today' : '', `a${level}`]
    .filter(Boolean).join(' ');
  return html`<td role="gridcell" aria-selected=${on ? 'true' : 'false'}>
    <button type="button" class=${cls} data-date=${day} tabindex=${day === c.tabDay ? '0' : '-1'} disabled=${outside}
      aria-label=${`${name}, ${outside ? 'outside the loaded range' : text}`} title=${outside ? 'Outside the loaded range' : text}
      onClick=${() => pick(input, c.actions, day)}>
      ${Number(day.slice(8))}<i class="dot" aria-hidden="true"></i>
    </button></td>` as VNode;
}

/** Pick a day or a range, close; then the month, with ‹ › to the months that hold loaded days. */
function calHead(c: Cal): VNode {
  const { input } = c;
  const setMode = (mode: Mode) => {
    Object.assign(ui, { mode, anchor: null });
    redraw();
  };
  const goMonth = (n: number) => {
    ui.month = shiftMonth(ui.month, n);
    redraw();
  };
  const monthName = new Date(ui.month + '-01T00:00:00').toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  return html`
    <div class="tlx-cal-head">
      <span class="tlx-seg" id="tlxCalMode" role="group" aria-label="Pick">
        ${([['date', 'A day'], ['range', 'A range']] as [Mode, string][]).map(([m, text]) => html`<button type="button" data-value=${m}
          class=${ui.mode === m ? 'on' : ''} aria-pressed=${ui.mode === m ? 'true' : 'false'} onClick=${() => setMode(m)}>${text}</button>`)}
      </span>
      <button type="button" class="tlx-btn tlx-btn-quiet" id="tlxCalClose" aria-label="Close" onClick=${close}>✕</button>
    </div>
    <div class="tlx-cal-month">
      <button type="button" id="tlxCalPrev" aria-label="Previous month" disabled=${ui.month <= monthOf(input.lo)} onClick=${() => goMonth(-1)}>‹</button>
      <b id="tlxCalMonth" aria-live="polite">${monthName}</b>
      <button type="button" id="tlxCalNext" aria-label="Next month" disabled=${ui.month >= monthOf(input.hi)} onClick=${() => goMonth(1)}>›</button>
    </div>` as VNode;
}

/** Today, and the quick ranges, each kept within the loaded days. */
function calQuick(c: Cal): VNode {
  const { input, actions } = c;
  const todayIn = input.today >= input.lo && input.today <= input.hi;
  // Today: picks it as the day, or shows it to start a range from.
  const today = () => {
    if (ui.mode === 'date') return pick(input, actions, input.today);
    Object.assign(ui, { focus: input.today, month: monthOf(input.today), focusDay: true });
    redraw();
  };
  return html`
    <div class="tlx-cal-quick">
      <button type="button" class="tlx-btn tlx-btn-quiet" id="tlxCalToday" disabled=${!todayIn}
        title=${todayIn ? '' : 'Today is outside the loaded range'} onClick=${today}>Today</button>
      ${QUICK_RANGES.map(([kind, text]) => {
        const q = quickRange(kind, input.today);
        const r = clampRange(q.from, q.to, input.lo, input.hi);
        const go = () => {
          if (!r) return;
          closePicker();
          ui.focusButton = true;
          actions.pickRange(r.range, r.capped);
        };
        return html`<button type="button" class="tlx-btn tlx-btn-quiet" data-quick=${kind} disabled=${!r}
          title=${r ? `${short(r.range.from)} – ${short(r.range.to)}` : 'No loaded day in it'} onClick=${go}>${text}</button>`;
      })}
    </div>` as VNode;
}

function calendar(input: PickerInput, actions: PickerActions): VNode {
  const cells = monthCells(ui.month);
  const selectable = (d: string) => d >= input.lo && d <= input.hi && monthOf(d) === ui.month;
  // The one day reached by Tab: the focused day when it's in this month, else the month's first that can be picked.
  const c: Cal = { input, actions, tabDay: selectable(ui.focus) ? ui.focus : cells.find(selectable) ?? '', span: highlighted(input) };
  const status = ui.mode === 'date'
    ? (input.view === 'week' ? 'Pick a day: its week opens.' : 'Pick a day.')
    : ui.anchor ? `From ${short(ui.anchor)}: now pick the last day.` : `Pick the first day, then the last (up to ${MAX_RANGE_DAYS} days).`;
  return html`
    <div class="tlx-cal" id="tlxCal" role="dialog" aria-modal="true" aria-label="Choose dates" onKeyDown=${(e: KeyboardEvent) => onKeyDown(e, input)}>
      ${calHead(c)}
      <table class="tlx-cal-grid" role="grid" aria-labelledby="tlxCalMonth">
        <thead><tr>${['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map(d => html`<th scope="col">${d}</th>`)}</tr></thead>
        <tbody>${[0, 1, 2, 3, 4, 5].map(w => html`<tr>${cells.slice(w * 7, w * 7 + 7).map(d => dayCell(c, d))}</tr>`)}</tbody>
      </table>
      <p class="tlx-cal-status" id="tlxCalStatus" aria-live="polite">${status}</p>
      ${calQuick(c)}
      <p class="tlx-cal-key"><i class="dot a2" aria-hidden="true"></i> turns that day · ← → ↑ ↓ day or week · Page Up/Down month · Enter picks · Esc closes</p>
    </div>` as VNode;
}
function short(date: string): string {
  return new Date(date + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', e => {
    if (!ui.open || (e.target instanceof Element && e.target.closest('.tlx-picker'))) return;
    const hadFocus = !!document.activeElement?.closest('.tlx-picker');
    closePicker();
    redraw();
    // Focus goes back to the date, as after Esc, unless the click focused something else. Checked once the browser
    // has handled the press, which can move focus.
    if (hadFocus) {
      setTimeout(() => {
        if (!document.activeElement || document.activeElement === document.body) document.getElementById('tlxDateLabel')?.focus();
      }, 0);
    }
  });
}

interface PickerProps {
  input: PickerInput;
  actions: PickerActions;
}

/** The toolbar's date button, and the calendar under it while it's open. A component, so the calendar's own changes
 *  draw it alone. */
class DatePicker extends Component<PickerProps> {
  private readonly root = createRef<HTMLSpanElement>();
  private readonly redraw = () => this.forceUpdate();

  override componentDidMount(): void {
    shown = this.redraw;
    this.drawn();
  }

  override componentDidUpdate(): void {
    shown = this.redraw;
    this.drawn();
  }

  override componentWillUnmount(): void {
    if (shown === this.redraw) shown = null;
  }

  private drawn(): void {
    if (this.root.current) afterDraw(this.root.current);
  }

  override render({ input, actions }: PickerProps): VNode {
    return html`
      <span class="tlx-picker" ref=${this.root}>
        <button type="button" id="tlxDateLabel" class="tlx-date-btn" aria-haspopup="dialog" aria-expanded=${ui.open ? 'true' : 'false'}
          aria-controls=${ui.open ? 'tlxCal' : undefined} title="Choose a day, a week or a range of days"
          onClick=${() => (ui.open ? close() : open(input))}>${input.label} <span class="caret" aria-hidden="true">▾</span></button>
        ${ui.open ? calendar(input, actions) : null}
      </span>` as VNode;
  }
}

/** The toolbar's date button, and the calendar under it while it's open. */
export function datePicker(input: PickerInput, actions: PickerActions): VNode {
  return html`<${DatePicker} input=${input} actions=${actions} />` as VNode;
}
