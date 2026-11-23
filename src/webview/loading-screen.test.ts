/**
 * @vitest-environment jsdom
 */
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoadItem } from '../core/load-phases';
import {
  disposeLoadingScreen,
  loadingDiagnostics,
  mountLoadingScreen,
  READY_HOLD_MS,
  recordLoadingProgress,
  renderLoadingScreen,
  showLoadingReady,
  type DetailsStore,
} from './loading-screen';

function memoryStore(initial = false): DetailsStore & { saved: boolean[] } {
  let open = initial;
  const saved: boolean[] = [];
  return { saved, get: () => open, set: (value) => { open = value; saved.push(value); } };
}

const text = (id: string): string => document.getElementById(id)?.textContent ?? '';

function cli(index: number, total: number, status: LoadItem['status'] = 'parsed'): LoadItem {
  return { kind: 'cli-session', index, total, folder: 'my-api', path: '~/work/my-api', status, ms: 40, sessions: 1 };
}

let content: HTMLElement;

beforeEach(() => {
  disposeLoadingScreen();
  document.body.innerHTML = '<div id="content"></div>';
  content = document.getElementById('content')!;
});

describe('details drawer', () => {
  it('starts collapsed, remembers the choice, and reopens on the next mount', () => {
    const store = memoryStore(false);
    mountLoadingScreen(content, store, 0);
    const toggle = document.getElementById('loading-details-toggle')!;
    expect(document.getElementById('loading-details')!.hidden).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    toggle.click();
    expect(store.saved).toEqual([true]);
    expect(document.getElementById('loading-details')!.hidden).toBe(false);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.textContent).toBe('Hide details');

    mountLoadingScreen(content, store, 0);
    expect(document.getElementById('loading-details')!.hidden).toBe(false);
    document.getElementById('loading-details-toggle')!.click();
    expect(store.saved).toEqual([true, false]);
  });

  it('filters the activity table to slow rows', () => {
    mountLoadingScreen(content, memoryStore(true), 0);
    recordLoadingProgress({ phase: 2, pct: 20, item: { ...cli(1, 3), kind: 'workspace' } }, 100);
    recordLoadingProgress({ phase: 2, pct: 30, item: { ...cli(2, 3, 'slow'), kind: 'workspace', ms: 2600 } }, 200);
    renderLoadingScreen(300);
    expect(document.querySelectorAll('#loading-activity tr')).toHaveLength(2);
    document.querySelector<HTMLButtonElement>('.load-filter[data-filter="slow"]')!.click();
    const rows = [...document.querySelectorAll('#loading-activity tr')];
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('Slow');
    expect(rows[0].querySelector('.load-path b')?.textContent).toBe('my-api');
    expect(document.querySelector('.load-filter[data-filter="slow"]')!.getAttribute('aria-pressed')).toBe('true');
  });
});

describe('status card', () => {
  it('shows the folder name only, never the path, on the card', () => {
    mountLoadingScreen(content, memoryStore(), 0);
    recordLoadingProgress({
      phase: 2, pct: 40, detail: 'workspace 619/835: ~/work/my-api',
      item: { kind: 'workspace', index: 619, total: 835, folder: 'my-api', path: '~/work/my-api', status: 'reading' },
    }, 1000);
    renderLoadingScreen(1000);
    expect(text('loading-phase-detail')).toBe('Workspace 619 of 835 \u00b7 my-api');
    expect(document.querySelector('#loading-phase-detail b')?.textContent).toBe('my-api');
  });

  it('names the CLI re-read step with a count on a cached load', () => {
    mountLoadingScreen(content, memoryStore(), 0);
    recordLoadingProgress({ phase: 1, pct: 10, detail: 'Loaded 520 cached sessions from disk', sessions: 520 }, 500);
    recordLoadingProgress({ phase: 2, pct: 22, sessions: 601, item: cli(81, 790) }, 1500);
    renderLoadingScreen(1500);
    expect(text('loading-phase-title')).toBe('Re-reading Copilot CLI and App sessions');
    expect(text('loading-phase-detail')).toBe('Session 81 of 790 \u00b7 my-api');
    expect(document.getElementById('loading-note')!.hidden).toBe(false);
    expect(text('loading-stat-sessions')).toBe('601');
  });

  it('keeps the shown percentage and stepper moving forward', () => {
    mountLoadingScreen(content, memoryStore(), 0);
    recordLoadingProgress({ phase: 3, pct: 82 }, 100);
    recordLoadingProgress({ phase: 1, pct: 10, detail: 'late cache report' }, 200);
    renderLoadingScreen(200);
    expect(text('loading-pct-value')).toBe('82');
    expect(document.getElementById('loading-step-2')!.dataset.state).toBe('done');
    expect(document.getElementById('loading-step-3')!.dataset.state).toBe('active');
  });
});

