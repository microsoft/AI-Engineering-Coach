/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type {
  GitHubAppMergeDay,
  GitHubAppMetrics,
  GitHubAppSnapshot,
} from './types';
import {
  resolveGitHubAppDatabaseAccess,
  type GitHubAppDatabaseDependencies,
} from './github-app-database';
import { warnCore } from './log';
import { assertTrustedPath } from './parser-shared';

const ISSUE_SESSION_REFERENCES_QUERY = `
SELECT DISTINCT session_id AS sessionId
FROM session_refs
WHERE ref_type = 'issue'`;

const METRICS_QUERY = `
WITH RECURSIVE
days(date) AS (
  VALUES(date('now', '-7 days'))
  UNION ALL
  SELECT date(date, '+1 day')
  FROM days
  WHERE date < date('now', '-1 day')
),
workspace_pull_requests AS (
  SELECT
    contexts.workspace_id AS workspaceId,
    workspaces.created_at AS workspaceCreatedAt,
    CASE
      WHEN contexts.created_pr_merged_at IS NOT NULL
        OR lower(COALESCE(contexts.created_pr_state, '')) = 'merged'
      THEN 1 ELSE 0
    END AS merged
  FROM workspace_repo_contexts AS contexts
  JOIN workspaces ON workspaces.id = contexts.workspace_id
  WHERE contexts.created_pr_number IS NOT NULL

  UNION ALL

  SELECT
    workspaces.id AS workspaceId,
    workspaces.created_at AS workspaceCreatedAt,
    CASE
      WHEN workspaces.created_pr_merged_at IS NOT NULL
        OR lower(COALESCE(workspaces.created_pr_state, '')) = 'merged'
      THEN 1 ELSE 0
    END AS merged
  FROM workspaces
  WHERE workspaces.created_pr_number IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM workspace_repo_contexts AS contexts
      WHERE contexts.workspace_id = workspaces.id
        AND contexts.created_pr_number IS NOT NULL
    )
),
workspace_outcomes AS (
  SELECT
    workspaceId,
    MAX(merged) AS hasMergedPullRequest
  FROM workspace_pull_requests
  GROUP BY workspaceId
),
summary AS (
  SELECT
    COUNT(*) AS totalProjectSessions,
    COALESCE(SUM(CASE
      WHEN workspaces.source_issue_number IS NOT NULL
        OR EXISTS (
          SELECT 1
          FROM workspace_repo_contexts AS contexts
          WHERE contexts.workspace_id = workspaces.id
            AND contexts.source_issue_number IS NOT NULL
        )
      THEN 1 ELSE 0
    END), 0) AS sessionsWithIssue,
    COALESCE(SUM(CASE WHEN outcomes.workspaceId IS NOT NULL THEN 1 ELSE 0 END), 0)
      AS sessionsWithPullRequest,
    COALESCE(SUM(outcomes.hasMergedPullRequest), 0) AS sessionsWithMergedPullRequest,
    MAX(workspaces.updated_at) AS lastActivityAt
  FROM workspaces
  LEFT JOIN workspace_outcomes AS outcomes ON outcomes.workspaceId = workspaces.id
)
SELECT
  days.date AS date,
  COUNT(pull_requests.workspaceId) AS cohortPullRequestsRaised,
  COALESCE(SUM(pull_requests.merged), 0) AS cohortPullRequestsMerged,
  summary.totalProjectSessions,
  summary.sessionsWithIssue,
  summary.sessionsWithPullRequest,
  summary.sessionsWithMergedPullRequest,
  summary.lastActivityAt
FROM days
CROSS JOIN summary
LEFT JOIN workspace_pull_requests AS pull_requests
  ON date(pull_requests.workspaceCreatedAt) = days.date
GROUP BY
  days.date,
  summary.totalProjectSessions,
  summary.sessionsWithIssue,
  summary.sessionsWithPullRequest,
  summary.sessionsWithMergedPullRequest,
  summary.lastActivityAt
ORDER BY days.date`;

const WORKSPACE_ISSUE_LINKS_QUERY = `
WITH
workspace_sessions(workspaceId, sessionId) AS (
  SELECT id, session_id FROM workspaces WHERE session_id IS NOT NULL
  UNION
  SELECT id, creator_session_id FROM workspaces WHERE creator_session_id IS NOT NULL
  UNION
  SELECT id, coordinating_creator_session_id
  FROM workspaces
  WHERE coordinating_creator_session_id IS NOT NULL
  UNION
  SELECT workspace_id, session_id FROM workspace_session_aliases
),
workspace_issue_flags(workspaceId, hasDirectIssue) AS (
  SELECT
    workspaces.id,
    CASE
      WHEN workspaces.source_issue_number IS NOT NULL
        OR EXISTS (
          SELECT 1
          FROM workspace_repo_contexts AS contexts
          WHERE contexts.workspace_id = workspaces.id
            AND contexts.source_issue_number IS NOT NULL
        )
      THEN 1 ELSE 0
    END
  FROM workspaces
)
SELECT
  issue_flags.workspaceId,
  issue_flags.hasDirectIssue,
  workspace_sessions.sessionId
FROM workspace_issue_flags AS issue_flags
LEFT JOIN workspace_sessions
  ON workspace_sessions.workspaceId = issue_flags.workspaceId`;

interface GitHubAppMetricsRow {
  date: string;
  cohortPullRequestsRaised: number;
  cohortPullRequestsMerged: number;
  totalProjectSessions: number;
  sessionsWithIssue: number;
  sessionsWithPullRequest: number;
  sessionsWithMergedPullRequest: number;
  lastActivityAt: string | null;
}

