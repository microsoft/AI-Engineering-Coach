/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* MCP formatters say which turns their time-based measures count. */

import { describe, it, expect } from 'vitest';
import { Analyzer } from '../core/analyzer';
import { createRequest, createSession } from '../core/parser-shared';
import type { NonHumanKind, Session } from '../core/types';
import { formatActivity, formatFlow, formatInsights, formatWellbeing } from './formatters';

const NOON = new Date(2026, 0, 14, 12).getTime();
const NEXT_NIGHT = new Date(2026, 0, 15, 2).getTime();

function session(turns: Array<[number, NonHumanKind?]>): Session {
  return createSession({
    sessionId: 's', workspaceId: 'ws', workspaceName: 'Project', harness: 'GitHub Copilot App',
    requests: turns.map(([timestamp, nonHumanKind], index) => createRequest({
      requestId: `r${index}`, timestamp, messageText: 'Refactor the parser', responseText: '', nonHumanKind,
    })),
  });
}

describe('MCP formatters', () => {
  const analyzer = new Analyzer([session([[NOON], [NOON + 60_000, 'agent'], [NEXT_NIGHT, 'autopilot']])], new Map());
  const basis = { counts: 'prompts the user typed', typedPrompts: 1, automatedTurnsLeftOut: 2 };

  it('activity: recent days count typed prompts, and the volume counts every turn', () => {
    const activity = formatActivity(analyzer);
    expect(activity.summary.totalRequests).toBe(3);
    expect(activity.recentDays).toEqual([{ date: '2026-01-14', requests: 1, focusScore: 100 }]);
    expect(activity.recentDaysBasis).toEqual(basis);
  });

  it('flow: peak hours count typed prompts', () => {
    const flow = formatFlow(analyzer);
    expect(flow.basis).toEqual(basis);
    expect(flow.peakActivityHours).toEqual([{ hour: '12:00', totalRequests: 1 }]);
  });

  it('wellbeing and sustainable pace: say they count typed prompts', () => {
    const wellbeing = formatWellbeing(analyzer);
    expect(wellbeing).toMatchObject({ basis, workLifeBalance: { timeDistribution: { lateNight: 0, workHours: 1 } } });
    expect(formatInsights(analyzer).sustainablePace.counts).toBe('prompts the user typed');
  });

  it('wellbeing: has no data when the user typed no prompt in range', () => {
    const automatedOnly = new Analyzer([session([[NEXT_NIGHT, 'autopilot']])], new Map());
    expect(formatWellbeing(automatedOnly)).toMatchObject({ status: 'no-data' });
  });
});
