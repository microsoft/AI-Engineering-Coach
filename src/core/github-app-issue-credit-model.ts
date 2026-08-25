/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type {
  GitHubAppIssueCreditEstimate,
  GitHubAppIssueCreditsMetrics,
} from './types';

export const NANO_AIU_PER_AI_CREDIT = 1_000_000_000;

interface WorkspaceIssueRow {
  workspaceId: string;
  repository: string;
  issueNumber: number;
}

interface WorkspaceSessionRow {
  workspaceId: string;
  sessionId: string;
}

interface SessionIssueRow {
  sessionId: string;
  repository: string;
  issueNumber: number;
  source: 'reference' | 'pasted-link';
}

interface SessionUsageRow {
  sessionId: string;
  totalNanoAiu: number;
}

export interface GitHubAppIssueCreditRows {
  workspaceIssues: readonly unknown[];
  workspaceSessions: readonly unknown[];
  sessionIssues: readonly unknown[];
  sessionUsage: readonly unknown[];
}

interface IssueIdentity {
  repository: string;
  issueNumber: number;
}

interface IssueEvidence extends IssueIdentity {
  explicitLink: boolean;
}

interface MutableIssueEstimate extends IssueIdentity {
  sessionIds: Set<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function normalizeRepository(value: unknown): string | null {
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

function issueKey(repository: string, issueNumber: number): string {
  return `${repository.toLowerCase()}#${issueNumber}`;
}

function parseWorkspaceIssue(value: unknown): WorkspaceIssueRow | null {
  if (!isRecord(value)) return null;
  const workspaceId = nonEmptyString(value.workspaceId);
  const repository = normalizeRepository(value.repository);
  const issueNumber = positiveInteger(value.issueNumber);
  return workspaceId && repository && issueNumber
    ? { workspaceId, repository, issueNumber }
    : null;
}

function parseWorkspaceSession(value: unknown): WorkspaceSessionRow | null {
  if (!isRecord(value)) return null;
  const workspaceId = nonEmptyString(value.workspaceId);
  const sessionId = nonEmptyString(value.sessionId);
  return workspaceId && sessionId ? { workspaceId, sessionId } : null;
}

function parseIssueReference(refValue: unknown, fallbackRepository: unknown): IssueIdentity | null {
  const ref = nonEmptyString(refValue);
  if (!ref) return null;

  if (/^\d+$/.test(ref)) {
    const repository = normalizeRepository(fallbackRepository);
    const issueNumber = Number(ref);
    return repository && Number.isSafeInteger(issueNumber) && issueNumber > 0
      ? { repository, issueNumber }
      : null;
  }

  const qualified = /^(?:https?:\/\/github\.com\/)?([^/\s]+\/[^/#\s]+?)(?:\/issues\/|#)(\d+)$/i.exec(ref);
  if (!qualified) return null;
  const repository = normalizeRepository(qualified[1]);
  const issueNumber = Number(qualified[2]);
  return repository && Number.isSafeInteger(issueNumber) && issueNumber > 0
    ? { repository, issueNumber }
    : null;
}

function parsePastedIssueLinks(refValue: unknown): IssueIdentity[] {
  const message = nonEmptyString(refValue);
  if (!message) return [];
  const issues = new Map<string, IssueIdentity>();
  for (const match of message.matchAll(
    /https?:\/\/github\.com\/([^/\s]+\/[^/#?\s]+)\/issues\/(\d+)/gi,
  )) {
    const repository = normalizeRepository(match[1]);
    const issueNumber = Number(match[2]);
    if (!repository || !Number.isSafeInteger(issueNumber) || issueNumber <= 0) continue;
    issues.set(issueKey(repository, issueNumber), { repository, issueNumber });
  }
  return [...issues.values()];
}

function parseSessionIssues(value: unknown): SessionIssueRow[] {
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

function parseSessionUsage(value: unknown): SessionUsageRow | null {
  if (!isRecord(value)) return null;
  const sessionId = nonEmptyString(value.sessionId);
  const totalNanoAiu = nonNegativeNumber(value.totalNanoAiu);
  return sessionId && totalNanoAiu !== null ? { sessionId, totalNanoAiu } : null;
}

function setMapValue<T>(map: Map<string, Map<string, T>>, key: string, valueKey: string, value: T): void {
  let values = map.get(key);
  if (!values) {
    values = new Map();
    map.set(key, values);
  }
  values.set(valueKey, value);
}

function buildWorkspaceSessions(values: readonly unknown[]): Map<string, Set<string>> {
  const workspaceSessions = new Map<string, Set<string>>();
  for (const value of values) {
    const row = parseWorkspaceSession(value);
    if (!row) continue;
    let sessionIds = workspaceSessions.get(row.workspaceId);
    if (!sessionIds) {
      sessionIds = new Set();
      workspaceSessions.set(row.workspaceId, sessionIds);
    }
    sessionIds.add(row.sessionId);
  }
  return workspaceSessions;
}

function buildDirectIssues(values: readonly unknown[]): Map<string, Map<string, IssueIdentity>> {
  const directIssues = new Map<string, Map<string, IssueIdentity>>();
  for (const value of values) {
    const row = parseWorkspaceIssue(value);
    if (!row) continue;
    setMapValue(directIssues, row.workspaceId, issueKey(row.repository, row.issueNumber), row);
  }
  return directIssues;
}

function buildSessionIssues(values: readonly unknown[]): Map<string, Map<string, IssueEvidence>> {
  const sessionIssues = new Map<string, Map<string, IssueEvidence>>();
  for (const value of values) {
    for (const row of parseSessionIssues(value)) {
      const key = issueKey(row.repository, row.issueNumber);
      const current = sessionIssues.get(row.sessionId)?.get(key);
      setMapValue(sessionIssues, row.sessionId, key, {
        repository: row.repository,
        issueNumber: row.issueNumber,
        explicitLink: current?.explicitLink === true || row.source === 'pasted-link',
      });
    }
  }
  return sessionIssues;
}

function issueCandidates(
  sessionIds: Set<string>,
  directIssues: Map<string, IssueIdentity> | undefined,
  sessionIssues: Map<string, Map<string, IssueEvidence>>,
): Map<string, IssueIdentity> {
  if (directIssues && directIssues.size > 0) return directIssues;

  const referenced = new Map<string, IssueEvidence>(
    [...sessionIds].flatMap(sessionId => [...(sessionIssues.get(sessionId)?.entries() ?? [])]),
  );
  const pasted = new Map<string, IssueEvidence>(
    [...referenced].filter(([, evidence]) => evidence.explicitLink),
  );
  if (pasted.size > 0) return pasted;
  return referenced.size === 1 ? referenced : new Map<string, IssueIdentity>();
}

function linkIssuesToSessions(
  workspaceSessions: Map<string, Set<string>>,
  directIssues: Map<string, Map<string, IssueIdentity>>,
  sessionIssues: Map<string, Map<string, IssueEvidence>>,
): Map<string, MutableIssueEstimate> {
  const issues = new Map<string, MutableIssueEstimate>();
  const workspaceIds = new Set([...workspaceSessions.keys(), ...directIssues.keys()]);
  for (const workspaceId of workspaceIds) {
    const sessionIds = workspaceSessions.get(workspaceId) ?? new Set<string>();
    for (const identity of issueCandidates(sessionIds, directIssues.get(workspaceId), sessionIssues).values()) {
      const key = issueKey(identity.repository, identity.issueNumber);
      let issue = issues.get(key);
      if (!issue) {
        issue = { ...identity, sessionIds: new Set() };
        issues.set(key, issue);
      }
      for (const sessionId of sessionIds) issue.sessionIds.add(sessionId);
    }
  }
  return issues;
}

function buildUsageBySession(values: readonly unknown[]): Map<string, number> {
  const usageBySession = new Map<string, number>();
  for (const value of values) {
    const row = parseSessionUsage(value);
    if (!row) continue;
    usageBySession.set(row.sessionId, (usageBySession.get(row.sessionId) ?? 0) + row.totalNanoAiu);
  }
  return usageBySession;
}

function compareIssues(a: GitHubAppIssueCreditEstimate, b: GitHubAppIssueCreditEstimate): number {
  return b.estimatedCredits - a.estimatedCredits
    || b.linkedSessionCount - a.linkedSessionCount
    || a.repository.localeCompare(b.repository)
    || a.issueNumber - b.issueNumber;
}

export function aggregateGitHubAppIssueCredits(rows: GitHubAppIssueCreditRows): GitHubAppIssueCreditsMetrics {
  const workspaceSessions = buildWorkspaceSessions(rows.workspaceSessions);
  const directIssues = buildDirectIssues(rows.workspaceIssues);
  const sessionIssues = buildSessionIssues(rows.sessionIssues);
  const issues = linkIssuesToSessions(workspaceSessions, directIssues, sessionIssues);
  const usageBySession = buildUsageBySession(rows.sessionUsage);
  const allLinkedSessions = new Set<string>();
  const allPricedSessions = new Set<string>();

  const estimates = [...issues.values()].map<GitHubAppIssueCreditEstimate>(issue => {
    let totalNanoAiu = 0;
    let pricedSessionCount = 0;
    for (const sessionId of issue.sessionIds) {
      allLinkedSessions.add(sessionId);
      const sessionNanoAiu = usageBySession.get(sessionId);
      if (sessionNanoAiu === undefined) continue;
      pricedSessionCount++;
      allPricedSessions.add(sessionId);
      totalNanoAiu += sessionNanoAiu;
    }
    return {
      repository: issue.repository,
      issueNumber: issue.issueNumber,
      linkedSessionCount: issue.sessionIds.size,
      pricedSessionCount,
      estimatedCredits: totalNanoAiu / NANO_AIU_PER_AI_CREDIT,
    };
  }).sort(compareIssues);

  let uniqueSessionNanoAiu = 0;
  for (const sessionId of allLinkedSessions) {
    uniqueSessionNanoAiu += usageBySession.get(sessionId) ?? 0;
  }

  return {
    issues: estimates,
    linkedSessionCount: allLinkedSessions.size,
    pricedSessionCount: allPricedSessions.size,
    estimatedCredits: uniqueSessionNanoAiu / NANO_AIU_PER_AI_CREDIT,
  };
}
