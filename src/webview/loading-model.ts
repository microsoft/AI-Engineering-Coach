/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Pure state and formatting for the loading screen: forward-only progress, the phase stepper,
 * the time-left estimate, the details drawer's activity log, phase timings and the copied
 * diagnostics. No DOM access, so every rule here is unit-tested. */

import { LOAD_PHASES, phaseFraction, type LoadItem } from '../core/load-phases';

/** Short stepper labels, one per entry of LOAD_PHASES. */
export const STEP_LABELS = ['Discover', 'Cache', 'Parse logs', 'Other tools', 'Analyze', 'Ready'] as const;

const LAST_PHASE = LOAD_PHASES.length - 1;

export interface ShownProgress {
  phase: number;
  pct: number;
}

/** Progress as shown on screen: the phase and percentage never move backwards, even when
 *  messages arrive late or a step reports a lower percentage than the one before. A negative
 *  phase (a load error) is passed through so the screen can show it. */
export function createForwardProgress(): { update(phase: number, pct: number): ShownProgress } {
  let phase = 0;
  let pct = 0;
  return {
    update(nextPhase: number, nextPct: number): ShownProgress {
      if (nextPhase < 0) return { phase: nextPhase, pct };
      phase = Math.max(phase, Math.min(LAST_PHASE, Math.floor(nextPhase)));
      const clamped = Number.isFinite(nextPct) ? Math.max(0, Math.min(100, Math.round(nextPct))) : 0;
      pct = Math.max(pct, clamped);
      return { phase, pct };
    },
  };
}

/** Fill (0–1) of each stepper segment: earlier phases full, the active one by its in-phase
 *  progress, later ones empty. */
export function stepFractions(phase: number, pct: number): number[] {
  return STEP_LABELS.map((_, i) => {
    if (i < phase) return 1;
    if (i > phase) return 0;
    return i === LAST_PHASE && pct >= 100 ? 1 : phaseFraction(i, pct);
  });
}

export interface EtaOptions {
  /** Rate window: the estimate uses the progress made over about this long. */
  windowMs: number;
  /** No estimate until this much progress data exists. */
  minDataMs: number;
}

/**
 * Typical share of a load's wall-clock time spent in each phase, from recorded real loads (cold
 * and cached, about 600 sessions): parsing dominates, and the steps after it take about a tenth
 * of the time while the percentage gives them a quarter. The time-left estimate runs on this
 * scale so it doesn't overestimate the short steps at the end.
 */
const PHASE_TIME_WEIGHTS = [1, 2, 86, 4, 7, 0];

/** Progress (0–100) on the time-weighted scale used by the time-left estimate. */
export function timeProgress(phase: number, pct: number): number {
  if (pct >= 100 || phase >= LAST_PHASE) return 100;
  let done = 0;
  for (let i = 0; i < phase && i < PHASE_TIME_WEIGHTS.length; i++) done += PHASE_TIME_WEIGHTS[i];
  return Math.min(100, done + (PHASE_TIME_WEIGHTS[phase] ?? 0) * phaseFraction(phase, pct));
}

/**
 * Time-left estimate from the rate progress moved over a sliding window, smoothed so it does not
 * jump on every message. Returns seconds, or `undefined` while there isn't enough data, while
 * progress is stalled, or once the load is complete. The value is an estimate: show it as
 * "about".
 */
export function createEtaEstimator(options: EtaOptions = { windowMs: 15_000, minDataMs: 3_000 }): { update(phase: number, pct: number, nowMs: number): number | undefined } {
  const samples: Array<{ t: number; p: number }> = [];
  let firstAt: number | undefined;
  let smoothed: number | undefined;
  return {
    update(phase: number, pct: number, nowMs: number): number | undefined {
      const p = timeProgress(phase, pct);
      if (firstAt === undefined) firstAt = nowMs;
      const last = samples[samples.length - 1];
      if (!last || nowMs - last.t >= 250) samples.push({ t: nowMs, p });
      else last.p = p;
      while (samples.length > 2 && samples[1].t <= nowMs - options.windowMs) samples.shift();
      if (p >= 100 || nowMs - firstAt < options.minDataMs) return undefined;
      const anchor = samples[0];
      const progressed = p - anchor.p;
      const span = nowMs - anchor.t;
      if (progressed <= 0 || span <= 0) return undefined;
      const raw = ((100 - p) / progressed) * span / 1000;
      smoothed = smoothed === undefined ? raw : smoothed * 0.7 + raw * 0.3;
      return smoothed;
    },
  };
}

/** "about 8s left", "about 25s left", "about 3 min left". */
export function formatTimeLeft(seconds: number): string {
  if (seconds < 10) return `about ${Math.max(1, Math.round(seconds))}s left`;
  if (seconds < 60) return `about ${Math.max(10, Math.round(seconds / 5) * 5)}s left`;
  return `about ${Math.round(seconds / 60)} min left`;
}

