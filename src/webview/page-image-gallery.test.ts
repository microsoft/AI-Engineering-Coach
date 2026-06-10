/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeAll } from 'vitest';

beforeAll(() => {
  (globalThis as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
    postMessage: () => { /* noop */ },
    getState: () => null,
    setState: () => { /* noop */ },
  });
});

const DAY = 86_400_000;

describe('Coding Moments time-range filter', () => {
  it('exposes ranges aligned with the Output tab (incl. All time)', async () => {
    const { IMAGE_TIME_RANGES } = await import('./page-image-gallery');
    const labels = IMAGE_TIME_RANGES.map(r => r.label);
    expect(labels).toContain('Last 7 days');
    expect(labels).toContain('Last 4 weeks');
    expect(labels).toContain('Last 3 months');
    expect(labels).toContain('Last 6 months');
    expect(labels).toContain('All time');
    // "All time" is represented by days === 0.
    expect(IMAGE_TIME_RANGES.find(r => r.label === 'All time')?.days).toBe(0);
  });

  it('rangeStartTimestamp returns 0 for All time and a cutoff otherwise', async () => {
    const { rangeStartTimestamp } = await import('./page-image-gallery');
    const now = 1_000_000_000_000;
    expect(rangeStartTimestamp(0, now)).toBe(0);
    expect(rangeStartTimestamp(7, now)).toBe(now - 7 * DAY);
    // Negative/garbage days are treated as "no lower bound".
    expect(rangeStartTimestamp(-5, now)).toBe(0);
  });

  it('filterMomentsByRange keeps only moments within the window', async () => {
    const { filterMomentsByRange } = await import('./page-image-gallery');
    const now = 1_000_000_000_000;
    const moments = [
      { id: 'recent', timestamp: now - DAY / 2 },
      { id: 'week', timestamp: now - 6 * DAY },
      { id: 'old', timestamp: now - 40 * DAY },
    ];

    const last7 = filterMomentsByRange(moments, 7, now).map(m => m.id);
    expect(last7).toEqual(['recent', 'week']);

    const last24h = filterMomentsByRange(moments, 1, now).map(m => m.id);
    expect(last24h).toEqual(['recent']);

    // 0 days ("All time") returns everything untouched.
    expect(filterMomentsByRange(moments, 0, now)).toBe(moments);
  });

  it('includes a moment exactly on the boundary', async () => {
    const { filterMomentsByRange } = await import('./page-image-gallery');
    const now = 1_000_000_000_000;
    const moments = [{ id: 'edge', timestamp: now - 7 * DAY }];
    expect(filterMomentsByRange(moments, 7, now).map(m => m.id)).toEqual(['edge']);
  });
});
