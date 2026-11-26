/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Pure visual-model helpers for the loading-screen workspace grid. No DOM / vscode access;
 * extracted from app.ts so the percentile/intensity/tile math is unit-testable. */


export interface WorkspacePlanMeta {
  key: string;
  order: number;
  date: string | null;
  month: string;
  workspace: string;
  workspaceKey: string;
  size: number;
}

/** Compact a running stat count for the loading screen: 1.2M / 47K / 9,384. */
export function formatStatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(0)}K`;
  return n.toLocaleString('en-US');
}

export interface GridDimensions {
  rows: number;
  cols: number;
  size: number;
}

/** Share of each grid stride a tile fills; the rest is the gap between tiles. */
export const TILE_STRIDE_SHARE = 0.34;

/** Compute the background tile grid layout for `n` cells inside a `width`×`height` viewport.
 * Rows/cols are chosen proportional to the viewport aspect ratio; cell size fills about a third
 * of the available stride and is clamped to 2–16px. Returns `null` when there is nothing to lay
 * out or the viewport is too small to be meaningful. */
export function computeGridDimensions(n: number, width: number, height: number): GridDimensions | null {
  if (n === 0 || width < 20 || height < 20) return null;
  const aspect = width / height;
  const rows = Math.max(1, Math.ceil(Math.sqrt(n / aspect)));
  const cols = Math.max(1, Math.ceil(n / rows));
  const stride = Math.min(width / cols, height / rows);
  const size = Math.max(2, Math.min(16, Math.floor(stride * TILE_STRIDE_SHARE)));
  return { rows, cols, size };
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const weight = idx - lo;
  return sorted[lo] * (1 - weight) + sorted[hi] * weight;
}

export function sessionIntensityLevel(size: number, breakpoints: { q25: number; q50: number; q75: number }): 1 | 2 | 3 | 4 {
  if (size >= breakpoints.q75 && breakpoints.q75 > 0) return 4;
  if (size >= breakpoints.q50 && breakpoints.q50 > 0) return 3;
  if (size >= breakpoints.q25 && breakpoints.q25 > 0) return 2;
  return 1;
}

/** Opacity of a read tile by session size: bigger sessions read stronger. The color itself is
 *  always the accent, so read tiles never look duller than pending ones in any theme. */
export function sessionTileOpacity(level: 1 | 2 | 3 | 4): number {
  return { 1: 0.45, 2: 0.62, 3: 0.8, 4: 1 }[level];
}

export function parseWorkspacePlanKey(key: string, fallbackOrder: number): WorkspacePlanMeta {
  try {
    const parsed = JSON.parse(key) as { order?: number; date?: string | null; wsId?: string; workspaceKey?: string; size?: number };
    const order = typeof parsed.order === 'number' ? parsed.order : fallbackOrder;
    const date = typeof parsed.date === 'string' ? parsed.date : null;
    return {
      key,
      order,
      date,
      month: date ? date.slice(0, 7) : `chunk-${Math.floor(fallbackOrder / 28)}`,
      workspace: typeof parsed.wsId === 'string' && parsed.wsId.length > 0 ? parsed.wsId : `Workspace ${fallbackOrder + 1}`,
      workspaceKey: typeof parsed.workspaceKey === 'string' && parsed.workspaceKey.length > 0 ? parsed.workspaceKey : `workspace-${fallbackOrder}`,
      size: typeof parsed.size === 'number' ? parsed.size : 0,
    };
  } catch {
    return {
      key,
      order: fallbackOrder,
      date: null,
      month: `chunk-${Math.floor(fallbackOrder / 28)}`,
      workspace: `Workspace ${fallbackOrder + 1}`,
      workspaceKey: `workspace-${fallbackOrder}`,
      size: 0,
    };
  }
}
