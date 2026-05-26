/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { PRACTICE_GROUPS } from '../core/types';
import type { TeamDashboardCategory, TeamDashboardDeveloperRow, TeamDashboardFilters, TeamDashboardResponse } from '../core/types/team-mode-types';
import { rpc, scoreColor, scoreLabel, formatNum, formatDate } from './shared';
import { html, render, ScoreRing } from './render';

const CATEGORY_OPTIONS: Array<{ value: TeamDashboardCategory | 'all'; label: string }> = [
  { value: 'all', label: 'All Categories' },
  { value: 'prompt-quality', label: PRACTICE_GROUPS['prompt-quality'] },
  { value: 'session-hygiene', label: PRACTICE_GROUPS['session-hygiene'] },
  { value: 'code-review', label: PRACTICE_GROUPS['code-review'] },
  { value: 'tool-mastery', label: PRACTICE_GROUPS['tool-mastery'] },
  { value: 'context-management', label: PRACTICE_GROUPS['context-management'] },
];

let activeFilters: TeamDashboardFilters = {};
let activeRequestId = 0;
let activeContainer: HTMLElement | null = null;
let exportPrintCleanupBound = false;

export function renderTeamDashboard(container: HTMLElement): void {
  activeContainer = container;
  renderLoading();
  void loadTeamDashboard();
}

function renderLoading(): void {
  if (!activeContainer) return;
  render(html`
    <section class="team-dashboard">
      <header class="team-dashboard-hero">
        <div>
          <div class="team-dashboard-kicker">Team Mode</div>
          <h2 class="team-dashboard-title">Team Dashboard</h2>
          <p class="team-dashboard-subtitle">Privacy-safe coaching signals, trends, and usage quality at a glance.</p>
        </div>
        <div class="team-dashboard-actions">
          <button class="team-dashboard-button team-dashboard-button--ghost" type="button" id="team-dashboard-import" data-action="import-snapshots">Import Snapshots</button>
          <button class="team-dashboard-button" type="button" id="team-dashboard-export" data-action="export-pdf" disabled>Export PDF</button>
        </div>
      </header>

      <section class="team-dashboard-filters team-dashboard-filters--loading" aria-label="Team filters" aria-busy="true">
        <div class="team-dashboard-loading">
          <div class="loading-spinner"></div>
          <div class="loading-text">Loading team dashboard...</div>
        </div>
      </section>
    </section>
  `, activeContainer);
}

async function loadTeamDashboard(): Promise<void> {
  if (!activeContainer) return;
  const requestId = ++activeRequestId;
  renderLoading();

  try {
    const data = await rpc<TeamDashboardResponse>('getTeamDashboard', normalizeFilters(activeFilters) as Record<string, unknown>);
    if (requestId !== activeRequestId || !activeContainer) return;
    renderDashboard(data);
  } catch (error: unknown) {
    if (requestId !== activeRequestId || !activeContainer) return;
    renderError(error instanceof Error ? error.message : 'Failed to load team dashboard');
  }
}

function normalizeFilters(filters: TeamDashboardFilters): TeamDashboardFilters {
  return {
    developerId: filters.developerId?.trim() || undefined,
    fromMs: filters.fromMs,
    toMs: filters.toMs,
    category: filters.category,
  };
}

function renderError(message: string): void {
  if (!activeContainer) return;
  render(html`
    <section class="team-dashboard">
      <div class="team-dashboard-error">
        <h2>Team Dashboard unavailable</h2>
        <p>${message}</p>
        <p class="team-dashboard-error-hint">Check Team Mode settings and try importing snapshots again.</p>
      </div>
    </section>
  `, activeContainer);
}

