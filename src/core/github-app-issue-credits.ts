/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { GitHubAppIssueCreditsSnapshot } from './types';
import {
  resolveGitHubAppDatabaseAccess,
  type GitHubAppDatabaseDependencies,
} from './github-app-database';
import {
  aggregateGitHubAppIssueCredits,
  type GitHubAppIssueCreditRows,
} from './github-app-issue-credit-model';
import { warnCore } from './log';
import { assertTrustedPath } from './parser-shared';

const WORKSPACE_ISSUES_QUERY = `
SELECT
  workspace_id AS workspaceId,
  repo_full_name AS repository,
  source_issue_number AS issueNumber
FROM workspace_repo_contexts
WHERE source_issue_number IS NOT NULL

UNION ALL

SELECT
  id AS workspaceId,
  source_issue_repo_full_name AS repository,
  source_issue_number AS issueNumber
FROM workspaces
WHERE source_issue_number IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM workspace_repo_contexts
    WHERE workspace_repo_contexts.workspace_id = workspaces.id
      AND workspace_repo_contexts.source_issue_number IS NOT NULL
  )`;

const WORKSPACE_SESSIONS_QUERY = `
SELECT id AS workspaceId, session_id AS sessionId
FROM workspaces
WHERE session_id IS NOT NULL

UNION

SELECT id AS workspaceId, creator_session_id AS sessionId
FROM workspaces
WHERE creator_session_id IS NOT NULL

UNION

SELECT id AS workspaceId, coordinating_creator_session_id AS sessionId
FROM workspaces
WHERE coordinating_creator_session_id IS NOT NULL

UNION

SELECT workspace_id AS workspaceId, session_id AS sessionId
FROM workspace_session_aliases`;

const SESSION_ISSUES_QUERY = `
SELECT
  refs.session_id AS sessionId,
  sessions.repository AS repository,
  refs.ref_value AS refValue,
  'reference' AS source
FROM session_refs AS refs
LEFT JOIN sessions ON sessions.id = refs.session_id
WHERE refs.ref_type = 'issue'

UNION ALL

SELECT
  turns.session_id AS sessionId,
  sessions.repository AS repository,
  turns.user_message AS refValue,
  'pasted-link' AS source
FROM turns
LEFT JOIN sessions ON sessions.id = turns.session_id
WHERE turns.turn_index IN (0, 1)
  AND turns.user_message LIKE '%github.com/%/issues/%'`;

const SESSION_USAGE_QUERY = `
SELECT
  session_id AS sessionId,
  SUM(total_nano_aiu) AS totalNanoAiu
FROM assistant_usage_events
WHERE total_nano_aiu IS NOT NULL
  AND total_nano_aiu >= 0
GROUP BY session_id`;

export type GitHubAppIssueCreditsDependencies = GitHubAppDatabaseDependencies;

function parseRows(raw: string, description: string): unknown[] {
  if (raw.trim().length === 0) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`${description} query returned an unexpected result.`);
  }
  return parsed;
}

export async function loadGitHubAppIssueCredits(
  dependencies: GitHubAppIssueCreditsDependencies = {},
): Promise<GitHubAppIssueCreditsSnapshot> {
  const { databasePath, sessionStorePath, exists, query } =
    resolveGitHubAppDatabaseAccess(dependencies);

  try {
    assertTrustedPath(databasePath);
    assertTrustedPath(sessionStorePath);
  } catch (error) {
    warnCore('github-app-issue-credits', 'Rejected GitHub App database path', error);
    return { status: 'absent' };
  }

  if (!exists(databasePath)) return { status: 'absent' };
  if (!exists(sessionStorePath)) return { status: 'unavailable' };

  try {
    const [workspaceIssues, workspaceSessions, sessionIssues, sessionUsage] =
      await Promise.all([
        query(databasePath, WORKSPACE_ISSUES_QUERY),
        query(databasePath, WORKSPACE_SESSIONS_QUERY),
        query(sessionStorePath, SESSION_ISSUES_QUERY),
        query(sessionStorePath, SESSION_USAGE_QUERY),
      ]);
    const rows: GitHubAppIssueCreditRows = {
      workspaceIssues: parseRows(workspaceIssues, 'Workspace issue'),
      workspaceSessions: parseRows(workspaceSessions, 'Workspace session'),
      sessionIssues: parseRows(sessionIssues, 'Session issue'),
      sessionUsage: parseRows(sessionUsage, 'Session usage'),
    };
    return { status: 'ready', metrics: aggregateGitHubAppIssueCredits(rows) };
  } catch (error) {
    warnCore('github-app-issue-credits', 'Could not read GitHub App issue credit estimates', error);
    return { status: 'unavailable' };
  }
}
