/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export const WORKSPACE_CREATED_PULL_REQUESTS_CTE = `
workspace_created_pull_requests AS (
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
)`;
