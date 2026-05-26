/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { PracticeGroup } from './analytics-types';

export type TeamModeSeverity = 'low' | 'medium' | 'high';
export type TeamDashboardCategory = PracticeGroup;

export interface TeamDashboardFilters {
  developerId?: string;
  fromMs?: number;
  toMs?: number;
  category?: TeamDashboardCategory;
}

export interface TeamDashboardCategoryScores {
  'prompt-quality': number;
  'session-hygiene': number;
  'code-review': number;
  'tool-mastery': number;
  'context-management': number;
}

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
  totalTokens: number;
  missingPct: number;
}

export interface TeamModeSnapshotFile {
  schemaVersion: 1;
  capturedAtMs: number;
  windowStartMs: number;
  windowEndMs: number;
  categoryScores: TeamDashboardCategoryScores;
  tokenUsage: TeamModeTokenUsageSummary;
  antiPatterns: {
    totalOccurrences: number;
    bySeverity: Record<TeamModeSeverity, number>;
    topViolations: TeamModeAntiPatternSummary[];
  };
  weeklyDeltas: TeamDashboardCategoryScores;
}

export type TeamModeSnapshot = TeamModeSnapshotFile;

export interface TeamModeImportedSnapshotRecord {
  importId: string;
  filePath: string;
  fileName: string;
  displayName: string;
  importedAtMs: number;
  snapshot: TeamModeSnapshotFile;
}

export interface TeamDashboardImportedRun {
  snapshotId: string;
  fileName: string;
  capturedAtMs: number;
  importedAtMs: number;
}

export interface TeamDashboardAntiPatternSummary {
  totalOccurrences: number;
  bySeverity: Record<TeamModeSeverity, number>;
  topViolations: TeamModeAntiPatternSummary[];
}

export interface TeamDashboardDeveloperRow {
  developerId: string;
  displayName: string;
  snapshotCount: number;
  latestCapturedAtMs: number;
  categoryScores: TeamDashboardCategoryScores;
  tokenUsage: TeamModeTokenUsageSummary;
  antiPatterns: TeamDashboardAntiPatternSummary;
  weekOverWeek: TeamDashboardCategoryScores;
  importedSnapshots: TeamDashboardImportedRun[];
}

export type TeamDashboardMemberRow = TeamDashboardDeveloperRow;

export interface TeamDashboardResponse {
  filters: TeamDashboardFilters;
  selectedCategory: TeamDashboardCategory | 'all';
  totalDevelopers: number;
  totalSnapshots: number;
  importedSnapshots: number;
  availableDevelopers: Array<{ developerId: string; displayName: string }>;
  developers: TeamDashboardDeveloperRow[];
  hasSnapshots: boolean;
  lastImportedAtMs: number | null;
}

const PRACTICE_GROUP_KEYS: TeamDashboardCategory[] = [
  'prompt-quality',
  'session-hygiene',
  'code-review',
  'tool-mastery',
  'context-management',
];

export function createEmptyTeamDashboardCategoryScores(): TeamDashboardCategoryScores {
  return {
    'prompt-quality': 0,
    'session-hygiene': 0,
    'code-review': 0,
    'tool-mastery': 0,
    'context-management': 0,
  };
}

export function createEmptyTeamModeTokenUsageSummary(): TeamModeTokenUsageSummary {
  return {
    requests: 0,
    countedRequests: 0,
    partialRequests: 0,
    pendingRequests: 0,
    noDataRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    missingPct: 0,
  };
}

export function createEmptyTeamModeSnapshotFile(): TeamModeSnapshotFile {
  return {
    schemaVersion: 1,
    capturedAtMs: 0,
    windowStartMs: 0,
    windowEndMs: 0,
    categoryScores: createEmptyTeamDashboardCategoryScores(),
    tokenUsage: createEmptyTeamModeTokenUsageSummary(),
    antiPatterns: {
      totalOccurrences: 0,
      bySeverity: {
        low: 0,
        medium: 0,
        high: 0,
      },
      topViolations: [],
    },
    weeklyDeltas: createEmptyTeamDashboardCategoryScores(),
  };
}

export function createEmptyTeamModeSnapshot(): TeamModeSnapshotFile {
  return createEmptyTeamModeSnapshotFile();
}

export function createEmptyTeamDashboardResponse(): TeamDashboardResponse {
  return {
    filters: {},
    selectedCategory: 'all',
    totalDevelopers: 0,
    totalSnapshots: 0,
    importedSnapshots: 0,
    availableDevelopers: [],
    developers: [],
    hasSnapshots: false,
    lastImportedAtMs: null,
  };
}

export const TEAM_MODE_CATEGORIES = PRACTICE_GROUP_KEYS;
