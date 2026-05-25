/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildTeamModeSnapshot, normalizeTeamModeSettings, readTeamModeSettings } from './team-mode';
import type { DateFilter, TeamModeSnapshot } from './types';
import type { AntiPatternData, AiCreditData, ContextManagementData, FlowStateData, SessionRequest } from './types';

describe('Team Mode settings', () => {
  it('fills in safe defaults when no settings are provided', () => {
    expect(normalizeTeamModeSettings()).toEqual({
      enabled: false,
      serverUrl: '',
      developerId: '',
    });
  });

  it('trims and normalizes explicit settings', () => {
    expect(normalizeTeamModeSettings({
      enabled: true,
      serverUrl: '  https://team.example.com/api  ',
      developerId: '  dev-123  ',
    })).toEqual({
      enabled: true,
      serverUrl: 'https://team.example.com/api',
      developerId: 'dev-123',
    });
  });

  it('reads Team Mode settings from a VS Code-style configuration object', () => {
    const settings = readTeamModeSettings({
      get: <T>(key: string, defaultValue?: T): T => {
        const values: Record<string, unknown> = {
          'teamMode.enabled': true,
          'teamMode.serverUrl': 'https://team.example.com/api',
          'teamMode.developerId': 'dev-123',
        };
        return (values[key] ?? defaultValue) as T;
      },
    });

    expect(settings).toEqual({
      enabled: true,
      serverUrl: 'https://team.example.com/api',
      developerId: 'dev-123',
    });
  });

  it('declares the Team Mode settings surface in package.json', () => {
    const manifestPath = path.resolve(process.cwd(), 'package.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as {
      contributes?: {
        configuration?: {
          properties?: Record<string, { type?: string; default?: unknown; description?: string }>;
        };
      };
    };

    const properties = manifest.contributes?.configuration?.properties ?? {};

    expect(properties['aiEngineerCoach.teamMode.enabled']).toMatchObject({
      type: 'boolean',
      default: false,
    });
    expect(properties['aiEngineerCoach.teamMode.serverUrl']).toMatchObject({
      type: 'string',
      default: '',
    });
    expect(properties['aiEngineerCoach.teamMode.developerId']).toMatchObject({
      type: 'string',
      default: '',
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
      messageLength: 13,
      responseLength: 4,
      agentName: 'copilot',
      modelId: 'gpt-4.1',
      toolsUsed: [],
      editedFiles: [],
      referencedFiles: [],
      preview: 'refactor this',
      loc: 0,
      workType: 'refactor',
      variableKinds: {},
      customInstructions: [],
      skillsUsed: [],
      isCanceled: false,
    } as unknown as SessionRequest;
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

    const flowState: FlowStateData = {
      days: [],
      overallFlowScore: 0,
      avgFollowUpSec: 0,
      avgBlockMin: 0,
      deepFlowDays: 0,
      totalDays: 0,
      weeklyTrend: { labels: [], scores: [] },
      hourlyFlow: Array<number>(24).fill(0),
      suggestions: [],
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
      getFlowState: (_filter?: DateFilter) => flowState,
    };
  }

  it('assembles a privacy-safe numeric snapshot from analyzer outputs', () => {
    const snapshot = buildTeamModeSnapshot(makeAnalyzerLike(), {
      enabled: true,
      serverUrl: 'https://team.example.com/api',
      developerId: 'dev-123',
    });

    expect(snapshot.developerId).toBe('dev-123');
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
    expect(snapshot.weeklyTrend.weekStartMs).toHaveLength(2);
    expect(snapshot.weeklyTrend.scoresByCategory['context-management']).toEqual([60, 65]);
    expect(JSON.stringify(snapshot)).not.toContain('raw prompt text');
    expect(JSON.stringify(snapshot)).not.toContain('session detail');
  });
});
