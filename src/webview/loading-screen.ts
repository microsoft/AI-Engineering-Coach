/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* The dashboard loading screen: a centred card over the workspace tile field, a details drawer,
 * and a short "ready" summary before the dashboard appears. app.ts feeds every progress message
 * to `recordLoadingProgress` (cheap bookkeeping) and calls `renderLoadingScreen` at most once per
 * animation frame. The rules (forward-only %, time left, activity log, diagnostics) live in
 * ./loading-model so they are unit-tested without a DOM. */

import { LOAD_PHASES, type LoadItem } from '../core/load-phases';
import { activityRowElement, writeClipboard } from './loading-activity-view';
import { formatStatCount } from './loading-grid-model';
import { loadingScreenMarkup, STAT_FIELDS } from './loading-markup';
import { fmtMem, heapPeakMB, resetTelemetryHistory, updateTelemetry, updateThroughput } from './telemetry-strip';
import {
  STEP_LABELS,
  buildDiagnostics,
  createActivityLog,
  createEtaEstimator,
  createForwardProgress,
  createPhaseTimer,
  createRateSeries,
  formatDuration,
  formatElapsed,
  formatTimeLeft,
  heapHealth,
  plural,
  stepFractions,
  type ActivityFilter,
  type ActivityLog,
} from './loading-model';
import { render, unmount } from './render';
import type { WorkerTelemetry } from './shared';

/** A load that finishes faster than this skips the ready summary (a cache hit). */
export const FAST_LOAD_MS = 400;
/** How long the ready summary stays before the dashboard replaces it. */
export const READY_HOLD_MS = 600;
const LEAVE_MS = 180;
const ACTIVITY_LIMIT = 200;

export interface LoadingProgress {
  phase: number;
  detail?: string;
  pct: number;
  sessions?: number;
  linesOfCode?: number;
  toolCalls?: number;
  filesEdited?: number;
  requests?: number;
  item?: LoadItem;
  telemetry?: WorkerTelemetry;
}

/** Where the drawer's open/closed choice is remembered (webview state in the app). */
export interface DetailsStore {
  get(): boolean;
  set(open: boolean): void;
}

type Totals = Pick<LoadingProgress, 'sessions' | 'linesOfCode' | 'toolCalls' | 'filesEdited' | 'requests'>;

interface ScreenState {
  startedAt: number;
  store: DetailsStore;
  forward: ReturnType<typeof createForwardProgress>;
  eta: ReturnType<typeof createEtaEstimator>;
  phases: ReturnType<typeof createPhaseTimer>;
  rate: ReturnType<typeof createRateSeries>;
  log: ActivityLog;
  logVersion: number;
  renderedVersion: string;
  filter: ActivityFilter;
  phase: number;
  pct: number;
  detail: string;
  item: LoadItem | undefined;
  totals: Totals;
  telemetry: WorkerTelemetry | undefined;
  etaSeconds: number | undefined;
  etaAt: number;
  rateUnit: string;
  ready: boolean;
  readyAt: number;
  timer: number;
}

let state: ScreenState | undefined;

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function byId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function setText(id: string, text: string): void {
  const el = byId(id);
  if (el && el.textContent !== text) el.textContent = text;
}

export function isLoadingScreenMounted(): boolean {
  return state !== undefined && byId('loading-card') !== null;
}

/** Render the loading screen into `content` and reset its state. */
export function mountLoadingScreen(content: HTMLElement, store: DetailsStore, now = Date.now()): void {
  if (state) window.clearInterval(state.timer);
  resetTelemetryHistory();
  const open = store.get();
  // Fresh elements each mount, so control listeners are never attached twice.
  unmount(content);
  content.textContent = '';
  render(loadingScreenMarkup(open), content);

  state = {
    startedAt: now,
    store,
    forward: createForwardProgress(),
    eta: createEtaEstimator(),
    phases: createPhaseTimer(),
    rate: createRateSeries(),
    log: createActivityLog(ACTIVITY_LIMIT),
    logVersion: 0,
    renderedVersion: '',
    filter: 'all',
    phase: 0,
    pct: 0,
    detail: '',
    item: undefined,
    totals: {},
    telemetry: undefined,
    etaSeconds: undefined,
    etaAt: now,
    rateUnit: 'workspaces',
    ready: false,
    readyAt: 0,
    timer: window.setInterval(() => tickClock(), 1000),
  };
  state.phases.enter(0, now);
  wireControls();
}

