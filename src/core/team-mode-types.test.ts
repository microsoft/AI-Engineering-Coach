/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { createEmptyTeamModeSnapshot } from './types/team-mode-types';
import { PRACTICE_GROUPS } from './types';

describe('Team Mode snapshot model', () => {
  it('creates an empty privacy-safe snapshot with all expected numeric buckets', () => {
    const snapshot = createEmptyTeamModeSnapshot();

    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.developerId).toBe('');
    expect(snapshot.categoryScores).toEqual({
      'prompt-quality': 0,
      'session-hygiene': 0,
      'code-review': 0,
      'tool-mastery': 0,
      'context-management': 0,
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
      missingPct: 0,
    });
    expect(snapshot.antiPatterns.bySeverity).toEqual({
      low: 0,
      medium: 0,
      high: 0,
    });
    expect(snapshot.antiPatterns.byGroup).toEqual({
      'prompt-quality': 0,
      'session-hygiene': 0,
      'code-review': 0,
      'tool-mastery': 0,
      'context-management': 0,
    });
    expect(snapshot.antiPatterns.topViolations).toEqual([]);
    expect(snapshot.weeklyTrend.weekStartMs).toEqual([]);
    expect(snapshot.weeklyTrend.scoresByCategory).toEqual({
      'prompt-quality': [],
      'session-hygiene': [],
      'code-review': [],
      'tool-mastery': [],
      'context-management': [],
    });
  });

  it('keeps the category order aligned with the dashboard group definitions', () => {
    const snapshot = createEmptyTeamModeSnapshot();

    expect(Object.keys(snapshot.categoryScores)).toEqual(Object.keys(PRACTICE_GROUPS));
  });
});
