/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Dashboard analytics -- daily activity, workspace breakdown, harness breakdown */

import { DateFilter, DailyActivity, WorkspaceBreakdown, WORK_TYPES, HarnessComparisonData, HarnessComparisonItem, StatsResult, CalendarActivityData, CalendarDay, Session, SessionRequest, ParserCoverageData, ParserPreviewData, ParserPreviewSample, FieldMeta, FieldCategory, HourlyDistribution, HeatmapData  } from './types';
import { toDateStr, classifyWorkType } from './helpers';
import { AnalyzerBase } from './analyzer-base';

/* ── Parser coverage field metadata ───────────────────────────────── */

function fm(name: string, label: string, category: FieldCategory): FieldMeta { return { name, label, category }; }

const PARSER_FIELDS: FieldMeta[] = [
  fm('requestId',          'Request ID',           'core'),
  fm('timestamp',          'Timestamp',            'core'),
  fm('messageText',        'Message Text',         'core'),
  fm('responseText',       'Response Text',        'core'),
  fm('isCanceled',         'Canceled',             'enrichment'),
  fm('agentName',          'Agent Name',           'enrichment'),
  fm('agentMode',          'Agent Mode',           'enrichment'),
  fm('modelId',            'Model ID',             'enrichment'),
  fm('toolsUsed',          'Tools Used',           'enrichment'),
  fm('editedFiles',        'Edited Files',         'enrichment'),
  fm('referencedFiles',    'Referenced Files',      'enrichment'),
  fm('slashCommand',       'Slash Command',        'enrichment'),
  fm('variableKinds',      'Variable Kinds',       'enrichment'),
  fm('customInstructions', 'Custom Instructions',  'enrichment'),
  fm('skillsUsed',         'Skills Used',          'enrichment'),
  fm('firstProgress',      'First Progress',       'enrichment'),
  fm('totalElapsed',       'Total Elapsed',        'enrichment'),
  fm('toolConfirmations',  'Tool Confirmations',   'enrichment'),
  fm('promptTokens',       'Prompt Tokens',        'enrichment'),
  fm('completionTokens',   'Completion Tokens',    'enrichment'),
  fm('reasoningEffort',    'Reasoning Effort',     'enrichment'),
  fm('compaction',         'Compaction',           'enrichment'),
  fm('todoSnapshot',       'Todo Snapshot',        'enrichment'),
  fm('messageLength',      'Message Length',        'auto-computed'),
  fm('responseLength',     'Response Length',       'auto-computed'),
  fm('userCode',           'User Code Blocks',     'auto-computed'),
  fm('aiCode',             'AI Code Blocks',       'auto-computed'),
  fm('workType',           'Work Type',            'auto-computed'),
];

function isFieldPopulated(r: SessionRequest, field: string): boolean {
  const v = (r as unknown as Record<string, unknown>)[field];
  if (v == null) return false;
  if (typeof v === 'string') return v.length > 0;
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'boolean') return true;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return false;
}

function stringifyFieldValue(r: SessionRequest, field: string): string {
  const v = (r as unknown as Record<string, unknown>)[field];
  if (v == null) return '—';
  if (typeof v === 'string') return v.length > 80 ? v.slice(0, 77) + '…' : v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'bigint' || typeof v === 'symbol') return v.toString();
  if (typeof v === 'function') return v.name ? `[Function ${v.name}]` : '[Function]';
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    const items = v.slice(0, 4).map(i => typeof i === 'string' ? i : JSON.stringify(i));
    return `[${items.join(', ')}${v.length > 4 ? `, …+${v.length - 4}` : ''}]`;
  }
  if (typeof v === 'object') {
    const keys = Object.keys(v);
    if (keys.length === 0) return '{}';
    return `{${keys.slice(0, 3).join(', ')}${keys.length > 3 ? `, …+${keys.length - 3}` : ''}}`;
  }
  return '—';
}

function makeHourBuckets(): number[] {
  return Array<number>(24).fill(0);
}

function makeWeekHourGrid(): number[][] {
  return Array.from({ length: 7 }, () => makeHourBuckets());
}

export class DashboardAnalyzer extends AnalyzerBase {

  getStats(f?: DateFilter): StatsResult {
    const sessions = this.filteredSessions(f);
    return {
      totalSessions: sessions.length,
      totalWorkspaces: new Set(sessions.map(s => s.workspaceName)).size,
      totalRequests: sessions.reduce((s, sess) => s + sess.requestCount, 0),
    };
  }

