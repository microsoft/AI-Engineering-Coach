/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { buildTeamModeSnapshot, normalizeTeamModeSettings, readTeamModeSettings } from './team-mode';
import type { DateFilter, SessionRequest } from './types';
import type { AntiPatternData, AiCreditData, ContextManagementData } from './types';

describe('Team Mode settings', () => {
  it('fills in safe defaults when no settings are provided', () => {
    expect(normalizeTeamModeSettings()).toEqual({
      enabled: false,
      aggregationGranularity: 'weekly',
      detailLevel: 'category-only',
    });
  });

  it('normalizes the enabled flag', () => {
    expect(normalizeTeamModeSettings({ enabled: true })).toEqual({
      enabled: true,
      aggregationGranularity: 'weekly',
      detailLevel: 'category-only',
    });
  });

  it('normalizes aggregation preferences', () => {
    expect(normalizeTeamModeSettings({
      enabled: true,
      aggregationGranularity: 'monthly',
      detailLevel: 'expanded',
    })).toEqual({
      enabled: true,
      aggregationGranularity: 'monthly',
      detailLevel: 'expanded',
    });
  });

  it('reads Team Mode settings from a VS Code-style configuration object', () => {
    const settings = readTeamModeSettings({
      get: <T>(key: string, defaultValue?: T): T => {
        const values: Record<string, unknown> = {
          'teamMode.enabled': true,
          'teamMode.aggregationGranularity': 'daily',
          'teamMode.detailLevel': 'expanded',
        };
        return (values[key] ?? defaultValue) as T;
      },
    });

    expect(settings).toEqual({
      enabled: true,
      aggregationGranularity: 'daily',
      detailLevel: 'expanded',
    });
  });
});