function wireControls(): void {
  byId('loading-details-toggle')?.addEventListener('click', () => {
    if (!state) return;
    const open = byId('loading-details')?.hidden !== false;
    state.store.set(open);
    applyDetailsOpen(open);
  });
  for (const button of document.querySelectorAll<HTMLButtonElement>('#loading-card .load-filter')) {
    button.addEventListener('click', () => {
      if (!state) return;
      state.filter = (button.dataset.filter as ActivityFilter | undefined) ?? 'all';
      for (const b of document.querySelectorAll<HTMLButtonElement>('#loading-card .load-filter')) {
        b.setAttribute('aria-pressed', b === button ? 'true' : 'false');
      }
      renderActivity(true);
    });
  }
  byId('loading-copy')?.addEventListener('click', () => { void copyDiagnostics(); });
}

function applyDetailsOpen(open: boolean): void {
  const drawer = byId('loading-details');
  const toggle = byId('loading-details-toggle');
  if (drawer) drawer.hidden = !open;
  byId('loading-card')?.classList.toggle('details-open', open);
  if (toggle) {
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggle.textContent = open ? 'Hide details' : 'Show details';
  }
  if (open) renderLoadingScreen();
}

/** Bookkeeping for one progress message. Call for every message, before frame batching, so no
 *  finished item is lost from the activity table or the throughput rate. */
export function recordLoadingProgress(msg: LoadingProgress, now = Date.now()): void {
  const s = state;
  if (!s || s.ready) return;
  const shown = s.forward.update(msg.phase, msg.pct);
  s.phase = shown.phase;
  s.pct = shown.pct;
  s.detail = msg.detail ?? '';
  if (shown.phase >= 0) s.phases.enter(shown.phase, now);
  for (const f of STAT_FIELDS) {
    const v = msg[f.key];
    // A reported 0 is a real count; omitted counters stay unknown (shown as a dash).
    if (typeof v === 'number' && v >= 0) s.totals[f.key] = v;
  }
  if (msg.telemetry) s.telemetry = msg.telemetry;
  if (msg.item) {
    s.item = msg.item;
    if (s.log.add(msg.item, now - s.startedAt)) {
      s.rate.add(now);
      s.rateUnit = msg.item.kind === 'cli-session' ? 'sessions' : 'workspaces';
      s.logVersion++;
    }
  }
  const eta = s.phase >= 0 ? s.eta.update(s.phase, s.pct, now) : undefined;
  s.etaSeconds = eta;
  s.etaAt = now;
}

function tickClock(now = Date.now()): void {
  const s = state;
  if (!s || !byId('loading-time')) return;
  if (s.ready || s.phase < 0) {
    setText('loading-time', '');
    return;
  }
  const elapsed = now - s.startedAt;
  let text = elapsed >= 1000 ? `${formatElapsed(elapsed)} elapsed` : '';
  if (s.etaSeconds !== undefined) {
    const left = s.etaSeconds - (now - s.etaAt) / 1000;
    if (left > 0.5) text += ` · ${formatTimeLeft(left)}`;
  }
  setText('loading-time', text);
}

function nowLine(s: ScreenState): { text: string; folder?: string } {
  if (s.ready) return { text: 'Opening your dashboard\u2026' };
  if (s.phase === 2 && s.item) {
    const noun = s.item.kind === 'cli-session' ? 'Session' : 'Workspace';
    return {
      text: `${noun} ${s.item.index.toLocaleString('en-US')} of ${s.item.total.toLocaleString('en-US')} \u00b7 `,
      folder: s.item.folder,
    };
  }
  return { text: s.detail || 'Working through your session history.' };
}

function title(s: ScreenState): string {
  if (s.phase < 0) return 'Could not load your sessions';
  if (s.ready) {
    const secs = ((s.readyAt - s.startedAt) / 1000).toFixed(1);
    return s.totals.sessions ? `${plural(s.totals.sessions, 'session')} indexed in ${secs}s` : `Activity index ready in ${secs}s`;
  }
  if (s.phase === 2 && s.item?.kind === 'cli-session') return 'Re-reading Copilot CLI and App sessions';
  return LOAD_PHASES[s.phase] ?? `Phase ${s.phase}`;
}

