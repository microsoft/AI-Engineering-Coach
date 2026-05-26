/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Summary export helpers for machine-readable and human-readable reports. */

import type {
  AntiPatternData,
  CodeProductionData,
  DailyActivity,
  StatsResult,
  WorkLifeBalanceResult,
} from './types/analytics-types';
import type { FlowStateData } from './types/context-types';
import type { DateFilter } from './types/session-types';

export interface SummaryExportInput {
  generatedAt?: string | Date;
  filter?: DateFilter;
  stats: StatsResult;
  codeProduction: CodeProductionData;
  dailyActivity: DailyActivity;
  workLifeBalance: WorkLifeBalanceResult | null;
  flowState: FlowStateData;
  antiPatterns: AntiPatternData;
}

export interface SummaryExportAnalyzer {
  getStats(filter?: DateFilter): StatsResult;
  getCodeProduction(filter?: DateFilter): CodeProductionData;
  getDailyActivity(filter?: DateFilter): DailyActivity;
  getWorkLifeBalance(filter?: DateFilter): WorkLifeBalanceResult | null;
  getFlowState(filter?: DateFilter): FlowStateData;
  getAntiPatterns(filter?: DateFilter): AntiPatternData;
}

export interface SummaryExportReport {
  schemaVersion: 1;
  generatedAt: string;
  filter: DateFilter;
  totals: {
    sessions: number;
    requests: number;
    workspaces: number;
  };
  production: {
    totalAiLoc: number;
    totalUserLoc: number;
    totalLoc: number;
    aiRatio: number;
    topLanguages: Array<{ language: string; aiLoc: number; userLoc: number }>;
  };
  activity: {
    activeDays: number;
    firstActivityDate: string | null;
    lastActivityDate: string | null;
    maxStreak: number | null;
  };
  flow: {
    overallScore: number;
    deepFlowDays: number;
    totalDays: number;
    avgBlockMin: number;
    suggestions: string[];
  };
  antiPatterns: {
    totalOccurrences: number;
    topPatterns: Array<{
      id: string;
      name: string;
      severity: string;
      group: string;
      occurrences: number;
      description: string;
      suggestion: string;
    }>;
  };
}

const TOP_LANGUAGE_LIMIT = 10;
const TOP_ANTI_PATTERN_LIMIT = 10;

function toIsoString(value: string | Date | undefined): string {
  if (!value) return new Date().toISOString();
  if (value instanceof Date) return value.toISOString();
  return value;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US').format(Math.round(value));
}

function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return '0%';
  return `${Math.round(value * 100)}%`;
}

function summarizeFilter(filter: DateFilter): string {
  const parts: string[] = [];
  if (filter.workspaceId) parts.push(`workspace=${filter.workspaceId}`);
  if (filter.harness) parts.push(`harness=${filter.harness}`);
  if (filter.fromDate) parts.push(`from=${filter.fromDate}`);
  if (filter.toDate) parts.push(`to=${filter.toDate}`);
  return parts.length > 0 ? parts.join(', ') : 'All data';
}

function buildTopLanguages(data: CodeProductionData): SummaryExportReport['production']['topLanguages'] {
  return data.byLanguage.labels
    .map((language, index) => ({
      language,
      aiLoc: data.byLanguage.aiLoc[index] ?? 0,
      userLoc: data.byLanguage.userLoc[index] ?? 0,
    }))
    .filter(item => item.aiLoc > 0 || item.userLoc > 0)
    .sort((a, b) => b.aiLoc - a.aiLoc || b.userLoc - a.userLoc || a.language.localeCompare(b.language))
    .slice(0, TOP_LANGUAGE_LIMIT);
}

function activeDates(data: DailyActivity): { activeDays: number; firstActivityDate: string | null; lastActivityDate: string | null } {
  const active = data.labels.filter((_, index) => (data.values[index] ?? 0) > 0);
  return {
    activeDays: active.length,
    firstActivityDate: data.labels[0] ?? null,
    lastActivityDate: data.labels[data.labels.length - 1] ?? null,
  };
}

function buildTopAntiPatterns(data: AntiPatternData): SummaryExportReport['antiPatterns']['topPatterns'] {
  const severityRank: Record<string, number> = { high: 0, medium: 1, low: 2 };
  return data.patterns
    .map(pattern => ({
      id: pattern.id,
      name: pattern.name,
      severity: pattern.severity,
      group: pattern.group,
      occurrences: pattern.occurrences,
      description: pattern.description,
      suggestion: pattern.suggestion,
    }))
    .sort((a, b) =>
      b.occurrences - a.occurrences ||
      (severityRank[a.severity] ?? 99) - (severityRank[b.severity] ?? 99) ||
      a.name.localeCompare(b.name)
    )
    .slice(0, TOP_ANTI_PATTERN_LIMIT);
}

