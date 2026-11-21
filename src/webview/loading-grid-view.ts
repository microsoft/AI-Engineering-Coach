/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Loading-screen workspace background grid: a self-contained UI widget that paints one tile per
 * planned workspace, sizes the grid to the viewport, and flips tiles to "done" as each workspace
 * finishes parsing. Owns its own render state; app.ts drives it via the three exported entry
 * points. The pure layout/intensity math lives in ./loading-grid-model so it can be unit-tested. */

import { html, render } from './render';
import {
  percentile,
  sessionIntensityLevel,
  sessionTileVars,
  parseWorkspacePlanKey,
  computeGridDimensions,
} from './loading-grid-model';

let workspacePlan: string[] = [];
let workspaceDone = new Set<string>();
let workspaceRendered = false;
let workspaceSlotIndex = new Map<number, number>();
let loadingGridResizeBound = false;
let workspaceGroupSlots = new Map<string, number[]>();

export function layoutWorkspaceGrid(): void {
  const container = document.getElementById('loading-tile-bg');
  const grid = document.getElementById('loading-bg-grid');
  if (!container || !grid) return;

  const dims = computeGridDimensions(workspacePlan.length, container.clientWidth, container.clientHeight);
  if (!dims) return;

  grid.style.setProperty('--bg-rows', String(dims.rows));
  grid.style.setProperty('--bg-cols', String(dims.cols));
  grid.style.setProperty('--bg-cell', `${dims.size}px`);
}

export function renderWorkspaceGrid(plan: string[]): void {
  workspacePlan = plan;
  workspaceDone = new Set();
  workspaceRendered = true;
  workspaceSlotIndex = new Map();
  workspaceGroupSlots = new Map();

  const container = document.getElementById('loading-tile-bg');
  if (!container) return;
  if (plan.length === 0) { container.style.display = 'none'; return; }

  const items = plan.map((key, index) => parseWorkspacePlanKey(key, index))
    .sort((a, b) => a.order - b.order);
  const sizes = items.map(item => item.size).filter(size => size > 0);
  const intensityBreakpoints = {
    q25: percentile(sizes, 0.25),
    q50: percentile(sizes, 0.5),
    q75: percentile(sizes, 0.75),
  };

  for (const [index, item] of items.entries()) {
    workspaceSlotIndex.set(item.order, index);
    const existingSlots = workspaceGroupSlots.get(item.workspaceKey) ?? [];
    existingSlots.push(item.order);
    workspaceGroupSlots.set(item.workspaceKey, existingSlots);
  }

  const gridCells = items.map(item => {
    const level = sessionIntensityLevel(item.size, intensityBreakpoints);
    const vars = sessionTileVars(level);
    const titleParts = [item.date ? item.date : '', item.workspace, item.size > 0 ? `${Math.round(item.size / 1024)} KB session` : 'session'];
    return html`<div class="cal-cell cal-workspace-cell cal-workspace-pending" data-slot=${item.order} title=${titleParts.filter(Boolean).join(' \u2014 ')} style=${`--pending-bg:${vars.pendingBg};--pending-border:${vars.pendingBorder};--done-bg:${vars.doneBg};--done-border:${vars.doneBorder};--done-glow:${vars.doneGlow};`}></div>`;
  });
  render(html`<div class="loading-bg-grid" id="loading-bg-grid">${gridCells}</div>`, container);
  container.style.display = '';

  requestAnimationFrame(() => layoutWorkspaceGrid());

  if (!loadingGridResizeBound) {
    window.addEventListener('resize', layoutWorkspaceGrid);
    loadingGridResizeBound = true;
  }
}

export function updateWorkspaceCell(workspaceKey: string, detail?: string): void {
  if (!workspaceRendered || workspaceDone.has(workspaceKey)) return;
  const slots = workspaceGroupSlots.get(workspaceKey);
  if (!slots || slots.length === 0) return;
  const grid = document.getElementById('loading-bg-grid');
  if (!grid) return;
  workspaceDone.add(workspaceKey);

  for (const slotIdx of slots) {
    const index = workspaceSlotIndex.get(slotIdx);
    const cell = index === undefined ? null : grid.children.item(index);
    if (!(cell instanceof HTMLElement)) continue;
    cell.className = 'cal-cell cal-workspace-cell cal-workspace-done cal-pop';
    if (detail) cell.title = detail;
  }
}