function renderHealth(s: ScreenState): void {
  const chip = byId('loading-health');
  if (!chip) return;
  const t = s.telemetry;
  if (!t) { chip.hidden = true; return; }
  const health = heapHealth(t.heapUsedMB, t.heapLimitMB);
  const skipped = t.skippedFiles ?? 0;
  chip.hidden = false;
  chip.dataset.level = health.level;
  setText('loading-health-text', `${health.label} \u00b7 ${fmtMem(t.heapUsedMB)} of ${fmtMem(t.heapLimitMB)} heap \u00b7 ${plural(skipped, 'file')} skipped`);
}

function renderStepper(s: ScreenState): void {
  const fractions = s.ready ? STEP_LABELS.map(() => 1) : stepFractions(Math.max(0, s.phase), s.pct);
  for (let i = 0; i < STEP_LABELS.length; i++) {
    const seg = byId(`loading-step-${i}`);
    const fill = byId(`loading-step-fill-${i}`);
    if (!seg || !fill) continue;
    const done = s.ready || i < s.phase;
    const active = !done && i === s.phase;
    seg.dataset.state = done ? 'done' : active ? 'active' : 'pending';
    fill.style.width = `${Math.round(fractions[i] * 100)}%`;
    setText(`loading-step-status-${i}`, `${LOAD_PHASES[i]}: ${done ? 'done' : active ? `in progress, ${Math.round(fractions[i] * 100)}%` : 'not started'}`);
  }
}

function renderPhaseList(s: ScreenState, now: number): void {
  const durations = s.phases.durations(s.ready ? s.readyAt : now);
  for (let i = 0; i < LOAD_PHASES.length; i++) {
    const row = byId(`loading-phase-row-${i}`);
    if (!row) continue;
    const done = s.ready || i < s.phase;
    const active = !done && i === s.phase;
    row.dataset.state = done ? 'done' : active ? 'active' : 'pending';
    const icon = row.querySelector('i');
    if (icon) icon.textContent = done ? '\u2713' : active ? '\u25CF' : '\u25CB';
    const ms = durations[i];
    setText(`loading-phase-ms-${i}`, ms === undefined || (done && ms === 0 && i === LOAD_PHASES.length - 1) ? '\u2014' : formatDuration(ms));
  }
}

function renderActivity(force = false): void {
  const s = state;
  const body = byId('loading-activity');
  if (!s || !body || byId('loading-details')?.hidden) return;
  const counts = s.log.counts();
  setText('loading-filter-count-all', counts.done > 0 ? ` ${counts.done.toLocaleString('en-US')}` : '');
  setText('loading-filter-count-slow', counts.slow > 0 ? ` ${counts.slow.toLocaleString('en-US')}` : '');
  setText('loading-filter-count-skipped', counts.skipped > 0 ? ` ${counts.skipped.toLocaleString('en-US')}` : '');
  // Redraw only when a row finished, the item being read changed, or the filter switched, which
  // keeps a 200-row table cheap at one call per frame.
  const reading = s.filter === 'all' ? s.log.reading()?.key ?? '' : '';
  const version = `${s.logVersion}|${reading}|${s.filter}`;
  if (!force && version === s.renderedVersion) return;
  s.renderedVersion = version;
  const rows = s.log.rows(s.filter);
  body.replaceChildren(...rows.map(activityRowElement));
  const empty = byId('loading-activity-empty');
  if (empty) {
    empty.hidden = rows.length > 0;
    empty.textContent = s.filter === 'all' ? 'Folders appear here as they are read.' : `No ${s.filter} folders.`;
  }
}

function renderHeader(s: ScreenState): void {
  const root = byId('load-index');
  if (root) root.dataset.state = s.ready ? 'ready' : s.phase < 0 ? 'error' : 'loading';
  setText('loading-kicker-text', s.ready ? 'Activity index ready' : s.phase < 0 ? 'Loading stopped' : 'Building your activity index');
  setText('loading-phase-title', title(s));
  setText('loading-found-label', s.ready ? 'Found' : 'Found so far');
  const pct = String(s.ready ? 100 : s.pct);
  setText('loading-pct-value', pct);
  byId('loading-pct')?.setAttribute('aria-valuenow', pct);
}

