/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export const SESSION_ISSUES_QUERY = `
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

export interface GitHubIssueIdentity {
  repository: string;
  issueNumber: number;
}

export interface GitHubIssueEvidence extends GitHubIssueIdentity {
  explicitLink: boolean;
}

export interface GitHubAppSessionIssueRow extends GitHubIssueIdentity {
  sessionId: string;
  source: 'reference' | 'pasted-link';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeGitHubRepository(value: unknown): string | null {
  const raw = nonEmptyString(value);
  if (!raw) return null;
  const normalized = raw
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replaceAll(/^\/+|\/+$/g, '');
  const segments = normalized.split('/');
  if (segments.length !== 2 || segments.some(segment => segment.length === 0)) return null;
  return normalized;
}

export function githubIssueKey(repository: string, issueNumber: number): string {
  return `${repository.toLowerCase()}#${issueNumber}`;
}

function parseIssueReference(
  refValue: unknown,
  fallbackRepository: unknown,
): GitHubIssueIdentity | null {
  const ref = nonEmptyString(refValue);
  if (!ref) return null;

  if (/^\d+$/.test(ref)) {
    const repository = normalizeGitHubRepository(fallbackRepository);
    const issueNumber = Number(ref);
    return repository && Number.isSafeInteger(issueNumber) && issueNumber > 0
      ? { repository, issueNumber }
      : null;
  }

  const qualified = /^(?:https?:\/\/github\.com\/)?([^/\s]+\/[^/#\s]+?)(?:\/issues\/|#)(\d+)$/i.exec(ref);
  if (!qualified) return null;
  const repository = normalizeGitHubRepository(qualified[1]);
  const issueNumber = Number(qualified[2]);
  return repository && Number.isSafeInteger(issueNumber) && issueNumber > 0
    ? { repository, issueNumber }
    : null;
}

function parsePastedIssueLinks(refValue: unknown): GitHubIssueIdentity[] {
  const message = nonEmptyString(refValue);
  if (!message) return [];
  const issues = new Map<string, GitHubIssueIdentity>();
  for (const match of message.matchAll(
    /https?:\/\/github\.com\/([^/\s]+\/[^/#?\s]+)\/issues\/(\d+)/gi,
  )) {
    const repository = normalizeGitHubRepository(match[1]);
    const issueNumber = Number(match[2]);
    if (!repository || !Number.isSafeInteger(issueNumber) || issueNumber <= 0) continue;
    issues.set(githubIssueKey(repository, issueNumber), { repository, issueNumber });
  }
  return [...issues.values()];
}

export function parseGitHubAppSessionIssues(value: unknown): GitHubAppSessionIssueRow[] {
  if (!isRecord(value)) return [];
  const sessionId = nonEmptyString(value.sessionId);
  if (!sessionId) return [];
  if (value.source === 'pasted-link') {
    return parsePastedIssueLinks(value.refValue).map(issue => ({
      sessionId,
      ...issue,
      source: 'pasted-link',
    }));
  }
  if (value.source !== 'reference') return [];
  const issue = parseIssueReference(value.refValue, value.repository);
  return issue ? [{ sessionId, ...issue, source: 'reference' }] : [];
}

export function collectGitHubAppIssueSessionIds(values: readonly unknown[]): Set<string> {
  const sessionIds = new Set<string>();
  for (const value of values) {
    for (const row of parseGitHubAppSessionIssues(value)) sessionIds.add(row.sessionId);
  }
  return sessionIds;
}
