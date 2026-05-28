/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { createEmptyTeamDashboardResponse, createEmptyTeamModeSnapshotFile, TEAM_MODE_CATEGORIES } from './types/team-mode-types';

describe('Team Mode snapshot model', () => {
  it('creates an empty privacy-safe snapshot with all expected numeric buckets', () => {
    const snapshot = createEmptyTeamModeSnapshotFile();

    expect(snapshot.schemaVersion).toBe(2);
    expect(snapshot.capturedAtMs).toBe(0);
    expect(snapshot.windowStartMs).toBe(0);
    expect(snapshot.windowEndMs).toBe(0);
    expect(snapshot.aggregation).toEqual({
      granularity: 'weekly',
      detailLevel: 'category-only',
    });
    expect(snapshot.categoryScores).toEqual({
      'prompt-quality': 0,
      'session-hygiene': 0,
      'code-review': 0,
      'tool-mastery': 0,
      'context-management': 0,
    });
    expect(snapshot.categoryBreakdown).toEqual({
      'prompt-quality': {
        score: 0,
        wowPct: 0,
        momPct: 0,
        patternCount: 0,
        topIssue: null,
        improvements: [],
      },
      'session-hygiene': {
        score: 0,
        wowPct: 0,
        momPct: 0,
        patternCount: 0,
        topIssue: null,
        improvements: [],
      },
      'code-review': {
        score: 0,
        wowPct: 0,
        momPct: 0,
        patternCount: 0,
        topIssue: null,
        improvements: [],
      },
      'tool-mastery': {
        score: 0,
        wowPct: 0,
        momPct: 0,
        patternCount: 0,
        topIssue: null,
        improvements: [],
      },
      'context-management': {
        score: 0,
        wowPct: 0,
        momPct: 0,
        patternCount: 0,
        topIssue: null,
        improvements: [],
      },
    });
    expect(snapshot.tokenUsage).toEqual({
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
    });
    expect(snapshot.antiPatterns).toEqual({
      totalOccurrences: 0,
      bySeverity: {
        low: 0,
        medium: 0,
        high: 0,
      },
      topViolations: [],
    });
    expect(snapshot.weeklyDeltas).toEqual({
      'prompt-quality': 0,
      'session-hygiene': 0,
      'code-review': 0,
      'tool-mastery': 0,
      'context-management': 0,
    });
  });

  it('keeps the category order aligned with the dashboard group definitions', () => {
    const snapshot = createEmptyTeamModeSnapshotFile();

    expect(Object.keys(snapshot.categoryScores)).toEqual(TEAM_MODE_CATEGORIES);
  });

  it('creates an empty dashboard response without access metadata', () => {
    const response = createEmptyTeamDashboardResponse();

    expect(response).toEqual({
      filters: {},
      selectedCategory: 'all',
      aggregation: {
        granularity: 'weekly',
        detailLevel: 'category-only',
        label: 'Weekly rollup',
        bucketCount: 0,
      },
      totalDevelopers: 0,
      totalSnapshots: 0,
      importedSnapshots: 0,
      availableDevelopers: [],
      developers: [],
      hasSnapshots: false,
      lastImportedAtMs: null,
    });
  });
});