function renderDashboard(data: TeamDashboardResponse): void {
  if (!activeContainer) return;

  const selectedDeveloper = activeFilters.developerId || 'all';
  const fromValue = toDateInputValue(activeFilters.fromMs);
  const toValue = toDateInputValue(activeFilters.toMs);
  const selectedCategory = activeFilters.category || data.selectedCategory;
  const exportDisabled = !data.hasSnapshots;
  const developerOptions = [{ value: 'all', label: 'All Developers' }, ...data.availableDevelopers.map(dev => ({ value: dev.developerId, label: dev.displayName }))];

  render(html`
    <section class="team-dashboard">
      <header class="team-dashboard-hero">
        <div>
          <div class="team-dashboard-kicker">Team Mode</div>
          <h2 class="team-dashboard-title">Team Dashboard</h2>
          <p class="team-dashboard-subtitle">Privacy-safe coaching signals, trends, and usage quality from locally imported snapshots.</p>
        </div>
        <div class="team-dashboard-actions">
          <button class="team-dashboard-button team-dashboard-button--ghost" type="button" id="team-dashboard-import" data-action="import-snapshots">Import Snapshots</button>
          <button class="team-dashboard-button" type="button" id="team-dashboard-export" data-action="export-pdf" ?disabled=${exportDisabled}>Export PDF</button>
        </div>
      </header>

      <section class="team-dashboard-filters" aria-label="Team filters">
        <label class="team-dashboard-filter">
          <span>Developer</span>
          <select id="team-dashboard-filter-developer">
            ${developerOptions.map(option => html`<option value=${option.value} selected=${option.value === selectedDeveloper}>${option.label}</option>`)}
          </select>
        </label>
        <label class="team-dashboard-filter">
          <span>From</span>
          <input id="team-dashboard-filter-from" type="date" value=${fromValue} />
        </label>
        <label class="team-dashboard-filter">
          <span>To</span>
          <input id="team-dashboard-filter-to" type="date" value=${toValue} />
        </label>
        <label class="team-dashboard-filter">
          <span>Category</span>
          <select id="team-dashboard-filter-category">
            ${CATEGORY_OPTIONS.map(option => html`<option value=${option.value} selected=${option.value === selectedCategory}>${option.label}</option>`)}
          </select>
        </label>
        <button class="team-dashboard-button team-dashboard-button--ghost" type="button" id="team-dashboard-clear">Clear Filters</button>
      </section>

      ${renderActiveFilterSummary(data)}

      <section class="team-dashboard-summary">
        <div class="team-dashboard-summary-card">
          <div class="team-dashboard-summary-value">${formatNum(data.totalDevelopers)}</div>
          <div class="team-dashboard-summary-label">Developers</div>
        </div>
        <div class="team-dashboard-summary-card">
          <div class="team-dashboard-summary-value">${formatNum(data.totalSnapshots)}</div>
          <div class="team-dashboard-summary-label">Visible snapshots</div>
        </div>
        <div class="team-dashboard-summary-card">
          <div class="team-dashboard-summary-value">${data.lastImportedAtMs ? formatDate(data.lastImportedAtMs) : 'Never'}</div>
          <div class="team-dashboard-summary-label">Last import</div>
        </div>
      </section>

      ${data.developers.length > 0
        ? html`<section class="team-dashboard-grid">${data.developers.map((developer) => renderMemberCard(developer))}</section>`
        : html`<section class="team-dashboard-empty"><h3>No matching team snapshots</h3><p>Try widening the date range or clearing the developer filter.</p></section>`}
    </section>
  `, activeContainer);

  bindFilters();
  bindExportButton();
  bindImportButton();
}

function bindFilters(): void {
  const developer = document.getElementById('team-dashboard-filter-developer') as HTMLSelectElement | null;
  const from = document.getElementById('team-dashboard-filter-from') as HTMLInputElement | null;
  const to = document.getElementById('team-dashboard-filter-to') as HTMLInputElement | null;
  const category = document.getElementById('team-dashboard-filter-category') as HTMLSelectElement | null;
  const clear = document.getElementById('team-dashboard-clear') as HTMLButtonElement | null;
  const focusButtons = document.querySelectorAll<HTMLButtonElement>('[data-action="focus-developer"]');

  developer?.addEventListener('change', () => {
    const value = developer.value;
    activeFilters.developerId = value && value !== 'all' ? value : undefined;
    void loadTeamDashboard();
  });

  from?.addEventListener('change', () => {
    activeFilters.fromMs = from.value ? dateInputToMs(from.value) : undefined;
    void loadTeamDashboard();
  });

  to?.addEventListener('change', () => {
    activeFilters.toMs = to.value ? dateInputToMs(to.value) : undefined;
    void loadTeamDashboard();
  });

  category?.addEventListener('change', () => {
    const value = category.value as TeamDashboardCategory | 'all';
    activeFilters.category = value === 'all' ? undefined : value;
    void loadTeamDashboard();
  });

  clear?.addEventListener('click', () => {
    activeFilters = {};
    void loadTeamDashboard();
  });

  focusButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const developerId = button.dataset.developerId;
      if (!developerId) return;
      activeFilters.developerId = developerId;
      void loadTeamDashboard();
    });
  });
}

function bindExportButton(): void {
  const exportButton = document.getElementById('team-dashboard-export') as HTMLButtonElement | null;
  if (!exportPrintCleanupBound) {
    window.addEventListener('afterprint', () => {
      document.body.classList.remove('team-dashboard-printing');
    });
    exportPrintCleanupBound = true;
  }
  exportButton?.addEventListener('click', () => {
    if (exportButton.disabled) return;
    document.body.classList.add('team-dashboard-printing');
    window.requestAnimationFrame(() => {
      window.print();
    });
  });
}

function bindImportButton(): void {
  const importButton = document.getElementById('team-dashboard-import') as HTMLButtonElement | null;
  importButton?.addEventListener('click', async () => {
    importButton.disabled = true;
    try {
      await rpc<{ ok: boolean }>('importTeamSnapshots');
      await loadTeamDashboard();
    } finally {
      importButton.disabled = false;
    }
  });
}

