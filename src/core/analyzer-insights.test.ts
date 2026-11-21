/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect } from 'vitest';
import { InsightsAnalyzer } from './analyzer-insights';
import { Session, SessionRequest } from './types/session-types';

function makeRequest(overrides: Partial<SessionRequest> = {}): SessionRequest {
  return {
    requestId: 'req-' + Math.random().toString(36).slice(2, 8),
    timestamp: Date.now(),
    messageText: 'test message',
    responseText: 'test response',
    isCanceled: false,
    agentName: 'Copilot',
    agentMode: 'chat',
    modelId: 'gpt-4.1',
    toolsUsed: [],
    editedFiles: [],
    referencedFiles: [],
    slashCommand: '',
    variableKinds: {},
    customInstructions: [],
    skillsUsed: [],
    firstProgress: 100,
    totalElapsed: 2000,
    messageLength: 12,
    responseLength: 13,
    userCode: [],
    aiCode: [],
    toolConfirmations: [],
    promptTokens: null,
    completionTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    compaction: null,
    todoSnapshot: null,
    workType: 'other',
    ...overrides,
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  const now = Date.now();
  const base: Session = {
    sessionId: 'sess-' + Math.random().toString(36).slice(2, 8),
    workspaceId: 'ws-1',
    workspaceName: 'my-project',
    location: '/projects/my-project',
    harness: 'Local Agent',
    creationDate: now - 3600000,
    lastMessageDate: now,
    requestCount: 1,
    requests: [makeRequest()],
    ...overrides,
  };
  base.requestCount = base.requests.length;
  return base;
}

function createAnalyzer(sessions: Session[]): InsightsAnalyzer {
  return new InsightsAnalyzer(sessions, new Map());
}

describe('InsightsAnalyzer', () => {
  describe('getInsights', () => {
    it('returns all insight categories', () => {
      const analyzer = createAnalyzer([]);
      const result = analyzer.getInsights();
      expect(result).toHaveProperty('learningVelocity');
      expect(result).toHaveProperty('intentClassification');
      expect(result).toHaveProperty('specDriven');
      expect(result).toHaveProperty('productionReview');
      expect(result).toHaveProperty('sustainablePace');
      expect(result).toHaveProperty('promptMaturity');
      expect(result).toHaveProperty('migrationReadiness');
    });
  });

  describe('learningVelocity', () => {
    it('returns zeros for empty data', () => {
      const analyzer = createAnalyzer([]);
      const result = analyzer.getInsights().learningVelocity;
      expect(result.totalLanguagesEncountered).toBe(0);
      expect(result.totalNewLanguagesLearned).toBe(0);
      expect(result.weeklyLanguages).toEqual([]);
    });

    it('tracks languages from code blocks', () => {
      const ts = new Date('2024-03-15T10:00:00').getTime();
      const session = makeSession({
        requests: [
          makeRequest({
            timestamp: ts,
            aiCode: [{ language: 'TypeScript', loc: 10 }],
            userCode: [{ language: 'Python', loc: 5 }],
          }),
        ],
        lastMessageDate: ts,
      });
      const analyzer = createAnalyzer([session]);
      const result = analyzer.getInsights().learningVelocity;
      expect(result.totalLanguagesEncountered).toBe(2);
      expect(result.topLanguages.map(l => l.language)).toContain('typescript');
      expect(result.topLanguages.map(l => l.language)).toContain('python');
    });

    it('tracks new languages over weeks', () => {
      const week1 = new Date('2024-03-11T10:00:00').getTime();
      const week2 = new Date('2024-03-18T10:00:00').getTime();
      const sessions = [
        makeSession({
          requests: [makeRequest({ timestamp: week1, aiCode: [{ language: 'typescript', loc: 10 }] })],
          lastMessageDate: week1,
        }),
        makeSession({
          requests: [makeRequest({ timestamp: week2, aiCode: [{ language: 'rust', loc: 5 }] })],
          lastMessageDate: week2,
        }),
      ];
      const analyzer = createAnalyzer(sessions);
      const result = analyzer.getInsights().learningVelocity;
      expect(result.totalLanguagesEncountered).toBe(2);
      expect(result.weeklyLanguages.length).toBe(2);
      // Week 2 should have rust as new
      expect(result.weeklyLanguages[1].newLanguages).toContain('rust');
    });
  });

  describe('intentClassification', () => {
    it('classifies implementation sessions', () => {
      const ts = new Date('2024-03-15T10:00:00').getTime();
      const session = makeSession({
        requests: [
          makeRequest({
            timestamp: ts,
            messageText: 'add a login button',
            aiCode: [{ language: 'ts', loc: 20 }],
            editedFiles: ['src/login.ts'],
            workType: 'feature',
          }),
        ],
        lastMessageDate: ts,
      });
      const analyzer = createAnalyzer([session]);
      const result = analyzer.getInsights().intentClassification;
      expect(result.distribution.Implementation).toBeGreaterThan(0);
    });

    it('classifies debugging sessions', () => {
      const ts = new Date('2024-03-15T10:00:00').getTime();
      const session = makeSession({
        requests: [
          makeRequest({ timestamp: ts, messageText: 'fix the bug in login', slashCommand: 'fix' }),
          makeRequest({ timestamp: ts + 1000, messageText: 'there is an error when I click submit' }),
          makeRequest({ timestamp: ts + 2000, messageText: 'debug the crash on startup' }),
        ],
        lastMessageDate: ts + 2000,
      });
      const analyzer = createAnalyzer([session]);
      const result = analyzer.getInsights().intentClassification;
      expect(result.distribution.Debugging).toBeGreaterThan(0);
    });

    it('classifies planning sessions', () => {
      const ts = new Date('2024-03-15T10:00:00').getTime();
      const session = makeSession({
        requests: [
          makeRequest({ timestamp: ts, messageText: 'plan the architecture for auth module', agentMode: 'plan' }),
          makeRequest({ timestamp: ts + 1000, messageText: 'outline the approach for the migration', slashCommand: 'plan' }),
        ],
        lastMessageDate: ts + 1000,
      });
      const analyzer = createAnalyzer([session]);
      const result = analyzer.getInsights().intentClassification;
      expect(result.distribution.Planning).toBeGreaterThan(0);
    });

    it('classifies review sessions', () => {
      const ts = new Date('2024-03-15T10:00:00').getTime();
      const session = makeSession({
        requests: [
          makeRequest({ timestamp: ts, messageText: 'explain this function', slashCommand: 'explain' }),
          makeRequest({ timestamp: ts + 1000, messageText: 'review the code for security issues' }),
        ],
        lastMessageDate: ts + 1000,
      });
      const analyzer = createAnalyzer([session]);
      const result = analyzer.getInsights().intentClassification;
      expect(result.distribution.Review).toBeGreaterThan(0);
    });

    it('builds weekly distribution', () => {
      const ts = new Date('2024-03-15T10:00:00').getTime();
      const session = makeSession({
        requests: [makeRequest({ timestamp: ts })],
        lastMessageDate: ts,
      });
      const analyzer = createAnalyzer([session]);
      const result = analyzer.getInsights().intentClassification;
      expect(result.weeklyDistribution.labels.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('specDriven', () => {
    it('returns zeros for empty data', () => {
      const analyzer = createAnalyzer([]);
      const result = analyzer.getInsights().specDriven;
      expect(result.totalSessions).toBe(0);
      expect(result.specDrivenCount).toBe(0);
    });

    it('detects spec-driven session by file reference', () => {
      const ts = new Date('2024-03-15T10:00:00').getTime();
      const session = makeSession({
        requests: [
          makeRequest({ timestamp: ts, referencedFiles: ['requirements.md'] }),
          makeRequest({ timestamp: ts + 1000 }),
          makeRequest({ timestamp: ts + 2000 }),
        ],
        lastMessageDate: ts + 2000,
      });
      const analyzer = createAnalyzer([session]);
      const result = analyzer.getInsights().specDriven;
      expect(result.specDrivenCount).toBe(1);
    });

    it('detects spec-driven session by keywords', () => {
      const ts = new Date('2024-03-15T10:00:00').getTime();
      const session = makeSession({
        requests: [
          makeRequest({ timestamp: ts, messageText: 'Implement the requirements as specified in the spec document' }),
          makeRequest({ timestamp: ts + 1000 }),
          makeRequest({ timestamp: ts + 2000 }),
        ],
        lastMessageDate: ts + 2000,
      });
      const analyzer = createAnalyzer([session]);
      const result = analyzer.getInsights().specDriven;
      expect(result.specDrivenCount).toBe(1);
    });

    it('detects spec-driven session by plan mode', () => {
      const ts = new Date('2024-03-15T10:00:00').getTime();
      const session = makeSession({
        requests: [
          makeRequest({ timestamp: ts, agentMode: 'plan' }),
          makeRequest({ timestamp: ts + 1000 }),
          makeRequest({ timestamp: ts + 2000 }),
        ],
        lastMessageDate: ts + 2000,
      });
      const analyzer = createAnalyzer([session]);
      const result = analyzer.getInsights().specDriven;
      expect(result.specDrivenCount).toBe(1);
    });

    it('detects spec-driven by numbered list format', () => {
      const ts = new Date('2024-03-15T10:00:00').getTime();
      const session = makeSession({
        requests: [
          makeRequest({ timestamp: ts, messageText: '1. Create a login page\n2. Add validation\n3. Connect to API\n4. Handle errors' }),
          makeRequest({ timestamp: ts + 1000 }),
          makeRequest({ timestamp: ts + 2000 }),
        ],
        lastMessageDate: ts + 2000,
      });
      const analyzer = createAnalyzer([session]);
      const result = analyzer.getInsights().specDriven;
      expect(result.specDrivenCount).toBe(1);
    });

    it('requires at least 3 requests', () => {
      const ts = new Date('2024-03-15T10:00:00').getTime();
      const session = makeSession({
        requests: [
          makeRequest({ timestamp: ts, referencedFiles: ['spec.md'] }),
          makeRequest({ timestamp: ts + 1000 }),
        ],
        lastMessageDate: ts + 1000,
      });
      const analyzer = createAnalyzer([session]);
      const result = analyzer.getInsights().specDriven;
      expect(result.totalSessions).toBe(0);
    });
  });

  describe('productionReview', () => {
    it('returns zeros for no sessions', () => {
      const analyzer = createAnalyzer([]);
      const result = analyzer.getInsights().productionReview;
      expect(result.totalAiLoc).toBe(0);
      expect(result.estimatedReviewedLoc).toBe(0);
    });

    it('tracks AI-produced LOC', () => {
      const ts = new Date('2024-03-15T10:00:00').getTime();
      const session = makeSession({
        requests: [
          makeRequest({ timestamp: ts, aiCode: [{ language: 'ts', loc: 50 }] }),
        ],
        lastMessageDate: ts,
      });
      const analyzer = createAnalyzer([session]);
      const result = analyzer.getInsights().productionReview;
      expect(result.totalAiLoc).toBe(50);
    });

    it('detects reviewed code when gap exceeds threshold', () => {
      const ts = new Date('2024-03-15T10:00:00').getTime();
      // REVIEW_GAP_THRESHOLD_MS = 30000 (30 seconds)
      const session = makeSession({
        requests: [
          makeRequest({ timestamp: ts, aiCode: [{ language: 'ts', loc: 50 }], totalElapsed: 5000 }),
          makeRequest({ timestamp: ts + 40000 }), // 40s after, gap > 30s threshold
        ],
        lastMessageDate: ts + 40000,
      });
      const analyzer = createAnalyzer([session]);
      const result = analyzer.getInsights().productionReview;
      expect(result.estimatedReviewedLoc).toBe(50);
      expect(result.reviewRatio).toBeGreaterThan(0);
    });
  });

  describe('sustainablePace', () => {
    it('returns low burnout risk for normal work', () => {
      const ts = new Date('2024-03-13T10:00:00').getTime(); // Wednesday 10 AM
      const session = makeSession({
        requests: [makeRequest({ timestamp: ts })],
        lastMessageDate: ts,
      });
      const analyzer = createAnalyzer([session]);
      const result = analyzer.getInsights().sustainablePace;
      expect(result.burnoutRisk).toBe('low');
      expect(result.alerts).toHaveLength(0);
    });

    it('tracks late night and weekend requests', () => {
      // Late night request (11 PM)
      const lateTs = new Date('2024-03-13T23:00:00').getTime();
      // Weekend request
      const satTs = new Date('2024-03-16T10:00:00').getTime();
      const session = makeSession({
        requests: [
          makeRequest({ timestamp: lateTs }),
          makeRequest({ timestamp: satTs }),
        ],
        lastMessageDate: satTs,
      });
      const analyzer = createAnalyzer([session]);
      const result = analyzer.getInsights().sustainablePace;
      expect(result.weeklyTrend.lateNightReqs.some(v => v > 0)).toBe(true);
      expect(result.weeklyTrend.weekendReqs.some(v => v > 0)).toBe(true);
    });

    it('counts late nights, weekends and totals from typed prompts, and session length from every turn', () => {
      const wednesday = new Date('2024-03-13T10:00:00').getTime();
      const session = makeSession({
        requests: [
          makeRequest({ timestamp: wednesday }),
          makeRequest({ timestamp: new Date('2024-03-13T23:00:00').getTime(), nonHumanKind: 'autopilot' }),
          makeRequest({ timestamp: new Date('2024-03-16T10:00:00').getTime(), nonHumanKind: 'agent' }),
        ],
        lastMessageDate: new Date('2024-03-16T10:00:00').getTime(),
      });
      const result = createAnalyzer([session]).getInsights().sustainablePace;
      expect(result.weeklyTrend).toMatchObject({ lateNightReqs: [0], weekendReqs: [0], totalReqs: [1], avgSessionLength: [3] });
      expect(result.alerts).toHaveLength(0);
    });
  });

  describe('promptMaturity', () => {
    it('returns F grade for empty data', () => {
      const analyzer = createAnalyzer([]);
      const result = analyzer.getInsights().promptMaturity;
      expect(result.overallGrade).toBe('F');
      expect(result.score).toBe(0);
    });

    it('grades a well-structured prompt highly', () => {
      const ts = new Date('2024-03-15T10:00:00').getTime();
      const session = makeSession({
        requests: [
          makeRequest({
            timestamp: ts,
            messageText: `You must create a function that validates email addresses.
The function should return true for valid emails.
It must handle edge cases.
Ensure the output matches RFC 5322.
Verify the result with at least 3 test cases.
- test@example.com should be valid
- invalid@ should fail
- test@sub.domain.com should be valid`,
            messageLength: 300,
            referencedFiles: ['src/validators.ts'],
            userCode: [{ language: 'typescript', loc: 5 }],
          }),
        ],
        lastMessageDate: ts,
      });
      const analyzer = createAnalyzer([session]);
      const result = analyzer.getInsights().promptMaturity;
      expect(result.score).toBeGreaterThan(40);
    });

    it('grades a vague prompt poorly', () => {
      const ts = new Date('2024-03-15T10:00:00').getTime();
      const session = makeSession({
        requests: [
          makeRequest({
            timestamp: ts,
            messageText: 'fix the thing',
            messageLength: 13,
          }),
        ],
        lastMessageDate: ts,
      });
      const analyzer = createAnalyzer([session]);
      const result = analyzer.getInsights().promptMaturity;
      expect(result.score).toBeLessThan(40);
    });

    it('skips very short messages', () => {
      const ts = new Date('2024-03-15T10:00:00').getTime();
      const session = makeSession({
        requests: [makeRequest({ timestamp: ts, messageText: 'hi', messageLength: 2 })],
        lastMessageDate: ts,
      });
      const analyzer = createAnalyzer([session]);
      const result = analyzer.getInsights().promptMaturity;
      expect(result.overallGrade).toBe('F');
    });
  });

  describe('migrationReadiness', () => {
    it('returns empty for no sessions', () => {
      const analyzer = createAnalyzer([]);
      const result = analyzer.getInsights().migrationReadiness;
      expect(result.primaryHarness).toBe('');
      expect(result.readinessScore).toBe(0);
    });

    it('identifies primary harness', () => {
      const ts = new Date('2024-03-15T10:00:00').getTime();
      const sessions = [
        makeSession({ harness: 'Local Agent', requests: [makeRequest({ timestamp: ts })], lastMessageDate: ts }),
        makeSession({ harness: 'Local Agent', requests: [makeRequest({ timestamp: ts })], lastMessageDate: ts }),
        makeSession({ harness: 'Claude', requests: [makeRequest({ timestamp: ts })], lastMessageDate: ts }),
      ];
      const analyzer = createAnalyzer(sessions);
      const result = analyzer.getInsights().migrationReadiness;
      expect(result.primaryHarness).toBe('Local Agent');
    });

    it('tracks used features', () => {
      const ts = new Date('2024-03-15T10:00:00').getTime();
      const session = makeSession({
        harness: 'Local Agent',
        requests: [
          makeRequest({
            timestamp: ts,
            slashCommand: 'fix',
            editedFiles: ['a.ts', 'b.ts'],
            referencedFiles: ['c.ts'],
            customInstructions: ['be concise'],
          }),
        ],
        lastMessageDate: ts,
      });
      const analyzer = createAnalyzer([session]);
      const result = analyzer.getInsights().migrationReadiness;
      expect(result.featureUsage.some(f => f.used)).toBe(true);
      expect(result.readinessScore).toBeGreaterThan(0);
    });
  });
});
