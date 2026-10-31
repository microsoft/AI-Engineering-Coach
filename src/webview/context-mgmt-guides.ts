/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Guides on Context Management's utilization charts: the degraded and limited thresholds, a session's
 * compaction and to-do events, and each to-do item's lifetime as a band along the bottom. */

import type { ContextVerdictThresholds, SessionContextDetail, SessionTimelineEvent } from '../core/types';
import { COLORS } from './shared';
import type { ChartGuides, GuideBand, GuideLine, GuideMarker } from './chart-guides';

/** Dashed lines at the degraded and limited thresholds: named at the start of the line (trend chart), or just
 *  the value at its end (session chart). */
export function thresholdLines(thresholds: ContextVerdictThresholds, style: 'named' | 'value'): GuideLine[] {
  const named = style === 'named';
  return [
    {
      y: thresholds.optimalUtilization, color: named ? 'rgba(210,153,34,0.5)' : 'rgba(210,153,34,0.4)', labelColor: COLORS.yellow, dash: [6, 4],
      label: named ? `Degraded (${thresholds.optimalUtilization}%)` : `${thresholds.optimalUtilization}%`, labelAt: named ? 'start' : 'end',
    },
    {
      y: thresholds.limitedUtilization, color: named ? 'rgba(248,81,73,0.5)' : 'rgba(248,81,73,0.4)', labelColor: COLORS.red, dash: [6, 4],
      label: named ? `Limited (${thresholds.limitedUtilization}%)` : `${thresholds.limitedUtilization}%`, labelAt: named ? 'start' : 'end',
    },
  ];
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 2) + '\u2026' : text;
}

function eventMarker(event: SessionTimelineEvent): GuideMarker {
  const color = event.type === 'compaction' ? COLORS.red
    : event.type === 'todo-complete' ? COLORS.green
      : event.type === 'todo-progress' ? COLORS.yellow
        : COLORS.blue;
  return {
    x: event.requestIndex,
    color,
    dash: event.type === 'compaction' ? [] : [4, 3],
    label: truncate(event.label, 20),
  };
}

interface TodoLife { title: string; addedAt: number; startedAt: number | null; completedAt: number | null }

/** Each to-do item's lifetime, from the request that added it to the one that completed it. */
function todoLives(events: SessionTimelineEvent[]): TodoLife[] {
  const items: TodoLife[] = [];
  const byTitle = new Map<string, TodoLife>();
  for (const event of events) {
    if (event.type === 'compaction') continue;
    const title = event.label;
    const item = byTitle.get(title);
    if (event.type === 'todo-add') {
      if (item) continue;
      const added: TodoLife = { title, addedAt: event.requestIndex, startedAt: null, completedAt: null };
      items.push(added);
      byTitle.set(title, added);
    } else if (event.type === 'todo-progress') {
      if (item && item.startedAt == null) item.startedAt = event.requestIndex;
    } else if (event.type === 'todo-complete') {
      if (item) item.completedAt = event.requestIndex;
      else {
        const completed: TodoLife = { title, addedAt: 0, startedAt: null, completedAt: event.requestIndex };
        items.push(completed);
        byTitle.set(title, completed);
      }
    }
  }
  return items;
}

function todoBand(item: TodoLife, row: number, requestCount: number): GuideBand {
  const color = item.completedAt != null ? COLORS.green : item.startedAt != null ? COLORS.yellow : COLORS.blue;
  const state = item.completedAt != null ? '\u2714 ' : item.startedAt != null ? '\u25B6 ' : '';
  return {
    xMin: item.addedAt,
    xMax: item.completedAt ?? Math.max(0, requestCount - 1),
    row,
    fill: color + '30',
    stroke: color + '80',
    label: state + truncate(item.title, 30),
    labelColor: color,
  };
}

/** Guides of a session's per-request utilization chart. */
export function sessionChartGuides(s: Pick<SessionContextDetail, 'events' | 'requestCount'>, thresholds: ContextVerdictThresholds): ChartGuides {
  return {
    lines: thresholdLines(thresholds, 'value'),
    markers: s.events.map(eventMarker),
    bands: todoLives(s.events).map((item, row) => todoBand(item, row, s.requestCount)),
  };
}

const TODO_EVENT_NAMES: Record<Exclude<SessionTimelineEvent['type'], 'compaction'>, string> = {
  'todo-add': 'To-do added',
  'todo-progress': 'To-do started',
  'todo-complete': 'To-do completed',
};

/** Tooltip lines naming the compactions and to-do events of one request; the chart only labels a few markers. */
export function eventTooltipLines(events: SessionTimelineEvent[], requestIndex: number): string[] {
  return events
    .filter(event => event.requestIndex === requestIndex)
    .map(event => (event.type === 'compaction' ? event.label : `${TODO_EVENT_NAMES[event.type]}: ${event.label}`));
}
