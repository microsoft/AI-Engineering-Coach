/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * @vitest-environment jsdom
 *
 * Characterization tests for the loading-screen workspace grid view. These pin the observable DOM
 * behavior (cell count, data-slot wiring, done-state flipping, empty-plan hiding) so the extraction
 * from app.ts is provably behavior-preserving.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderWorkspaceGrid, updateWorkspaceCell, layoutWorkspaceGrid } from './loading-grid-view';

function planKey(order: number, workspaceKey: string, size: number): string {
  return JSON.stringify({ order, date: `2026-01-0${order + 1}`, wsId: `WS ${workspaceKey}`, workspaceKey, size });
}

beforeEach(() => {
  document.body.innerHTML = '<div id="loading-tile-bg"></div>';
  // jsdom does not implement requestAnimationFrame deterministically; run callbacks synchronously.
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => { cb(0); return 0; }) as typeof requestAnimationFrame;
});

describe('renderWorkspaceGrid', () => {
  it('hides the container when the plan is empty', () => {
    renderWorkspaceGrid([]);
    const container = document.getElementById('loading-tile-bg')!;
    expect(container.style.display).toBe('none');
  });

  it('is a no-op when the host element is absent', () => {
    document.body.innerHTML = '';
    expect(() => renderWorkspaceGrid([planKey(0, 'a', 1024)])).not.toThrow();
  });

  it('paints one pending cell per planned workspace, wired by data-slot', () => {
    renderWorkspaceGrid([planKey(0, 'a', 2048), planKey(1, 'a', 4096), planKey(2, 'b', 1024)]);
    const container = document.getElementById('loading-tile-bg')!;
    const cells = container.querySelectorAll('.cal-workspace-cell');
    expect(cells.length).toBe(3);
    expect(container.style.display).toBe('');
    expect(document.querySelector('[data-slot="0"]')).not.toBeNull();
    expect(document.querySelector('[data-slot="2"]')).not.toBeNull();
    cells.forEach(c => expect(c.classList.contains('cal-workspace-pending')).toBe(true));
  });
});

describe('updateWorkspaceCell', () => {
  beforeEach(() => {
    renderWorkspaceGrid([planKey(0, 'a', 2048), planKey(1, 'a', 4096), planKey(2, 'b', 1024)]);
  });

  it('flips every slot of a finished workspace to the done state', () => {
    updateWorkspaceCell('a', 'done detail');
    const done = document.querySelectorAll('.cal-workspace-done');
    expect(done.length).toBe(2);
    done.forEach(c => expect((c as HTMLElement).title).toBe('done detail'));
    // The other workspace stays pending.
    expect(document.querySelectorAll('.cal-workspace-pending').length).toBe(1);
  });

  it('is idempotent and ignores unknown workspace keys', () => {
    updateWorkspaceCell('a');
    updateWorkspaceCell('a');
    updateWorkspaceCell('does-not-exist');
    expect(document.querySelectorAll('.cal-workspace-done').length).toBe(2);
  });

  it('resolves sparse, unsorted slot numbers without scanning the document', () => {
    renderWorkspaceGrid([planKey(100, 'a', 10), planKey(20, 'b', 10), planKey(50, 'a', 10)]);
    const query = vi.spyOn(document, 'querySelector');
    updateWorkspaceCell('a', 'Finished A');
    expect(query).not.toHaveBeenCalled();
    query.mockRestore();
    expect([...document.querySelectorAll('.cal-workspace-done')].map(cell => cell.getAttribute('data-slot'))).toEqual(['50', '100']);
    expect(document.querySelector<HTMLElement>('[data-slot="100"]')?.title).toBe('Finished A');
  });

  it('completes a large plan with no per-tile selector searches', () => {
    const count = 2000;
    renderWorkspaceGrid(Array.from({ length: count }, (_, order) => planKey(order, `ws-${order}`, 10)));
    const query = vi.spyOn(document, 'querySelector');
    for (let index = 0; index < count; index++) updateWorkspaceCell(`ws-${index}`);
    expect(query).not.toHaveBeenCalled();
    query.mockRestore();
    expect(document.querySelectorAll('.cal-workspace-done')).toHaveLength(count);
  });

  it('does not keep completion state after the grid has been replaced', () => {
    document.body.innerHTML = '<div id="loading-tile-bg"></div>';
    updateWorkspaceCell('a');
    renderWorkspaceGrid([planKey(0, 'a', 10)]);
    updateWorkspaceCell('a');
    expect(document.querySelectorAll('.cal-workspace-done')).toHaveLength(1);
  });
});

describe('layoutWorkspaceGrid', () => {
  it('does not throw when the grid is absent', () => {
    document.body.innerHTML = '<div id="loading-tile-bg"></div>';
    expect(() => layoutWorkspaceGrid()).not.toThrow();
  });
});
