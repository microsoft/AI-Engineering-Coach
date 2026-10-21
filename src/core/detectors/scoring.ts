/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { SessionRequest, PracticeGroup, AntiPattern, WeeklyPatternObservation } from '../types';
import { isoWeek } from '../helpers';

export const SEVERITY_PENALTIES: Readonly<Record<AntiPattern['severity'], number>> = { high: 12, medium: 7, low: 3 };

function promptQualityPenalty(request: SessionRequest): number {
  let penalty = 0;
  if (request.messageLength < 30 && request.messageLength > 0) penalty += 1;
  if (request.referencedFiles.length === 0 && !(request.variableKinds['file'] > 0) && request.editedFiles.length === 0) penalty += 0.5;
  return penalty;
}

function sessionHygienePenalty(request: SessionRequest): number {
  let penalty = 0;
  if (request.isCanceled) penalty += 1;
  if (request.timestamp !== null) {
    const when = new Date(request.timestamp);
    if (when.getHours() < 5) penalty += 0.3;
    const dayOfWeek = when.getDay();
    if (dayOfWeek === 0 || dayOfWeek === 6) penalty += 0.2;
  }
  return penalty;
}

function codeReviewPenalty(request: SessionRequest): number {
  return request.aiCode.length > 0 && request.totalElapsed != null && request.totalElapsed < 5000 ? 0.5 : 0;
}

function toolMasteryPenalty(request: SessionRequest): number {
  return request.toolsUsed.length === 0 && request.slashCommand === '' ? 0.3 : 0;
}

function requestPenalty(request: SessionRequest, group: PracticeGroup): number {
  if (group === 'prompt-quality') return promptQualityPenalty(request);
  if (group === 'session-hygiene') return sessionHygienePenalty(request);
  if (group === 'code-review') return codeReviewPenalty(request);
  if (group === 'tool-mastery') return toolMasteryPenalty(request);
  return 0;
}

function weekScore(weekRequests: SessionRequest[], group: PracticeGroup): number {
  const total = weekRequests.length;
  if (total === 0) return 100;
  const badCount = weekRequests.reduce((sum, request) => sum + requestPenalty(request, group), 0);
  const rate = badCount / total;
  return Math.max(0, Math.round(100 - rate * 100));
}

export function computeWeeklyTrend(reqs: SessionRequest[], observations: WeeklyPatternObservation[] = []): { labels: string[]; counts: number[] } {
  const weekCounts = new Map<string, number>();
  for (const r of reqs) {
    if (!r.timestamp) continue;
    const d = new Date(r.timestamp);
    const week = isoWeek(d);
    let count = 0;
    if (r.isCanceled) count++;
    if (r.messageLength < 30 && r.messageLength > 0) count++;
    if (r.referencedFiles.length === 0 && !(r.variableKinds['file'] > 0) && r.editedFiles.length === 0) count++;
    if (r.timestamp && new Date(r.timestamp).getHours() < 5) count++;
    const dow = new Date(r.timestamp).getDay();
    if (dow === 0 || dow === 6) count++;
    if (count > 0) weekCounts.set(week, (weekCounts.get(week) || 0) + count);
  }
  for (const row of observations) {
    if (row.occurrences > 0) weekCounts.set(row.week, (weekCounts.get(row.week) ?? 0) + row.occurrences);
  }
  const sortedWeeks = Array.from(weekCounts.keys()).sort();
  return {
    labels: sortedWeeks,
    counts: sortedWeeks.map(w => weekCounts.get(w) || 0),
  };
}

export function computeWeeklyScores(
  reqs: SessionRequest[],
  observations: WeeklyPatternObservation[] = [],
  detectorCounts: Partial<Record<PracticeGroup, number>> = {},
): { labels: string[]; series: { group: PracticeGroup; scores: number[] }[] } {
  const allGroups: PracticeGroup[] = ['prompt-quality', 'session-hygiene', 'code-review', 'tool-mastery'];
  const weekReqs = new Map<string, SessionRequest[]>();

  for (const r of reqs) {
    if (!r.timestamp) continue;
    const week = isoWeek(new Date(r.timestamp));
    if (!weekReqs.has(week)) weekReqs.set(week, []);
    weekReqs.get(week)!.push(r);
  }

  const sortedWeeks = Array.from(weekReqs.keys()).sort();
  const penalties = new Map<PracticeGroup, Map<string, number>>();
  for (const row of observations) {
    const weeks = penalties.get(row.group) ?? new Map<string, number>();
    weeks.set(row.week, (weeks.get(row.week) ?? 0) + SEVERITY_PENALTIES[row.severity]);
    penalties.set(row.group, weeks);
  }

  return {
    labels: sortedWeeks,
    series: allGroups.map(group => ({
      group,
      scores: sortedWeeks.map(w => {
        const penalty = penalties.get(group)?.get(w) ?? 0;
        const budget = (detectorCounts[group] || 8) * 12;
        return Math.max(0, Math.round(weekScore(weekReqs.get(w)!, group) - penalty * 100 / budget));
      }),
    })),
  };
}
