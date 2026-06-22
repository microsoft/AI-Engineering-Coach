/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect } from 'vitest';
import { WorkflowAnalyzer } from './analyzer-workflows';
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
    messageLength: 50,
    responseLength: 100,
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

function createAnalyzer(sessions: Session[]): WorkflowAnalyzer {
  return new WorkflowAnalyzer(sessions, new Map());
}

describe('WorkflowAnalyzer', () => {
  describe('getWorkflowOptimization', () => {
    it('returns empty clusters for no sessions', () => {
      const analyzer = createAnalyzer([]);
      const result = analyzer.getWorkflowOptimization();
      expect(result.clusters).toEqual([]);
      expect(result.totalRepetitions).toBe(0);
      expect(result.estimatedTimeSavedMins).toBe(0);
      expect(result.topWorkspaces).toEqual([]);
    });

    it('returns empty clusters for sessions with short prompts', () => {
      const session = makeSession({
        requests: [
          makeRequest({ messageText: 'hi' }),
          makeRequest({ messageText: 'ok' }),
        ],
        lastMessageDate: Date.now(),
      });
      const analyzer = createAnalyzer([session]);
      const result = analyzer.getWorkflowOptimization();
      expect(result.clusters).toEqual([]);
    });

    it('filters noise messages', () => {
      const now = Date.now();
      const sessions = Array.from({ length: 5 }, () =>
        makeSession({
          requests: [makeRequest({ messageText: 'continue', timestamp: now })],
          lastMessageDate: now,
        })
      );
      const analyzer = createAnalyzer(sessions);
      const result = analyzer.getWorkflowOptimization();
      expect(result.clusters).toEqual([]);
    });

    it('filters harness-injected AGENTS.md context as noise', () => {
      const now = Date.now();
      const injected = '# AGENTS.md instructions for /home/me/project\n\n<INSTRUCTIONS>\nfollow repo conventions\n</INSTRUCTIONS>';
      const sessions = Array.from({ length: 5 }, (_, i) =>
        makeSession({
          sessionId: `inj-${i}`,
          requests: [makeRequest({ messageText: injected, timestamp: now + i * 1000 })],
          lastMessageDate: now + i * 1000,
        })
      );
      const analyzer = createAnalyzer(sessions);
      const result = analyzer.getWorkflowOptimization();
      expect(result.clusters).toEqual([]);
    });

    it('clusters repeated similar prompts', () => {
      const now = Date.now();
      // Need at least 3 occurrences with same fingerprint
      const repeatedPrompt = 'please refactor the authentication module to use dependency injection';
      const sessions = Array.from({ length: 5 }, (_, i) =>
        makeSession({
          sessionId: `s${i}`,
          requests: [
            makeRequest({ messageText: repeatedPrompt, timestamp: now + i * 1000 }),
          ],
          lastMessageDate: now + i * 1000,
        })
      );
      const analyzer = createAnalyzer(sessions);
      const result = analyzer.getWorkflowOptimization();
      // Should find at least one cluster
      expect(result.clusters.length).toBeGreaterThanOrEqual(1);
      expect(result.totalRepetitions).toBeGreaterThanOrEqual(3);
      expect(result.estimatedTimeSavedMins).toBeGreaterThan(0);
    });

    it('builds skill drafts for clusters', () => {
      const now = Date.now();
      const repeatedPrompt = 'generate unit tests for the user service module with jest and mocking';
      const sessions = Array.from({ length: 4 }, (_, i) =>
        makeSession({
          sessionId: `s${i}`,
          workspaceName: 'test-project',
          requests: [
            makeRequest({ messageText: repeatedPrompt, timestamp: now + i * 1000 }),
          ],
          lastMessageDate: now + i * 1000,
        })
      );
      const analyzer = createAnalyzer(sessions);
      const result = analyzer.getWorkflowOptimization();
      if (result.clusters.length > 0) {
        const cluster = result.clusters[0];
        expect(cluster.skillDraft).toContain('# Skill:');
        expect(cluster.skillDraft).toContain('## When to use');
        expect(cluster.skillDraft).toContain('## Steps');
        expect(cluster.skillDraft).toContain('## Example prompts');
      }
    });

    it('tracks workspaces per cluster', () => {
      const now = Date.now();
      const repeatedPrompt = 'run the database migration scripts and verify the schema changes';
      const sessions = [
        makeSession({ sessionId: 's1', workspaceName: 'project-a', requests: [makeRequest({ messageText: repeatedPrompt, timestamp: now })], lastMessageDate: now }),
        makeSession({ sessionId: 's2', workspaceName: 'project-b', requests: [makeRequest({ messageText: repeatedPrompt, timestamp: now + 1000 })], lastMessageDate: now + 1000 }),
        makeSession({ sessionId: 's3', workspaceName: 'project-a', requests: [makeRequest({ messageText: repeatedPrompt, timestamp: now + 2000 })], lastMessageDate: now + 2000 }),
      ];
      const analyzer = createAnalyzer(sessions);
      const result = analyzer.getWorkflowOptimization();
      if (result.clusters.length > 0) {
        expect(result.clusters[0].workspaces.length).toBeGreaterThanOrEqual(1);
        expect(result.topWorkspaces.length).toBeGreaterThanOrEqual(1);
      }
    });

    it('computes cancel rate within clusters', () => {
      const now = Date.now();
      const repeatedPrompt = 'deploy the application to staging environment and verify health checks';
      const sessions = Array.from({ length: 4 }, (_, i) =>
        makeSession({
          sessionId: `s${i}`,
          requests: [makeRequest({ messageText: repeatedPrompt, timestamp: now + i * 1000, isCanceled: i < 2 })],
          lastMessageDate: now + i * 1000,
        })
      );
      const analyzer = createAnalyzer(sessions);
      const result = analyzer.getWorkflowOptimization();
      if (result.clusters.length > 0) {
        expect(result.clusters[0].cancelRate).toBeGreaterThanOrEqual(0);
        expect(result.clusters[0].cancelRate).toBeLessThanOrEqual(100);
      }
    });

    it('handles very long messages as noise', () => {
      const now = Date.now();
      const longMessage = 'x'.repeat(2500);
      const sessions = Array.from({ length: 5 }, (_, i) =>
        makeSession({
          sessionId: `s${i}`,
          requests: [makeRequest({ messageText: longMessage, timestamp: now + i * 1000 })],
          lastMessageDate: now + i * 1000,
        })
      );
      const analyzer = createAnalyzer(sessions);
      const result = analyzer.getWorkflowOptimization();
      expect(result.clusters).toEqual([]);
    });

    it('filters system messages', () => {
      const now = Date.now();
      const sessions = Array.from({ length: 5 }, (_, i) =>
        makeSession({
          sessionId: `s${i}`,
          requests: [makeRequest({ messageText: 'system authentication token expired', timestamp: now + i * 1000 })],
          lastMessageDate: now + i * 1000,
        })
      );
      const analyzer = createAnalyzer(sessions);
      const result = analyzer.getWorkflowOptimization();
      expect(result.clusters).toEqual([]);
    });
  });
});
