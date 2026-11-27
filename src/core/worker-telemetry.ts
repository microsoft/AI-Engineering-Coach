/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Parse-worker resource telemetry sampler (issue #106).
 *
 * Extracted from parse-worker.ts so the CPU%/memory math is unit-testable with injected sources
 * (the worker entry itself wires up IPC and is awkward to load in a test). The sampler holds the
 * CPU-delta state between calls; create one per worker run.
 */

import * as v8 from 'v8';
import type { ParseTelemetry } from './parser';

const BYTES_PER_MB = 1024 * 1024;

/** Pluggable sources so tests can drive deterministic values. Defaults read the real runtime. */
export interface TelemetrySources {
  memoryUsage: () => NodeJS.MemoryUsage;
  cpuUsage: (previous?: NodeJS.CpuUsage) => NodeJS.CpuUsage;
  /** Monotonic time in nanoseconds (defaults to process.hrtime.bigint). */
  hrtimeNs: () => bigint;
  heapLimitBytes: () => number;
  /** Live parse-warning counts (failed files / skipped lines). */
  warningCounts: () => { skippedFiles: number; skippedLines: number };
}

const defaultSources: TelemetrySources = {
  memoryUsage: () => process.memoryUsage(),
  cpuUsage: (previous) => process.cpuUsage(previous),
  hrtimeNs: () => process.hrtime.bigint(),
  heapLimitBytes: () => v8.getHeapStatistics().heap_size_limit,
  warningCounts: () => ({ skippedFiles: 0, skippedLines: 0 }),
};

/**
 * Shortest window the CPU percentage is measured over. The worker samples on every progress
 * event, often well under a millisecond apart, and `process.cpuUsage()` advances in scheduler
 * ticks (about 15.6 ms on Windows), so per-call deltas read 0% while the worker is busy. Calls
 * inside the window reuse the last measured value and keep the window open.
 */
export const CPU_SAMPLE_WINDOW_MS = 500;

/**
 * Create a telemetry sampler. Each call to the returned function produces a fresh snapshot;
 * `cpuPct` is measured over at least `minWindowMs` (0 until the first window closes).
 */
export function createTelemetrySampler(
  sources: Partial<TelemetrySources> = {},
  minWindowMs: number = CPU_SAMPLE_WINDOW_MS,
): () => ParseTelemetry {
  const s: TelemetrySources = { ...defaultSources, ...sources };
  const mb = (n: number): number => Math.round(n / BYTES_PER_MB);

  // Constant read once — the heap ceiling does not change during a run.
  const heapLimitMB = mb(s.heapLimitBytes());

  let lastCpu = s.cpuUsage();
  let lastAt = s.hrtimeNs();
  let cpuPct = 0;

  return function sample(): ParseTelemetry {
    const m = s.memoryUsage();

    const at = s.hrtimeNs();
    const elapsedMicros = Number(at - lastAt) / 1000; // ns → µs
    if (elapsedMicros >= minWindowMs * 1000 && elapsedMicros > 0) {
      const cpuNow = s.cpuUsage();
      const usedMicros = (cpuNow.user - lastCpu.user) + (cpuNow.system - lastCpu.system);
      lastCpu = cpuNow;
      lastAt = at;
      cpuPct = Math.round(Math.max(0, Math.min(100, (usedMicros / elapsedMicros) * 100)));
    }

    return {
      rssMB: mb(m.rss),
      heapUsedMB: mb(m.heapUsed),
      heapLimitMB,
      fileBufMB: mb(m.external + m.arrayBuffers),
      cpuPct,
      ...s.warningCounts(),
    };
  };
}
