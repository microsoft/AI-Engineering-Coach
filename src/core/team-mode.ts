/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type {
  DateFilter,
  TeamModeSettings,
  TeamModeSnapshotFile,
  AntiPatternData,
  AiCreditData,
  ContextManagementData,
  TeamModeSeverity,
} from './types';
import type {
  TeamModeAggregationDetailLevel,
  TeamModeAggregationGranularity,
} from './types/config-types';
import {
  TEAM_MODE_CATEGORIES,
  createEmptyTeamDashboardCategoryScores,
  createEmptyTeamModeSnapshotFile,
} from './types/team-mode-types';
import type { TeamModeSnapshotAggregation, TeamModeCategoryBreakdown } from './types/team-mode-types';

export interface TeamModeConfigurationLike {
  get<T>(section: string, defaultValue?: T): T;
}

export const DEFAULT_TEAM_MODE_SETTINGS: TeamModeSettings = {
  enabled: false,
  aggregationGranularity: 'weekly',
  detailLevel: 'category-only',
};

function normalizeBoolean(value: unknown): boolean {
  return typeof value === 'boolean' ? value : Boolean(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function normalizeAggregationGranularity(value: unknown): TeamModeAggregationGranularity {
  return value === 'daily' || value === 'weekly' || value === 'monthly' ? value : DEFAULT_TEAM_MODE_SETTINGS.aggregationGranularity;
}

function normalizeDetailLevel(value: unknown): TeamModeAggregationDetailLevel {
  return value === 'category-only' || value === 'expanded' ? value : DEFAULT_TEAM_MODE_SETTINGS.detailLevel;
}

function normalizeCount(value: unknown): number {
  const num = toFiniteNumber(value);
  return num == null ? 0 : Math.max(0, Math.round(num));
}

function normalizeCategoryScores(raw: unknown): ReturnType<typeof createEmptyTeamDashboardCategoryScores> {
  const scores = createEmptyTeamDashboardCategoryScores();
  if (!isRecord(raw)) return scores;
  for (const category of TEAM_MODE_CATEGORIES) {
    scores[category] = clampScore(toFiniteNumber(raw[category]) ?? 0);
  }
  return scores;
}

function normalizeWeeklyDeltaScores(raw: unknown): ReturnType<typeof createEmptyTeamDashboardCategoryScores> {
  const deltas = createEmptyTeamDashboardCategoryScores();
  if (!isRecord(raw)) return deltas;
  for (const category of TEAM_MODE_CATEGORIES) {
    const value = toFiniteNumber(raw[category]);
    deltas[category] = value == null ? 0 : Math.round(value);
  }
  return deltas;
}

function normalizeSeverityCounts(raw: unknown): Record<TeamModeSeverity, number> {
  const counts: Record<TeamModeSeverity, number> = { low: 0, medium: 0, high: 0 };
  if (!isRecord(raw)) return counts;
  counts.low = normalizeCount(raw.low);
  counts.medium = normalizeCount(raw.medium);
  counts.high = normalizeCount(raw.high);
  return counts;
}

function normalizeTopViolations(raw: unknown): TeamModeSnapshotFile['antiPatterns']['topViolations'] {
  if (!Array.isArray(raw)) return [];
  const violations: TeamModeSnapshotFile['antiPatterns']['topViolations'] = [];
  for (const candidate of raw) {
    if (!isRecord(candidate)) continue;
    const ruleId = typeof candidate.ruleId === 'string' ? candidate.ruleId.trim() : '';
    const severity = candidate.severity;
    if (!ruleId || (severity !== 'low' && severity !== 'medium' && severity !== 'high')) continue;
    violations.push({
      ruleId,
      severity,
      count: normalizeCount(candidate.count),
    });
  }
  return violations.slice(0, 10);
}

export function normalizeTeamModeSettings(raw?: Partial<TeamModeSettings> | null): TeamModeSettings {
  return {
    enabled: normalizeBoolean(raw?.enabled ?? false),
    aggregationGranularity: normalizeAggregationGranularity(raw?.aggregationGranularity),
    detailLevel: normalizeDetailLevel(raw?.detailLevel),
  };
}

export function readTeamModeSettings(configuration: TeamModeConfigurationLike): TeamModeSettings {
  return normalizeTeamModeSettings({
    enabled: configuration.get<boolean>('teamMode.enabled', DEFAULT_TEAM_MODE_SETTINGS.enabled),
    aggregationGranularity: configuration.get<TeamModeAggregationGranularity>('teamMode.aggregationGranularity', DEFAULT_TEAM_MODE_SETTINGS.aggregationGranularity),
    detailLevel: configuration.get<TeamModeAggregationDetailLevel>('teamMode.detailLevel', DEFAULT_TEAM_MODE_SETTINGS.detailLevel),
  });
}

export interface TeamModeAnalyticsSource {
  filterRequests(filter?: DateFilter): Array<{ timestamp: number | null }>;
  getAntiPatterns(filter?: DateFilter): AntiPatternData;
  getAiCredits(filter?: DateFilter): AiCreditData;
  getContextManagement(filter?: DateFilter): ContextManagementData;
}

export function sanitizeTeamModeSnapshotFile(raw: unknown): TeamModeSnapshotFile | null {
  if (!isRecord(raw) || (raw.schemaVersion !== 1 && raw.schemaVersion !== 2)) return null;

  const snapshot = createEmptyTeamModeSnapshotFile();
  const tokenUsage = isRecord(raw.tokenUsage) ? raw.tokenUsage : {};
  const antiPatterns = isRecord(raw.antiPatterns) ? raw.antiPatterns : {};
  const aggregation = isRecord(raw.aggregation) ? raw.aggregation : {};
  snapshot.capturedAtMs = normalizeCount(raw.capturedAtMs);
  snapshot.windowStartMs = normalizeCount(raw.windowStartMs);
  snapshot.windowEndMs = normalizeCount(raw.windowEndMs);
  if (snapshot.windowEndMs < snapshot.windowStartMs) {
    const tmp = snapshot.windowStartMs;
    snapshot.windowStartMs = snapshot.windowEndMs;
    snapshot.windowEndMs = tmp;
  }
  snapshot.categoryScores = normalizeCategoryScores(raw.categoryScores);
  snapshot.aggregation = {
    granularity: normalizeAggregationGranularity(aggregation.granularity),
    detailLevel: normalizeDetailLevel(aggregation.detailLevel),
  };
  snapshot.categoryBreakdown = normalizeCategoryBreakdown(raw.categoryBreakdown, snapshot.categoryScores);
  snapshot.tokenUsage = {
    requests: normalizeCount(tokenUsage.requests),
    countedRequests: normalizeCount(tokenUsage.countedRequests),
    partialRequests: normalizeCount(tokenUsage.partialRequests),
    pendingRequests: normalizeCount(tokenUsage.pendingRequests),
    noDataRequests: normalizeCount(tokenUsage.noDataRequests),
    inputTokens: normalizeCount(tokenUsage.inputTokens),
    outputTokens: normalizeCount(tokenUsage.outputTokens),
    cacheReadTokens: normalizeCount(tokenUsage.cacheReadTokens),
    cacheWriteTokens: normalizeCount(tokenUsage.cacheWriteTokens),
    totalTokens: normalizeCount(tokenUsage.totalTokens),
    missingPct: clampScore(toFiniteNumber(tokenUsage.missingPct) ?? 0),
  };
  snapshot.antiPatterns.totalOccurrences = normalizeCount(antiPatterns.totalOccurrences);
  snapshot.antiPatterns.bySeverity = normalizeSeverityCounts(antiPatterns.bySeverity);
  snapshot.antiPatterns.topViolations = normalizeTopViolations(antiPatterns.topViolations);
  snapshot.weeklyDeltas = normalizeWeeklyDeltaScores(raw.weeklyDeltas);
  return snapshot;
}

function normalizeCategoryBreakdown(
  raw: unknown,
  categoryScores: ReturnType<typeof createEmptyTeamDashboardCategoryScores>,
): TeamModeSnapshotFile['categoryBreakdown'] {
  const breakdown = createEmptyTeamModeSnapshotFile().categoryBreakdown;
  if (!isRecord(raw)) {
    for (const category of TEAM_MODE_CATEGORIES) {
      breakdown[category] = {
        ...breakdown[category],
        score: categoryScores[category],
      };
    }
    return breakdown;
  }

  for (const category of TEAM_MODE_CATEGORIES) {
    const candidate = isRecord(raw[category]) ? raw[category] : {};
    breakdown[category] = {
      score: clampScore(toFiniteNumber(candidate.score) ?? categoryScores[category]),
      wowPct: Math.round(toFiniteNumber(candidate.wowPct) ?? 0),
      momPct: Math.round(toFiniteNumber(candidate.momPct) ?? 0),
      patternCount: normalizeCount(candidate.patternCount),
      topIssue: typeof candidate.topIssue === 'string' && candidate.topIssue.trim() ? candidate.topIssue.trim() : null,
      improvements: Array.isArray(candidate.improvements)
        ? candidate.improvements.filter((value): value is string => typeof value === 'string' && value.trim().length > 0).map(value => value.trim()).slice(0, 5)
        : [],
    };
  }

  return breakdown;
}

function parseWeekStartMs(label: string): number | null {
  const ts = Date.parse(`${label}T00:00:00Z`);
  return Number.isFinite(ts) ? ts : null;
}

function buildWeeklySeries(
  antiPatterns: AntiPatternData,
  contextManagement: ContextManagementData,
): Record<(typeof TEAM_MODE_CATEGORIES)[number], number[]> {
  const weekSet = new Set<number>();
  const seriesByGroup = new Map<(typeof TEAM_MODE_CATEGORIES)[number], Map<number, number>>();

  for (const group of TEAM_MODE_CATEGORIES) {
    seriesByGroup.set(group, new Map());
  }

  for (const series of antiPatterns.weeklyScores.series) {
    const group = series.group as (typeof TEAM_MODE_CATEGORIES)[number];
    const bucket = seriesByGroup.get(group);
    if (!bucket) continue;
    for (let i = 0; i < series.scores.length; i++) {
      const weekStartMs = parseWeekStartMs(antiPatterns.weeklyScores.labels[i] ?? '');
      if (weekStartMs == null) continue;
      weekSet.add(weekStartMs);
      bucket.set(weekStartMs, clampScore(series.scores[i] ?? 0));
    }
  }

  const contextSeries = new Map<number, number>();
  for (const entry of contextManagement.trend) {
    const weekStartMs = parseWeekStartMs(entry.label);
    if (weekStartMs == null) continue;
    weekSet.add(weekStartMs);
    contextSeries.set(weekStartMs, clampScore(100 - entry.avgUtilization));
  }

  const weekStartMs = [...weekSet].sort((a, b) => a - b);
  const series: Record<(typeof TEAM_MODE_CATEGORIES)[number], number[]> = {
    'prompt-quality': [],
    'session-hygiene': [],
    'code-review': [],
    'tool-mastery': [],
    'context-management': [],
  };

  for (const week of weekStartMs) {
    for (const group of TEAM_MODE_CATEGORIES) {
      if (group === 'context-management') {
        series[group].push(contextSeries.get(week) ?? 0);
      } else {
        series[group].push(seriesByGroup.get(group)?.get(week) ?? 0);
      }
    }
  }

  return series;
}

function computeWeekOverWeekDelta(series: number[]): number {
  if (series.length < 2) return 0;
  return Math.round(series[series.length - 1] - series[series.length - 2]);
}

function sumTokens(aiCredits: AiCreditData): number {
  return aiCredits.totalInputTokens + aiCredits.totalOutputTokens + aiCredits.totalCacheReadTokens + aiCredits.totalCacheWriteTokens;
}

export function buildTeamModeSnapshot(
  source: TeamModeAnalyticsSource,
  filter?: DateFilter,
  settings: TeamModeSettings = DEFAULT_TEAM_MODE_SETTINGS,
): TeamModeSnapshotFile {
  const snapshot = createEmptyTeamModeSnapshotFile();
  const requests = source.filterRequests(filter);
  const antiPatterns = source.getAntiPatterns(filter);
  const aiCredits = source.getAiCredits(filter);
  const contextManagement = source.getContextManagement(filter);

  const timestamps = requests
    .map(request => request.timestamp)
    .filter((timestamp): timestamp is number => typeof timestamp === 'number' && Number.isFinite(timestamp));

  const weeklySeries = buildWeeklySeries(antiPatterns, contextManagement);
  const normalizedSettings = normalizeTeamModeSettings(settings);

  snapshot.capturedAtMs = Date.now();
  snapshot.windowStartMs = timestamps.length > 0 ? Math.min(...timestamps) : snapshot.capturedAtMs;
  snapshot.windowEndMs = timestamps.length > 0 ? Math.max(...timestamps) : snapshot.capturedAtMs;
  snapshot.aggregation = {
    granularity: normalizedSettings.aggregationGranularity,
    detailLevel: normalizedSettings.detailLevel,
  };
  snapshot.categoryScores = {
    'prompt-quality': antiPatterns.groupScores.find(group => group.group === 'prompt-quality')?.score ?? 0,
    'session-hygiene': antiPatterns.groupScores.find(group => group.group === 'session-hygiene')?.score ?? 0,
    'code-review': antiPatterns.groupScores.find(group => group.group === 'code-review')?.score ?? 0,
    'tool-mastery': antiPatterns.groupScores.find(group => group.group === 'tool-mastery')?.score ?? 0,
    'context-management': contextManagement.overallScore,
  };
  snapshot.categoryBreakdown = buildCategoryBreakdown(antiPatterns, contextManagement, snapshot.categoryScores);
  snapshot.tokenUsage = {
    requests: aiCredits.totalRequests,
    countedRequests: aiCredits.countedRequests,
    partialRequests: aiCredits.partialRequests,
    pendingRequests: aiCredits.pendingRequests,
    noDataRequests: aiCredits.noDataRequests,
    inputTokens: aiCredits.totalInputTokens,
    outputTokens: aiCredits.totalOutputTokens,
    cacheReadTokens: aiCredits.totalCacheReadTokens,
    cacheWriteTokens: aiCredits.totalCacheWriteTokens,
    totalTokens: sumTokens(aiCredits),
    missingPct: aiCredits.missingPct,
  };
  snapshot.antiPatterns.totalOccurrences = antiPatterns.totalOccurrences;
  snapshot.antiPatterns.topViolations = [...antiPatterns.patterns]
    .sort((a, b) => b.occurrences - a.occurrences || a.name.localeCompare(b.name))
    .slice(0, 10)
    .map(pattern => ({
      ruleId: pattern.id,
      severity: pattern.severity,
      count: pattern.occurrences,
    }));
  snapshot.antiPatterns.bySeverity = antiPatterns.patterns.reduce((acc, pattern) => {
    acc[pattern.severity] += pattern.occurrences;
    return acc;
  }, { low: 0, medium: 0, high: 0 });
  snapshot.weeklyDeltas = {
    'prompt-quality': computeWeekOverWeekDelta(weeklySeries['prompt-quality']),
    'session-hygiene': computeWeekOverWeekDelta(weeklySeries['session-hygiene']),
    'code-review': computeWeekOverWeekDelta(weeklySeries['code-review']),
    'tool-mastery': computeWeekOverWeekDelta(weeklySeries['tool-mastery']),
    'context-management': computeWeekOverWeekDelta(weeklySeries['context-management']),
  };

  return snapshot;
}

function buildCategoryBreakdown(
  antiPatterns: AntiPatternData,
  contextManagement: ContextManagementData,
  categoryScores: ReturnType<typeof createEmptyTeamDashboardCategoryScores>,
): TeamModeSnapshotFile['categoryBreakdown'] {
  const breakdown = createEmptyTeamModeSnapshotFile().categoryBreakdown;
  const scoreByGroup = new Map(antiPatterns.groupScores.map(group => [group.group, group]));
  const improvementsByGroup = new Map<(typeof TEAM_MODE_CATEGORIES)[number], string[]>();
  for (const pattern of antiPatterns.patterns) {
    const list = improvementsByGroup.get(pattern.group) ?? [];
    if (pattern.suggestion) list.push(pattern.suggestion);
    improvementsByGroup.set(pattern.group, list);
  }

  for (const category of TEAM_MODE_CATEGORIES) {
    const group = scoreByGroup.get(category);
    breakdown[category] = {
      score: categoryScores[category],
      wowPct: Math.round(group?.wowPct ?? 0),
      momPct: Math.round(group?.momPct ?? 0),
      patternCount: group?.patternCount ?? 0,
      topIssue: group?.topIssue ?? (category === 'context-management' ? (contextManagement.tips[0] ?? null) : null),
      improvements: (group?.improvements ?? improvementsByGroup.get(category) ?? []).filter(Boolean).slice(0, 5),
    };
  }

  return breakdown;
}
