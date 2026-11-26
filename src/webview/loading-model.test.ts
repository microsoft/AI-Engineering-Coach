/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import type { LoadItem } from '../core/load-phases';
import {
  buildDiagnostics,
  createActivityLog,
  createEtaEstimator,
  createForwardProgress,
  createPhaseTimer,
  createRateSeries,
  formatElapsed,
  formatTimeLeft,
  heapHealth,
  sparklinePoints,
  stepFractions,
  timeProgress,
} from './loading-model';

function item(index: number, status: LoadItem['status'], extra: Partial<LoadItem> = {}): LoadItem {
  return { kind: 'workspace', index, total: 10, folder: `repo-${index}`, path: `~/src/repo-${index}`, status, ...extra };
}

describe('createForwardProgress', () => {
  it('never moves the percentage or phase backwards (the warm-load 82% → 10% jump)', () => {
    const forward = createForwardProgress();
    expect(forward.update(1, 6)).toEqual({ phase: 1, pct: 6 });
    expect(forward.update(3, 82)).toEqual({ phase: 3, pct: 82 });
    expect(forward.update(1, 10)).toEqual({ phase: 3, pct: 82 });
    expect(forward.update(4, 91)).toEqual({ phase: 4, pct: 91 });
  });

  it('clamps out-of-range input and passes an error phase through', () => {
    const forward = createForwardProgress();
    expect(forward.update(9, 140)).toEqual({ phase: 5, pct: 100 });
    expect(forward.update(-1, 0)).toEqual({ phase: -1, pct: 100 });
    expect(createForwardProgress().update(2, Number.NaN)).toEqual({ phase: 2, pct: 0 });
  });
});

describe('stepFractions', () => {
  it('fills earlier steps, the active step by in-phase progress, and leaves later ones empty', () => {
    // Phase 2 spans 10–75%: 42.5% is half way.
    expect(stepFractions(2, 42.5)).toEqual([1, 1, 0.5, 0, 0, 0]);
    expect(stepFractions(5, 100)).toEqual([1, 1, 1, 1, 1, 1]);
  });
});

describe('timeProgress', () => {
  it('gives parsing most of the scale and the steps after it little', () => {
    expect(timeProgress(0, 0)).toBe(0);
    expect(timeProgress(2, 10)).toBe(3);
    expect(timeProgress(2, 75)).toBe(89);
    expect(timeProgress(4, 90)).toBeCloseTo(96.5, 5);
    expect(timeProgress(5, 100)).toBe(100);
  });
});

describe('createEtaEstimator', () => {
  it('stays hidden until 3 s of data, then estimates from the recent rate', () => {
    const eta = createEtaEstimator();
    expect(eta.update(2, 10, 0)).toBeUndefined();
    expect(eta.update(2, 30, 2000)).toBeUndefined();
    // 39% of parsing in 3 s: 33.54 of the 97 remaining time-weighted points → ≈ 5.7 s.
    expect(eta.update(2, 40, 3000)).toBeCloseTo((100 - (3 + 86 * 30 / 65)) / (86 * 30 / 65) * 3, 1);
  });

  // A cached load measured on real logs: parsing (10→75%) took ~15.8 s, and the steps after it
  // (75→100%) ~1.9 s. On the raw percentage the estimate at 58% was 82% too high.
  it('is within 15% of the real time left at 58% for a load shaped like a real cached load', () => {
    const eta = createEtaEstimator();
    const parseMs = 15_800;
    let estimate: number | undefined;
    let at58 = 0;
    for (let t = 0; t <= parseMs; t += 200) {
      const pct = Math.round(10 + 65 * (t / parseMs));
      estimate = eta.update(2, pct, t);
      if (pct >= 58) { at58 = t; break; }
    }
    const actualLeft = (parseMs - at58 + 1900) / 1000;
    expect(estimate).toBeGreaterThan(actualLeft * 0.85);
    expect(estimate).toBeLessThan(actualLeft * 1.15);
  });

  it('hides the estimate while progress stalls and once the load is complete', () => {
    const eta = createEtaEstimator({ windowMs: 2000, minDataMs: 0 });
    eta.update(2, 20, 0);
    expect(eta.update(2, 20, 3000)).toBeUndefined();
    expect(eta.update(5, 100, 4000)).toBeUndefined();
  });
});

describe('time formatting', () => {
  it('labels the estimate as approximate and rounds by magnitude', () => {
    expect(formatTimeLeft(0.2)).toBe('about 1s left');
    expect(formatTimeLeft(8.4)).toBe('about 8s left');
    expect(formatTimeLeft(23)).toBe('about 25s left');
    expect(formatTimeLeft(150)).toBe('about 3 min left');
  });

  it('formats elapsed seconds and minutes', () => {
    expect(formatElapsed(12_900)).toBe('12s');
    expect(formatElapsed(65_000)).toBe('1m 05s');
  });
});

describe('heapHealth', () => {
  it('uses the existing 65% and 85% thresholds', () => {
    expect(heapHealth(640, 1000).level).toBe('ok');
    expect(heapHealth(650, 1000)).toMatchObject({ level: 'warn', label: 'Memory high' });
    expect(heapHealth(850, 1000)).toMatchObject({ level: 'crit', label: 'Memory critical' });
    expect(heapHealth(10, 0).level).toBe('ok');
  });
});

