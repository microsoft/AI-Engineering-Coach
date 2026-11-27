/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * @vitest-environment jsdom
 *
 * Unit tests for the loading-screen worker box (issue #106). Verifies the pure formatting
 * helpers and the DOM rendering of {@link updateTelemetry} against a real jsdom document.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { fmtMem, heapPeakMB, pressureColor, resetTelemetryHistory, updateTelemetry, updateThroughput } from './telemetry-strip';
import type { WorkerTelemetry } from './shared';

const SAMPLE: WorkerTelemetry = {
  rssMB: 512,
  heapUsedMB: 256,
  heapLimitMB: 4096,
  fileBufMB: 64,
  cpuPct: 42,
};

describe('telemetry-strip helpers', () => {
  it('fmtMem formats MB and GB', () => {
    expect(fmtMem(0)).toBe('0 MB');
    expect(fmtMem(512)).toBe('512 MB');
    expect(fmtMem(1024)).toBe('1.0 GB');
    expect(fmtMem(1536)).toBe('1.5 GB');
    expect(fmtMem(10240)).toBe('10 GB');
  });

  it('pressureColor escalates with utilization', () => {
    expect(pressureColor(10)).toContain('--accent-blue');
    expect(pressureColor(64)).toContain('--accent-blue');
    expect(pressureColor(65)).toContain('--accent-amber');
    expect(pressureColor(84)).toContain('--accent-amber');
    expect(pressureColor(85)).toContain('--accent-red');
    expect(pressureColor(100)).toContain('--accent-red');
  });
});

describe('updateTelemetry rendering', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="loading-telemetry"></div>';
    resetTelemetryHistory();
  });

  it('is a no-op when the host element is absent', () => {
    document.body.innerHTML = '';
    expect(() => updateTelemetry(SAMPLE)).not.toThrow();
  });

  it('builds the worker box once and populates all values', () => {
    updateTelemetry(SAMPLE);
    const host = document.getElementById('loading-telemetry')!;

    expect(host.dataset.init).toBe('1');
    expect(document.getElementById('tg-mem-used')?.textContent).toBe('256 MB');
    expect(document.getElementById('tg-mem-limit')?.textContent).toBe('4.0 GB');
    expect(document.getElementById('tg-rss')?.textContent).toBe('512 MB');
    expect(document.getElementById('tg-buf')?.textContent).toBe('64 MB');
    expect(document.getElementById('tg-cpu-load')?.textContent).toBe('42%');
  });

  it('updates in place and draws the heap sparkline against the cap', () => {
    updateTelemetry(SAMPLE, 0);
    const line = document.getElementById('tg-heap-line');
    updateTelemetry({ ...SAMPLE, heapUsedMB: 2048 }, 500);
    expect(document.getElementById('tg-heap-line')).toBe(line);
    expect(document.getElementById('tg-mem-used')?.textContent).toBe('2.0 GB');
    // Two samples: 256 MB and 2048 MB of a 4096 MB cap (height 34 → y = 33 - v/cap*32).
    expect(line?.getAttribute('points')).toBe('0.0,31.0 240.0,17.0');
  });

  it('keeps one heap sample per half second however often it is called', () => {
    for (let t = 0; t < 1000; t += 10) updateTelemetry(SAMPLE, t);
    expect(document.getElementById('tg-heap-line')?.getAttribute('points')?.split(' ')).toHaveLength(2);
    expect(heapPeakMB()).toBe(256);
  });

  it('marks heap pressure at 85% and clears it when use drops', () => {
    updateTelemetry({ ...SAMPLE, heapUsedMB: 3686 }, 0);
    const host = document.getElementById('loading-telemetry')!;
    expect(host.classList.contains('tg-pressure')).toBe(true);
    expect((document.getElementById('tg-heap-line') as unknown as SVGElement).style.stroke).toContain('--accent-red');
    updateTelemetry({ ...SAMPLE, heapUsedMB: 256 }, 600);
    expect(host.classList.contains('tg-pressure')).toBe(false);
  });

  it('handles a zero heap limit without dividing by zero', () => {
    expect(() => updateTelemetry({ ...SAMPLE, heapLimitMB: 0 })).not.toThrow();
  });

  it('shows the throughput rate with its unit', () => {
    updateTelemetry(SAMPLE);
    updateThroughput([2, 6, 4], 4.25, 'workspaces');
    expect(document.getElementById('tg-rate')?.textContent).toBe('4.3 workspaces/s');
    expect(document.getElementById('tg-rate-line')?.getAttribute('points')?.split(' ')).toHaveLength(3);
    updateThroughput([], undefined, 'workspaces');
    expect(document.getElementById('tg-rate')?.textContent).toBe('—');
  });

});

describe('updateTelemetry skipped files', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="loading-telemetry"></div>';
    resetTelemetryHistory();
  });

  it('shows no skipped files by default (clean parse)', () => {
    updateTelemetry(SAMPLE);
    expect(document.getElementById('tg-skipped')?.textContent).toBe('0 files');
    expect(document.getElementById('tg-skipped-tile')?.classList.contains('tg-tile-warn')).toBe(false);
  });

  it('highlights skipped files and includes skipped lines when present', () => {
    updateTelemetry({ ...SAMPLE, skippedFiles: 2, skippedLines: 5 });
    expect(document.getElementById('tg-skipped')?.textContent).toBe('2 files · 5 lines');
    expect(document.getElementById('tg-skipped-tile')?.classList.contains('tg-tile-warn')).toBe(true);
  });

  it('uses singular wording for a single skipped file and clears the warn class when resolved', () => {
    updateTelemetry({ ...SAMPLE, skippedFiles: 1, skippedLines: 0 });
    expect(document.getElementById('tg-skipped')?.textContent).toBe('1 file');
    expect(document.getElementById('tg-skipped-tile')?.classList.contains('tg-tile-warn')).toBe(true);
    updateTelemetry({ ...SAMPLE, skippedFiles: 0, skippedLines: 0 });
    expect(document.getElementById('tg-skipped-tile')?.classList.contains('tg-tile-warn')).toBe(false);
  });
});
