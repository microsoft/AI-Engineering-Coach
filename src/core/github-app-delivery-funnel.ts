/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
  parseSqliteJsonRows,
  type GitHubAppDatabaseAccess,
} from './github-app-database';
import {
  collectGitHubAppIssueSessionIds,
  SESSION_ISSUES_QUERY,
} from './github-app-issue-references';
import {
  collectGitHubAppMergedPullRequestSessionIds,
  collectGitHubAppPullRequestSessionIds,
  SESSION_MERGE_EVIDENCE_QUERY,
  SESSION_PULL_REQUESTS_QUERY,
} from './github-app-pr-references';
import { WORKSPACE_CREATED_PULL_REQUESTS_CTE } from './github-app-pr-outcomes';
import type { GitHubAppDeliveryFunnel } from './types';

const PROJECT_SESSIONS_QUERY = `
SELECT
  id AS sessionId,
  updated_at AS updatedAt
FROM sessions
WHERE session_type = 'project'`;

const WORKSPACE_DELIVERY_QUERY = `
WITH
${WORKSPACE_CREATED_PULL_REQUESTS_CTE},
workspace_pr_outcomes AS (
  SELECT
    workspaceId,
    MAX(merged) AS hasMergedPullRequest
  FROM workspace_created_pull_requests
  GROUP BY workspaceId
)
SELECT
  COALESCE(
    workspaces.session_id,
    (
      SELECT aliases.session_id
      FROM workspace_session_aliases AS aliases
      WHERE aliases.workspace_id = workspaces.id
      ORDER BY aliases.created_at DESC
      LIMIT 1
    )
  ) AS sessionId,
  CASE
    WHEN workspaces.source_issue_number IS NOT NULL
      OR EXISTS (
        SELECT 1
        FROM workspace_repo_contexts AS contexts
        WHERE contexts.workspace_id = workspaces.id
          AND contexts.source_issue_number IS NOT NULL
      )
    THEN 1 ELSE 0
  END AS hasDirectIssue,
  CASE
    WHEN pr_outcomes.workspaceId IS NOT NULL
      OR workspaces.source_pr_number IS NOT NULL
      OR EXISTS (
        SELECT 1
        FROM workspace_repo_contexts AS contexts
        WHERE contexts.workspace_id = workspaces.id
          AND contexts.source_pr_number IS NOT NULL
      )
    THEN 1 ELSE 0
  END AS hasPullRequest,
  CASE
    WHEN COALESCE(pr_outcomes.hasMergedPullRequest, 0) = 1
      OR (
        workspaces.source_pr_number IS NOT NULL
        AND (
          workspaces.source_pr_merged_at IS NOT NULL
          OR lower(COALESCE(workspaces.source_pr_state, '')) = 'merged'
        )
      )
      OR EXISTS (
        SELECT 1
        FROM workspace_repo_contexts AS contexts
        WHERE contexts.workspace_id = workspaces.id
          AND contexts.source_pr_number IS NOT NULL
          AND (
            contexts.source_pr_merged_at IS NOT NULL
            OR lower(COALESCE(contexts.source_pr_state, '')) = 'merged'
          )
      )
    THEN 1 ELSE 0
  END AS hasMergedPullRequest
FROM workspaces
LEFT JOIN workspace_pr_outcomes AS pr_outcomes
  ON pr_outcomes.workspaceId = workspaces.id`;

interface ProjectSessionRow {
  sessionId: string;
  updatedAt: string;
}

interface WorkspaceDeliveryRow {
  sessionId: string | null;
  hasDirectIssue: boolean;
  hasPullRequest: boolean;
  hasMergedPullRequest: boolean;
}

interface SessionDeliveryEvidence {
  issueSessionIds: ReadonlySet<string>;
  pullRequestSessionIds: ReadonlySet<string>;
  mergedPullRequestSessionIds: ReadonlySet<string>;
}

function isProjectSessionRow(value: unknown): value is ProjectSessionRow {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return typeof row.sessionId === 'string' && typeof row.updatedAt === 'string';
}

function parseProjectSessions(raw: string): ProjectSessionRow[] {
  const rows = parseSqliteJsonRows(raw, 'Project session');
  if (!rows.every(isProjectSessionRow)) {
    throw new Error('Project session query returned an unexpected row.');
  }
  return rows;
}

