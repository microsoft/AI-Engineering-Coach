/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect } from 'vitest';
import { percentile, sessionIntensityLevel, sessionTileOpacity, parseWorkspacePlanKey, formatStatCount, computeGridDimensions } from './loading-grid-model';

describe('percentile', () => {
  it('returns 0 for an empty set', () => {
    expect(percentile([], 0.5)).toBe(0);
  });

  it('interpolates between samples', () => {
    expect(percentile([10, 20, 30, 40], 0.5)).toBe(25);
    expect(percentile([1, 2, 3, 4], 0.25)).toBeCloseTo(1.75, 5);
  });

  it('returns the exact sample when the index is whole', () => {
    expect(percentile([5, 15, 25], 0)).toBe(5);
    expect(percentile([5, 15, 25], 1)).toBe(25);
  });

  it('does not mutate the input array', () => {
    const input = [3, 1, 2];
    percentile(input, 0.5);
    expect(input).toEqual([3, 1, 2]);
  });
});

describe('sessionIntensityLevel', () => {
  const bp = { q25: 10, q50: 20, q75: 30 };
  it('buckets sizes into 1..4 by breakpoint', () => {
    expect(sessionIntensityLevel(5, bp)).toBe(1);
    expect(sessionIntensityLevel(10, bp)).toBe(2);
    expect(sessionIntensityLevel(20, bp)).toBe(3);
    expect(sessionIntensityLevel(30, bp)).toBe(4);
  });

  it('falls back to level 1 when all breakpoints are zero', () => {
    expect(sessionIntensityLevel(100, { q25: 0, q50: 0, q75: 0 })).toBe(1);
  });
});

describe('sessionTileOpacity', () => {
  it('reads bigger sessions stronger, with the largest at full strength', () => {
    const levels = ([1, 2, 3, 4] as const).map(sessionTileOpacity);
    expect(levels).toEqual([...levels].sort((a, b) => a - b));
    expect(levels[3]).toBe(1);
    expect(levels[0]).toBeGreaterThan(0.3);
  });
});

describe('parseWorkspacePlanKey', () => {
  it('parses a well-formed JSON key', () => {
    const key = JSON.stringify({ order: 3, date: '2026-06-09', wsId: 'repo', workspaceKey: 'wk', size: 2048 });
    expect(parseWorkspacePlanKey(key, 0)).toEqual({
      key, order: 3, date: '2026-06-09', month: '2026-06', workspace: 'repo', workspaceKey: 'wk', size: 2048,
    });
  });

  it('falls back to defaults on malformed input', () => {
    const meta = parseWorkspacePlanKey('not-json', 30);
    expect(meta).toEqual({
      key: 'not-json', order: 30, date: null, month: 'chunk-1',
      workspace: 'Workspace 31', workspaceKey: 'workspace-30', size: 0,
    });
  });

  it('uses fallbackOrder and chunk month when fields are missing', () => {
    const meta = parseWorkspacePlanKey('{}', 5);
    expect(meta.order).toBe(5);
    expect(meta.month).toBe('chunk-0');
    expect(meta.workspace).toBe('Workspace 6');
  });
});

describe('formatStatCount', () => {
  it('renders millions with one decimal and an M suffix', () => {
    expect(formatStatCount(1_200_000)).toBe('1.2M');
    expect(formatStatCount(1_000_000)).toBe('1.0M');
  });

  it('renders ten thousand and up with no decimals and a K suffix', () => {
    expect(formatStatCount(47_000)).toBe('47K');
    expect(formatStatCount(10_000)).toBe('10K');
  });

  it('renders values below ten thousand in full with a thousands separator', () => {
    expect(formatStatCount(9_384)).toBe('9,384');
    expect(formatStatCount(938)).toBe('938');
    expect(formatStatCount(0)).toBe('0');
  });
});

describe('computeGridDimensions', () => {
  it('returns null when there is nothing to lay out', () => {
    expect(computeGridDimensions(0, 800, 600)).toBeNull();
  });

  it('returns null when the viewport is too small', () => {
    expect(computeGridDimensions(10, 10, 600)).toBeNull();
    expect(computeGridDimensions(10, 800, 10)).toBeNull();
  });

  it('chooses rows/cols proportional to aspect ratio and covers all cells', () => {
    const dims = computeGridDimensions(12, 800, 200)!;
    expect(dims).not.toBeNull();
    expect(dims.rows * dims.cols).toBeGreaterThanOrEqual(12);
    expect(dims.rows).toBeGreaterThanOrEqual(1);
    expect(dims.cols).toBeGreaterThanOrEqual(1);
  });

  it('clamps cell size to the 2–16px range', () => {
    const tiny = computeGridDimensions(400, 100, 100)!;
    expect(tiny.size).toBeGreaterThanOrEqual(2);
    const big = computeGridDimensions(1, 800, 600)!;
    expect(big.size).toBeLessThanOrEqual(16);
  });

  it('sizes tiles to about a third of the stride, leaving room between them', () => {
    // 895 tiles in 1280×900: 26 rows × 35 cols, stride ≈ 34.6px → 11px tiles.
    expect(computeGridDimensions(895, 1280, 900)).toEqual({ rows: 26, cols: 35, size: 11 });
  });
});
