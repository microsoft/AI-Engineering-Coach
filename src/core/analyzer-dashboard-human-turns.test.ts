/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Activity Patterns' work hours, hours and calendar count only the prompts the user typed; daily volume counts every turn. */

import { describe, it, expect } from 'vitest';
import { DashboardAnalyzer } from './analyzer-dashboard';
import { createRequest, createSession } from './parser-shared';
import type { NonHumanKind, WorkType } from './types';

const FRIDAY_2PM = new Date('2024-03-15T14:00:00').getTime();
const SATURDAY_2AM = new Date('2024-03-16T02:00:00').getTime();

function analyzer(): DashboardAnalyzer {
  const turns: Array<[number, WorkType, NonHumanKind?]> = [
    [FRIDAY_2PM, 'feature'],
    [FRIDAY_2PM + 60_000, 'feature', 'agent'],
    [SATURDAY_2AM, 'other', 'autopilot'],
    [SATURDAY_2AM + 60_000, 'other', 'autopilot'],
  ];
  const requests = turns.map(([timestamp, workType, nonHumanKind]) =>
    createRequest({ timestamp, workType, nonHumanKind, messageText: 'Refactor the parser', responseText: '' }));
  return new DashboardAnalyzer([createSession({ sessionId: 's', workspaceId: 'ws', workspaceName: 'Project', harness: 'GitHub Copilot App', requests })], new Map());
}

const BASIS = { humanTurns: 1, automatedTurns: 3, automatedByKind: { agent: 1, autopilot: 2 } };
const sum = (grid: number[][]) => grid.flat().reduce((a, b) => a + b, 0);

describe('DashboardAnalyzer — prompts the user typed', () => {
  it('counts only typed prompts in the work-hours heatmaps, and reports the turns it left out', () => {
    const heatmap = analyzer().getHeatmap();
    expect([sum(heatmap.heatmap), heatmap.heatmap[5][14], heatmap.heatmap[6][2], sum(heatmap.byType.feature)]).toEqual([1, 1, 0, 1]);
    expect(heatmap.focusHeatmap.flat().filter(value => value > 0)).toHaveLength(1);
    expect(heatmap.turnBasis).toEqual(BASIS);
  });

  it('counts only typed prompts by hour', () => {
    const hourly = analyzer().getHourlyDistribution();
    expect([hourly.hours[14], hourly.hours[2], hourly.byType.feature[14]]).toEqual([1, 0, 1]);
  });

  it('leaves days with only automated turns off the calendar', () => {
    const calendar = analyzer().getCalendarActivity();
    expect(calendar.days.map(day => [day.date, day.requests])).toEqual([['2024-03-15', 1]]);
    expect(calendar.maxRequests).toBe(1);
    expect(calendar.turnBasis).toEqual(BASIS);
  });

  it('keeps every turn in the daily volume, which counts output rather than working time', () => {
    expect(analyzer().getDailyActivity().values.reduce((a, b) => a + b, 0)).toBe(4);
  });
});
