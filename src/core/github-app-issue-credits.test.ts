/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { loadGitHubAppIssueCredits } from './github-app-issue-credits';
import {
  NANO_AIU_PER_AI_CREDIT,
  aggregateGitHubAppIssueCredits,
} from './github-app-issue-credit-model';

describe('GitHub App issue credit aggregation', () => {
  it('reconciles every workspace session path and de-duplicates aliases', () => {
    const metrics = aggregateGitHubAppIssueCredits({
      workspaceIssues: [
        { workspaceId: 'workspace-1', repository: 'microsoft/AI-Engineering-Coach', issueNumber: 42 },
      ],
      workspaceSessions: [
        { workspaceId: 'workspace-1', sessionId: 'workspace-session' },
        { workspaceId: 'workspace-1', sessionId: 'alias-session' },
        { workspaceId: 'workspace-1', sessionId: 'creator-session' },
        { workspaceId: 'workspace-1', sessionId: 'coordinating-session' },
        { workspaceId: 'workspace-1', sessionId: 'alias-session' },
      ],
      sessionIssues: [],
      sessionUsage: [
        { sessionId: 'workspace-session', totalNanoAiu: NANO_AIU_PER_AI_CREDIT },
        { sessionId: 'alias-session', totalNanoAiu: 2 * NANO_AIU_PER_AI_CREDIT },
        { sessionId: 'creator-session', totalNanoAiu: 3 * NANO_AIU_PER_AI_CREDIT },
        { sessionId: 'coordinating-session', totalNanoAiu: 4 * NANO_AIU_PER_AI_CREDIT },
      ],
    });

    expect(metrics.issues).toEqual([{
      repository: 'microsoft/AI-Engineering-Coach',
      issueNumber: 42,
      linkedSessionCount: 4,
      pricedSessionCount: 4,
      estimatedCredits: 10,
    }]);
    expect(metrics).toMatchObject({
      linkedSessionCount: 4,
      pricedSessionCount: 4,
      estimatedCredits: 10,
    });
  });

  it('aggregates one issue across workspaces without double-counting shared sessions', () => {
    const metrics = aggregateGitHubAppIssueCredits({
      workspaceIssues: [
        { workspaceId: 'workspace-1', repository: 'microsoft/repo', issueNumber: 7 },
        { workspaceId: 'workspace-2', repository: 'Microsoft/Repo', issueNumber: 7 },
      ],
      workspaceSessions: [
        { workspaceId: 'workspace-1', sessionId: 'shared-session' },
        { workspaceId: 'workspace-1', sessionId: 'session-1' },
        { workspaceId: 'workspace-2', sessionId: 'shared-session' },
        { workspaceId: 'workspace-2', sessionId: 'session-2' },
      ],
      sessionIssues: [],
      sessionUsage: [
        { sessionId: 'shared-session', totalNanoAiu: NANO_AIU_PER_AI_CREDIT },
        { sessionId: 'session-1', totalNanoAiu: 2 * NANO_AIU_PER_AI_CREDIT },
        { sessionId: 'session-2', totalNanoAiu: 3 * NANO_AIU_PER_AI_CREDIT },
      ],
    });

    expect(metrics.issues).toHaveLength(1);
    expect(metrics.issues[0]).toMatchObject({
      linkedSessionCount: 3,
      pricedSessionCount: 3,
      estimatedCredits: 6,
    });
  });

  it('uses linked session references when workspace issue fields are empty', () => {
    const metrics = aggregateGitHubAppIssueCredits({
      workspaceIssues: [],
      workspaceSessions: [
        { workspaceId: 'workspace-1', sessionId: 'session-with-reference' },
        { workspaceId: 'workspace-1', sessionId: 'related-session' },
      ],
      sessionIssues: [
        { sessionId: 'session-with-reference', repository: 'github/github-app', refValue: '15765', source: 'reference' },
        { sessionId: 'unrelated-session', repository: 'github/unrelated', refValue: '99', source: 'reference' },
      ],
      sessionUsage: [
        { sessionId: 'session-with-reference', totalNanoAiu: NANO_AIU_PER_AI_CREDIT },
        { sessionId: 'related-session', totalNanoAiu: NANO_AIU_PER_AI_CREDIT },
        { sessionId: 'unrelated-session', totalNanoAiu: 100 * NANO_AIU_PER_AI_CREDIT },
      ],
    });

    expect(metrics.issues).toEqual([{
      repository: 'github/github-app',
      issueNumber: 15765,
      linkedSessionCount: 2,
      pricedSessionCount: 2,
      estimatedCredits: 2,
    }]);
  });

  it('does not replace a direct issue with unrelated session references', () => {
    const metrics = aggregateGitHubAppIssueCredits({
      workspaceIssues: [
        { workspaceId: 'workspace-1', repository: 'microsoft/repo', issueNumber: 10 },
      ],
      workspaceSessions: [
        { workspaceId: 'workspace-1', sessionId: 'session-1' },
      ],
      sessionIssues: [
        { sessionId: 'session-1', repository: 'microsoft/repo', refValue: '999', source: 'reference' },
      ],
      sessionUsage: [
        { sessionId: 'session-1', totalNanoAiu: NANO_AIU_PER_AI_CREDIT },
      ],
    });

    expect(metrics.issues.map(issue => issue.issueNumber)).toEqual([10]);
  });

  it('does not attribute an ambiguous workspace to every referenced issue', () => {
    const metrics = aggregateGitHubAppIssueCredits({
      workspaceIssues: [],
      workspaceSessions: [
        { workspaceId: 'workspace-1', sessionId: 'session-1' },
        { workspaceId: 'workspace-1', sessionId: 'session-2' },
      ],
      sessionIssues: [
        { sessionId: 'session-1', repository: 'microsoft/repo', refValue: '10', source: 'reference' },
        { sessionId: 'session-2', repository: 'microsoft/repo', refValue: '11', source: 'reference' },
      ],
      sessionUsage: [
        { sessionId: 'session-1', totalNanoAiu: NANO_AIU_PER_AI_CREDIT },
        { sessionId: 'session-2', totalNanoAiu: NANO_AIU_PER_AI_CREDIT },
      ],
    });

    expect(metrics).toEqual({
      issues: [],
      linkedSessionCount: 0,
      pricedSessionCount: 0,
      estimatedCredits: 0,
    });
  });

  it('counts explicit pasted issue links and de-duplicates repeated URLs', () => {
    const metrics = aggregateGitHubAppIssueCredits({
      workspaceIssues: [],
      workspaceSessions: [
        { workspaceId: 'workspace-1', sessionId: 'session-1' },
      ],
      sessionIssues: [{
        sessionId: 'session-1',
        repository: 'fallback/repo',
        refValue: 'Work on https://github.com/microsoft/AI-Engineering-Coach/issues/208 and https://github.com/microsoft/AI-Engineering-Coach/issues/208.',
        source: 'pasted-link',
      }],
      sessionUsage: [
        { sessionId: 'session-1', totalNanoAiu: NANO_AIU_PER_AI_CREDIT },
      ],
    });

    expect(metrics.issues).toEqual([{
      repository: 'microsoft/AI-Engineering-Coach',
      issueNumber: 208,
      linkedSessionCount: 1,
      pricedSessionCount: 1,
      estimatedCredits: 1,
    }]);
  });

  it('keeps multiple explicit pasted issue links while de-duplicating the summary', () => {
    const metrics = aggregateGitHubAppIssueCredits({
      workspaceIssues: [],
      workspaceSessions: [
        { workspaceId: 'workspace-1', sessionId: 'session-1' },
      ],
      sessionIssues: [{
        sessionId: 'session-1',
        repository: null,
        refValue: 'https://github.com/github/app/issues/3034 then https://github.com/github/app/issues/3013',
        source: 'pasted-link',
      }],
      sessionUsage: [
        { sessionId: 'session-1', totalNanoAiu: NANO_AIU_PER_AI_CREDIT },
      ],
    });

    expect(metrics.issues.map(issue => issue.issueNumber).sort()).toEqual([3013, 3034]);
    expect(metrics.issues.every(issue => issue.estimatedCredits === 1)).toBe(true);
    expect(metrics).toMatchObject({
      linkedSessionCount: 1,
      pricedSessionCount: 1,
      estimatedCredits: 1,
    });
  });

  it('keeps valid partial data and ignores malformed rows', () => {
    const metrics = aggregateGitHubAppIssueCredits({
      workspaceIssues: [
        null,
        { workspaceId: '', repository: 'microsoft/repo', issueNumber: 1 },
        { workspaceId: 'workspace-1', repository: null, issueNumber: 1 },
      ],
      workspaceSessions: [
        { workspaceId: 'workspace-1', sessionId: 'session-1' },
        { workspaceId: 'workspace-1', sessionId: null },
      ],
      sessionIssues: [
        { sessionId: 'session-1', repository: 'microsoft/repo', refValue: '12', source: 'reference' },
        { sessionId: 'session-1', repository: 'microsoft/repo', refValue: 'mentioned #13', source: 'reference' },
        { sessionId: 'session-2', repository: null, refValue: '14', source: 'reference' },
      ],
      sessionUsage: [
        { sessionId: 'session-1', totalNanoAiu: NANO_AIU_PER_AI_CREDIT },
        { sessionId: 'session-1', totalNanoAiu: -1 },
        { sessionId: null, totalNanoAiu: NANO_AIU_PER_AI_CREDIT },
      ],
    });

    expect(metrics.issues).toEqual([{
      repository: 'microsoft/repo',
      issueNumber: 12,
      linkedSessionCount: 1,
      pricedSessionCount: 1,
      estimatedCredits: 1,
    }]);
  });
});

