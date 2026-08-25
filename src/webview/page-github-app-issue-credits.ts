/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type {
  GitHubAppIssueCreditEstimate,
  GitHubAppIssueCreditsMetrics,
  GitHubAppIssueCreditsSnapshot,
} from '../core/types';
import { formatNum } from './shared';
import { html, render, type ComponentChildren } from './render';

type IssueCreditSort = 'credits' | 'sessions' | 'issue';

function repositoryOwner(repository: string): string {
  return repository.split('/')[0] ?? repository;
}

function organizationAvatar(repository: string, size: number): ComponentChildren {
  const owner = repositoryOwner(repository);
  return html`
    <span class="gha-org-avatar" style=${`--avatar-size:${size}px`}>
      <span aria-hidden="true">${owner.slice(0, 1).toUpperCase()}</span>
      <img
        src=${`https://github.com/${encodeURIComponent(owner)}.png?size=${size * 2}`}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
        onerror=${(event: Event) => {
          (event.currentTarget as HTMLImageElement).hidden = true;
        }}
      />
    </span>`;
}

function formatCredits(value: number): string {
  const fractionDigits = value >= 100 ? 1 : 2;
  return value.toLocaleString(undefined, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}

function compareIssues(
  sort: IssueCreditSort,
): (a: GitHubAppIssueCreditEstimate, b: GitHubAppIssueCreditEstimate) => number {
  switch (sort) {
    case 'sessions':
      return (a, b) => b.linkedSessionCount - a.linkedSessionCount
        || b.estimatedCredits - a.estimatedCredits
        || a.repository.localeCompare(b.repository)
        || a.issueNumber - b.issueNumber;
    case 'issue':
      return (a, b) => a.repository.localeCompare(b.repository)
        || b.issueNumber - a.issueNumber;
    case 'credits':
      return (a, b) => b.estimatedCredits - a.estimatedCredits
        || b.linkedSessionCount - a.linkedSessionCount
        || a.repository.localeCompare(b.repository)
        || a.issueNumber - b.issueNumber;
  }
}

function renderUnavailable(container: HTMLElement): void {
  render(html`
    <div class="gha-page">
      <header class="gha-header">
        <div>
          <h1>Issue credits</h1>
          <p>Estimated AI Credits for GitHub issues from local GitHub Copilot app sessions.</p>
        </div>
      </header>
      <div class="gha-empty" role="status">
        <div class="gha-empty-icon">!</div>
        <div>
          <h2>Issue credit data is not available</h2>
          <p>The GitHub Copilot app is installed, but its local session or usage database could not be read. Make sure the <code>sqlite3</code> command is available, then reload the dashboard.</p>
        </div>
      </div>
    </div>`, container);
}

function summary(metrics: GitHubAppIssueCreditsMetrics): ComponentChildren {
  const coverage = metrics.linkedSessionCount > 0
    ? Math.round(metrics.pricedSessionCount / metrics.linkedSessionCount * 100)
    : 0;
  const topIssue = [...metrics.issues].sort(compareIssues('credits'))[0];
  return html`
    <section class="gha-credit-overview" aria-label="Issue credit summary">
      <div class="gha-credit-total">
        <span>Estimated AI Credits</span>
        <strong>${formatCredits(metrics.estimatedCredits)}</strong>
        <p>Across ${formatNum(metrics.linkedSessionCount)} unique issue-linked sessions</p>
      </div>
      ${topIssue
        ? html`
          <div class="gha-credit-leader">
            <span>Highest estimate</span>
            <div>
              ${organizationAvatar(topIssue.repository, 26)}
              <strong>${topIssue.repository}<b>#${topIssue.issueNumber}</b></strong>
              <em>${formatCredits(topIssue.estimatedCredits)} credits</em>
            </div>
          </div>`
        : null}
      <dl class="gha-credit-facts">
        <div><dt>Issues found</dt><dd>${formatNum(metrics.issues.length)}</dd></div>
        <div><dt>Credit coverage</dt><dd>${coverage}%</dd></div>
        <div><dt>Priced sessions</dt><dd>${formatNum(metrics.pricedSessionCount)}<small> / ${formatNum(metrics.linkedSessionCount)}</small></dd></div>
      </dl>
    </section>`;
}

function issueRows(issues: readonly GitHubAppIssueCreditEstimate[]): ComponentChildren {
  const topCredits = Math.max(...issues.map(issue => issue.estimatedCredits), 0);
  return issues.map((issue, index) => {
    const creditShare = topCredits > 0 ? issue.estimatedCredits / topCredits * 100 : 0;
    const coverage = issue.linkedSessionCount > 0
      ? issue.pricedSessionCount / issue.linkedSessionCount * 100
      : 0;
    return html`
    <tr>
      <td>
        <div class="gha-issue-identity">
          <span class=${`gha-issue-rank${index < 3 ? ` gha-issue-rank-${index + 1}` : ''}`}>${index + 1}</span>
          ${organizationAvatar(issue.repository, 20)}
          <span>
            <span class="gha-issue-repository">${issue.repository}</span>
            <strong class="gha-issue-number">#${issue.issueNumber}</strong>
          </span>
        </div>
      </td>
      <td class="gha-session-coverage">
        <div><strong>${formatNum(issue.pricedSessionCount)}</strong><span> of ${formatNum(issue.linkedSessionCount)}</span></div>
        <span class="gha-session-meter" aria-label=${`${Math.round(coverage)}% credit coverage`}>
          <i style=${`width:${coverage}%`}></i>
        </span>
        ${issue.pricedSessionCount < issue.linkedSessionCount
          ? html`<small class="gha-credit-partial">Usage missing for ${formatNum(issue.linkedSessionCount - issue.pricedSessionCount)}</small>`
          : null}
      </td>
      <td class="gha-credit-value">
        <div><strong>${formatCredits(issue.estimatedCredits)}</strong><span>${Math.round(creditShare)}% of top</span></div>
        <span class="gha-credit-bar"><i style=${`width:${creditShare}%`}></i></span>
      </td>
    </tr>`;
  });
}

function issueTable(metrics: GitHubAppIssueCreditsMetrics, sort: IssueCreditSort): ComponentChildren {
  const sorted = [...metrics.issues].sort(compareIssues(sort));
  return html`
    <section class="gha-credit-table-card" aria-labelledby="gha-issue-credit-table-title">
      <div class="gha-section-heading gha-credit-table-heading">
        <div>
          <h2 id="gha-issue-credit-table-title">Credits by issue</h2>
          <p>Sessions are reconciled through workspace IDs, aliases, creator IDs, coordinating creator IDs, local issue references, and issue links pasted when a session starts.</p>
        </div>
        <label class="gha-credit-sort">
          <span>Sort by</span>
          <select id="gha-credit-sort">
            <option value="credits" selected=${sort === 'credits'}>Estimated credits</option>
            <option value="sessions" selected=${sort === 'sessions'}>Linked sessions</option>
            <option value="issue" selected=${sort === 'issue'}>Repository and issue</option>
          </select>
        </label>
      </div>
      ${sorted.length === 0
        ? html`<div class="gha-inline-empty">No GitHub issues are linked to local project sessions yet.</div>`
        : html`
          <div class="gha-credit-table-wrap">
            <table class="gha-credit-table">
              <thead>
                <tr>
                  <th>Issue</th>
                  <th>Session coverage</th>
                  <th>Estimated AI Credits</th>
                </tr>
              </thead>
              <tbody>${issueRows(sorted)}</tbody>
            </table>
          </div>`}
    </section>`;
}

function renderMetrics(container: HTMLElement, metrics: GitHubAppIssueCreditsMetrics): void {
  let sort: IssueCreditSort = 'credits';

  const renderPage = (): void => {
    render(html`
      <div class="gha-page">
        <header class="gha-header">
          <div>
            <h1>Issue credits</h1>
            <p>Estimate the AI effort for each GitHub issue across all related local sessions.</p>
          </div>
          <span class="gha-estimate-label">Local estimate</span>
        </header>
        ${summary(metrics)}
        ${issueTable(metrics, sort)}
        <p class="gha-credit-method">
          Estimates use the locally recorded billed value <code>total_nano_aiu</code>, where 1 AI Credit equals 1,000,000,000 nano-AIU.
          Each issue total counts a linked session once. The summary also counts a session once if it is shared by more than one issue.
          Pasted links are accepted from the first two turns so later research links do not create unrelated issue entries.
          Organization avatars are loaded directly from GitHub.
        </p>
      </div>`, container);

    document.getElementById('gha-credit-sort')?.addEventListener('change', event => {
      const value = (event.currentTarget as HTMLSelectElement).value;
      if (value !== 'credits' && value !== 'sessions' && value !== 'issue') return;
      sort = value;
      renderPage();
    });
  };

  renderPage();
}

export function renderGitHubAppIssueCredits(
  container: HTMLElement,
  snapshot: GitHubAppIssueCreditsSnapshot,
): void {
  if (snapshot.status !== 'ready') {
    renderUnavailable(container);
    return;
  }
  renderMetrics(container, snapshot.metrics);
}