function renderMemberCard(member: TeamDashboardDeveloperRow) {
  return html`
    <article class="team-dashboard-card" data-developer-id=${member.developerId}>
      <header class="team-dashboard-card-head">
        <div>
          <h3 class="team-dashboard-member-name">${member.displayName}</h3>
          <div class="team-dashboard-member-meta">${formatNum(member.snapshotCount)} snapshots | ${formatNum(member.tokenUsage.totalTokens)} tokens</div>
        </div>
        <button class="team-dashboard-button team-dashboard-button--ghost team-dashboard-card-action" type="button" data-action="focus-developer" data-developer-id=${member.developerId}>View developer</button>
      </header>

      <div class="team-dashboard-score-grid">
        ${renderScoreTile('Prompt Quality', member.categoryScores['prompt-quality'])}
        ${renderScoreTile('Session Hygiene', member.categoryScores['session-hygiene'])}
        ${renderScoreTile('Code Review', member.categoryScores['code-review'])}
        ${renderScoreTile('Tool Mastery', member.categoryScores['tool-mastery'])}
        ${renderScoreTile('Context Management', member.categoryScores['context-management'])}
      </div>

      <div class="team-dashboard-surface">
        <section>
          <h4>Token Usage</h4>
          <div class="team-dashboard-token-grid">
            <div><span>Requests</span><strong>${formatNum(member.tokenUsage.requests)}</strong></div>
            <div><span>Input</span><strong>${formatNum(member.tokenUsage.inputTokens)}</strong></div>
            <div><span>Output</span><strong>${formatNum(member.tokenUsage.outputTokens)}</strong></div>
            <div><span>Total</span><strong>${formatNum(member.tokenUsage.totalTokens)}</strong></div>
          </div>
        </section>

        <section>
          <h4>Top Violations</h4>
          ${member.antiPatterns.topViolations.length > 0
            ? html`<div class="team-dashboard-violations">${member.antiPatterns.topViolations.map((violation) => html`
              <div class="team-dashboard-violation">
                <span class=${'team-dashboard-severity severity-' + violation.severity}>${violation.severity}</span>
                <strong>${violation.ruleId}</strong>
                <span>${formatNum(violation.count)}</span>
              </div>
            `)}</div>`
            : html`<p class="team-dashboard-muted">No anti-patterns recorded.</p>`}
        </section>

        <section>
          <h4>Week-over-Week</h4>
          <div class="team-dashboard-trends">
            ${renderTrendLine('Prompt Quality', member.weekOverWeek['prompt-quality'])}
            ${renderTrendLine('Session Hygiene', member.weekOverWeek['session-hygiene'])}
            ${renderTrendLine('Code Review', member.weekOverWeek['code-review'])}
            ${renderTrendLine('Tool Mastery', member.weekOverWeek['tool-mastery'])}
            ${renderTrendLine('Context Management', member.weekOverWeek['context-management'])}
          </div>
        </section>
      </div>
    </article>
  `;
}

function renderActiveFilterSummary(data: TeamDashboardResponse) {
  const filters: Array<{ label: string; value: string }> = [];
  if (activeFilters.developerId) {
    const selected = data.developers.find(dev => dev.developerId === activeFilters.developerId);
    filters.push({ label: 'Developer', value: selected?.displayName || activeFilters.developerId });
  }
  if (typeof activeFilters.fromMs === 'number') {
    filters.push({ label: 'From', value: toDateInputValue(activeFilters.fromMs) });
  }
  if (typeof activeFilters.toMs === 'number') {
    filters.push({ label: 'To', value: toDateInputValue(activeFilters.toMs) });
  }
  if (activeFilters.category) {
    filters.push({ label: 'Category', value: PRACTICE_GROUPS[activeFilters.category] });
  }

  if (filters.length === 0) return html``;

  return html`
    <section class="team-dashboard-active-filters" aria-label="Active filters">
      <span class="team-dashboard-active-filters-label">Active filters</span>
      <div class="team-dashboard-filter-chips">
        ${filters.map(filter => html`<span class="team-dashboard-filter-chip"><strong>${filter.label}:</strong> ${filter.value}</span>`)}
      </div>
    </section>
  `;
}

function renderScoreTile(label: string, score: number) {
  const color = scoreColor(score);
  return html`
    <div class="team-dashboard-score-tile">
      <div class="team-dashboard-score-ring"><${ScoreRing} score=${score} color=${color} size=${44} /></div>
      <div class="team-dashboard-score-meta">
        <span>${label}</span>
        <strong style=${'color:' + color}>${scoreLabel(score)}</strong>
      </div>
    </div>
  `;
}

function renderTrendLine(label: string, delta: number) {
  const cls = delta > 0 ? 'trend-improving' : delta < 0 ? 'trend-worsening' : 'trend-stable';
  const sign = delta > 0 ? '+' : '';
  return html`
    <div class="team-dashboard-trend-row">
      <span>${label}</span>
      <strong class=${cls}>${sign}${delta} pts</strong>
    </div>
  `;
}

function dateInputToMs(value: string): number {
  return new Date(`${value}T00:00:00Z`).getTime();
}

function toDateInputValue(value?: number): string {
  if (!value || !Number.isFinite(value)) return '';
  return new Date(value).toISOString().slice(0, 10);
}