function isWorkspaceDeliveryRow(value: unknown): value is {
  sessionId: string | null;
  hasDirectIssue: number;
  hasPullRequest: number;
  hasMergedPullRequest: number;
} {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return (row.sessionId === null || typeof row.sessionId === 'string')
    && (row.hasDirectIssue === 0 || row.hasDirectIssue === 1)
    && (row.hasPullRequest === 0 || row.hasPullRequest === 1)
    && (row.hasMergedPullRequest === 0 || row.hasMergedPullRequest === 1);
}

function parseWorkspaceDelivery(raw: string): WorkspaceDeliveryRow[] {
  const rows = parseSqliteJsonRows(raw, 'Workspace delivery');
  if (!rows.every(isWorkspaceDeliveryRow)) {
    throw new Error('Workspace delivery query returned an unexpected row.');
  }
  return rows.map(row => ({
    sessionId: row.sessionId,
    hasDirectIssue: row.hasDirectIssue === 1,
    hasPullRequest: row.hasPullRequest === 1,
    hasMergedPullRequest: row.hasMergedPullRequest === 1,
  }));
}

function buildDeliveryFunnel(
  projectSessions: readonly ProjectSessionRow[],
  workspaceDelivery: readonly WorkspaceDeliveryRow[],
  evidence: SessionDeliveryEvidence,
): GitHubAppDeliveryFunnel {
  const projectSessionIds = new Set(projectSessions.map(session => session.sessionId));
  const issueSessions = new Set<string>();
  const pullRequestSessions = new Set<string>();
  const mergedPullRequestSessions = new Set<string>();

  for (const sessionId of evidence.issueSessionIds) {
    if (projectSessionIds.has(sessionId)) issueSessions.add(sessionId);
  }

  for (const sessionId of evidence.pullRequestSessionIds) {
    if (projectSessionIds.has(sessionId)) pullRequestSessions.add(sessionId);
  }

  for (const sessionId of evidence.mergedPullRequestSessionIds) {
    if (!projectSessionIds.has(sessionId)) continue;
    pullRequestSessions.add(sessionId);
    mergedPullRequestSessions.add(sessionId);
  }

  for (const outcome of workspaceDelivery) {
    if (outcome.sessionId === null || !projectSessionIds.has(outcome.sessionId)) continue;
    if (outcome.hasDirectIssue) issueSessions.add(outcome.sessionId);
    if (outcome.hasPullRequest) pullRequestSessions.add(outcome.sessionId);
    if (outcome.hasMergedPullRequest) mergedPullRequestSessions.add(outcome.sessionId);
  }

  const lastActivityAt = projectSessions.reduce<string | null>(
    (latest, session) => (latest === null || session.updatedAt > latest) ? session.updatedAt : latest,
    null,
  );

  return {
    totalProjectSessions: projectSessionIds.size,
    sessionsWithIssue: issueSessions.size,
    sessionsWithPullRequest: pullRequestSessions.size,
    sessionsWithMergedPullRequest: mergedPullRequestSessions.size,
    lastActivityAt,
  };
}

export async function loadGitHubAppDeliveryFunnel(
  access: GitHubAppDatabaseAccess,
): Promise<GitHubAppDeliveryFunnel> {
  const [
    projectSessionsRaw,
    workspaceDeliveryRaw,
    sessionIssuesRaw,
    sessionPullRequestsRaw,
    sessionMergeEvidenceRaw,
  ] = await Promise.all([
    access.query(access.databasePath, PROJECT_SESSIONS_QUERY),
    access.query(access.databasePath, WORKSPACE_DELIVERY_QUERY),
    access.query(access.sessionStorePath, SESSION_ISSUES_QUERY),
    access.query(access.sessionStorePath, SESSION_PULL_REQUESTS_QUERY),
    access.query(access.sessionStorePath, SESSION_MERGE_EVIDENCE_QUERY),
  ]);

  return buildDeliveryFunnel(
    parseProjectSessions(projectSessionsRaw),
    parseWorkspaceDelivery(workspaceDeliveryRaw),
    {
      issueSessionIds: collectGitHubAppIssueSessionIds(
        parseSqliteJsonRows(sessionIssuesRaw, 'Session issue'),
      ),
      pullRequestSessionIds: collectGitHubAppPullRequestSessionIds(
        parseSqliteJsonRows(sessionPullRequestsRaw, 'Session pull request'),
      ),
      mergedPullRequestSessionIds: collectGitHubAppMergedPullRequestSessionIds(
        parseSqliteJsonRows(sessionMergeEvidenceRaw, 'Session merge evidence'),
      ),
    },
  );
}
