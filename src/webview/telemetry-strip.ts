/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Parse-worker resources in the loading screen's details drawer (issue #106): a heap sparkline
 * against the heap cap, a throughput sparkline, CPU, RSS, session buffers and skipped files.
 *
 * Kept in its own module (rather than inline in app.ts) so the DOM rendering can be unit-tested
 * under jsdom without importing the whole app shell (Chart.js, pages, message listener wiring).
 */

import type { WorkerTelemetry } from './shared';
import { sparklinePoints } from './loading-model';

const SPARK_W = 240;
const SPARK_H = 34;
/** Heap samples kept for the sparkline, one per HEAP_SAMPLE_MS: about a minute of history. */
const HEAP_HISTORY = 120;
const HEAP_SAMPLE_MS = 500;

let heapHistory: number[] = [];
let heapPeak = 0;
let lastHeapSampleAt = -Infinity;

/** Format a megabyte count as a compact human string (e.g. `512 MB`, `1.5 GB`). */
export function fmtMem(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(mb >= 10240 ? 0 : 1)} GB`;
  return `${Math.round(mb)} MB`;
}

/** Map a 0–100 pressure percentage to a gauge color: blue → amber (≥65) → red (≥85). */
export function pressureColor(pct: number): string {
  if (pct >= 85) return 'var(--accent-red, #f14c4c)';
  if (pct >= 65) return 'var(--accent-amber, #d7a000)';
  return 'var(--accent-blue)';
}

/** Highest heap use seen since the strip was last reset. */
export function heapPeakMB(): number {
  return heapPeak;
}

/** Forget the heap history (a new load started). */
export function resetTelemetryHistory(): void {
  heapHistory = [];
  heapPeak = 0;
  lastHeapSampleAt = -Infinity;
}

function sparkMarkup(id: string, label: string, valueHtml: string): string {
  return (
    `<div class="tg-spark">` +
      `<div class="tg-spark-head"><span class="tg-label">${label}</span><span class="tg-value">${valueHtml}</span></div>` +
      `<svg class="tg-spark-svg" viewBox="0 0 ${SPARK_W} ${SPARK_H}" preserveAspectRatio="none" aria-hidden="true">` +
        `<line class="tg-spark-cap" x1="0" y1="1" x2="${SPARK_W}" y2="1"></line>` +
        `<polyline class="tg-spark-line" id="${id}" points=""></polyline>` +
      `</svg>` +
    `</div>`
  );
}

/** Build the static markup once into `host`. Content is fully static (no user data), so the
 *  innerHTML assignment is safe. */
function buildTelemetryStrip(host: HTMLElement): void {
  // eslint-disable-next-line no-unsanitized/property
  host.innerHTML =
    sparkMarkup('tg-heap-line', 'Heap', `<span id="tg-mem-used">—</span> <span class="tg-sub">of <span id="tg-mem-limit">—</span> cap</span>`) +
    sparkMarkup('tg-rate-line', 'Throughput', `<span id="tg-rate">—</span>`) +
    `<div class="tg-tiles">` +
      `<div class="tg-tile"><span class="tg-tile-label">Worker CPU</span><span class="tg-tile-value" id="tg-cpu-load">—</span></div>` +
      `<div class="tg-tile"><span class="tg-tile-label">Process RSS</span><span class="tg-tile-value" id="tg-rss">—</span></div>` +
      `<div class="tg-tile"><span class="tg-tile-label">Session buffers</span><span class="tg-tile-value" id="tg-buf">—</span></div>` +
      `<div class="tg-tile" id="tg-skipped-tile"><span class="tg-tile-label">Skipped</span><span class="tg-tile-value" id="tg-skipped">0 files</span></div>` +
    `</div>`;
}

function ensureStrip(): HTMLElement | null {
  const host = document.getElementById('loading-telemetry');
  if (!host) return null;
  if (!host.dataset.init) {
    host.dataset.init = '1';
    buildTelemetryStrip(host);
  }
  return host;
}

function setText(id: string, text: string): void {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

/**
 * Record a worker telemetry snapshot and refresh the worker box. The heap history keeps one
 * sample per HEAP_SAMPLE_MS however often this is called, and is kept while the drawer is
 * closed, so opening it shows the recent curve. No DOM work when `#loading-telemetry` is absent.
 */
export function updateTelemetry(t: WorkerTelemetry, nowMs = Date.now()): void {
  if (nowMs - lastHeapSampleAt >= HEAP_SAMPLE_MS) {
    heapHistory.push(t.heapUsedMB);
    if (heapHistory.length > HEAP_HISTORY) heapHistory.shift();
    lastHeapSampleAt = nowMs;
  }
  heapPeak = Math.max(heapPeak, t.heapUsedMB);

  const host = ensureStrip();
  if (!host) return;
  const memPct = t.heapLimitMB > 0 ? (t.heapUsedMB / t.heapLimitMB) * 100 : 0;
  const line = document.getElementById('tg-heap-line');
  if (line) {
    line.setAttribute('points', sparklinePoints(heapHistory, t.heapLimitMB > 0 ? t.heapLimitMB : heapPeak, SPARK_W, SPARK_H));
    line.style.stroke = pressureColor(memPct);
  }
  setText('tg-mem-used', fmtMem(t.heapUsedMB));
  setText('tg-mem-limit', fmtMem(t.heapLimitMB));
  setText('tg-cpu-load', `${Math.round(t.cpuPct)}%`);
  setText('tg-rss', fmtMem(t.rssMB));
  setText('tg-buf', fmtMem(t.fileBufMB));

  // Files that failed to parse, with skipped malformed lines as secondary detail. Highlighted only
  // when something failed; each failed file is listed in the "AI Engineer Coach" output channel.
  const skippedFiles = t.skippedFiles ?? 0;
  const skippedLines = t.skippedLines ?? 0;
  setText('tg-skipped', skippedLines > 0
    ? `${skippedFiles} file${skippedFiles === 1 ? '' : 's'} · ${skippedLines} line${skippedLines === 1 ? '' : 's'}`
    : `${skippedFiles} file${skippedFiles === 1 ? '' : 's'}`);
  document.getElementById('tg-skipped-tile')?.classList.toggle('tg-tile-warn', skippedFiles > 0);

  host.classList.toggle('tg-pressure', memPct >= 85);
}

/** Refresh the throughput sparkline: items finished per second, with the recent rate. */
export function updateThroughput(series: readonly number[], perSecond: number | undefined, unit: string): void {
  if (!ensureStrip()) return;
  let max = 1;
  for (const v of series) if (v > max) max = v;
  document.getElementById('tg-rate-line')?.setAttribute('points', sparklinePoints(series, max, SPARK_W, SPARK_H));
  setText('tg-rate', perSecond === undefined ? '—' : `${perSecond.toFixed(perSecond >= 10 ? 0 : 1)} ${unit}/s`);
}