describe('createActivityLog', () => {
  it('counts each item once and leads with the item being read', () => {
    const log = createActivityLog();
    expect(log.add(item(1, 'parsed'), 100)).toBe(true);
    expect(log.add(item(1, 'parsed'), 600)).toBe(false);
    log.add(item(2, 'reading'), 700);
    expect(log.rows('all').map(r => `${r.item.index}:${r.item.status}`)).toEqual(['2:reading', '1:parsed']);
    log.add(item(2, 'slow', { ms: 2400 }), 900);
    expect(log.reading()).toBeUndefined();
    expect(log.rows('all').map(r => `${r.item.index}:${r.item.status}`)).toEqual(['2:slow', '1:parsed']);
    expect(log.counts()).toEqual({ done: 2, slow: 1, skipped: 0 });
  });

  it('filters slow and skipped rows and keeps them past the row limit', () => {
    const log = createActivityLog(3);
    log.add(item(1, 'skipped'), 0);
    for (let i = 2; i <= 9; i++) log.add(item(i, 'parsed'), i);
    log.add(item(10, 'slow'), 10);
    expect(log.rows('all')).toHaveLength(3);
    expect(log.rows('skipped').map(r => r.item.index)).toEqual([1]);
    expect(log.rows('slow').map(r => r.item.index)).toEqual([10]);
    expect(log.counts()).toEqual({ done: 10, slow: 1, skipped: 1 });
  });
});

describe('createPhaseTimer', () => {
  it('measures each phase until the next one starts', () => {
    const timer = createPhaseTimer();
    timer.enter(0, 0);
    timer.enter(1, 100);
    timer.enter(1, 300);
    timer.enter(2, 400);
    expect(timer.durations(1400)).toEqual([100, 300, 1000, undefined, undefined, undefined]);
  });
});

describe('createRateSeries', () => {
  it('catches up after a long gap in bounded time', () => {
    const rate = createRateSeries(1000, 60);
    rate.add(0);
    const started = performance.now();
    rate.add(100_000_000); // ~28 hours later, e.g. a webview that was hidden (was ~1 s of work)
    const series = rate.series(100_000_500);
    expect(performance.now() - started).toBeLessThan(50);
    expect(series).toHaveLength(60);
    expect(series.reduce((a, b) => a + b, 0)).toBe(1);
    expect(rate.recent(100_000_500)).toBeCloseTo(1 / 3, 5);
  });

  it('buckets events per second and reports the recent rate', () => {
    const rate = createRateSeries(1000, 5);
    for (const t of [0, 100, 200, 1100, 2500, 2600, 2700, 2800]) rate.add(t);
    expect(rate.series(2900)).toEqual([3, 1, 4]);
    expect(rate.recent(3000, 2000)).toBe(2.5);
    expect(rate.series(9000)).toHaveLength(5);
  });
});

describe('sparklinePoints', () => {
  it('scales values to the box and clamps above the cap', () => {
    expect(sparklinePoints([0, 50, 200], 100, 100, 12)).toBe('0.0,11.0 50.0,6.0 100.0,1.0');
    expect(sparklinePoints([], 100, 100, 12)).toBe('');
  });
});

describe('buildDiagnostics', () => {
  it('lists aggregates and display paths, never more', () => {
    const log = createActivityLog();
    log.add(item(3, 'slow', { ms: 2400, sessions: 2, path: '~\\src\\big-repo', folder: 'big-repo' }), 5000);
    const text = buildDiagnostics({
      elapsedMs: 12_300, phase: 2, pct: 58, ready: false,
      phaseDurations: [100, 400, 11_800, undefined, undefined, undefined],
      sessions: 312, requests: 4210, toolCalls: 12_004, linesOfCode: 41_000, filesEdited: 812,
      item: item(412, 'reading', { total: 836 }),
      telemetry: { heapUsedMB: 1200, heapLimitMB: 4096, heapPeakMB: 1400, rssMB: 1600, fileBufMB: 80, cpuPct: 92, skippedFiles: 0, skippedLines: 0 },
      itemsPerSecond: 14,
      counts: log.counts(),
      flagged: log.flagged(),
    });
    expect(text).toContain('Progress: 58% · Step: Parsing session logs');
    expect(text).toContain('Workspace 412 of 836');
    expect(text).toContain('Parse logs 11.8s (running)');
    expect(text).toContain('heap 1.2 GB of 4.0 GB (peak 1.4 GB)');
    expect(text).toContain('~\\src\\big-repo');
    expect(text).not.toMatch(/[A-Za-z]:\\Users|\/home\/|\/Users\//);
  });
});

describe('buildDiagnostics unknown totals', () => {
  it('prints a dash, not 0, for totals that were never reported', () => {
    const text = buildDiagnostics({
      elapsedMs: 1000, phase: 4, pct: 90, ready: false,
      phaseDurations: [undefined, undefined, undefined, undefined, 1000, undefined],
      sessions: 12,
      counts: { done: 0, slow: 0, skipped: 0 },
      flagged: [],
    });
    expect(text).toContain('Found: 12 sessions · — prompts · — tool calls · — lines written · — files touched');
  });
});
