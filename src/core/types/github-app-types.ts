/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface GitHubAppWorkspacePrCohortDay {
  date: string;
  pullRequestsRaised: number;
  pullRequestsMerged: number;
}

export interface GitHubAppDeliveryFunnel {
  totalProjectSessions: number;
  sessionsWithIssue: number;
  sessionsWithPullRequest: number;
  sessionsWithMergedPullRequest: number;
  lastActivityAt: string | null;
}

export interface GitHubAppMetrics {
  delivery: GitHubAppDeliveryFunnel;
  workspacePrCohorts: GitHubAppWorkspacePrCohortDay[];
}

export type GitHubAppDataSnapshot<T> =
  | { status: 'absent' }
  | { status: 'unavailable' }
  | { status: 'ready'; metrics: T };

export type GitHubAppSnapshot = GitHubAppDataSnapshot<GitHubAppMetrics>;

export interface GitHubAppIssueCreditEstimate {
  repository: string;
  issueNumber: number;
  linkedSessionCount: number;
  pricedSessionCount: number;
  estimatedCredits: number;
}

export interface GitHubAppIssueCreditsMetrics {
  issues: GitHubAppIssueCreditEstimate[];
  linkedSessionCount: number;
  pricedSessionCount: number;
  estimatedCredits: number;
}

export type GitHubAppIssueCreditsSnapshot = GitHubAppDataSnapshot<GitHubAppIssueCreditsMetrics>;
