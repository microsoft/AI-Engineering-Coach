/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadGitHubAppMetrics,
  parseGitHubAppWorkspacePrCohorts,
} from './github-app-analytics';
import type { GitHubAppMetrics } from './types';

const APP_SCHEMA_SQL = `
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    session_type TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE workspaces (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    created_at TEXT NOT NULL,
    source_issue_number INTEGER,
    source_pr_number INTEGER,
    source_pr_merged_at TEXT,
    source_pr_state TEXT,
    created_pr_number INTEGER,
    created_pr_merged_at TEXT,
    created_pr_state TEXT
  );
  CREATE TABLE workspace_session_aliases (
    session_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE workspace_repo_contexts (
    workspace_id TEXT NOT NULL,
    source_issue_number INTEGER,
    source_pr_number INTEGER,
    source_pr_merged_at TEXT,
    source_pr_state TEXT,
    created_pr_number INTEGER,
    created_pr_merged_at TEXT,
    created_pr_state TEXT
  );
`;

const SESSION_STORE_SCHEMA_SQL = `
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    repository TEXT
  );
  CREATE TABLE session_refs (
    session_id TEXT NOT NULL,
    ref_type TEXT NOT NULL,
    ref_value TEXT NOT NULL
  );
  CREATE TABLE turns (
    session_id TEXT NOT NULL,
    turn_index INTEGER NOT NULL,
    user_message TEXT,
    assistant_response TEXT
  );
`;

const tempDirectories: string[] = [];

function createDatabase(databasePath: string, schema: string, fixtures: string): void {
  const database = new DatabaseSync(databasePath);
  database.exec(schema);
  database.exec(fixtures);
  database.close();
}

function createFixtureDatabases(
  appFixtures: string,
  sessionStoreFixtures = '',
): { databasePath: string; sessionStorePath: string } {
  const directory = fs.mkdtempSync(path.join(os.homedir(), '.ai-engineer-coach-test-'));
  tempDirectories.push(directory);
  const databasePath = path.join(directory, 'data.db');
  const sessionStorePath = path.join(directory, 'session-store.db');
  createDatabase(databasePath, APP_SCHEMA_SQL, appFixtures);
  createDatabase(sessionStorePath, SESSION_STORE_SCHEMA_SQL, sessionStoreFixtures);
  return { databasePath, sessionStorePath };
}

async function loadFixture(
  appFixtures: string,
  sessionStoreFixtures = '',
): Promise<GitHubAppMetrics> {
  const snapshot = await loadGitHubAppMetrics(
    createFixtureDatabases(appFixtures, sessionStoreFixtures),
  );
  expect(snapshot.status).toBe('ready');
  if (snapshot.status !== 'ready') throw new Error('Expected ready metrics.');
  return snapshot.metrics;
}

