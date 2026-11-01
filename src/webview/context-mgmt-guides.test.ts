/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Guides on Context Management's utilization charts: thresholds, compaction and to-do markers, to-do bands, and
 * the tooltip lines that name each request's events. */

import { describe, expect, it, vi } from 'vitest';
import type { ContextVerdictThresholds, SessionContextDetail, TodoItem } from '../core/types';
import { Analyzer } from '../core/analyzer';
import { createRequest, createSession } from '../core/parser-shared';

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
      // Added again after it was completed: a new lifetime, still open.
      ['Plan', 5, 6, 3, '#58a6ff80'],
    ]);
  });
});

describe('sessionChartGuides to-do lifetimes', () => {
  it('starts a new lifetime when a completed to-do is put back in progress, and ignores a repeated completion', () => {
    const events: Events = [
      { requestIndex: 1, type: 'todo-add', label: 'Fix' },
      { requestIndex: 3, type: 'todo-progress', label: 'Fix' },
      { requestIndex: 5, type: 'todo-complete', label: 'Fix' },
      { requestIndex: 7, type: 'todo-progress', label: 'Fix' },
      { requestIndex: 9, type: 'todo-complete', label: 'Fix' },
      { requestIndex: 10, type: 'todo-complete', label: 'Fix' },
      { requestIndex: 10, type: 'todo-progress', label: 'Unknown' },
    ];
    const { bands } = sessionChartGuides({ events, requestCount: 12 }, THRESHOLDS);
    expect(bands?.map(b => [b.label, b.xMin, b.xMax, b.row])).toEqual([
      ['\u2714 Fix', 1, 5, 0],
      ['\u2714 Fix', 7, 9, 1],
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

describe('sessionChartGuides to-dos a snapshot first shows in progress or completed', () => {
  it('starts an item first shown in progress there, and ends one first shown completed there', () => {
    const events: Events = [
      { requestIndex: 2, type: 'todo-add', label: 'Plan', status: 'completed' },
      { requestIndex: 2, type: 'todo-add', label: 'Build', status: 'in-progress' },
      { requestIndex: 2, type: 'todo-add', label: 'Ship' },
      { requestIndex: 5, type: 'todo-add', label: 'Review', status: 'completed' },
      { requestIndex: 6, type: 'todo-progress', label: 'Review' },
    ];
    const { bands, markers } = sessionChartGuides({ events, requestCount: 8 }, THRESHOLDS);
    expect(bands?.map(b => [b.label, b.xMin, b.xMax, b.row, b.stroke])).toEqual([
      ['\u2714 Plan', 2, 2, 0, '#3fb95080'],
      ['\u25B6 Build', 2, 7, 1, '#d2992280'],
      ['Ship', 2, 7, 2, '#58a6ff80'],
      ['\u2714 Review', 5, 5, 3, '#3fb95080'],
      // Put back in progress after it was shown completed: a new lifetime.
      ['\u25B6 Review', 6, 7, 4, '#d2992280'],
    ]);
    // The markers still show each addition alone.
    expect(markers?.map(m => [m.x, m.color])).toEqual([[2, '#58a6ff'], [2, '#58a6ff'], [2, '#58a6ff'], [5, '#58a6ff'], [6, '#d29922']]);
  });

  it('come out of the analyzer from VS Code\u2019s to-do list snapshots, still one addition per item', () => {
    const todo = (id: number, title: string, status: TodoItem['status']): TodoItem => ({ id, title, status });
    const request = (n: number, todoSnapshot: TodoItem[] | null) => createRequest({
      requestId: `r${n}`, messageText: 'm', responseText: 'r', timestamp: Date.UTC(2026, 9, 28, 10, n), promptTokens: 10_000, completionTokens: 100, todoSnapshot,
    });
    const session = createSession({
      sessionId: 's', workspaceId: 'ws', workspaceName: 'ws', harness: 'VS Code', requests: [
        request(0, null),
        request(1, [todo(1, 'Plan', 'completed'), todo(2, 'Build', 'in-progress'), todo(3, 'Ship', 'not-started')]),
        request(2, [todo(1, 'Plan', 'completed'), todo(2, 'Build', 'completed'), todo(3, 'Ship', 'not-started'), todo(4, 'Review', 'completed')]),
        request(3, null),
      ],
    });
    const [row] = new Analyzer([session]).getWorkspaceContextSessions('ws').sessions;
    // Markers, tooltips and the to-do counts read these: one addition per item, as before.
    expect(row.events.map(e => [e.requestIndex, e.type, e.label])).toEqual([
      [1, 'todo-add', 'Plan'], [1, 'todo-add', 'Build'], [1, 'todo-add', 'Ship'], [2, 'todo-complete', 'Build'], [2, 'todo-add', 'Review'],
    ]);
    expect(sessionChartGuides(row, THRESHOLDS).bands?.map(b => [b.label, b.xMin, b.xMax])).toEqual([
      ['\u2714 Plan', 1, 1], ['\u2714 Build', 1, 2], ['Ship', 1, 3], ['\u2714 Review', 2, 2],
    ]);
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
