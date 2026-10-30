/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { activityCount, emptyActivityCounts, inquiryCount, type CuriosityActivity, type ActivityCounts } from '../core/curiosity-activity';
import type { CuriosityData, CuriositySession } from '../core/types/curiosity-types';

export const ACTIVITIES: { id: CuriosityActivity; label: string }[] = [
  { id: 'direct', label: 'Model knowledge inquiry' },
  { id: 'web', label: 'Web-grounded inquiry' },
  { id: 'repository', label: 'Program comprehension' },
  { id: 'action', label: 'Task execution' },
];

export interface ActivityBucket { from: string; to: string; counts: ActivityCounts; sessions: Record<CuriosityActivity, CuriositySession[]> }
export type ActivityInterval = 'daily' | 'weekly' | 'monthly';
export function elapsedLabel(ms: number): string {
  if (ms < 60_000) return '<1 min';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `~${minutes} min`;
  return `~${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`;
}
export function explorationShare(counts: ActivityCounts): number | null {
  const total = activityCount(counts);
  return total ? inquiryCount(counts) / total * 100 : null;
}
export function activityInterval(days: number): ActivityInterval {
  return days <= 14 ? 'daily' : days <= 90 ? 'weekly' : 'monthly';
}
export function comparisonPeriods(toDate: string) {
  const date = (offset: number) => {
    const value = new Date(`${toDate}T00:00:00Z`);
    value.setUTCDate(value.getUTCDate() + offset);
    return value.toISOString().slice(0, 10);
  };
  return ([{ days: 7, label: 'WoW' }, { days: 28, label: 'MoM' }] as const).map(({ days, label }) => ({
    label, current: { fromDate: date(1 - days), toDate },
    previous: { fromDate: date(1 - days * 2), toDate: date(-days) },
  }));
}
export function summaryCounts(data: CuriosityData) {
  return { sessions: data.sessionCounts.inquiry, inquiries: inquiryCount(data.counts), followups: data.chains.total };
}
export function percentageChange(current: number, previous: number): number | null {
  return previous ? Math.round((current - previous) / previous * 100) : current ? null : 0;
}
export function activityBuckets(daily: CuriosityData['daily'], interval: ActivityInterval): ActivityBucket[] {
  const buckets = new Map<string, ActivityBucket>();
  for (const day of daily) {
    const date = new Date(`${day.date}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
    const key = interval === 'weekly' ? date.toISOString().slice(0, 10)
      : interval === 'monthly' ? day.date.slice(0, 7) : day.date;
    const bucket = buckets.get(key) ?? { from: day.date, to: day.date, counts: emptyActivityCounts(),
      sessions: { direct: [], web: [], repository: [], action: [] } };
    bucket.to = day.date;
    for (const { id } of ACTIVITIES) {
      bucket.counts[id] += day.counts[id];
      const sessions = [...bucket.sessions[id], ...day.sessions?.[id] ?? []];
      bucket.sessions[id] = [...new Map(sessions.sort((a, b) => a.timestamp - b.timestamp)
        .map(session => [JSON.stringify([session.harness, session.workspace, session.sessionId]), session])).values()]
        .sort((a, b) => b.timestamp - a.timestamp).slice(0, 8);
    }
    buckets.set(key, bucket);
  }
  return [...buckets.values()];
}
