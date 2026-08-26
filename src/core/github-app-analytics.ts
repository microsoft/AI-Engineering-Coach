/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type {
  GitHubAppMetrics,
  GitHubAppSnapshot,
  GitHubAppWorkspacePrCohortDay,
} from './types';
import {
  parseSqliteJsonRows,
  resolveGitHubAppDatabaseAccess,
  type GitHubAppDatabaseDependencies,
} from './github-app-database';
import { loadGitHubAppDeliveryFunnel } from './github-app-delivery-funnel';
import { WORKSPACE_CREATED_PULL_REQUESTS_CTE } from './github-app-pr-outcomes';
import { warnCore } from './log';
import { assertTrustedPath } from './parser-shared';

const WORKSPACE_PR_COHORT_QUERY = `
WITH RECURSIVE
days(date) AS (
  VALUES(date('now', '-7 days'))
  UNION ALL
  SELECT date(date, '+1 day')
  FROM days
  WHERE date < date('now', '-1 day')
),
${WORKSPACE_CREATED_PULL_REQUESTS_CTE}
SELECT
  days.date AS date,
  COUNT(created_pull_requests.workspaceId) AS cohortPullRequestsRaised,
  COALESCE(SUM(created_pull_requests.merged), 0) AS cohortPullRequestsMerged
FROM days
LEFT JOIN workspace_created_pull_requests AS created_pull_requests
  ON date(created_pull_requests.workspaceCreatedAt) = days.date
GROUP BY
  days.date
ORDER BY days.date`;

interface GitHubAppWorkspacePrCohortRow {
  date: string;
  cohortPullRequestsRaised: number;
  cohortPullRequestsMerged: number;
}

export type GitHubAppAnalyticsDependencies = GitHubAppDatabaseDependencies;

function isWorkspacePrCohortRow(value: unknown): value is GitHubAppWorkspacePrCohortRow {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return typeof row.date === 'string'
    && typeof row.cohortPullRequestsRaised === 'number'
    && typeof row.cohortPullRequestsMerged === 'number';
}

function workspacePrCohortDay(
  row: GitHubAppWorkspacePrCohortRow,
): GitHubAppWorkspacePrCohortDay {
  return {
    date: row.date,
    pullRequestsRaised: row.cohortPullRequestsRaised,
    pullRequestsMerged: row.cohortPullRequestsMerged,
  };
}

export function parseGitHubAppWorkspacePrCohorts(
  raw: string,
): GitHubAppWorkspacePrCohortDay[] {
  const parsed = parseSqliteJsonRows(raw, 'GitHub App PR cohort');
  if (parsed.length === 0 || !parsed.every(isWorkspacePrCohortRow)) {
    throw new Error('GitHub App PR cohort query returned an unexpected result.');
  }
  return parsed.map(workspacePrCohortDay);
}

export async function loadGitHubAppMetrics(
  dependencies: GitHubAppAnalyticsDependencies = {},
): Promise<GitHubAppSnapshot> {
  const access = resolveGitHubAppDatabaseAccess(dependencies);
  const { databasePath, sessionStorePath, exists, query } = access;

  try {
    assertTrustedPath(databasePath);
    assertTrustedPath(sessionStorePath);
  } catch (error) {
    warnCore('github-app-analytics', 'Rejected GitHub App database path', error);
    return { status: 'absent' };
  }

  if (!exists(databasePath)) return { status: 'absent' };
  if (!exists(sessionStorePath)) return { status: 'unavailable' };

  try {
    const [workspacePrCohortsRaw, delivery] = await Promise.all([
      query(databasePath, WORKSPACE_PR_COHORT_QUERY),
      loadGitHubAppDeliveryFunnel(access),
    ]);
    const metrics: GitHubAppMetrics = {
      delivery,
      workspacePrCohorts: parseGitHubAppWorkspacePrCohorts(workspacePrCohortsRaw),
    };
    return { status: 'ready', metrics };
  } catch (error) {
    warnCore('github-app-analytics', 'Could not read GitHub App productivity metrics', error);
    return { status: 'unavailable' };
  }
}