export function buildSummaryExport(input: SummaryExportInput): SummaryExportReport {
  const filter = input.filter ?? {};
  const activity = activeDates(input.dailyActivity);

  return {
    schemaVersion: 1,
    generatedAt: toIsoString(input.generatedAt),
    filter,
    totals: {
      sessions: input.stats.totalSessions,
      requests: input.stats.totalRequests,
      workspaces: input.stats.totalWorkspaces,
    },
    production: {
      totalAiLoc: input.codeProduction.summary.totalAiLoc,
      totalUserLoc: input.codeProduction.summary.totalUserLoc,
      totalLoc: input.codeProduction.summary.totalLoc,
      aiRatio: input.codeProduction.summary.aiRatio,
      topLanguages: buildTopLanguages(input.codeProduction),
    },
    activity: {
      ...activity,
      maxStreak: input.workLifeBalance?.maxStreak ?? null,
    },
    flow: {
      overallScore: input.flowState.overallFlowScore,
      deepFlowDays: input.flowState.deepFlowDays,
      totalDays: input.flowState.totalDays,
      avgBlockMin: input.flowState.avgBlockMin,
      suggestions: input.flowState.suggestions.slice(0, 5),
    },
    antiPatterns: {
      totalOccurrences: input.antiPatterns.totalOccurrences,
      topPatterns: buildTopAntiPatterns(input.antiPatterns),
    },
  };
}

export function buildSummaryExportFromAnalyzer(
  analyzer: SummaryExportAnalyzer,
  filter?: DateFilter,
  generatedAt?: string | Date,
): SummaryExportReport {
  return buildSummaryExport({
    generatedAt,
    filter,
    stats: analyzer.getStats(filter),
    codeProduction: analyzer.getCodeProduction(filter),
    dailyActivity: analyzer.getDailyActivity(filter),
    workLifeBalance: analyzer.getWorkLifeBalance(filter),
    flowState: analyzer.getFlowState(filter),
    antiPatterns: analyzer.getAntiPatterns(filter),
  });
}

export function renderSummaryJson(report: SummaryExportReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function renderSummaryMarkdown(report: SummaryExportReport): string {
  const lines: string[] = [
    '# AI Engineer Coach Summary',
    '',
    `Generated: ${report.generatedAt}`,
    `Filter: ${summarizeFilter(report.filter)}`,
    '',
    '## Totals',
    `- Sessions: ${formatNumber(report.totals.sessions)}`,
    `- Requests: ${formatNumber(report.totals.requests)}`,
    `- Workspaces: ${formatNumber(report.totals.workspaces)}`,
    `- AI-generated LoC: ${formatNumber(report.production.totalAiLoc)}`,
    `- User LoC observed: ${formatNumber(report.production.totalUserLoc)}`,
    `- AI ratio: ${formatPercent(report.production.aiRatio)}`,
    '',
    '## Activity',
    `- Active days: ${formatNumber(report.activity.activeDays)}`,
    `- First activity date: ${report.activity.firstActivityDate ?? 'n/a'}`,
    `- Last activity date: ${report.activity.lastActivityDate ?? 'n/a'}`,
    `- Max streak: ${report.activity.maxStreak === null ? 'n/a' : formatNumber(report.activity.maxStreak)}`,
    '',
    '## Flow',
    `- Overall flow score: ${formatNumber(report.flow.overallScore)}`,
    `- Deep-flow days: ${formatNumber(report.flow.deepFlowDays)} of ${formatNumber(report.flow.totalDays)}`,
    `- Average block length: ${formatNumber(report.flow.avgBlockMin)} min`,
  ];

  if (report.flow.suggestions.length > 0) {
    lines.push('', '### Flow Suggestions');
    for (const suggestion of report.flow.suggestions) lines.push(`- ${suggestion}`);
  }

  lines.push('', '## Top Languages');
  if (report.production.topLanguages.length === 0) {
    lines.push('- No language data available.');
  } else {
    for (const item of report.production.topLanguages) {
      lines.push(`- ${item.language}: ${formatNumber(item.aiLoc)} AI LoC, ${formatNumber(item.userLoc)} user LoC`);
    }
  }

  lines.push('', '## Top Anti-Patterns');
  if (report.antiPatterns.topPatterns.length === 0) {
    lines.push('- No anti-patterns detected.');
  } else {
    for (const pattern of report.antiPatterns.topPatterns) {
      lines.push(
        `- ${pattern.name} (${pattern.severity}, ${formatNumber(pattern.occurrences)} occurrence${pattern.occurrences === 1 ? '' : 's'}): ${pattern.suggestion}`,
      );
    }
  }

  return `${lines.join('\n')}\n`;
}

export function getSummaryExportFilenames(generatedAt: string | Date = new Date()): { markdown: string; json: string } {
  const date = toIsoString(generatedAt).slice(0, 10);
  return {
    markdown: `ai-engineer-coach-summary-${date}.md`,
    json: `ai-engineer-coach-summary-${date}.json`,
  };
}