describe('GitHub App issue credit availability', () => {
  it('does not show the page when the GitHub App database is absent', async () => {
    const snapshot = await loadGitHubAppIssueCredits({
      databasePath: path.join(os.tmpdir(), 'missing-data.db'),
      sessionStorePath: path.join(os.tmpdir(), 'missing-session-store.db'),
      exists: () => false,
      query: () => Promise.reject(new Error('query should not run')),
    });

    expect(snapshot).toEqual({ status: 'absent' });
  });

  it('reports unavailable credit data when the session store is absent', async () => {
    const databasePath = path.join(os.tmpdir(), 'data.db');
    const snapshot = await loadGitHubAppIssueCredits({
      databasePath,
      sessionStorePath: path.join(os.tmpdir(), 'missing-session-store.db'),
      exists: filePath => filePath === databasePath,
      query: () => Promise.reject(new Error('query should not run')),
    });

    expect(snapshot).toEqual({ status: 'unavailable' });
  });

  it('loads all four local data sets', async () => {
    const databasePath = path.join(os.tmpdir(), 'data.db');
    const sessionStorePath = path.join(os.tmpdir(), 'session-store.db');
    const queries: string[] = [];
    const snapshot = await loadGitHubAppIssueCredits({
      databasePath,
      sessionStorePath,
      exists: () => true,
      query: (_requestedPath, sql) => {
        queries.push(sql);
        if (sql.includes('source_issue_repo_full_name')) {
          return Promise.resolve(JSON.stringify([
            { workspaceId: 'workspace-1', repository: 'microsoft/repo', issueNumber: 3 },
          ]));
        }
        if (sql.includes('coordinating_creator_session_id')) {
          return Promise.resolve(JSON.stringify([
            { workspaceId: 'workspace-1', sessionId: 'session-1' },
          ]));
        }
        if (sql.includes("refs.ref_type = 'issue'")) return Promise.resolve('');
        if (sql.includes('SUM(total_nano_aiu)')) {
          return Promise.resolve(JSON.stringify([
            { sessionId: 'session-1', totalNanoAiu: NANO_AIU_PER_AI_CREDIT },
          ]));
        }
        return Promise.reject(new Error('Unexpected query'));
      },
    });

    expect(queries).toHaveLength(4);
    expect(queries.find(sql => sql.includes('source_issue_repo_full_name'))).toContain('NOT EXISTS');
    expect(snapshot).toEqual({
      status: 'ready',
      metrics: {
        issues: [{
          repository: 'microsoft/repo',
          issueNumber: 3,
          linkedSessionCount: 1,
          pricedSessionCount: 1,
          estimatedCredits: 1,
        }],
        linkedSessionCount: 1,
        pricedSessionCount: 1,
        estimatedCredits: 1,
      },
    });
  });
});
