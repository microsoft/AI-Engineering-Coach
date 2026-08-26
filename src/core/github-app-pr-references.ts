/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export const SESSION_PULL_REQUESTS_QUERY = `
SELECT DISTINCT
  session_id AS sessionId,
  ref_value AS refValue
FROM session_refs
WHERE ref_type = 'pr'`;

export const SESSION_MERGE_EVIDENCE_QUERY = `
SELECT
  turns.session_id AS sessionId,
  turns.assistant_response AS response
FROM turns
WHERE turns.assistant_response LIKE '%merged%'
  AND EXISTS (
    SELECT 1
    FROM session_refs AS refs
    WHERE refs.session_id = turns.session_id
      AND refs.ref_type = 'pr'
  )`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function sessionId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isPullRequestReference(value: unknown): value is {
  sessionId: string;
  refValue: string;
} {
  if (!isRecord(value)) return false;
  return sessionId(value.sessionId) !== null
    && typeof value.refValue === 'string'
    && /^[1-9]\d*$/.test(value.refValue.trim());
}

function hasMergeEvidence(response: unknown): boolean {
  if (typeof response !== 'string') return false;
  return /\b(?:has been|was|is)\s+merged\b/i.test(response)
    || /\bsuccessfully\s+merged\b/i.test(response)
    || /\bmerged\s+successfully\b/i.test(response)
    || /\b(?:state|status)\s*[:=]\s*["']?merged\b/i.test(response)
    || /^\s*merged pull request\b/im.test(response);
}

export function collectGitHubAppPullRequestSessionIds(
  values: readonly unknown[],
): Set<string> {
  const sessionIds = new Set<string>();
  for (const value of values) {
    if (isPullRequestReference(value)) sessionIds.add(value.sessionId);
  }
  return sessionIds;
}

export function collectGitHubAppMergedPullRequestSessionIds(
  values: readonly unknown[],
): Set<string> {
  const sessionIds = new Set<string>();
  for (const value of values) {
    if (!isRecord(value) || !hasMergeEvidence(value.response)) continue;
    const id = sessionId(value.sessionId);
    if (id) sessionIds.add(id);
  }
  return sessionIds;
}