  getWorkspaces(): { id: string; name: string; recent?: boolean; harnesses?: string[] }[] {
    const lastActivity = new Map<string, number>();
    const workspaces = new Map<string, { id: string; name: string }>();
    const wsHarnesses = new Map<string, Set<string>>();
    for (const s of this.sessions) {
      const key = s.workspaceName;
      if (!workspaces.has(key)) {
        workspaces.set(key, { id: key, name: s.workspaceName });
        wsHarnesses.set(key, new Set());
      }
      wsHarnesses.get(key)!.add(s.harness);
      for (const r of s.requests) {
        const ts = r.timestamp;
        if (ts != null && ts > (lastActivity.get(key) || 0)) {
          lastActivity.set(key, ts);
        }
      }
    }

    const all = Array.from(workspaces.values());

    // Top 5 by most recent activity
    const recentIds = new Set(
      [...all]
        .filter(w => lastActivity.has(w.id))
        .sort((a, b) => (lastActivity.get(b.id) || 0) - (lastActivity.get(a.id) || 0))
        .slice(0, 5)
        .map(w => w.id),
    );

    // Recent first (by activity desc), then all alphabetically
    const recent = all
      .filter(w => recentIds.has(w.id))
      .sort((a, b) => (lastActivity.get(b.id) || 0) - (lastActivity.get(a.id) || 0))
      .map(w => ({ ...w, recent: true, harnesses: [...(wsHarnesses.get(w.id) || [])] }));
    const rest = all
      .filter(w => !recentIds.has(w.id))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(w => ({ ...w, harnesses: [...(wsHarnesses.get(w.id) || [])] }));

    return [...recent, ...rest];
  }

  getHarnesses(): string[] {
    const ides = new Set<string>();
    for (const s of this.sessions) ides.add(s.harness);
    return Array.from(ides).sort();
  }

  getHarnessBreakdown(f?: DateFilter): { labels: string[]; sessions: number[]; requests: number[] } {
    const sessMap = new Map<string, number>();
    const reqMap = new Map<string, number>();
    for (const s of this.filteredSessions(f)) {
      sessMap.set(s.harness, (sessMap.get(s.harness) || 0) + 1);
      reqMap.set(s.harness, (reqMap.get(s.harness) || 0) + s.requests.length);
    }
    const sorted = Array.from(sessMap.entries()).sort((a, b) => b[1] - a[1]);
    return {
      labels: sorted.map(([l]) => l),
      sessions: sorted.map(([l]) => sessMap.get(l) || 0),
      requests: sorted.map(([l]) => reqMap.get(l) || 0),
    };
  }

