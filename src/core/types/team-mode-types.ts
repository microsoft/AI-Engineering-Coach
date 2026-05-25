/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { PracticeGroup } from './analytics-types';

export type TeamModeSeverity = 'low' | 'medium' | 'high';

export interface TeamModeAntiPatternSummary {
  ruleId: string;
  severity: TeamModeSeverity;
  count: number;
}

export interface TeamModeTokenUsageSummary {
  requests: number;
  countedRequests: number;
  partialRequests: number;
  pendingRequests: number;
  noDataRequests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  missingPct: number;
}

export interface TeamModeWeeklyTrend {
  weekStartMs: number[];
  scoresByCategory: Record<PracticeGroup, number[]>;
}

export interface TeamModeSnapshot {
  schemaVersion: 1;
  developerId: string;
  capturedAtMs: number;
  windowStartMs: number;
  windowEndMs: number;
  categoryScores: Record<PracticeGroup, number>;
  tokenUsage: TeamModeTokenUsageSummary;
  antiPatterns: {
    totalOccurrences: number;
    bySeverity: Record<TeamModeSeverity, number>;
    byGroup: Record<PracticeGroup, number>;
    topViolations: TeamModeAntiPatternSummary[];
  };
  weeklyTrend: TeamModeWeeklyTrend;
}

const PRACTICE_GROUP_KEYS: PracticeGroup[] = [
  'prompt-quality',
  'session-hygiene',
  'code-review',
  'tool-mastery',
  'context-management',
];

export function createEmptyTeamModeSnapshot(): TeamModeSnapshot {
  return {
    schemaVersion: 1,
    developerId: '',
    capturedAtMs: 0,
    windowStartMs: 0,
    windowEndMs: 0,
    categoryScores: {
      'prompt-quality': 0,
      'session-hygiene': 0,
      'code-review': 0,
      'tool-mastery': 0,
      'context-management': 0,
    },
    tokenUsage: {
      requests: 0,
      countedRequests: 0,
      partialRequests: 0,
      pendingRequests: 0,
      noDataRequests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      missingPct: 0,
    },
    antiPatterns: {
      totalOccurrences: 0,
      bySeverity: {
        low: 0,
        medium: 0,
        high: 0,
      },
      byGroup: {
        'prompt-quality': 0,
        'session-hygiene': 0,
        'code-review': 0,
        'tool-mastery': 0,
        'context-management': 0,
      },
      topViolations: [],
    },
    weeklyTrend: {
      weekStartMs: [],
      scoresByCategory: Object.fromEntries(PRACTICE_GROUP_KEYS.map(group => [group, []])) as unknown as Record<PracticeGroup, number[]>,
    },
  };
}
