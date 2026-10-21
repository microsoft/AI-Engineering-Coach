/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { emptyActivityCounts } from '../core/curiosity-activity';
import { CuriosityAnalyzer } from '../core/analyzer-curiosity';
import { ACTIVITIES, activityBuckets, activityInterval, comparisonPeriods, elapsedLabel, explorationShare, percentageChange, summaryCounts } from './curiosity-charts';

describe('Curiosity labels', () => {
  it('renames model and web inquiry without changing activity identities', () => {
    expect(ACTIVITIES.map(({ id, label }) => [id, label])).toEqual([
      ['direct', 'Model knowledge inquiry'], ['web', 'Web-grounded inquiry'],
      ['repository', 'Program comprehension'], ['action', 'Task execution'],
    ]);
  });

  it('formats approximate recorded spans without presenting sub-minute timing as zero', () => {
    expect([1, 59_999, 60_000, 90_000, 3_570_000, 3_600_000, 5_400_000, 86_400_000].map(elapsedLabel))
      .toEqual(['<1 min', '<1 min', '~1 min', '~2 min', '~1 h', '~1 h', '~1 h 30 min', '~24 h']);
  });
});

describe('Curiosity chart geometry', () => {
  it('groups ISO weeks without hiding partial-week boundaries or cross-year dates', () => {
    const daily = ['2025-12-31', '2026-01-01', '2026-01-04', '2026-01-05'].map(date => ({
      date, counts: { ...emptyActivityCounts(), direct: 1, action: 2 },
    }));
    expect(activityBuckets(daily, 'weekly')).toMatchObject([
      { from: '2025-12-31', to: '2026-01-04', counts: { direct: 3, web: 0, repository: 0, action: 6 } },
      { from: '2026-01-05', to: '2026-01-05', counts: { direct: 1, web: 0, repository: 0, action: 2 } },
    ]);
    expect(activityBuckets(daily, 'daily')).toHaveLength(4);
  });

  it('merges weekly hover names by session identity and keeps the most recent date', () => {
    const old = { sessionId: 's', requestId: 'r', workspaceId: 'project', name: 'Explain the cache',
      promptPreview: 'Explain the cache', promptTruncated: false, date: '2026-09-28',
      timestamp: 1, workspace: 'project', harness: 'Local Agent' };
    const names = { direct: [old], web: [], repository: [], action: [] };
    const bucket = activityBuckets([
      { date: old.date, counts: { ...emptyActivityCounts(), direct: 2 }, sessions: names },
      { date: '2026-09-30', counts: { ...emptyActivityCounts(), direct: 1 },
        sessions: { ...names, direct: [{ ...old, date: '2026-09-30', timestamp: 2 }] } },
    ], 'weekly')[0];
    expect(bucket.counts.direct).toBe(3);
    expect(bucket.sessions.direct).toMatchObject([{ sessionId: 's', date: '2026-09-30', timestamp: 2 }]);
    expect(bucket.sessions.direct).toHaveLength(1);
    const many = activityBuckets([{ date: old.date, counts: { ...emptyActivityCounts(), direct: 12 },
      sessions: { ...names, direct: Array.from({ length: 12 }, (_, index) => ({
        ...old, sessionId: `session-${index}`, timestamp: index,
      })) } }], 'weekly')[0];
    expect(many.sessions.direct).toHaveLength(8);
    expect(many.sessions.direct.map(session => session.timestamp)).toEqual([11, 10, 9, 8, 7, 6, 5, 4]);
  });

  it('selects intervals at the exact range boundaries', () => {
    expect([0, 7, 14, 15, 28, 90, 91, 180, 365].map(activityInterval))
      .toEqual(['daily', 'daily', 'daily', 'weekly', 'weekly', 'weekly', 'monthly', 'monthly', 'monthly']);
  });

  it('groups calendar months with partial boundaries across leap days and years', () => {
    const daily = ['2023-12-31', '2024-01-01', '2024-02-28', '2024-02-29', '2024-03-01'].map(date => ({
      date, counts: { ...emptyActivityCounts(), direct: 1, action: 2 },
    }));
    expect(activityBuckets(daily, 'monthly')).toMatchObject([
      { from: '2023-12-31', to: '2023-12-31', counts: { direct: 1, action: 2 } },
      { from: '2024-01-01', to: '2024-01-01', counts: { direct: 1, action: 2 } },
      { from: '2024-02-28', to: '2024-02-29', counts: { direct: 2, action: 4 } },
      { from: '2024-03-01', to: '2024-03-01', counts: { direct: 1, action: 2 } },
    ]);
    expect(activityBuckets(daily, 'monthly').reduce((total, bucket) => total + bucket.counts.direct, 0)).toBe(5);
  });

  it('includes every inquiry category and counts Task execution in the share denominator', () => {
    expect(explorationShare({ direct: 1, web: 2, repository: 3, action: 18 })).toBe(25);
    expect(explorationShare({ direct: 0, web: 0, repository: 0, action: 3 })).toBe(0);
    expect(explorationShare({ direct: 1, web: 2, repository: 3, action: 0 })).toBe(100);
    expect(explorationShare(emptyActivityCounts())).toBeNull();
  });

  it('uses aggregated turn counts rather than averaging daily ratios and leaves empty periods undefined', () => {
    const daily = [
      { date: '2026-09-28', counts: { direct: 1, web: 0, repository: 0, action: 0 } },
      { date: '2026-09-29', counts: { direct: 0, web: 1, repository: 0, action: 8 } },
      { date: '2026-09-30', counts: emptyActivityCounts() },
      { date: '2026-10-05', counts: emptyActivityCounts() },
    ];
    expect(activityBuckets(daily, 'daily').map(bucket => explorationShare(bucket.counts))).toEqual([100, 100 / 9, null, null]);
    expect(activityBuckets(daily, 'weekly').map(bucket => explorationShare(bucket.counts))).toEqual([20, null]);
    expect(activityBuckets(daily, 'monthly').map(bucket => explorationShare(bucket.counts))).toEqual([20, null]);
  });
});

