/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Guides on Context Management's utilization charts: thresholds, compaction and to-do markers, to-do bands, and
 * the tooltip lines that name each request's events. */

import { describe, expect, it, vi } from 'vitest';
import type { ContextVerdictThresholds, SessionContextDetail } from '../core/types';

vi.mock('./shared', () => ({ COLORS: { green: '#3fb950', yellow: '#d29922', red: '#f85149', blue: '#58a6ff' } }));

import { eventTooltipLines, sessionChartGuides, thresholdLines } from './context-mgmt-guides';

const THRESHOLDS: ContextVerdictThresholds = { optimalUtilization: 55, limitedUtilization: 85, adaptive: true, sampleSize: 40 };
type Events = SessionContextDetail['events'];

describe('thresholdLines', () => {
  it('draws the degraded and limited thresholds, named on the trend chart and as values on a session chart', () => {
    expect(thresholdLines(THRESHOLDS, 'named').map(line => [line.y, line.label, line.labelAt, line.labelColor])).toEqual([
      [55, 'Degraded (55%)', 'start', '#d29922'],
      [85, 'Limited (85%)', 'start', '#f85149'],
    ]);
    expect(thresholdLines(THRESHOLDS, 'value').map(line => [line.y, line.label, line.labelAt])).toEqual([
      [55, '55%', 'end'],
      [85, '85%', 'end'],
    ]);
  });
});

describe('sessionChartGuides', () => {
  it('marks compactions with a solid red line and to-do events with dashed lines', () => {
    const events: Events = [
      { requestIndex: 2, type: 'compaction', label: 'Compaction 180K\u219240K' },
      { requestIndex: 1, type: 'todo-add', label: 'Add a parser for the new log format' },
      { requestIndex: 3, type: 'todo-progress', label: 'Add a parser for the new log format' },
      { requestIndex: 5, type: 'todo-complete', label: 'Add a parser for the new log format' },
    ];
    const { markers } = sessionChartGuides({ events, requestCount: 8 }, THRESHOLDS);
    expect(markers?.map(m => [m.x, m.color, m.dash, m.label])).toEqual([
      [2, '#f85149', [], 'Compaction 180K\u219240K'],
      [1, '#58a6ff', [4, 3], 'Add a parser for t\u2026'],
      [3, '#d29922', [4, 3], 'Add a parser for t\u2026'],
      [5, '#3fb950', [4, 3], 'Add a parser for t\u2026'],
    ]);
  });

  it('draws each to-do item in its own row, from the request that added it to the one that completed it, or to the last request', () => {
    const events: Events = [
      { requestIndex: 0, type: 'todo-add', label: 'Plan' },
      { requestIndex: 1, type: 'todo-add', label: 'Build' },
      { requestIndex: 2, type: 'todo-progress', label: 'Build' },
      { requestIndex: 3, type: 'todo-complete', label: 'Plan' },
      { requestIndex: 4, type: 'todo-complete', label: 'Ship' },
      { requestIndex: 4, type: 'compaction', label: 'Compaction' },
      { requestIndex: 5, type: 'todo-add', label: 'Plan' },
    ];
    const { bands } = sessionChartGuides({ events, requestCount: 7 }, THRESHOLDS);
    expect(bands?.map(b => [b.label, b.xMin, b.xMax, b.row, b.stroke])).toEqual([
      ['\u2714 Plan', 0, 3, 0, '#3fb95080'],
      ['\u25B6 Build', 1, 6, 1, '#d2992280'],
      ['\u2714 Ship', 0, 4, 2, '#3fb95080'],
    ]);
  });

  it('has only the thresholds for a session without events', () => {
    expect(sessionChartGuides({ events: [], requestCount: 3 }, THRESHOLDS)).toEqual({
      lines: thresholdLines(THRESHOLDS, 'value'),
      markers: [],
      bands: [],
    });
  });
});

describe('eventTooltipLines', () => {
  it('names every compaction and to-do event of the hovered request, in order', () => {
    const events: Events = [
      { requestIndex: 0, type: 'todo-add', label: 'Plan' },
      { requestIndex: 2, type: 'compaction', label: 'Compaction 180K\u219240K' },
      { requestIndex: 2, type: 'todo-complete', label: 'Plan' },
      { requestIndex: 2, type: 'todo-progress', label: 'Build' },
    ];
    expect(eventTooltipLines(events, 2)).toEqual(['Compaction 180K\u219240K', 'To-do completed: Plan', 'To-do started: Build']);
    expect(eventTooltipLines(events, 0)).toEqual(['To-do added: Plan']);
    expect(eventTooltipLines(events, 1)).toEqual([]);
  });
});