interface GitHubAppWorkspaceIssueLink {
  workspaceId: string;
  hasDirectIssue: boolean;
  sessionId: string | null;
}

export type GitHubAppAnalyticsDependencies = GitHubAppDatabaseDependencies;

function isMetricsRow(value: unknown): value is GitHubAppMetricsRow {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  const numericFields = [
    'cohortPullRequestsRaised',
    'cohortPullRequestsMerged',
    'totalProjectSessions',
    'sessionsWithIssue',
    'sessionsWithPullRequest',
    'sessionsWithMergedPullRequest',
  ];
  return typeof row.date === 'string'
    && numericFields.every(field => typeof row[field] === 'number')
    && (row.lastActivityAt === null || typeof row.lastActivityAt === 'string');
}

function mergeDay(row: GitHubAppMetricsRow): GitHubAppMergeDay {
  return {
    date: row.date,
    pullRequestsRaised: row.cohortPullRequestsRaised,
    pullRequestsMerged: row.cohortPullRequestsMerged,
  };
}

export function parseGitHubAppMetricsRows(raw: string): GitHubAppMetrics {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every(isMetricsRow)) {
    throw new Error('GitHub App metrics query returned an unexpected result.');
  }

  const first = parsed[0];
  return {
    totalProjectSessions: first.totalProjectSessions,
    sessionsWithIssue: first.sessionsWithIssue,
    sessionsWithPullRequest: first.sessionsWithPullRequest,
    sessionsWithMergedPullRequest: first.sessionsWithMergedPullRequest,
    lastActivityAt: first.lastActivityAt,
    mergeHistory: parsed.map(mergeDay),
  };
}

function isIssueSessionReference(value: unknown): value is { sessionId: string } {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return typeof row.sessionId === 'string';
}

export function parseGitHubAppIssueSessionReferences(raw: string): string[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every(isIssueSessionReference)) {
    throw new Error('GitHub App issue session query returned an unexpected result.');
  }
  return parsed.map(row => row.sessionId);
}

function isWorkspaceIssueLink(value: unknown): value is {
  workspaceId: string;
  hasDirectIssue: number;
  sessionId: string | null;
} {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return typeof row.workspaceId === 'string'
    && (row.hasDirectIssue === 0 || row.hasDirectIssue === 1)
    && (row.sessionId === null || typeof row.sessionId === 'string');
}

function parseWorkspaceIssueLinks(raw: string): GitHubAppWorkspaceIssueLink[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every(isWorkspaceIssueLink)) {
    throw new Error('GitHub App workspace issue-link query returned an unexpected result.');
  }
  return parsed.map(row => ({
    workspaceId: row.workspaceId,
    hasDirectIssue: row.hasDirectIssue === 1,
    sessionId: row.sessionId,
  }));
}

function countIssueLinkedWorkspaces(
  workspaceLinks: GitHubAppWorkspaceIssueLink[],
  issueSessionIds: string[],
): number {
  const issueSessions = new Set(issueSessionIds);
  const issueWorkspaces = new Set<string>();
  for (const link of workspaceLinks) {
    if (link.hasDirectIssue || (link.sessionId !== null && issueSessions.has(link.sessionId))) {
      issueWorkspaces.add(link.workspaceId);
    }
  }
  return issueWorkspaces.size;
}

async function loadIssueLinkedWorkspaceCount(
  databasePath: string,
  sessionStorePath: string,
  exists: (filePath: string) => boolean,
  query: (databasePath: string, sql: string) => Promise<string>,
): Promise<number | null> {
  if (!exists(sessionStorePath)) return null;
  try {
    assertTrustedPath(sessionStorePath);
    const [issueReferencesRaw, workspaceLinksRaw] = await Promise.all([
      query(sessionStorePath, ISSUE_SESSION_REFERENCES_QUERY),
      query(databasePath, WORKSPACE_ISSUE_LINKS_QUERY),
    ]);
    return countIssueLinkedWorkspaces(
      parseWorkspaceIssueLinks(workspaceLinksRaw),
      parseGitHubAppIssueSessionReferences(issueReferencesRaw),
    );
  } catch (error) {
    warnCore('github-app-analytics', 'Could not map issue references to GitHub App project sessions', error);
    return null;
  }
}

export async function loadGitHubAppMetrics(
  dependencies: GitHubAppAnalyticsDependencies = {},
): Promise<GitHubAppSnapshot> {
  const { databasePath, sessionStorePath, exists, query } =
    resolveGitHubAppDatabaseAccess(dependencies);

  try {
    assertTrustedPath(databasePath);
  } catch (error) {
    warnCore('github-app-analytics', 'Rejected GitHub App database path', error);
    return { status: 'absent' };
  }

  if (!exists(databasePath)) return { status: 'absent' };

  try {
    const [raw, issueLinkedWorkspaceCount] = await Promise.all([
      query(databasePath, METRICS_QUERY),
      loadIssueLinkedWorkspaceCount(databasePath, sessionStorePath, exists, query),
    ]);
    const metrics = parseGitHubAppMetricsRows(raw);
    if (issueLinkedWorkspaceCount !== null) {
      metrics.sessionsWithIssue = Math.min(
        metrics.totalProjectSessions,
        issueLinkedWorkspaceCount,
      );
    }
    return { status: 'ready', metrics };
  } catch (error) {
    warnCore('github-app-analytics', 'Could not read GitHub App productivity metrics', error);
    return { status: 'unavailable' };
  }
}