describe('status card counters and timing', () => {
  it('shows a reported zero as 0 and keeps "—" for counters never reported', () => {
    mountLoadingScreen(content, memoryStore(), 0);
    recordLoadingProgress({ phase: 2, pct: 40, sessions: 3, toolCalls: 7 }, 100);
    recordLoadingProgress({ phase: 3, pct: 85, sessions: 3, requests: 4, toolCalls: 0, linesOfCode: 0 }, 200);
    renderLoadingScreen(200);
    expect(text('loading-stat-tools')).toBe('0');
    expect(text('loading-stat-loc')).toBe('0');
    expect(text('loading-stat-files')).toBe('\u2014');
  });

  it('shows the health chip with heap use and skipped files at the warn threshold', () => {
    mountLoadingScreen(content, memoryStore(), 0);
    recordLoadingProgress({ phase: 2, pct: 30, telemetry: { rssMB: 900, heapUsedMB: 700, heapLimitMB: 1024, fileBufMB: 20, cpuPct: 80, skippedFiles: 1 } }, 100);
    renderLoadingScreen(100);
    const chip = document.getElementById('loading-health')!;
    expect(chip.hidden).toBe(false);
    expect(chip.dataset.level).toBe('warn');
    expect(text('loading-health-text')).toBe('Memory high \u00b7 700 MB of 1.0 GB heap \u00b7 1 file skipped');
  });

  it('shows the time left only after 3 s of data, labelled "about"', () => {
    mountLoadingScreen(content, memoryStore(), 0);
    recordLoadingProgress({ phase: 2, pct: 10 }, 0);
    recordLoadingProgress({ phase: 2, pct: 14 }, 2000);
    renderLoadingScreen(2000);
    expect(text('loading-time')).toBe('2s elapsed');
    recordLoadingProgress({ phase: 2, pct: 16 }, 3000);
    renderLoadingScreen(3000);
    expect(text('loading-time')).toBe('3s elapsed \u00b7 about 35s left');
  });
});

describe('ready summary', () => {
  it('holds a summary after a slow load, with every step done', () => {
    mountLoadingScreen(content, memoryStore(), 0);
    recordLoadingProgress({ phase: 5, pct: 100, sessions: 291 }, 16_800);
    expect(showLoadingReady(17_000)).toBe(READY_HOLD_MS);
    expect(document.getElementById('load-index')!.dataset.state).toBe('ready');
    expect(text('loading-kicker-text')).toBe('Activity index ready');
    expect(text('loading-phase-title')).toBe('291 sessions indexed in 17.0s');
    expect(text('loading-phase-detail')).toBe('Opening your dashboard\u2026');
    expect(text('loading-found-label')).toBe('Found');
    expect([...document.querySelectorAll('.load-seg')].every(seg => (seg as HTMLElement).dataset.state === 'done')).toBe(true);
    expect(loadingDiagnostics(17_500)).toContain('Step: Ready');
  });

  it('skips the summary on a fast cache hit', () => {
    mountLoadingScreen(content, memoryStore(), 0);
    recordLoadingProgress({ phase: 5, pct: 100, sessions: 291 }, 120);
    expect(showLoadingReady(150)).toBe(0);
    expect(document.getElementById('load-index')!.dataset.state).toBe('loading');
  });
});

describe('details drawer measurements', () => {
  const tel = (heapUsedMB: number) => ({ rssMB: 900, heapUsedMB, heapLimitMB: 4096, fileBufMB: 20, cpuPct: 80 });

  it('keeps the heap peak from every snapshot, not only the ones that reach a frame', () => {
    mountLoadingScreen(content, memoryStore(), 0);
    recordLoadingProgress({ phase: 2, pct: 30, telemetry: tel(2048) }, 100);
    recordLoadingProgress({ phase: 2, pct: 31, telemetry: tel(300) }, 110);
    renderLoadingScreen(120);
    expect(loadingDiagnostics(120)).toContain('heap 300 MB of 4.0 GB (peak 2.0 GB)');
  });

  it('restarts the throughput rate when the step switches from workspaces to sessions', () => {
    mountLoadingScreen(content, memoryStore(true), 0);
    for (let i = 1; i <= 9; i++) {
      recordLoadingProgress({ phase: 2, pct: 10 + i, item: { kind: 'workspace', index: i, total: 9, folder: 'api', path: '~/api', status: 'parsed', ms: 5, sessions: 1 } }, 1000 + i * 10);
    }
    recordLoadingProgress({ phase: 2, pct: 40, item: cli(1, 50) }, 1200);
    renderLoadingScreen(1300);
    // One session in the last three seconds, not ten items relabelled as sessions.
    expect(text('tg-rate')).toBe('0.3 sessions/s');
  });
});

describe('details drawer clock', () => {
  it('keeps the running step time moving between progress messages', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      mountLoadingScreen(content, memoryStore(true), 0);
      recordLoadingProgress({ phase: 4, pct: 90, detail: 'Computing analytics' }, 0);
      renderLoadingScreen(0);
      expect(text('loading-phase-ms-4')).toBe('0 ms');
      vi.advanceTimersByTime(3000);
      expect(text('loading-phase-ms-4')).toBe('3.0s');
    } finally {
      disposeLoadingScreen();
      vi.useRealTimers();
    }
  });
});