function cohortTotals(metrics: GitHubAppMetrics): { raised: number; merged: number } {
  return metrics.workspacePrCohorts.reduce(
    (totals, day) => ({
      raised: totals.raised + day.pullRequestsRaised,
      merged: totals.merged + day.pullRequestsMerged,
    }),
    { raised: 0, merged: 0 },
  );
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('GitHub App analytics parsing', () => {
  it('parses workspace PR cohorts', () => {
    expect(parseGitHubAppWorkspacePrCohorts(JSON.stringify([
      { date: '2026-08-23', cohortPullRequestsRaised: 4, cohortPullRequestsMerged: 3 },
      { date: '2026-08-24', cohortPullRequestsRaised: 0, cohortPullRequestsMerged: 0 },
    ]))).toEqual([
      { date: '2026-08-23', pullRequestsRaised: 4, pullRequestsMerged: 3 },
      { date: '2026-08-24', pullRequestsRaised: 0, pullRequestsMerged: 0 },
    ]);
  });
});

describe('GitHub App analytics availability', () => {
  it('hides the feature when the App database is absent', async () => {
    const metrics = await loadGitHubAppMetrics({
      databasePath: path.join(os.homedir(), 'missing-copilot-data.db'),
      sessionStorePath: path.join(os.homedir(), 'missing-session-store.db'),
      exists: () => false,
      query: () => Promise.reject(new Error('query should not run')),
    });

    expect(metrics).toEqual({ status: 'absent' });
  });

  it('reports unavailable when the session store is absent', async () => {
    const databasePath = path.join(os.homedir(), 'copilot-data.db');
    const metrics = await loadGitHubAppMetrics({
      databasePath,
      sessionStorePath: path.join(os.homedir(), 'missing-session-store.db'),
      exists: filePath => filePath === databasePath,
      query: () => Promise.reject(new Error('query should not run')),
    });

    expect(metrics).toEqual({ status: 'unavailable' });
  });

  it('does not return fallback metrics after a query failure', async () => {
    const metrics = await loadGitHubAppMetrics({
      databasePath: path.join(os.homedir(), 'copilot-data.db'),
      sessionStorePath: path.join(os.homedir(), 'session-store.db'),
      exists: () => true,
      query: () => Promise.reject(new Error('sqlite unavailable')),
    });

    expect(metrics).toEqual({ status: 'unavailable' });
  });
});

describe('GitHub App delivery references', () => {
  it('counts structured issues and early pasted links only', async () => {
    const metrics = await loadFixture(`
      INSERT INTO sessions VALUES
        ('structured', 'project', '2026-08-20T10:00:00.000Z'),
        ('pasted', 'project', '2026-08-21T10:00:00.000Z'),
        ('late', 'project', '2026-08-22T10:00:00.000Z'),
        ('prose', 'project', '2026-08-23T10:00:00.000Z');
    `, `
      INSERT INTO sessions VALUES
        ('structured', 'org/repo'),
        ('pasted', 'org/repo'),
        ('late', 'org/repo'),
        ('prose', 'org/repo');
      INSERT INTO session_refs VALUES ('structured', 'issue', '42');
      INSERT INTO turns VALUES
        ('pasted', 0, 'Fix https://github.com/org/repo/issues/123', NULL),
        ('late', 2, 'Later: https://github.com/org/repo/issues/456', NULL),
        ('prose', 0, 'Issue 789 is not an explicit link', NULL);
    `);

    expect(metrics.delivery).toMatchObject({
      totalProjectSessions: 4,
      sessionsWithIssue: 2,
      sessionsWithPullRequest: 0,
      sessionsWithMergedPullRequest: 0,
    });
  });

  it('counts a structured PR reference without assuming it merged', async () => {
    const metrics = await loadFixture(`
      INSERT INTO sessions VALUES ('referenced-pr', 'project', '2026-08-20T10:00:00.000Z');
    `, `
      INSERT INTO sessions VALUES ('referenced-pr', 'org/repo');
      INSERT INTO session_refs VALUES ('referenced-pr', 'pr', '99');
    `);

    expect(metrics.delivery.sessionsWithPullRequest).toBe(1);
    expect(metrics.delivery.sessionsWithMergedPullRequest).toBe(0);
  });
});

describe('GitHub App merge evidence', () => {
  it('counts only explicit assistant merge evidence', async () => {
    const metrics = await loadFixture(`
      INSERT INTO sessions VALUES
        ('merged', 'project', '2026-08-20T10:00:00.000Z'),
        ('not-merged', 'project', '2026-08-21T10:00:00.000Z'),
        ('merge-request', 'project', '2026-08-22T10:00:00.000Z');
    `, `
      INSERT INTO sessions VALUES
        ('merged', 'org/repo'),
        ('not-merged', 'org/repo'),
        ('merge-request', 'org/repo');
      INSERT INTO session_refs VALUES
        ('merged', 'pr', '1'),
        ('not-merged', 'pr', '2'),
        ('merge-request', 'pr', '3');
      INSERT INTO turns VALUES
        ('merged', 2, NULL, 'The pull request has been merged.'),
        ('not-merged', 2, NULL, 'The pull request is not merged.'),
        ('merge-request', 2, NULL, 'I can merge the pull request after confirmation.');
    `);

    expect(metrics.delivery.sessionsWithPullRequest).toBe(3);
    expect(metrics.delivery.sessionsWithMergedPullRequest).toBe(1);
  });
});

describe('GitHub App delivery ownership', () => {
  it('attributes a workspace outcome only to its primary session', async () => {
    const metrics = await loadFixture(`
      INSERT INTO sessions VALUES
        ('primary', 'project', '2026-08-20T10:00:00.000Z'),
        ('stale-alias', 'project', '2026-08-21T10:00:00.000Z');
      INSERT INTO workspaces VALUES
        ('workspace', 'primary', datetime('now', '-1 day'), 7, NULL, NULL, NULL, 101, datetime('now'), 'merged');
      INSERT INTO workspace_session_aliases VALUES
        ('stale-alias', 'workspace', datetime('now', '-2 days'));
    `);

    expect(metrics.delivery).toMatchObject({
      totalProjectSessions: 2,
      sessionsWithIssue: 1,
      sessionsWithPullRequest: 1,
      sessionsWithMergedPullRequest: 1,
    });
  });

  it('uses the latest alias when a workspace has no primary session', async () => {
    const metrics = await loadFixture(`
      INSERT INTO sessions VALUES
        ('latest-alias', 'project', '2026-08-20T10:00:00.000Z'),
        ('older-alias', 'general_chat', '2026-08-21T10:00:00.000Z');
      INSERT INTO workspaces VALUES
        ('workspace', NULL, datetime('now', '-1 day'), NULL, NULL, NULL, NULL, 101, NULL, 'open');
      INSERT INTO workspace_session_aliases VALUES
        ('older-alias', 'workspace', datetime('now', '-2 days')),
        ('latest-alias', 'workspace', datetime('now', '-1 hour'));
    `);

    expect(metrics.delivery.totalProjectSessions).toBe(1);
    expect(metrics.delivery.sessionsWithPullRequest).toBe(1);
  });
});

describe('GitHub App PR outcome integrity', () => {
  it('requires a created PR number before counting merge metadata', async () => {
    const metrics = await loadFixture(`
      INSERT INTO sessions VALUES ('merge-state-only', 'project', '2026-08-20T10:00:00.000Z');
      INSERT INTO workspaces VALUES
        ('workspace', 'merge-state-only', datetime('now', '-1 day'), NULL, NULL, NULL, NULL, NULL, datetime('now'), 'merged');
    `);

    expect(metrics.delivery.sessionsWithPullRequest).toBe(0);
    expect(metrics.delivery.sessionsWithMergedPullRequest).toBe(0);
    expect(cohortTotals(metrics)).toEqual({ raised: 0, merged: 0 });
  });

  it('uses context PRs without also counting legacy workspace fields', async () => {
    const metrics = await loadFixture(`
      INSERT INTO sessions VALUES ('owner', 'project', '2026-08-20T10:00:00.000Z');
      INSERT INTO workspaces VALUES
        ('workspace', 'owner', datetime('now', '-1 day'), NULL, NULL, NULL, NULL, 100, NULL, 'open');
      INSERT INTO workspace_repo_contexts VALUES
        ('workspace', NULL, NULL, NULL, NULL, 200, datetime('now'), 'merged');
    `);

    expect(metrics.delivery.sessionsWithPullRequest).toBe(1);
    expect(metrics.delivery.sessionsWithMergedPullRequest).toBe(1);
    expect(cohortTotals(metrics)).toEqual({ raised: 1, merged: 1 });
  });
});
