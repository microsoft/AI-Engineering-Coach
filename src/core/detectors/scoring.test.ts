/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect } from 'vitest';
import { createRequest } from '../parser-shared';
import type { NonHumanKind, SessionRequest } from '../types';
import { computeWeeklyScores, computeWeeklyTrend } from './scoring';

const SATURDAY_2AM = new Date(2026, 0, 17, 2).getTime();

/** A request at 2 AM on a Saturday that no other trend or score check flags. */
function request(nonHumanKind?: NonHumanKind, extra: Partial<SessionRequest> = {}): SessionRequest {
  return createRequest({
    timestamp: SATURDAY_2AM,
    messageText: 'Refactor the parser so it streams events instead of buffering the file',
    responseText: '',
    referencedFiles: ['src/parser.ts'],
    nonHumanKind,
    ...extra,
  });
}

const hygieneScores = (reqs: SessionRequest[]) =>
  computeWeeklyScores(reqs).series.find(series => series.group === 'session-hygiene')?.scores;

describe('late-night and weekend penalties count only typed prompts', () => {
  it('adds them to the weekly anti-pattern trend for a typed prompt only', () => {
    expect(computeWeeklyTrend([request()]).counts).toEqual([2]);
    expect(computeWeeklyTrend([request('autopilot')])).toEqual({ labels: [], counts: [] });
  });

  it('lowers the session-hygiene score for a typed prompt only', () => {
    expect(hygieneScores([request()])).toEqual([50]);
    expect(hygieneScores([request('agent')])).toEqual([100]);
  });

  it('still counts a canceled automated turn', () => {
    expect(computeWeeklyTrend([request('autopilot', { isCanceled: true })]).counts).toEqual([1]);
    expect(hygieneScores([request('autopilot', { isCanceled: true })])).toEqual([0]);
  });
});