function renderNowLine(s: ScreenState): void {
  const detailEl = byId('loading-phase-detail');
  const line = nowLine(s);
  const full = line.folder ? `${line.text}${line.folder}` : line.text;
  if (detailEl && detailEl.title !== full) {
    detailEl.replaceChildren(document.createTextNode(line.text));
    if (line.folder) {
      const b = document.createElement('b');
      b.textContent = line.folder;
      detailEl.appendChild(b);
    }
    detailEl.title = full;
  }
  const note = byId('loading-note');
  if (note) note.hidden = s.ready || !(s.phase === 2 && s.item?.kind === 'cli-session');
}

/** Refresh the screen from the recorded state. Cheap enough to call once per frame. */
export function renderLoadingScreen(now = Date.now()): void {
  const s = state;
  if (!s || !byId('loading-card')) return;
  renderHeader(s);
  renderNowLine(s);
  for (const f of STAT_FIELDS) {
    const v = s.totals[f.key];
    setText(f.id, v === undefined ? '\u2014' : formatStatCount(v));
  }
  renderStepper(s);
  renderHealth(s);
  tickClock(now);
  if (s.telemetry) updateTelemetry(s.telemetry, now);
  if (byId('loading-details')?.hidden !== false) return;
  renderPhaseList(s, now);
  const series = s.rate.series(now);
  updateThroughput(series, series.length > 0 ? s.rate.recent(now) : undefined, s.rateUnit);
  renderActivity();
}

/** Show the ready summary. Returns how long to keep it before the dashboard takes over: 0 when
 *  the load was fast enough (a cache hit) to go straight to the dashboard. */
export function showLoadingReady(now = Date.now()): number {
  const s = state;
  if (!s) return 0;
  window.clearInterval(s.timer);
  if (!byId('loading-card') || now - s.startedAt < FAST_LOAD_MS || s.phase < 0) return 0;
  s.ready = true;
  s.readyAt = now;
  s.phases.enter(LOAD_PHASES.length - 1, now);
  renderLoadingScreen(now);
  return READY_HOLD_MS;
}

/** Fade the loading screen out (instant with reduced motion). */
export function leaveLoadingScreen(): Promise<void> {
  const root = byId('load-index');
  if (!root || prefersReducedMotion()) return Promise.resolve();
  root.classList.add('is-leaving');
  return new Promise(resolve => window.setTimeout(resolve, LEAVE_MS));
}

/** Stop the screen's clock and forget its state (the dashboard replaced it). */
export function disposeLoadingScreen(): void {
  if (state) window.clearInterval(state.timer);
  state = undefined;
}

/** The text "Copy diagnostics" puts on the clipboard. */
export function loadingDiagnostics(now = Date.now()): string {
  const s = state;
  if (!s) return '';
  const t = s.telemetry;
  return buildDiagnostics({
    elapsedMs: (s.ready ? s.readyAt : now) - s.startedAt,
    phase: s.phase,
    pct: s.ready ? 100 : s.pct,
    ready: s.ready,
    phaseDurations: s.phases.durations(s.ready ? s.readyAt : now),
    ...s.totals,
    item: s.item,
    telemetry: t ? {
      heapUsedMB: t.heapUsedMB,
      heapLimitMB: t.heapLimitMB,
      heapPeakMB: Math.max(heapPeakMB(), t.heapUsedMB),
      rssMB: t.rssMB,
      fileBufMB: t.fileBufMB,
      cpuPct: t.cpuPct,
      skippedFiles: t.skippedFiles ?? 0,
      skippedLines: t.skippedLines ?? 0,
    } : undefined,
    itemsPerSecond: s.log.counts().done > 0 ? s.rate.recent(now) : undefined,
    counts: s.log.counts(),
    flagged: s.log.flagged(),
  });
}

async function copyDiagnostics(): Promise<void> {
  const ok = await writeClipboard(loadingDiagnostics());
  const button = byId('loading-copy');
  const message = ok ? 'Diagnostics copied' : 'Could not copy diagnostics';
  setText('loading-copy-status', message);
  if (button) {
    button.textContent = ok ? 'Copied' : 'Copy failed';
    window.setTimeout(() => { if (button.isConnected) button.textContent = 'Copy diagnostics'; }, 1500);
  }
}
