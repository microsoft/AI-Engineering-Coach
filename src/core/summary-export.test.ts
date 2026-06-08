/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import {
  buildSummaryExport,
  renderSummaryMarkdown,
  renderSummaryJson,
  getSummaryExportFilenames,
  buildContextPackExport,
  buildContextPackExportFromAnalyzerAsync,
  renderContextPackJson,
  renderContextPackMarkdown,
  getContextPackExportFilenames,
} from './summary-export';
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

describe('context pack export', () => {
  const rawSession = {
    sessionId: 'session-1',
    workspaceId: 'workspace-1',
    workspaceName: 'Coach App',
    location: 'local',
    harness: 'Codex',
    creationDate: Date.UTC(2026, 4, 20),
    lastMessageDate: Date.UTC(2026, 4, 21),
    requestCount: 1,
    requests: [
      {
        requestId: 'request-1',
        timestamp: Date.UTC(2026, 4, 20, 10),
        messageText: `please fix this ${'without much context '.repeat(400)}`,
        responseText: `I changed the implementation ${'and explained details '.repeat(400)}`,
        isCanceled: false,
        agentName: 'Codex',
        agentMode: 'agent',
        modelId: 'gpt-5-codex',
        toolsUsed: ['apply_patch'],
        editedFiles: ['src/core/summary-export.ts'],
        referencedFiles: ['src/core/summary-export.test.ts'],
        slashCommand: '',
        variableKinds: {},
        customInstructions: [],
        skillsUsed: ['test-driven-development'],
        firstProgress: 1000,
        totalElapsed: 2000,
        messageLength: 6000,
        responseLength: 8000,
        userCode: [],
        aiCode: [{ language: 'typescript', loc: 12 }],
        toolConfirmations: [],
        promptTokens: 100,
        completionTokens: 200,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        compaction: null,
        todoSnapshot: null,
        workType: 'bug fix',
      },
    ],
  };

  const baseInput = {
    generatedAt: '2026-05-25T10:00:00.000Z',
    filter: { harness: 'Codex' },
    stats,
    codeProduction,
    dailyActivity,
    workLifeBalance,
    flowState,
    antiPatterns: {
      ...antiPatterns,
      patterns: antiPatterns.patterns.map(pattern => ({
        ...pattern,
        details: [
          {
            sessionId: 'session-1',
            workspace: 'Coach App',
            timestamp: Date.UTC(2026, 4, 20, 10),
            message: 'please fix this',
            model: 'gpt-5-codex',
          },
        ],
      })),
    },
    recommendations: [{ name: 'Prompt context', score: 62, status: 'needs-improvement' }],
    contextManagement: { contextHealthScore: 70, antiPatterns: [] },
    configHealth: { agenticReadiness: { score: 80, checklist: [] } },
    workflowOptimization: { totalRepetitions: 4, clusters: [] },
    sessionList: {
      total: 1,
      page: 1,
      pageSize: 50,
      sessions: [
        {
          sessionId: 'session-1',
          workspaceName: 'Coach App',
          workspaceId: 'workspace-1',
          creationDate: Date.UTC(2026, 4, 20),
          lastMessageDate: Date.UTC(2026, 4, 21),
          requestCount: 1,
          firstMessage: 'please fix this',
        },
      ],
    },
  };

  it('builds a safe context pack without raw session turns', () => {
    const report = buildContextPackExport({
      ...baseInput,
      mode: 'safe',
      rawSessions: [rawSession],
    });

    expect(report.kind).toBe('context-pack');
    expect(report.mode).toBe('safe');
    expect(report.summary.totals.sessions).toBe(7);
    expect(report.antiPatterns.patterns).toHaveLength(2);
    expect(report.antiPatterns.patterns[0].details).toHaveLength(1);
    expect(report.sessions?.total).toBe(1);
    expect(report.rawSessions).toBeUndefined();
  });

  it('builds a full context pack with bounded raw session turns', () => {
    const report = buildContextPackExport({
      ...baseInput,
      mode: 'full',
      rawSessions: [rawSession],
    });

    expect(report.rawSessions).toHaveLength(1);
    expect(report.rawSessions?.[0]?.requests).toHaveLength(1);
    expect(report.rawSessions?.[0]?.requests[0]?.prompt.length).toBeLessThanOrEqual(report.limits.textCharLimit + 20);
    expect(report.rawSessions?.[0]?.requests[0]?.response.length).toBeLessThanOrEqual(report.limits.textCharLimit + 20);
    expect(report.rawSessions?.[0]?.requests[0]?.toolsUsed).toEqual(['apply_patch']);
  });

  it('renders deterministic json, agent-focused markdown, and date-stamped filenames', () => {
    const report = buildContextPackExport({
      ...baseInput,
      mode: 'safe',
    });

    expect(JSON.parse(renderContextPackJson(report))).toEqual(report);

    const markdown = renderContextPackMarkdown(report);
    expect(markdown).toContain('# AI Engineer Coach Agent Context Pack');
    expect(markdown).toContain('Mode: safe');
    expect(markdown).toContain('## Agent Context Prompt');
    expect(markdown).toContain('Low Context Prompts');
    expect(markdown).toContain('Reference the relevant files and constraints.');

    expect(getContextPackExportFilenames('2026-05-25T10:00:00.000Z')).toEqual({
      markdown: 'ai-engineer-coach-context-pack-2026-05-25.md',
      json: 'ai-engineer-coach-context-pack-2026-05-25.json',
    });
  });

  it('loads raw full-mode sessions through an async session loader', async () => {
    const strippedSession = {
      ...rawSession,
      requests: rawSession.requests.map(request => ({
        ...request,
        messageText: request.messageText.slice(0, 20),
        responseText: '',
      })),
    };
    const analyzer = {
      getStats: () => stats,
      getCodeProduction: () => codeProduction,
      getDailyActivity: () => dailyActivity,
      getWorkLifeBalance: () => workLifeBalance,
      getFlowState: () => flowState,
      getAntiPatterns: () => antiPatterns,
      getSessions: () => baseInput.sessionList,
      getSessionDetail: () => strippedSession,
    };

    const report = await buildContextPackExportFromAnalyzerAsync(
      analyzer,
      'full',
      undefined,
      '2026-05-25T10:00:00.000Z',
      async sessionId => sessionId === rawSession.sessionId ? rawSession : null,
    );

    expect(report.rawSessions?.[0]?.requests[0]?.prompt).toContain('without much context');
    expect(report.rawSessions?.[0]?.requests[0]?.response).toContain('I changed the implementation');
  });

  it('explains when full mode has no raw session excerpts available', () => {
    const report = buildContextPackExport({
      ...baseInput,
      mode: 'full',
      rawSessions: [],
    });

    const markdown = renderContextPackMarkdown(report);

    expect(markdown).toContain('Full mode was requested');
    expect(markdown).toContain('raw prompt/response excerpts were not available');
  });
});
