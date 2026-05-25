/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { DateFilter, PracticeGroup, TeamModeSettings, TeamModeSnapshot, AntiPatternData, AiCreditData, ContextManagementData } from './types';
import { createEmptyTeamModeSnapshot } from './types/team-mode-types';

export interface TeamModeConfigurationLike {
  get<T>(section: string, defaultValue?: T): T;
}

export const DEFAULT_TEAM_MODE_SETTINGS: TeamModeSettings = {
  enabled: false,
  serverUrl: '',
  developerId: '',
};

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeBoolean(value: unknown): boolean {
  return typeof value === 'boolean' ? value : Boolean(value);
}

export function normalizeTeamModeSettings(raw?: Partial<TeamModeSettings> | null): TeamModeSettings {
  return {
    enabled: normalizeBoolean(raw?.enabled ?? false),
    serverUrl: normalizeString(raw?.serverUrl),
    developerId: normalizeString(raw?.developerId),
  };
}

export function readTeamModeSettings(configuration: TeamModeConfigurationLike): TeamModeSettings {
  return normalizeTeamModeSettings({
    enabled: configuration.get<boolean>('teamMode.enabled', DEFAULT_TEAM_MODE_SETTINGS.enabled),
    serverUrl: configuration.get<string>('teamMode.serverUrl', DEFAULT_TEAM_MODE_SETTINGS.serverUrl),
    developerId: configuration.get<string>('teamMode.developerId', DEFAULT_TEAM_MODE_SETTINGS.developerId),
  });
}

export interface TeamModeAnalyticsSource {
  filterRequests(filter?: DateFilter): Array<{ timestamp: number | null }>;
  getAntiPatterns(filter?: DateFilter): AntiPatternData;
  getAiCredits(filter?: DateFilter): AiCreditData;
  getContextManagement(filter?: DateFilter): ContextManagementData;
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function parseWeekStartMs(label: string): number | null {
  const ts = Date.parse(`${label}T00:00:00Z`);
  return Number.isFinite(ts) ? ts : null;
}

function buildWeeklySeries(
  antiPatterns: AntiPatternData,
  contextManagement: ContextManagementData,
): TeamModeSnapshot['weeklyTrend'] {
  const snapshot = createEmptyTeamModeSnapshot().weeklyTrend;
  const weekSet = new Set<number>();
  const seriesByGroup = new Map<PracticeGroup, Map<number, number>>();

  for (const group of Object.keys(snapshot.scoresByCategory) as PracticeGroup[]) {
    seriesByGroup.set(group, new Map());
  }

  for (const series of antiPatterns.weeklyScores.series) {
    const group = series.group as PracticeGroup;
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
  const scoresByCategory: TeamModeSnapshot['weeklyTrend']['scoresByCategory'] = {
    'prompt-quality': [],
    'session-hygiene': [],
    'code-review': [],
    'tool-mastery': [],
    'context-management': [],
  };

  for (const week of weekStartMs) {
    for (const group of Object.keys(scoresByCategory) as PracticeGroup[]) {
      if (group === 'context-management') {
        scoresByCategory[group].push(contextSeries.get(week) ?? 0);
      } else {
        scoresByCategory[group].push(seriesByGroup.get(group)?.get(week) ?? 0);
      }
    }
  }

  return { weekStartMs, scoresByCategory };
}

export function buildTeamModeSnapshot(
  source: TeamModeAnalyticsSource,
  settings: TeamModeSettings,
  filter?: DateFilter,
): TeamModeSnapshot {
  const snapshot = createEmptyTeamModeSnapshot();
  const requests = source.filterRequests(filter);
  const antiPatterns = source.getAntiPatterns(filter);
  const aiCredits = source.getAiCredits(filter);
  const contextManagement = source.getContextManagement(filter);

  const timestamps = requests
    .map(request => request.timestamp)
    .filter((timestamp): timestamp is number => typeof timestamp === 'number' && Number.isFinite(timestamp));

  const weekSeries = buildWeeklySeries(antiPatterns, contextManagement);

  snapshot.developerId = settings.developerId;
  snapshot.capturedAtMs = Date.now();
  snapshot.windowStartMs = timestamps.length > 0 ? Math.min(...timestamps) : snapshot.capturedAtMs;
  snapshot.windowEndMs = timestamps.length > 0 ? Math.max(...timestamps) : snapshot.capturedAtMs;
  snapshot.categoryScores = {
    'prompt-quality': antiPatterns.groupScores.find(group => group.group === 'prompt-quality')?.score ?? 0,
    'session-hygiene': antiPatterns.groupScores.find(group => group.group === 'session-hygiene')?.score ?? 0,
    'code-review': antiPatterns.groupScores.find(group => group.group === 'code-review')?.score ?? 0,
    'tool-mastery': antiPatterns.groupScores.find(group => group.group === 'tool-mastery')?.score ?? 0,
    'context-management': contextManagement.overallScore,
  };
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
  snapshot.antiPatterns.byGroup = antiPatterns.patterns.reduce((acc, pattern) => {
    acc[pattern.group] += pattern.occurrences;
    return acc;
  }, {
    'prompt-quality': 0,
    'session-hygiene': 0,
    'code-review': 0,
    'tool-mastery': 0,
    'context-management': 0,
  });
  snapshot.weeklyTrend = weekSeries;

  return snapshot;
}
