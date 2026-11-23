/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Unit tests for the parse-worker telemetry sampler (issue #106). Uses injected sources so the
 * memory conversion and CPU-delta math are verified deterministically without a real process.
 */

import { describe, it, expect } from 'vitest';
import { createTelemetrySampler, type TelemetrySources } from './worker-telemetry';

const MB = 1024 * 1024;

function mem(over: Partial<NodeJS.MemoryUsage> = {}): NodeJS.MemoryUsage {
  return {
    rss: 0,
    heapTotal: 0,
    heapUsed: 0,
    external: 0,
    arrayBuffers: 0,
    ...over,
  };
}

describe('createTelemetrySampler', () => {
  it('converts byte sources to whole megabytes', () => {
    const sample = createTelemetrySampler({
      memoryUsage: () => mem({ rss: 512 * MB, heapUsed: 256 * MB, external: 40 * MB, arrayBuffers: 24 * MB }),
      cpuUsage: () => ({ user: 0, system: 0 }),
      hrtimeNs: () => 0n,
      heapLimitBytes: () => 4096 * MB,
    });

    const t = sample();
    expect(t.rssMB).toBe(512);
    expect(t.heapUsedMB).toBe(256);
    expect(t.heapLimitMB).toBe(4096);
    expect(t.fileBufMB).toBe(64); // external + arrayBuffers
  });

  it('reports 0% CPU on the first sample (no prior delta)', () => {
    const sample = createTelemetrySampler({
      memoryUsage: () => mem(),
      cpuUsage: () => ({ user: 1_000_000, system: 0 }),
      hrtimeNs: () => 1_000_000_000n,
      heapLimitBytes: () => 2048 * MB,
    });
    expect(sample().cpuPct).toBe(0);
  });

  it('computes CPU% from the delta between samples', () => {
    // The factory seeds lastCpu=0µs @ t=0 on construction (consumes index 0); the first sample()
    // then sees +500_000µs CPU over 1s (1_000_000µs) wall → 50%.
    const cpuSeq = [
      { user: 0, system: 0 },
      { user: 500_000, system: 0 },
    ];
    const timeSeq = [0n, 1_000_000_000n]; // ns
    let ci = 0;
    let ti = 0;
    const sources: Partial<TelemetrySources> = {
      memoryUsage: () => mem(),
      cpuUsage: () => cpuSeq[Math.min(ci++, cpuSeq.length - 1)],
      hrtimeNs: () => timeSeq[Math.min(ti++, timeSeq.length - 1)],
      heapLimitBytes: () => 4096 * MB,
    };
    const sample = createTelemetrySampler(sources); // seed (consumes cpuSeq[0], timeSeq[0])

    const t = sample();        // delta (consumes cpuSeq[1], timeSeq[1])
    expect(t.cpuPct).toBe(50);
  });

  it('clamps CPU% to the 0–100 range', () => {
    const cpuSeq = [
      { user: 0, system: 0 },
      { user: 5_000_000, system: 0 }, // 5s CPU over 1s wall → 500% → clamp to 100
    ];
    const timeSeq = [0n, 1_000_000_000n];
    let ci = 0;
    let ti = 0;
    const sample = createTelemetrySampler({ // seed (consumes index 0)
      memoryUsage: () => mem(),
      cpuUsage: () => cpuSeq[Math.min(ci++, cpuSeq.length - 1)],
      hrtimeNs: () => timeSeq[Math.min(ti++, timeSeq.length - 1)],
      heapLimitBytes: () => 4096 * MB,
    });
    expect(sample().cpuPct).toBe(100);
  });

  it('keeps reading a busy worker as busy when it samples far more often than the CPU clock ticks', () => {
    // A fully busy worker sampled every millisecond (progress events) while process.cpuUsage()
    // only advances in 15.6 ms scheduler ticks, as on Windows. Per-call deltas are mostly 0.
    let nowMs = 0;
    const tickMs = 15.6;
    const sample = createTelemetrySampler({
      memoryUsage: () => mem(),
      cpuUsage: () => ({ user: Math.floor(nowMs / tickMs) * tickMs * 1000, system: 0 }),
      hrtimeNs: () => BigInt(Math.round(nowMs * 1e6)),
      heapLimitBytes: () => 4096 * MB,
    });
    const readings: number[] = [];
    for (nowMs = 1; nowMs <= 3000; nowMs++) {
      const t = sample();
      if (nowMs > 600) readings.push(t.cpuPct);
    }
    const busy = readings.filter(pct => pct >= 90).length;
    expect(busy / readings.length).toBeGreaterThan(0.95);
  });

  it('produces a payload matching the ParseTelemetry contract', () => {
    const sample = createTelemetrySampler({
      memoryUsage: () => mem({ rss: 100 * MB, heapUsed: 50 * MB }),
      cpuUsage: () => ({ user: 0, system: 0 }),
      hrtimeNs: () => 0n,
      heapLimitBytes: () => 2048 * MB,
    });
    const t = sample();
    for (const key of ['rssMB', 'heapUsedMB', 'heapLimitMB', 'fileBufMB', 'cpuPct'] as const) {
      expect(typeof t[key]).toBe('number');
      expect(Number.isFinite(t[key])).toBe(true);
    }
  });
});