describe('Team Mode snapshot assembly', () => {
  function makeRequest(timestamp: number): SessionRequest {
    return {
      requestId: `req-${timestamp}`,
      timestamp,
      messageText: 'refactor this',
      responseText: 'done',
      isCanceled: false,
      agentName: 'copilot',
      agentMode: 'agent',
      modelId: 'gpt-4.1',
      toolsUsed: [],
      editedFiles: [],
      referencedFiles: [],
      slashCommand: '',
      variableKinds: {},
      customInstructions: [],
      skillsUsed: [],
      firstProgress: null,
      totalElapsed: null,
      messageLength: 13,
      responseLength: 4,
      userCode: [],
      aiCode: [],
      toolConfirmations: [],
      promptTokens: null,
      completionTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      compaction: null,
      todoSnapshot: null,
      workType: 'refactor',
      endState: 'no-data',
    };
  }

  function makeAnalyzerLike() {
    const antiPatterns: AntiPatternData = {
      patterns: [
        {
          id: 'lazy-prompting',
          name: 'Lazy Prompting',
          severity: 'medium',
          group: 'prompt-quality',
          occurrences: 3,
          description: 'desc',
          suggestion: 'suggest',
          examples: ['raw prompt text'],
          details: [],
          weeklyHist: { labels: ['2026-05-12', '2026-05-19'], counts: [2, 1] },
        },
        {
          id: 'mega-sessions',
          name: 'Mega Sessions',
          severity: 'high',
          group: 'session-hygiene',
          occurrences: 2,
          description: 'desc',
          suggestion: 'suggest',
          examples: ['session detail'],
          details: [],
          weeklyHist: { labels: ['2026-05-12', '2026-05-19'], counts: [1, 1] },
        },
      ],
      totalOccurrences: 5,
      weeklyTrend: { labels: ['2026-05-12', '2026-05-19'], counts: [3, 2] },
      groupScores: [
        { group: 'prompt-quality', score: 70, wowPct: 2, momPct: 4, topIssue: 'prompt issue', improvements: [], patternCount: 3 },
        { group: 'session-hygiene', score: 80, wowPct: 1, momPct: 2, topIssue: 'session issue', improvements: [], patternCount: 2 },
        { group: 'code-review', score: 90, wowPct: 0, momPct: 1, topIssue: null, improvements: ['good'], patternCount: 0 },
        { group: 'tool-mastery', score: 60, wowPct: -1, momPct: 0, topIssue: 'tool issue', improvements: [], patternCount: 4 },
      ],
      weeklyScores: {
        labels: ['2026-05-12', '2026-05-19'],
        series: [
          { group: 'prompt-quality', scores: [68, 70] },
          { group: 'session-hygiene', scores: [78, 80] },
          { group: 'code-review', scores: [89, 90] },
          { group: 'tool-mastery', scores: [58, 60] },
          { group: 'context-management', scores: [60, 65] },
        ],
      },
    };

    const aiCredits: AiCreditData = {
      totalCredits: 12.5,
      totalInputTokens: 1000,
      totalOutputTokens: 500,
      totalCacheReadTokens: 25,
      totalCacheWriteTokens: 10,
      totalRequests: 10,
      countedRequests: 8,
      partialRequests: 1,
      pendingRequests: 1,
      noDataRequests: 0,
      delegatedRequests: 0,
      finalizableRequests: 9,
      missingPct: 11,
      avgCreditsPerRequest: 1.2,
      avgCreditsPerDay: 2.5,
      costByModel: {},
      daily: { labels: ['2026-05-12', '2026-05-19'], credits: [5, 7.5], cumulative: [5, 12.5], byModel: {} },
      weekly: { labels: ['2026-W20', '2026-W21'], credits: [5, 7.5], cumulative: [5, 12.5], byModel: {} },
      dailyTokensByWorkspace: { labels: ['2026-05-12', '2026-05-19'], byWorkspace: {} },
      dailyTokensByHarness: { labels: ['2026-05-12', '2026-05-19'], byHarness: {} },
      topRequests: [],
    };

    const contextManagement: ContextManagementData = {
      overallScore: 65,
      estimatedContextWindow: 128000,
      thresholds: { optimalUtilization: 60, limitedUtilization: 80, adaptive: false, sampleSize: 2 },
      workspaces: [],
      trend: [
        { label: '2026-05-12', avgUtilization: 40, compactions: 1, sessionsOverThreshold: 0 },
        { label: '2026-05-19', avgUtilization: 35, compactions: 0, sessionsOverThreshold: 0 },
      ],
      workspaceTrend: [],
      totalCompactions: 1,
      fullCompactions: 0,
      simpleCompactions: 1,
      sessionsWithTokenData: 2,
      totalSessions: 2,
      antiPatterns: [],
      tips: [],
    };

    const filterRequests = [
      makeRequest(new Date('2026-05-12T10:00:00Z').getTime()),
      makeRequest(new Date('2026-05-19T10:00:00Z').getTime()),
    ];

    return {
      filterRequests: (_filter?: DateFilter) => filterRequests,
      getAntiPatterns: (_filter?: DateFilter) => antiPatterns,
      getAiCredits: (_filter?: DateFilter) => aiCredits,
      getContextManagement: (_filter?: DateFilter) => contextManagement,
    };
  }

  it('assembles a privacy-safe numeric snapshot from analyzer outputs', () => {
    const snapshot = buildTeamModeSnapshot(makeAnalyzerLike(), {
      fromDate: '2026-05-01',
      toDate: '2026-05-31',
    }, {
      enabled: false,
      aggregationGranularity: 'monthly',
      detailLevel: 'expanded',
    });

    expect(snapshot.categoryScores).toMatchObject({
      'prompt-quality': 70,
      'session-hygiene': 80,
      'code-review': 90,
      'tool-mastery': 60,
      'context-management': 65,
    });
    expect(snapshot.tokenUsage).toMatchObject({
      requests: 10,
      countedRequests: 8,
      partialRequests: 1,
      pendingRequests: 1,
      noDataRequests: 0,
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 25,
      cacheWriteTokens: 10,
      totalTokens: 1535,
      missingPct: 11,
    });
    expect(snapshot.antiPatterns.totalOccurrences).toBe(5);
    expect(snapshot.antiPatterns.bySeverity).toEqual({
      low: 0,
      medium: 3,
      high: 2,
    });
    expect(snapshot.antiPatterns.topViolations[0]).toEqual({
      ruleId: 'lazy-prompting',
      severity: 'medium',
      count: 3,
    });
    expect(snapshot.weeklyDeltas).toEqual({
      'prompt-quality': 2,
      'session-hygiene': 2,
      'code-review': 1,
      'tool-mastery': 2,
      'context-management': 5,
    });
    expect(snapshot.aggregation).toEqual({
      granularity: 'monthly',
      detailLevel: 'expanded',
    });
    expect(snapshot.categoryBreakdown['prompt-quality']).toMatchObject({
      score: 70,
      wowPct: 2,
      momPct: 4,
      patternCount: 3,
    });
    expect(JSON.stringify(snapshot)).not.toContain('raw prompt text');
    expect(JSON.stringify(snapshot)).not.toContain('session detail');
  });
});