/** "12s" or "1m 05s". */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, '0')}s`;
}

/** "340 ms", "2.4s". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

export type HealthLevel = 'ok' | 'warn' | 'crit';

/** Heap pressure level at the existing gauge thresholds (65% amber, 85% red). */
export function heapHealth(heapUsedMB: number, heapLimitMB: number): { level: HealthLevel; label: string; pct: number } {
  const pct = heapLimitMB > 0 ? (heapUsedMB / heapLimitMB) * 100 : 0;
  if (pct >= 85) return { level: 'crit', label: 'Memory critical', pct };
  if (pct >= 65) return { level: 'warn', label: 'Memory high', pct };
  return { level: 'ok', label: 'Healthy', pct };
}

export type ActivityFilter = 'all' | 'slow' | 'skipped';

export interface ActivityRow {
  key: string;
  /** Time since the load started when the row was recorded. */
  atMs: number;
  item: LoadItem;
}

export interface ActivityLog {
  /** Record an item; returns true when it finished an item not seen before. */
  add(item: LoadItem, atMs: number): boolean;
  /** Newest first. `all` leads with the item being read, if any. */
  rows(filter: ActivityFilter): ActivityRow[];
  /** The item being read, if it has not finished yet. */
  reading(): ActivityRow | undefined;
  counts(): { done: number; slow: number; skipped: number };
  /** Slow and skipped rows kept, newest first. */
  flagged(): ActivityRow[];
}

/**
 * The details drawer's activity table. Bounded: keeps the newest `limit` finished rows, and
 * separately the newest `limit` slow or skipped rows, so a long load can't grow the DOM or
 * hide the rows worth looking at. Each item is counted once, however often it is resent.
 */
export function createActivityLog(limit = 200): ActivityLog {
  const all: ActivityRow[] = [];
  const flaggedRows: ActivityRow[] = [];
  const finished = new Set<string>();
  let current: ActivityRow | undefined;
  let slow = 0;
  let skipped = 0;
  const push = (list: ActivityRow[], row: ActivityRow): void => {
    list.push(row);
    if (list.length > limit) list.shift();
  };
  return {
    add(item: LoadItem, atMs: number): boolean {
      const key = `${item.kind}:${item.index}/${item.total}`;
      if (item.status === 'reading') {
        if (!finished.has(key)) current = { key, atMs, item };
        return false;
      }
      if (finished.has(key)) return false;
      finished.add(key);
      const row = { key, atMs, item };
      push(all, row);
      if (item.status === 'slow') slow++;
      if (item.status === 'skipped') skipped++;
      if (item.status === 'slow' || item.status === 'skipped') push(flaggedRows, row);
      if (current?.key === key) current = undefined;
      return true;
    },
    rows(filter: ActivityFilter): ActivityRow[] {
      if (filter === 'all') {
        const rows = all.slice().reverse();
        return current ? [current, ...rows] : rows;
      }
      return flaggedRows.filter(row => row.item.status === filter).reverse();
    },
    reading: () => current,
    counts: () => ({ done: finished.size, slow, skipped }),
    flagged: () => flaggedRows.slice().reverse(),
  };
}

/** When each phase was first shown, so the drawer can list how long each one took. */
export function createPhaseTimer(): { enter(phase: number, nowMs: number): void; durations(nowMs: number): Array<number | undefined> } {
  const starts: Array<number | undefined> = STEP_LABELS.map(() => undefined);
  return {
    enter(phase: number, nowMs: number): void {
      if (phase >= 0 && phase < starts.length && starts[phase] === undefined) starts[phase] = nowMs;
    },
    durations(nowMs: number): Array<number | undefined> {
      return starts.map((start, i) => {
        if (start === undefined) return undefined;
        const next = starts.slice(i + 1).find((s): s is number => s !== undefined);
        return (next ?? nowMs) - start;
      });
    },
  };
}

/** Per-second event counts in fixed buckets, for the throughput sparkline. */
export function createRateSeries(bucketMs = 1000, maxBuckets = 60): { add(nowMs: number): void; series(nowMs: number): number[]; recent(nowMs: number, spanMs?: number): number } {
  const counts: number[] = [];
  const events: number[] = [];
  let start: number | undefined;
  const reach = (nowMs: number): number => {
    const base = start ?? nowMs;
    let index = Math.floor((nowMs - base) / bucketMs);
    // Drop whole buckets that fall out of the window in one step, so a long gap (a hidden
    // webview) costs at most maxBuckets of work instead of one shift per elapsed bucket.
    const overflow = index + 1 - maxBuckets;
    if (overflow > 0) {
      if (overflow >= counts.length) counts.length = 0;
      else counts.splice(0, overflow);
      start = base + overflow * bucketMs;
      index -= overflow;
    }
    while (counts.length <= index) counts.push(0);
    return index;
  };
  return {
    add(nowMs: number): void {
      if (start === undefined) start = nowMs;
      counts[reach(nowMs)]++;
      events.push(nowMs);
      const cutoff = nowMs - 10_000;
      let drop = 0;
      while (drop < events.length && events[drop] < cutoff) drop++;
      drop = Math.max(drop, events.length - 5000);
      if (drop > 0) events.splice(0, drop);
    },
    series(nowMs: number): number[] {
      if (start === undefined) return [];
      reach(nowMs);
      return counts.map(count => count * (1000 / bucketMs));
    },
    recent(nowMs: number, spanMs = 3000): number {
      const from = nowMs - spanMs;
      let total = 0;
      for (const t of events) if (t > from) total++;
      return total / (spanMs / 1000);
    },
  };
}

/** SVG polyline points for a sparkline of `values` scaled to `max`. */
export function sparklinePoints(values: readonly number[], max: number, width: number, height: number): string {
  if (values.length === 0) return '';
  const top = max > 0 ? max : 1;
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  return values.map((v, i) => {
    const x = values.length > 1 ? i * step : width;
    const y = height - 1 - (Math.max(0, Math.min(top, v)) / top) * (height - 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
}

export interface DiagnosticsInput {
  elapsedMs: number;
  phase: number;
  pct: number;
  ready: boolean;
  phaseDurations: Array<number | undefined>;
  sessions?: number;
  requests?: number;
  toolCalls?: number;
  linesOfCode?: number;
  filesEdited?: number;
  item?: LoadItem;
  telemetry?: { heapUsedMB: number; heapLimitMB: number; heapPeakMB: number; rssMB: number; fileBufMB: number; cpuPct: number; skippedFiles: number; skippedLines: number };
  itemsPerSecond?: number;
  counts: { done: number; slow: number; skipped: number };
  flagged: ActivityRow[];
}

function mem(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

/** A count, or a dash when it was never reported (unknown is not 0). */
const n = (v: number | undefined): string => (v === undefined ? '—' : v.toLocaleString('en-US'));

/** Plain-text diagnostics for "Copy diagnostics": aggregates and display paths only, never
 *  session content. */
export function buildDiagnostics(d: DiagnosticsInput): string {
  const lines: string[] = ['AI Engineer Coach loading diagnostics'];
  const step = d.phase >= 0 ? LOAD_PHASES[d.phase] ?? `Phase ${d.phase}` : 'Stopped';
  lines.push(`Elapsed: ${formatDuration(d.elapsedMs)} · Progress: ${d.pct}% · Step: ${d.ready ? 'Ready' : step}`);
  if (d.item) lines.push(`${d.item.kind === 'cli-session' ? 'Session' : 'Workspace'} ${n(d.item.index)} of ${n(d.item.total)}`);
  const phases = STEP_LABELS.map((label, i) => {
    const ms = d.phaseDurations[i];
    if (ms === undefined) return `${label} —`;
    return `${label} ${formatDuration(ms)}${i === d.phase && !d.ready ? ' (running)' : ''}`;
  });
  lines.push(`Phases: ${phases.join(' · ')}`);
  lines.push(`Found: ${n(d.sessions)} sessions · ${n(d.requests)} prompts · ${n(d.toolCalls)} tool calls · ${n(d.linesOfCode)} lines written · ${n(d.filesEdited)} files touched`);
  if (d.telemetry) {
    const t = d.telemetry;
    const rate = d.itemsPerSecond !== undefined ? ` · ${d.itemsPerSecond.toFixed(1)} items/s` : '';
    lines.push(`Worker: heap ${mem(t.heapUsedMB)} of ${mem(t.heapLimitMB)} (peak ${mem(t.heapPeakMB)}) · RSS ${mem(t.rssMB)} · buffers ${mem(t.fileBufMB)} · CPU ${t.cpuPct}%${rate}`);
    lines.push(`Skipped: ${plural(t.skippedFiles, 'file')} · ${plural(t.skippedLines, 'line')}`);
  }
  lines.push(`Items finished: ${n(d.counts.done)} · slow: ${n(d.counts.slow)} · skipped: ${n(d.counts.skipped)}`);
  if (d.flagged.length > 0) {
    lines.push('Slow and skipped items:');
    for (const row of d.flagged) {
      const ms = row.item.ms !== undefined ? formatDuration(row.item.ms) : '—';
      lines.push(`  ${row.item.status.padEnd(7)} ${ms.padStart(7)}  ${plural(row.item.sessions ?? 0, 'session').padEnd(12)} ${row.item.path}`);
    }
  }
  return lines.join('\n');
}