  getDailyActivity(f?: DateFilter): DailyActivity {
    const reqs = this.filter(f);
    interface DayEntry {
      count: number; loc: number;
      sessionIds: Set<string>; workspaceNames: Set<string>;
      harnessReqs: Map<string, number>;
      harnessSessions: Map<string, Set<string>>;
      harnessLoc: Map<string, number>;
    }
    const dayMap = new Map<string, DayEntry>();
    const allHarnesses = new Set<string>();

    for (const r of reqs) {
      const d = toDateStr(r.timestamp!);
      let e = dayMap.get(d);
      if (!e) {
        e = {
          count: 0, loc: 0,
          sessionIds: new Set(), workspaceNames: new Set(),
          harnessReqs: new Map(), harnessSessions: new Map(), harnessLoc: new Map(),
        };
        dayMap.set(d, e);
      }
      e.count++;
      const rLoc = this.requestLoc(r);
      e.loc += rLoc;
      const session = this.requestSessionMap.get(r);
      const harness = session?.harness || 'Unknown';
      allHarnesses.add(harness);
      if (session) {
        e.sessionIds.add(session.sessionId);
        e.workspaceNames.add(session.workspaceName);
      }
      e.harnessReqs.set(harness, (e.harnessReqs.get(harness) || 0) + 1);
      if (!e.harnessSessions.has(harness)) e.harnessSessions.set(harness, new Set());
      if (session) e.harnessSessions.get(harness)!.add(session.sessionId);
      e.harnessLoc.set(harness, (e.harnessLoc.get(harness) || 0) + rLoc);
    }

    const sorted = Array.from(dayMap.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    const harnesses = Array.from(allHarnesses).sort();

    return {
      labels: sorted.map(([d]) => d),
      values: sorted.map(([, v]) => v.count),
      loc: sorted.map(([, v]) => v.loc),
      sessions: sorted.map(([, v]) => v.sessionIds.size),
      workspaces: sorted.map(([, v]) => v.workspaceNames.size),
      byHarness: harnesses.map(h => ({
        harness: h,
        requests: sorted.map(([, v]) => v.harnessReqs.get(h) || 0),
        sessions: sorted.map(([, v]) => v.harnessSessions.get(h)?.size || 0),
        loc: sorted.map(([, v]) => v.harnessLoc.get(h) || 0),
      })),
    };
  }

  getWorkspaceBreakdown(f?: DateFilter): WorkspaceBreakdown {
    const reqs = this.filter(f);
    const wsCount = new Map<string, number>();
    for (const r of reqs) {
      const session = this.requestSessionMap.get(r);
      if (session) {
        wsCount.set(session.workspaceName, (wsCount.get(session.workspaceName) || 0) + 1);
      }
    }
    const sorted = Array.from(wsCount.entries()).sort((a, b) => b[1] - a[1]).slice(0, 20);
    return { labels: sorted.map(([l]) => l), values: sorted.map(([, v]) => v) };
  }

  /** Hours the user typed prompts in, by work type (automated turns are left out). */
  getHourlyDistribution(f?: DateFilter): HourlyDistribution {
    const reqs = this.humanFilter(f).reqs;
    const hours = makeHourBuckets();
    const byType: Record<string, number[]> = {};
    for (const wt of WORK_TYPES) byType[wt] = makeHourBuckets();
    for (const r of reqs) {
      const h = new Date(r.timestamp!).getHours();
      hours[h]++;
      const wt = r.workType || classifyWorkType(r.messageText);
      byType[wt][h]++;
    }
    return { hours, byType };
  }

  /** When in the week the user typed prompts; automated turns are left out and counted in `turnBasis`. */
  getHeatmap(f?: DateFilter): HeatmapData {
    const { reqs, basis } = this.humanFilter(f);
    const heatmap = makeWeekHourGrid();
    const byType: Record<string, number[][]> = {};
    for (const wt of WORK_TYPES) byType[wt] = makeWeekHourGrid();
    for (const r of reqs) {
      const d = new Date(r.timestamp!);
      const dow = d.getDay();
      const h = d.getHours();
      heatmap[dow][h]++;
      const wt = r.workType || classifyWorkType(r.messageText);
      byType[wt][dow][h]++;
    }
    const focusHeatmap = computeFocusHeatmap(reqs);
    return { heatmap, byType, focusHeatmap, turnBasis: basis };
  }

  /** Days the user typed prompts on; automated turns are left out and counted in `turnBasis`. */
  getCalendarActivity(f?: DateFilter): CalendarActivityData {
    const { reqs, basis } = this.humanFilter(f);
    return { ...computeCalendarActivity(reqs), turnBasis: basis };
  }

  getHarnessComparison(f?: DateFilter): HarnessComparisonData {
    const sessions = this.filteredSessions(f);
    const byHarness = new Map<string, Session[]>();

    for (const s of sessions) {
      const arr = byHarness.get(s.harness) ?? [];
      arr.push(s);
      byHarness.set(s.harness, arr);
    }

    const harnesses = Array.from(byHarness.entries())
      .map(([harness, hSessions]) => this.buildHarnessComparisonItem(harness, hSessions))
      .sort((a, b) => b.requests - a.requests);

    // Daily activity by harness
    const dayHarness = new Map<string, Map<string, number>>();
    for (const s of sessions) {
      for (const r of s.requests) {
        if (r.timestamp == null) continue;
        const d = toDateStr(r.timestamp);
        if (!dayHarness.has(d)) dayHarness.set(d, new Map());
        const hMap = dayHarness.get(d)!;
        hMap.set(s.harness, (hMap.get(s.harness) || 0) + 1);
      }
    }
    const allDays = Array.from(dayHarness.keys()).sort();
    const allHarnessNames = harnesses.map(h => h.harness);
    const series: Record<string, number[]> = {};
    for (const h of allHarnessNames) series[h] = [];
    for (const d of allDays) {
      const hMap = dayHarness.get(d)!;
      for (const h of allHarnessNames) {
        series[h].push(hMap.get(h) || 0);
      }
    }

    return { harnesses, dailyByHarness: { labels: allDays, series } };
  }

  private buildHarnessComparisonItem(harness: string, sessions: Session[]): HarnessComparisonItem {
    const reqs = sessions.flatMap(session => session.requests);
    const totalReqs = reqs.length;
    const timestamps = reqs.flatMap(r => r.timestamp != null ? [r.timestamp] : []);
    const days = new Set(timestamps.map(ts => toDateStr(ts)));

    return {
      harness,
      sessions: sessions.length,
      requests: totalReqs,
      avgRequestsPerSession: sessions.length > 0 ? Math.round((totalReqs / sessions.length) * 10) / 10 : 0,
      totalAiLoc: reqs.reduce((sum, r) => sum + this.requestLoc(r), 0),
      avgResponseLength: totalReqs > 0 ? Math.round(reqs.reduce((sum, r) => sum + r.responseLength, 0) / totalReqs) : 0,
      topModels: this.getTopNamedCounts(reqs.flatMap(r => r.modelId ? [r.modelId] : [])),
      topTools: this.getTopNamedCounts(reqs.flatMap(r => r.toolsUsed)),
      avgElapsed: this.getAverageElapsed(reqs),
      cancelRate: totalReqs > 0 ? reqs.filter(r => r.isCanceled).length / totalReqs : 0,
      activeDays: days.size,
      firstSeen: timestamps.length > 0 ? toDateStr(Math.min(...timestamps)) : null,
      lastSeen: timestamps.length > 0 ? toDateStr(Math.max(...timestamps)) : null,
    };
  }

  private getAverageElapsed(reqs: SessionRequest[]): number | null {
    const elapsedVals = reqs.flatMap(r => r.totalElapsed != null ? [r.totalElapsed] : []);
    if (elapsedVals.length === 0) return null;
    return Math.round(elapsedVals.reduce((a, b) => a + b, 0) / elapsedVals.length);
  }

  private getTopNamedCounts(items: string[]): Array<{ name: string; count: number }> {
    const counts = new Map<string, number>();
    for (const item of items) {
      counts.set(item, (counts.get(item) || 0) + 1);
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => ({ name, count }));
  }

  /* ── Parser field-population matrix ──────────────────────────────── */

  getParserCoverage(): ParserCoverageData {
    // Use all sessions (unfiltered) so coverage isn't skewed by date filters
    const byHarness = new Map<string, SessionRequest[]>();
    for (const s of this.sessions) {
      const arr = byHarness.get(s.harness) || [];
      for (const r of s.requests) arr.push(r);
      byHarness.set(s.harness, arr);
    }

    const harnessNames = Array.from(byHarness.keys()).sort();
    const matrix: Record<string, Record<string, { populated: number; total: number }>> = {};

    for (const field of PARSER_FIELDS) {
      matrix[field.name] = {};
      for (const h of harnessNames) {
        const reqs = byHarness.get(h) || [];
        const populated = reqs.filter(r => isFieldPopulated(r, field.name)).length;
        matrix[field.name][h] = { populated, total: reqs.length };
      }
    }

    return { fields: PARSER_FIELDS, harnesses: harnessNames, matrix };
  }

  /**
   * For each harness, find the most-populated recent request and return a
   * field-by-field preview showing what was extracted and what's missing.
   * If `focusField` is given, prioritize requests where that field is populated.
   */
  getParserPreview(focusField?: string): ParserPreviewData {
    const byHarness = new Map<string, { session: { sessionId: string; workspaceName: string }; request: SessionRequest; reqIdx: number }[]>();
    for (const s of this.sessions) {
      const arr = byHarness.get(s.harness) || [];
      for (let i = 0; i < s.requests.length; i++) {
        arr.push({ session: { sessionId: s.sessionId, workspaceName: s.workspaceName }, request: s.requests[i], reqIdx: i });
      }
      byHarness.set(s.harness, arr);
    }

    const samples: ParserPreviewSample[] = [];

    for (const [harness, entries] of byHarness) {
      let best: typeof entries[0] | null = null;
      let bestScore = -1;

      for (const entry of entries) {
        let score = 0;
        for (const field of PARSER_FIELDS) {
          if (isFieldPopulated(entry.request, field.name)) score++;
        }
        // When a focus field is specified, heavily boost requests that have it
        if (focusField && isFieldPopulated(entry.request, focusField)) {
          score += 100;
        }
        const recency = entry.request.timestamp ? entry.request.timestamp / 1e12 : 0;
        const totalScore = score + recency;
        if (totalScore > bestScore) {
          bestScore = totalScore;
          best = entry;
        }
      }

      if (!best) continue;

      const fields: Record<string, { value: string; populated: boolean }> = {};
      let populatedCount = 0;
      for (const field of PARSER_FIELDS) {
        const populated = isFieldPopulated(best.request, field.name);
        if (populated) populatedCount++;
        fields[field.name] = {
          value: stringifyFieldValue(best.request, field.name),
          populated,
        };
      }

      samples.push({
        harness,
        sessionId: best.session.sessionId,
        workspaceName: best.session.workspaceName,
        requestIndex: best.reqIdx,
        fields,
        populatedCount,
        totalFields: PARSER_FIELDS.length,
      });
    }

    // Sort by harness name
    samples.sort((a, b) => a.harness.localeCompare(b.harness));
    return { samples, fields: PARSER_FIELDS };
  }
}

/* ── Focus score computation ──────────────────────────────────────── */

/**
 * Compute focus intensity per (weekday, hour) cell.
 *
 * Algorithm — "Minute Coverage":
 * For each (weekday, hour, week-instance), gather all request timestamps.
 * Divide the hour into 5-minute buckets (12 buckets). A bucket is "active"
 * if at least one request falls in it. Focus = activeBuckets / 12 * 100.
 * Then average across all week-instances for that (weekday, hour) cell.
 *
 * This naturally rewards sustained activity (many buckets filled)
 * over burst activity (many requests in one moment).
 */
function computeFocusHeatmap(reqs: SessionRequest[]): number[][] {
  // Collect per (dow, hour, weekKey) -> minute timestamps
  const cellInstances = new Map<string, Map<string, number[]>>();

  for (const r of reqs) {
    if (!r.timestamp) continue;
    const d = new Date(r.timestamp);
    const dow = d.getDay();
    const h = d.getHours();
    const minute = d.getMinutes();
    // Week key for grouping instances
    const weekStart = new Date(d);
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    const wk = `${weekStart.getFullYear()}-${String(weekStart.getMonth() + 1).padStart(2, '0')}-${String(weekStart.getDate()).padStart(2, '0')}`;

    const cellKey = `${dow}-${h}`;
    if (!cellInstances.has(cellKey)) cellInstances.set(cellKey, new Map());
    const weekMap = cellInstances.get(cellKey)!;
    if (!weekMap.has(wk)) weekMap.set(wk, []);
    weekMap.get(wk)!.push(minute);
  }

  const focus = makeWeekHourGrid();
  const BUCKET_SIZE = 5;
  const BUCKET_COUNT = 12;

  for (const [cellKey, weekMap] of cellInstances) {
    const [dowStr, hStr] = cellKey.split('-');
    const dow = Number(dowStr);
    const h = Number(hStr);

    let totalScore = 0;
    let instances = 0;

    for (const [, minutes] of weekMap) {
      // Count active 5-minute buckets
      const activeBuckets = new Set<number>();
      for (const m of minutes) {
        activeBuckets.add(Math.floor(m / BUCKET_SIZE));
      }
      totalScore += (activeBuckets.size / BUCKET_COUNT) * 100;
      instances++;
    }

    focus[dow][h] = instances > 0 ? Math.round(totalScore / instances) : 0;
  }

  return focus;
}

/**
 * Compute per-date activity data for the GitHub-style calendar.
 *
 * Focus score per day: divide the day's active hours into 15-minute buckets.
 * Focus = activeBuckets / totalPossibleBuckets (across the time span).
 */
function computeCalendarActivity(reqs: SessionRequest[]): Omit<CalendarActivityData, 'turnBasis'> {
  const dayData = new Map<string, { count: number; minutes: number[] }>();

  for (const r of reqs) {
    if (!r.timestamp) continue;
    const dateStr = toDateStr(r.timestamp);
    const d = new Date(r.timestamp);
    const minuteOfDay = d.getHours() * 60 + d.getMinutes();

    if (!dayData.has(dateStr)) dayData.set(dateStr, { count: 0, minutes: [] });
    const entry = dayData.get(dateStr)!;
    entry.count++;
    entry.minutes.push(minuteOfDay);
  }

  const days: CalendarDay[] = [];
  let maxRequests = 0;

  for (const [date, data] of dayData) {
    maxRequests = Math.max(maxRequests, data.count);
    const d = new Date(date + 'T00:00:00');
    const dow = d.getDay();

    // Compute focus: 15-min bucket coverage over active span
    const sorted = data.minutes.sort((a, b) => a - b);
    const spanStart = sorted[0];
    const spanEnd = sorted[sorted.length - 1];
    const spanBuckets = Math.max(1, Math.floor((spanEnd - spanStart) / 15) + 1);

    const activeBuckets = new Set<number>();
    for (const m of sorted) {
      activeBuckets.add(Math.floor((m - spanStart) / 15));
    }

    const focusScore = Math.min(100, Math.round((activeBuckets.size / spanBuckets) * 100));

    days.push({ date, requests: data.count, focusScore, dow });
  }

  days.sort((a, b) => a.date.localeCompare(b.date));
  return { days, maxRequests };
}
