/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { buildSummaryExport, renderSummaryMarkdown, renderSummaryJson, getSummaryExportFilenames } from './summary-export';
import type {
  AntiPatternData,
  CodeProductionData,
  DailyActivity,
  StatsResult,
  WorkLifeBalanceResult,
} from './types/analytics-types';
import type { FlowStateData } from './types/context-types';

const stats: StatsResult = {
  totalSessions: 7,
  totalRequests: 42,
  totalWorkspaces: 3,
};

const codeProduction: CodeProductionData = {
  summary: {
    totalAiLoc: 1200,
    totalUserLoc: 300,
    totalLoc: 1500,
    aiBlocks: 12,
    userBlocks: 4,
    aiRatio: 0.8,
    locCost2010: 0,
    costPerLoc: 0,
  },
  byLanguage: {
    labels: ['typescript', 'python', 'markdown'],
    aiLoc: [900, 250, 50],
    userLoc: [100, 150, 50],
  },
  dailyTimeline: { labels: [], aiLoc: [], userLoc: [] },
  byWorkspace: { labels: [], aiLoc: [], userLoc: [] },
  dailyByWorkspace: {},
  dailyByModel: {},
  dailyByHarness: {},
};

const dailyActivity: DailyActivity = {
  labels: ['2026-05-20', '2026-05-21', '2026-05-22'],
  values: [2, 0, 5],
  loc: [100, 0, 400],
  sessions: [1, 0, 2],
  workspaces: [1, 0, 2],
  byHarness: [],
};

const workLifeBalance: WorkLifeBalanceResult = {
  score: 76,
  totalRequests: 42,
  weekdayReqs: 40,
  weekendReqs: 2,
  weekendRatio: 0.05,
  timeDistribution: { lateNight: 1, earlyMorning: 2, workHours: 30, evening: 9 },
  hours: [],
  weekdayHours: [],
  weekendHours: [],
  avgStartHour: 9,
  avgEndHour: 18,
  avgSpanHours: 7.5,
  maxStreak: 5,
  maxBreak: 2,
  activeDays: 12,
  weeklyTrend: { labels: [], weekday: [], weekend: [] },
};

const flowState: FlowStateData = {
  days: [],
  overallFlowScore: 84,
  avgFollowUpSec: 45,
  avgBlockMin: 55,
  deepFlowDays: 4,
  totalDays: 10,
  weeklyTrend: { labels: [], scores: [] },
  hourlyFlow: [],
  suggestions: ['Batch related prompts before starting an agent session.'],
};

const antiPatterns: AntiPatternData = {
  totalOccurrences: 22,
  weeklyTrend: { labels: [], counts: [] },
  groupScores: [],
  weeklyScores: { labels: [], series: [] },
  patterns: [
    {
      id: 'low-context',
      name: 'Low Context Prompts',
      severity: 'medium',
      group: 'prompt-quality',
      occurrences: 8,
      description: 'Prompts often miss project context.',
      suggestion: 'Reference the relevant files and constraints.',
      examples: ['fix this'],
      details: [],
      weeklyHist: { labels: [], counts: [] },
    },
    {
      id: 'mega-session',
      name: 'Mega Sessions',
      severity: 'high',
      group: 'session-hygiene',
      occurrences: 14,
      description: 'Long sessions can lose decision context.',
      suggestion: 'Start a fresh session after major milestones.',
      examples: [],
      details: [],
      weeklyHist: { labels: [], counts: [] },
    },
  ],
};

describe('summary export', () => {
  it('builds a stable report object with totals, filters, languages, and top anti-patterns', () => {
    const report = buildSummaryExport({
      generatedAt: '2026-05-25T10:00:00.000Z',
      filter: { workspaceId: 'directus', harness: 'Codex' },
      stats,
      codeProduction,
      dailyActivity,
      workLifeBalance,
      flowState,
      antiPatterns,
    });

    expect(report.schemaVersion).toBe(1);
    expect(report.filter).toEqual({ workspaceId: 'directus', harness: 'Codex' });
    expect(report.totals).toEqual({ sessions: 7, requests: 42, workspaces: 3 });
    expect(report.production.totalAiLoc).toBe(1200);
    expect(report.production.topLanguages).toEqual([
      { language: 'typescript', aiLoc: 900, userLoc: 100 },
      { language: 'python', aiLoc: 250, userLoc: 150 },
      { language: 'markdown', aiLoc: 50, userLoc: 50 },
    ]);
    expect(report.activity).toEqual({ activeDays: 2, firstActivityDate: '2026-05-20', lastActivityDate: '2026-05-22', maxStreak: 5 });
    expect(report.antiPatterns.topPatterns.map(pattern => pattern.id)).toEqual(['mega-session', 'low-context']);
  });

  it('renders readable markdown and deterministic json', () => {
    const report = buildSummaryExport({
      generatedAt: '2026-05-25T10:00:00.000Z',
      filter: {},
      stats,
      codeProduction,
      dailyActivity,
      workLifeBalance: null,
      flowState,
      antiPatterns,
    });

    const markdown = renderSummaryMarkdown(report);
    expect(markdown).toContain('# AI Engineer Coach Summary');
    expect(markdown).toContain('- Sessions: 7');
    expect(markdown).toContain('- AI-generated LoC: 1,200');
    expect(markdown).toContain('## Top Anti-Patterns');
    expect(markdown).toContain('Mega Sessions');

    const json = renderSummaryJson(report);
    expect(JSON.parse(json)).toEqual(report);
    expect(json).toContain('  "schemaVersion": 1');
  });

  it('uses date-stamped markdown and json filenames', () => {
    expect(getSummaryExportFilenames('2026-05-25T10:00:00.000Z')).toEqual({
      markdown: 'ai-engineer-coach-summary-2026-05-25.md',
      json: 'ai-engineer-coach-summary-2026-05-25.json',
    });
  });
});