describe('Curiosity summary comparisons', () => {
  it('uses equal, adjacent calendar-day comparison windows across month and year boundaries', () => {
    expect(comparisonPeriods('2026-09-30')).toEqual([
      { label: 'WoW', current: { fromDate: '2026-09-24', toDate: '2026-09-30' },
        previous: { fromDate: '2026-09-17', toDate: '2026-09-23' } },
      { label: 'MoM', current: { fromDate: '2026-09-03', toDate: '2026-09-30' },
        previous: { fromDate: '2026-08-06', toDate: '2026-09-02' } },
    ]);
    for (const date of ['2024-03-01', '2026-01-01', '2026-03-08', '2026-11-01']) {
      for (const period of comparisonPeriods(date)) {
        const days = period.label === 'WoW' ? 7 : 28;
        expect((Date.parse(period.current.toDate) - Date.parse(period.current.fromDate)) / 86_400_000 + 1).toBe(days);
        expect((Date.parse(period.previous.toDate) - Date.parse(period.previous.fromDate)) / 86_400_000 + 1).toBe(days);
        expect(Date.parse(period.current.fromDate) - Date.parse(period.previous.toDate)).toBe(86_400_000);
      }
    }
  });

  it('reads exact summary totals, not bounded names or per-day session sums', () => {
    const data = new CuriosityAnalyzer([], new Map()).getCuriosity();
    data.counts = { direct: 50, web: 20, repository: 30, action: 80 };
    data.sessionCounts.inquiry = 25;
    data.chains.total = 15;
    expect(summaryCounts(data)).toEqual({ sessions: 25, inquiries: 100, followups: 15 });
    expect(data.daily).toHaveLength(0);
    expect(data.chains.examples).toHaveLength(0);
  });

  it('rounds count changes and does not invent percentages from zero', () => {
    expect(percentageChange(6, 4)).toBe(50);
    expect(percentageChange(1, 3)).toBe(-67);
    expect(percentageChange(0, 8)).toBe(-100);
    expect(percentageChange(8, 8)).toBe(0);
    expect(percentageChange(0, 0)).toBe(0);
    expect(percentageChange(8, 0)).toBeNull();
  });
});
