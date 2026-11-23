/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProgressThrottle } from './panel-progress-throttle';

type P = { phase: number; pct: number; detail: string; workspaceDone?: string };

let sent: string[];
const throttle = () => createProgressThrottle<P>(p => sent.push(p.detail), 250);

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
});
afterEach(() => vi.useRealTimers());

describe('createProgressThrottle', () => {
  it('sends a queued update before the next phase instead of dropping it (final totals)', () => {
    const t = throttle();
    t.push({ phase: 3, pct: 80, detail: 'Claude Code' });
    vi.advanceTimersByTime(10);
    t.push({ phase: 3, pct: 85, detail: 'Found 587 sessions' });
    t.push({ phase: 4, pct: 90, detail: 'Building analyzer' });
    expect(sent).toEqual(['Claude Code', 'Found 587 sessions', 'Building analyzer']);
    vi.advanceTimersByTime(1000);
    expect(sent).toHaveLength(3);
  });

  it('coalesces routine updates to one per interval, keeping the latest', () => {
    const t = throttle();
    t.push({ phase: 2, pct: 10, detail: 'a' });
    t.push({ phase: 2, pct: 11, detail: 'b' });
    t.push({ phase: 2, pct: 12, detail: 'c' });
    expect(sent).toEqual(['a']);
    vi.advanceTimersByTime(250);
    expect(sent).toEqual(['a', 'c']);
  });

  it('sends structural updates at once and stops after dispose', () => {
    const t = throttle();
    t.push({ phase: 2, pct: 10, detail: 'start' });
    t.push({ phase: 2, pct: 11, detail: 'done', workspaceDone: 'ws-1' });
    t.push({ phase: 2, pct: 12, detail: 'queued' });
    t.dispose();
    vi.advanceTimersByTime(1000);
    expect(sent).toEqual(['start', 'done']);
  });
});
