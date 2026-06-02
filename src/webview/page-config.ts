/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Context Health page renderer */

import { DateFilter, ConfigHealthData, WorkspaceConfigHealth, ConfigFileInfo, ContextProvisionScore, HookCoverageInfo, AgenticReadinessScore, ContextReviewResult, ContextReviewFinding } from '../core/types';
import { TOKEN_DATA_AVAILABLE_FROM } from '../core/constants';
import { rpc, COLORS, Chart, trackChart, destroyCharts } from './shared';
import { html, render, StatCard, ComponentChildren } from './render';
import { renderContextManagement } from './page-context-mgmt';

/* Harness colors */
const HC: Record<string, string> = { 'Local Agent': '#007acc', 'Local Agent (Insiders)': '#24bfa5', 'Xcode': '#147efb', 'Claude Code': '#d97706', 'GitHub Copilot CLI': '#8b5cf6', 'Codex CLI': '#ec4899', 'OpenCode': '#10b981', 'Pi': '#e11d48', 'Pi Coding Agent': '#e11d48' };
function hc(h: string): string { return HC[h] || COLORS.muted; }

/** Active treemap chart reference + workspace data for review highlighting */
let activeTreemapChart: Chart | null = null;

interface ContextProvisionDetailRow {
  entry: ContextProvisionScore;
  fp: number;
  ip: number;
  sp: number;
  tp: number;
}

let currentProvisionRows: ContextProvisionDetailRow[] = [];

/** Track the active sub-tab so we can restore it on re-render */
let activeSubTab: 'config-quality' | 'context-mgmt' = 'config-quality';

/** Track active range (days back) per sub-tab. Default 30 = 1 month. 0 = all time.
 *  Kept independent so context-mgmt's range filter (which auto-hides ranges
 *  with no token data) doesn't override config-quality's selection. */
const activeRangeDays: Record<'config-quality' | 'context-mgmt', number> = {
  'config-quality': 30,
  'context-mgmt': 30,
};

const ALL_RANGES: { days: number; label: string }[] = [
  { days: 30, label: 'Last 1 month' },
  { days: 90, label: 'Last 3 months' },
  { days: 180, label: 'Last 6 months' },
  { days: 365, label: 'Last 12 months' },
  { days: 0, label: 'All time' },
];

export async function renderConfigHealth(container: HTMLElement, currentFilter: DateFilter): Promise<void> {
  // Helpers for the TOKEN_DATA_AVAILABLE_FROM cutoff. Both sub-tabs (Context
  // Quality, Context Management) analyze token-driven signals, so any range
  // whose nominal start lies before the cutoff is greyed out with an
  // explanatory tooltip. As time advances and post-cutoff data fills the
  // longer ranges, the disabled buttons re-enable automatically.
  function rangeStartDate(days: number): string {
    if (days === 0) return '0001-01-01';
    const d = new Date();
    d.setDate(d.getDate() - days);
    return d.toISOString().slice(0, 10);
  }
  function isRangeDisabledByCutoff(days: number): boolean {
    return rangeStartDate(days) < TOKEN_DATA_AVAILABLE_FROM;
  }

  function buildRangeFilter(): DateFilter {
    const f: DateFilter = { ...currentFilter };
    const days = activeRangeDays[activeSubTab];
    if (days > 0) {
      f.fromDate = rangeStartDate(days);
    }
    // Both sub-tabs are token-data sensitive — clamp the lower bound to the
    // cutoff so even "All time" excludes pre-cutoff sessions.
    if (!f.fromDate || f.fromDate < TOKEN_DATA_AVAILABLE_FROM) {
      f.fromDate = TOKEN_DATA_AVAILABLE_FROM;
    }
    return f;
  }

  // For context-mgmt, fetch availability so we can hide buttons that would
  // yield no extra token data. Refresh on every render so reindexed data
  // is reflected immediately.
  let visibleRanges = ALL_RANGES;
  let emptyRangeMessage = 'No token-bearing context data available.';
  if (activeSubTab === 'context-mgmt') {
    try {
      const avail = await rpc<{
        rangesWithTokens: number[];
        matchingSessions: number;
        sessionsWithRequestTokens: number;
        harnessesWithoutRequestTokens: string[];
      }>(
        'getContextRangeAvailability',
        { filter: { ...currentFilter, fromDate: undefined, toDate: undefined } } as Record<string, unknown>,
      );
      const allowed = new Set(avail.rangesWithTokens);
      visibleRanges = ALL_RANGES.filter(r => allowed.has(r.days));
      // If the current range is no longer available, snap to the nearest
      // broader range that IS available (or the only available range, if
      // we have to widen significantly).
      if (visibleRanges.length > 0 && !allowed.has(activeRangeDays['context-mgmt'])) {
        const sortedAvail = [...avail.rangesWithTokens]
          .map(r => r === 0 ? Number.POSITIVE_INFINITY : r)
          .sort((a, b) => a - b);
        const cur = activeRangeDays['context-mgmt'] === 0 ? Number.POSITIVE_INFINITY : activeRangeDays['context-mgmt'];
        const nextBroader = sortedAvail.find(r => r >= cur) ?? sortedAvail[sortedAvail.length - 1];
        activeRangeDays['context-mgmt'] = nextBroader === Number.POSITIVE_INFINITY ? 0 : nextBroader;
      }
      // Build a contextual empty-state message when no ranges have data.
      if (visibleRanges.length === 0) {
        if (avail.matchingSessions === 0) {
          emptyRangeMessage = currentFilter.harness
            ? `No sessions found for ${currentFilter.harness}.`
            : 'No sessions match the current filter.';
        } else if (avail.sessionsWithRequestTokens === 0 && avail.harnessesWithoutRequestTokens.length > 0) {
          // Sessions exist, but none have per-request token data.
          const harnesses = avail.harnessesWithoutRequestTokens.join(', ');
          emptyRangeMessage = `${harnesses} only emits session-aggregated tokens, not per-request — Context Management requires per-request data to chart utilization. Try a different harness, or view consumption in the Output tab.`;
        } else {
          emptyRangeMessage = 'No token-bearing context data available.';
        }
      }
    } catch {
      // Fall back to all ranges on error so the UI stays usable.
    }
  }

  // If the active range falls before the cutoff (e.g. user previously chose
  // "All time" then context-mgmt's data filter shrank the visibleRanges to
  // post-cutoff only), snap to the largest enabled range so the page renders
  // with valid data.
  const enabledByCutoff = visibleRanges.filter(r => !isRangeDisabledByCutoff(r.days));
  if (enabledByCutoff.length > 0 && isRangeDisabledByCutoff(activeRangeDays[activeSubTab])) {
    const longest = enabledByCutoff.reduce((a, b) => {
      const aSpan = a.days === 0 ? Number.POSITIVE_INFINITY : a.days;
      const bSpan = b.days === 0 ? Number.POSITIVE_INFINITY : b.days;
      return bSpan > aSpan ? b : a;
    });
    activeRangeDays[activeSubTab] = longest.days;
  }

  // Render sub-tab navigation + range bar
  const tabBarStyle = 'display:flex;gap:0;border-bottom:1px solid var(--border-color, #30363d);margin-bottom:0;';
  const tabStyle = (active: boolean) =>
    `padding:8px 18px;font-size:13px;font-weight:${active ? '600' : '500'};cursor:pointer;border:none;background:transparent;color:${active ? 'var(--text-primary, #c9d1d9)' : 'var(--text-muted, #8b949e)'};border-bottom:2px solid ${active ? COLORS.blue : 'transparent'};transition:color 0.15s,border-color 0.15s;`;

  const cur = activeRangeDays[activeSubTab];
  const cutoffTitle = `Sessions before ${TOKEN_DATA_AVAILABLE_FROM} did not capture per-request token data, so this range can't show meaningful context analytics. It will become available again once enough recent data falls within the range.`;
  const rangeButtons = visibleRanges.length > 0
    ? visibleRanges.map(r => {
        const disabled = isRangeDisabledByCutoff(r.days);
        const isActive = cur === r.days && !disabled;
        const cls = `cons-range-btn${isActive ? ' active' : ''}${disabled ? ' disabled' : ''}`;
        return disabled
          ? html`<button class=${cls} data-range=${String(r.days)} disabled aria-disabled="true" title=${cutoffTitle} style="opacity:0.4;cursor:not-allowed;">${r.label}</button>`
          : html`<button class=${cls} data-range=${String(r.days)}>${r.label}</button>`;
      })
    : html`<span style="color:var(--text-muted);font-size:12px;padding:4px 8px;line-height:1.4;">${emptyRangeMessage}</span>`;

  render(html`
    <div style=${tabBarStyle}>
      <button id="ctxSubTabConfig" class="ctx-sub-tab" data-tab="config-quality" style=${tabStyle(activeSubTab === 'config-quality')}>Context Quality</button>
      <button id="ctxSubTabMgmt" class="ctx-sub-tab" data-tab="context-mgmt" style=${tabStyle(activeSubTab === 'context-mgmt')}>Context Management</button>
    </div>
    <div class="cons-range-bar" id="ctxRangeBar" style="margin-top:12px;display:flex;align-items:center;gap:0;flex-wrap:wrap;">
      ${rangeButtons}
    </div>
    <div id="ctxSubTabContent"></div>`, container);

  const contentEl = document.getElementById('ctxSubTabContent')!;

  // Range bar click handler — disabled buttons (greyed out for ranges that
  // dip below TOKEN_DATA_AVAILABLE_FROM) are no-ops.
  for (const btn of container.querySelectorAll('#ctxRangeBar .cons-range-btn')) {
    btn.addEventListener('click', () => {
      const el = btn as HTMLElement;
      if (el.hasAttribute('disabled')) return;
      const days = Number.parseInt(el.dataset.range!, 10);
      if (isRangeDisabledByCutoff(days)) return;
      if (days === activeRangeDays[activeSubTab]) return;
      activeRangeDays[activeSubTab] = days;
      destroyCharts();
      void renderConfigHealth(container, currentFilter);
    });
  }

  // Tab click handlers
  for (const btn of container.querySelectorAll('.ctx-sub-tab')) {
    btn.addEventListener('click', () => {
      const tab = (btn as HTMLElement).dataset.tab as typeof activeSubTab;
      if (tab === activeSubTab) return;
      activeSubTab = tab;
      destroyCharts();
      void renderConfigHealth(container, currentFilter);
    });
  }

  const effectiveFilter = buildRangeFilter();

  // Show loading spinner while sub-tab data is fetched
  render(html`<div class="loading-spinner" style="margin:40px auto;"></div>`, contentEl);

  if (activeSubTab === 'context-mgmt') {
    await renderContextManagement(contentEl, effectiveFilter);
  } else {
    await renderConfigQuality(contentEl, effectiveFilter);
  }
}

async function renderConfigQuality(container: HTMLElement, currentFilter: DateFilter): Promise<void> {
  const data = await rpc<ConfigHealthData>('getConfigHealth', currentFilter as Record<string, unknown>);
  // Filter out workspaces with 0 requests
  data.workspaces = data.workspaces.filter(w => w.requestCount > 0);
  const overallColor = data.overallScore >= 45 ? COLORS.green : data.overallScore >= 25 ? COLORS.yellow : COLORS.red;
  const ar = data.agenticReadiness;
  const arColor = ar.score >= 45 ? COLORS.green : ar.score >= 25 ? COLORS.yellow : COLORS.red;
  const wsCount = data.workspaces.length;
  const withInstructions = data.workspaces.filter(w => w.hasInstructions).length;
  const harnesses = [...new Set(data.workspaces.flatMap(w => w.harness.split(', ')))].sort();

  render(html`
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:8px;">
      <h2 style="margin:0;">Context Health</h2>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
        <select id="ctxHarnessFilter" style="padding:4px 8px;border-radius:6px;background:var(--card-bg, #161b22);border:1px solid var(--border-color, #30363d);color:var(--text-primary, #c9d1d9);font-size:12px;">
          <option value="">All Harnesses</option>
          ${harnesses.map(h => html`<option value=${h} selected=${currentFilter.harness === h || undefined}>${h}</option>`)}
        </select>
        <button id="ctxReviewBtn" style="padding:5px 14px;border-radius:6px;background:var(--accent-blue);color:#fff;border:none;font-size:12px;font-weight:600;cursor:pointer;transition:opacity 0.15s;" title="AI reviews your context files and scores them">Review Context Files</button>
        <select id="ctxReviewCount" style="padding:4px 6px;border-radius:6px;background:var(--card-bg, #161b22);border:1px solid var(--border-color, #30363d);color:var(--text-primary, #c9d1d9);font-size:12px;" title="Number of workspaces to review">
          <option value="3">Top 3</option>
          <option value="5" selected>Top 5</option>
          <option value="10">Top 10</option>
          <option value="15">Top 15</option>
        </select>
      </div>
    </div>
    <div class="stat-grid">
      <${StatCard} label="Overall Score" value=${data.overallScore + '/100'} accent=${overallColor} />
      <${StatCard} label="Agentic Readiness" value=${ar.score + '/100'} accent=${arColor} />
      <${StatCard} label="Active Workspaces" value=${String(wsCount)} accent=${COLORS.blue} />
      <${StatCard} label="With Context Files" value=${`${withInstructions}/${wsCount}`} accent=${withInstructions === wsCount && wsCount > 0 ? COLORS.green : COLORS.yellow} />
    </div>
    ${renderAgenticReadiness(ar)}
    ${renderContextProvision(data.contextProvisionByHarness)}
    <div id="ctxReviewResults"></div>
    <h3 style="margin-top:24px;">Workspace Context Map</h3>
    <p style="color:var(--text-muted);font-size:12px;margin:4px 0 12px;">Size = request volume. Color = instruction quality score. <b>Click a tile</b> for details & suggestions.</p>
    <div id="ctxTreemapWrap" style="min-height:200px;position:relative;"><canvas id="ctxTreemapCanvas" height="350"></canvas></div>
    <div id="ctxTileDetail" style="display:none;"></div>
    ${wsCount === 0 ? html`<div style="text-align:center;padding:40px 20px;color:var(--text-muted);"><div style="font-size:18px;margin-bottom:8px;">No active workspaces found</div><div>Requires workspaces with 50+ requests in the selected timeframe.</div></div>` : null}`, container);

  if (data.workspaces.length > 0) renderTreemap(data.workspaces, container);

  // Harness filter change
  document.getElementById('ctxHarnessFilter')?.addEventListener('change', (e) => {
    void renderConfigQuality(container, { ...currentFilter, harness: (e.target as HTMLSelectElement).value || undefined });
  });

  // Context provision row click
  for (const el of container.querySelectorAll<HTMLElement>('.ctx-provision-row')) {
    el.addEventListener('click', () => {
      const rowEl = el;
      const idx = Number.parseInt(rowEl.dataset.provisionIdx || '-1', 10);
      const detail = currentProvisionRows[idx];
      const panel = container.querySelector<HTMLElement>('#ctxProvisionDetailPanel');
      if (!detail || !panel) return;

      const isActive = rowEl.dataset.active === 'true';
      for (const otherEl of container.querySelectorAll<HTMLElement>('.ctx-provision-row')) {
        otherEl.dataset.active = 'false';
        otherEl.style.background = 'transparent';
      }

      if (isActive) {
        panel.style.display = 'none';
        render(null, panel);
        return;
      }

      rowEl.dataset.active = 'true';
      rowEl.style.background = 'rgba(88,166,255,0.06)';
      panel.style.display = 'block';
      render(renderProvisionDetailPanel(detail), panel);
    });
  }
  // Review button
  document.getElementById('ctxReviewBtn')?.addEventListener('click', () => {
    void runContextReview(data.workspaces);
  });
}

/* ── Agentic Readiness ────────────────────────────────────────────── */

function renderAgenticReadiness(ar: AgenticReadinessScore): ComponentChildren {
  if (ar.signals.length === 0) return null;
  const present = ar.signals.filter(s => s.present).length;
  const total = ar.signals.length;
  return html`
    <h3 style="margin-top:24px;">Agentic Readiness</h3>
    <p style="color:var(--text-muted);font-size:12px;margin:4px 0 8px;">${present}/${total} signals detected. Are your projects ready for AI agents?</p>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px;margin:8px 0 16px;">
      ${ar.signals.map(s => {
        const ic = s.present ? COLORS.green : COLORS.red;
        const icon = s.present ? '\u2713' : '\u2717';
        const bg = s.present ? 'rgba(63,185,80,0.08)' : 'rgba(248,81,73,0.06)';
        const border = s.present ? 'rgba(63,185,80,0.3)' : 'rgba(248,81,73,0.2)';
        return html`<div style="padding:10px 12px;border-radius:8px;background:${bg};border:1px solid ${border};" title=${s.detail}>
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
            <span style="color:${ic};font-size:14px;">${icon}</span>
            <span style="font-weight:600;font-size:13px;">${s.label}</span>
            <span style="margin-left:auto;font-size:10px;color:var(--text-muted);font-weight:500;">${s.weight}pt</span>
          </div>
          <div style="font-size:11px;color:var(--text-muted);line-height:1.3;">${s.detail}</div>
        </div>`;
      })}
    </div>`;
}

/* ── Context Review (AI Agent Flow) ───────────────────────────────── */

const CATEGORY_LABELS: Record<string, string> = {
  clarity: 'Clarity', specificity: 'Specificity', structure: 'Structure',
  completeness: 'Completeness', staleness: 'Staleness', redundancy: 'Redundancy',
  actionability: 'Actionability',
};

const CATEGORY_TOOLTIPS: Record<string, string> = {
  clarity: 'How easy it is for the AI to understand your instructions without ambiguity.',
  specificity: 'How precisely your instructions target concrete behaviors, tools, or patterns.',
  structure: 'How well-organized your instructions are with headings, lists, and logical sections.',
  completeness: 'How thoroughly your instructions cover the necessary topics and edge cases.',
  staleness: 'Whether your instructions are up-to-date and free of outdated references.',
  redundancy: 'How free your instructions are from duplicate or overlapping content.',
  actionability: 'How directly the AI can act on your instructions without needing clarification.',
};

const GRADE_COLORS: Record<string, string> = {
  A: COLORS.green, B: '#58a6ff', C: COLORS.yellow, D: COLORS.orange, F: COLORS.red,
};

async function runContextReview(workspaces: WorkspaceConfigHealth[]): Promise<void> {
  const btn = document.getElementById('ctxReviewBtn') as HTMLButtonElement | null;
  const countSelect = document.getElementById('ctxReviewCount') as HTMLSelectElement | null;
  const resultsEl = document.getElementById('ctxReviewResults');
  if (!resultsEl) return;
  if (btn) { btn.disabled = true; btn.textContent = 'Reviewing...'; btn.style.opacity = '0.6'; }

  const reviewCount = countSelect ? Number.parseInt(countSelect.value, 10) : 5;
  const toReview = workspaces.slice(0, reviewCount);
  const wsIds = toReview.map(w => w.workspaceId);

  // Grey out treemap tiles
  if (activeTreemapChart) {
    const ds = (activeTreemapChart.data.datasets[0] as unknown as { backgroundColor: unknown; _origBg?: unknown });
    ds._origBg = ds.backgroundColor;
    ds.backgroundColor = () => 'rgba(128, 128, 128, 0.3)';
    activeTreemapChart.update('none');
  }

  // Show simple loading indicator
  render(html`
    <div style="margin:20px 0;padding:24px;border-radius:8px;background:var(--card-bg, #161b22);border:1px solid var(--border-color, #30363d);display:flex;align-items:center;gap:12px;">
      <div class="loading-spinner" style="width:20px;height:20px;border-width:2px;flex-shrink:0;"></div>
      <div>
        <div style="font-size:14px;font-weight:600;color:var(--text-primary, #c9d1d9);">Reviewing context files\u2026</div>
        <div style="font-size:12px;color:var(--text-muted);margin-top:4px;">Analyzing ${toReview.length} workspace${toReview.length > 1 ? 's' : ''}</div>
      </div>
    </div>`, resultsEl);

  try {
    const result = await rpc<{ reviews?: ContextReviewResult[]; error?: string }>('reviewContextFiles', { workspaceIds: wsIds, count: reviewCount } as Record<string, unknown>);

    if (result.error) {
      render(html`<div style="margin:16px 0;padding:12px 16px;border-radius:6px;border-left:3px solid ${COLORS.red};background:rgba(248,81,73,0.06);font-size:13px;color:${COLORS.red};">Review failed: ${result.error}</div>`, resultsEl);
      return;
    }
    const reviews = result.reviews || [];
    if (reviews.length === 0) {
      render(html`<div style="margin:16px 0;padding:12px;text-align:center;color:var(--text-muted);font-size:13px;">No review results returned.</div>`, resultsEl);
      return;
    }
    render(html`
      <h3 style="margin-top:24px;">Context File Review</h3>
      <p style="color:var(--text-muted);font-size:12px;margin:4px 0 12px;">AI-powered review of your instruction files across ${reviews.length} workspace(s).</p>
      ${reviews.map(r => renderReviewCard(r))}`, resultsEl);
    // Collapse/expand
    for (const el of resultsEl.querySelectorAll('.ctx-review-header')) {
      el.addEventListener('click', () => {
        const body = el.nextElementSibling as HTMLElement | null;
        if (!body) return;
        const open = body.style.display !== 'none';
        body.style.display = open ? 'none' : 'block';
        const arrow = el.querySelector('.ctx-review-arrow');
        if (arrow) arrow.textContent = open ? '\u25B6' : '\u25BC';
      });
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Review failed';
    render(html`<div style="margin:16px 0;padding:12px 16px;border-radius:6px;border-left:3px solid ${COLORS.red};background:rgba(248,81,73,0.06);font-size:13px;color:${COLORS.red};">Error: ${msg}</div>`, resultsEl);
  } finally {
    // Restore treemap colors
    if (activeTreemapChart) {
      const ds = (activeTreemapChart.data.datasets[0] as unknown as { backgroundColor: unknown; _origBg?: unknown });
      if (ds._origBg) { ds.backgroundColor = ds._origBg; delete ds._origBg; }
      activeTreemapChart.update('none');
    }
    if (btn) { btn.disabled = false; btn.textContent = 'Review Context Files'; btn.style.opacity = '1'; }
  }
}

function renderReviewCard(review: ContextReviewResult): ComponentChildren {
  const gc = GRADE_COLORS[review.overallGrade] || COLORS.muted;
  const cats = Object.entries(review.categoryScores);
  const findings = review.findings || [];
  const goodCount = findings.filter(f => f.severity === 'good').length;
  const warnCount = findings.filter(f => f.severity === 'warning').length;
  const critCount = findings.filter(f => f.severity === 'critical').length;

  return html`
    <div style="margin:10px 0;border-radius:8px;background:var(--card-bg, #161b22);border:1px solid var(--border-color, #30363d);overflow:hidden;">
      <div class="ctx-review-header" style="display:flex;align-items:center;padding:12px 16px;cursor:pointer;user-select:none;gap:12px;">
        <span class="ctx-review-arrow" style="font-size:11px;color:var(--text-muted);">${'\u25BC'}</span>
        <div style="display:flex;align-items:center;gap:8px;flex:1;min-width:0;">
          <span style="font-size:24px;font-weight:800;color:${gc};line-height:1;">${review.overallGrade}</span>
          <div>
            <div style="font-weight:600;font-size:14px;">${review.workspaceName}</div>
            <div style="font-size:11px;color:var(--text-muted);">${review.overallScore}/100 \u2014 ${goodCount} good, ${warnCount} warnings, ${critCount} critical</div>
          </div>
        </div>
        <div style="display:flex;gap:4px;flex-shrink:0;">
          ${cats.map(([cat, score]) => {
            const c = score >= 45 ? COLORS.green : score >= 25 ? COLORS.yellow : COLORS.red;
            const tip = CATEGORY_TOOLTIPS[cat] || '';
            return html`<div style="text-align:center;min-width:42px;" data-tip=${tip || undefined} tabindex=${tip ? 0 : undefined} aria-label=${tip || undefined}><div style="font-size:12px;font-weight:700;color:${c};">${score}</div><div style="font-size:8px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.3px;">${(CATEGORY_LABELS[cat] || cat).slice(0, 5)}</div></div>`;
          })}
        </div>
      </div>
      <div style="display:block;padding:0 16px 16px;border-top:1px solid var(--border-color, #30363d);">
        <div style="padding:10px 0 8px;font-size:12px;color:var(--text-muted);line-height:1.5;font-style:italic;">${review.summary}</div>
        ${renderCategoryBars(cats)}
        <div style="margin-top:12px;">
          <div style="font-weight:600;font-size:13px;margin-bottom:8px;">Findings</div>
          ${findings.map(f => renderFinding(f))}
        </div>
      </div>
    </div>`;
}

function renderCategoryBars(cats: [string, number][]): ComponentChildren {
  return html`<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:8px 0 4px;">
    ${cats.map(([cat, score]) => sBar(CATEGORY_LABELS[cat] || cat, score, CATEGORY_TOOLTIPS[cat]))}
  </div>`;
}

function renderFinding(f: ContextReviewFinding): ComponentChildren {
  const sevIcon = f.severity === 'good' ? html`<span style="color:${COLORS.green};">${'\u2713'}</span>`
    : f.severity === 'critical' ? html`<span style="color:${COLORS.red};">${'\u2717'}</span>`
    : html`<span style="color:${COLORS.yellow};">${'\u26A0'}</span>`;
  const catLabel = CATEGORY_LABELS[f.category] || f.category;
  const bg = f.severity === 'good' ? 'rgba(63,185,80,0.05)' : f.severity === 'critical' ? 'rgba(248,81,73,0.06)' : 'rgba(210,153,34,0.06)';
  return html`
    <div style="padding:8px 10px;margin:4px 0;border-radius:6px;background:${bg};font-size:12px;">
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:3px;">
        ${sevIcon}
        <span style="font-weight:600;">${catLabel}</span>
        ${f.file ? html`<span style="color:var(--text-muted);font-family:monospace;font-size:11px;">${f.file}</span>` : null}
      </div>
      <div style="color:var(--text-secondary, #c9d1d9);line-height:1.4;">${f.finding}</div>
      ${f.suggestion ? html`<div style="color:var(--text-muted);margin-top:3px;font-style:italic;">${f.suggestion}</div>` : null}
    </div>`;
}

/* ── Treemap (Chart.js chartjs-chart-treemap) ─────────────────────── */

function renderTreemap(workspaces: WorkspaceConfigHealth[], container: HTMLElement): void {
  const canvas = document.getElementById('ctxTreemapCanvas') as HTMLCanvasElement | null;
  if (!canvas) return;
  if (workspaces.length === 0) return;

  const treeData = workspaces.map(w => {
    const uniqueHarnesses = [...new Set(w.harness.split(', '))].join(', ');
    const badges: string[] = [];
    if (w.hasInstructions) badges.push('Instructions');
    if (w.hasPrompts) badges.push('Prompts');
    if (w.hasAgents) badges.push('Agents');
    if (w.hasSkills) badges.push('Skills');
    if (w.hasHooks) badges.push('Hooks');
    return {
      name: w.workspaceName,
      requests: w.requestCount,
      sessions: w.sessionCount,
      score: w.progressiveDisclosureScore,
      qualityScore: w.instructionQualityScore,
      files: w.configFiles.length,
      harness: uniqueHarnesses,
      stale: w.staleContext,
      staleDays: w.staleDays,
      badges,
      lastActivity: w.lastActivity ? new Date(w.lastActivity).toLocaleDateString() : 'N/A',
    };
  });

  /** Smooth gradient: 0 = red, ~35 = yellow, 100 = green (lenient) */
  function scoreColor(score: number, alpha = 0.7): string {
    const t = Math.max(0, Math.min(100, score)) / 100;
    let r: number, g: number, b: number;
    if (t < 0.35) {
      const f = t / 0.35;
      r = 248 + (210 - 248) * f;
      g = 81 + (153 - 81) * f;
      b = 73 + (34 - 73) * f;
    } else {
      const f = (t - 0.35) / 0.65;
      r = 210 + (63 - 210) * f;
      g = 153 + (185 - 153) * f;
      b = 34 + (80 - 34) * f;
    }
    return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${alpha})`;
  }

  const chart = new Chart(canvas, {
    type: 'treemap' as never,
    data: {
      datasets: [{
        tree: treeData,
        key: 'requests',
        labels: { display: true, formatter: (ctx: { raw: { w: number; h: number; _data: { name: string; score: number; requests: number } } }) => {
          const d = ctx.raw._data;
          if (!d) return '';
          const w = ctx.raw.w || 0;
          const h = ctx.raw.h || 0;
          // Small tiles: name only, no stats
          if (w < 80 || h < 35) return d.name.length > 10 ? d.name.slice(0, 9) + '\u2026' : d.name;
          return [d.name, `${d.score}pts`];
        }, color: '#fff', font: (ctx: { raw: { w: number; h: number } }) => {
          const w = ctx.raw?.w || 0;
          const h = ctx.raw?.h || 0;
          if (w < 80 || h < 35) return { size: 9, weight: 'bold' as const };
          return { size: 11, weight: 'bold' as const };
        }, padding: 4 },
        backgroundColor: (ctx: { raw: { _data: { qualityScore: number } }; active?: boolean }) => {
          const d = ctx.raw?._data;
          return d ? scoreColor(d.qualityScore, ctx.active ? 0.9 : 0.72) : '#888';
        },
        borderColor: (ctx: { raw: { _data: { qualityScore: number } }; active?: boolean }) => {
          const d = ctx.raw?._data;
          return d ? (ctx.active ? 'rgba(240,246,252,0.92)' : scoreColor(d.qualityScore, 1)) : '#666';
        },
        borderWidth: (ctx: { active?: boolean }) => ctx.active ? 3 : 2,
        borderRadius: 6,
        spacing: 2,
      } as never],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      onHover: (event: { native: MouseEvent }, elements: { index: number }[]) => {
        const target = event.native?.target as HTMLElement | undefined;
        if (target) target.style.cursor = elements.length > 0 ? 'pointer' : 'default';
      },
      onClick: (_event: unknown, elements: { index: number }[]) => {
        if (elements.length === 0) return;
        const idx = elements[0].index;
        const ws = workspaces[idx];
        if (!ws) return;
        showTileDetail(ws, container);
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          displayColors: false,
          backgroundColor: 'rgba(13,17,23,0.96)',
          borderColor: 'rgba(240,246,252,0.08)',
          borderWidth: 1,
          cornerRadius: 10,
          titleColor: '#f0f6fc',
          bodyColor: '#c9d1d9',
          bodySpacing: 4,
          titleSpacing: 4,
          titleMarginBottom: 6,
          padding: 12,
          caretPadding: 10,
          callbacks: {
            title: (items: { raw: { _data: { name: string } } }[]) => items[0]?.raw?._data?.name || '',
            label: (ctx: { raw: { _data: typeof treeData[0] } }) => {
              const d = ctx.raw?._data;
              if (!d) return '';
              return [
                `Harness: ${d.harness}`,
                `Requests: ${d.requests.toLocaleString()} / Sessions: ${d.sessions}`,
                `Context Score: ${d.score}/100 / Quality: ${d.qualityScore}/100`,
                `Config Files: ${d.files}${d.badges.length > 0 ? ` (${d.badges.join(', ')})` : ''}`,
                `Last Active: ${d.lastActivity}`,
                d.stale ? (d.staleDays != null ? `Stale context (${d.staleDays} days)` : 'No context files') : '',
                '',
                'Click for details & suggestions',
              ].filter(Boolean);
            },
          },
        },
      },
    } as never,
  });
  trackChart(chart);
  activeTreemapChart = chart;
}

/** Show detail panel for a clicked treemap tile */
function showTileDetail(ws: WorkspaceConfigHealth, container: HTMLElement): void {
  const detailEl = container.querySelector<HTMLElement>('#ctxTileDetail');
  if (!detailEl) return;
  const pdC = ws.progressiveDisclosureScore >= 45 ? COLORS.green : ws.progressiveDisclosureScore >= 25 ? COLORS.yellow : COLORS.red;
  const iqC = ws.instructionQualityScore >= 45 ? COLORS.green : ws.instructionQualityScore >= 25 ? COLORS.yellow : COLORS.red;
  const uniqueHarness = [...new Set(ws.harness.split(', '))].join(', ');
  const badges: ComponentChildren[] = [];
  if (ws.hasInstructions) badges.push(bdg('Instructions', COLORS.blue));
  if (ws.hasPrompts) badges.push(bdg('Prompts', COLORS.purple));
  if (ws.hasAgents) badges.push(bdg('Agents', COLORS.cyan));
  if (ws.hasSkills) badges.push(bdg('Skills', COLORS.green));
  if (ws.hasHooks) badges.push(bdg('Hooks', COLORS.orange));
  if (ws.staleContext) badges.push(bdg(ws.staleDays != null ? `Stale (${ws.staleDays}d)` : 'No context', COLORS.red));
  if (badges.length === 0) badges.push(bdg('No config files', COLORS.muted));
  const lastAct = ws.lastActivity ? new Date(ws.lastActivity).toLocaleDateString() : 'N/A';

  detailEl.style.display = 'block';
  render(html`
    <div style="margin:12px 0;border-radius:8px;background:var(--card-bg, #161b22);border:1px solid var(--border-color, #30363d);overflow:hidden;">
      <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 16px;">
        <div style="flex:1;min-width:0;">
          <div style="display:flex;align-items:center;gap:8px;">
            <span style="font-weight:600;font-size:14px;">${ws.workspaceName}</span>
            <span style="font-size:11px;color:${hc(uniqueHarness.split(', ')[0])};">${uniqueHarness}</span>
          </div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">${ws.requestCount} requests / ${ws.sessionCount} sessions / last: ${lastAct}</div>
        </div>
        <div style="display:flex;gap:16px;text-align:center;flex-shrink:0;">
          <div><div style="font-size:16px;font-weight:700;color:${pdC};">${ws.progressiveDisclosureScore}</div><div style="font-size:10px;color:var(--text-muted);">Disclosure</div></div>
          <div><div style="font-size:16px;font-weight:700;color:${iqC};">${ws.instructionQualityScore}</div><div style="font-size:10px;color:var(--text-muted);">Quality</div></div>
        </div>
        <button id="ctxTileClose" style="margin-left:12px;background:none;border:none;color:var(--text-muted);font-size:18px;cursor:pointer;padding:4px 8px;line-height:1;">${'\u00D7'}</button>
      </div>
      <div style="padding:0 16px 16px;border-top:1px solid var(--border-color, #30363d);">
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin:12px 0 8px;">${badges}</div>
        ${ws.configFiles.length > 0 ? renderCfgFiles(ws.configFiles) : html`<div style="padding:8px 0;font-size:12px;color:var(--text-muted);">No context files found.</div>`}
        ${ws.hookCoverage ? renderHooks(ws.hookCoverage) : null}
        ${ws.suggestions.length > 0 ? renderSuggestions(ws.suggestions) : null}
      </div>
    </div>`, detailEl);

  detailEl.querySelector<HTMLElement>('#ctxTileClose')?.addEventListener('click', () => {
    detailEl.style.display = 'none';
  });
  detailEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* ── Context Provision by Harness ─────────────────────────────────── */

function renderContextProvision(byHarness: Record<string, ContextProvisionScore>): ComponentChildren {
  const entries = Object.values(byHarness);
  if (entries.length === 0) return null;
  currentProvisionRows = entries.map(e => ({
    entry: e,
    fp: e.totalRequests > 0 ? Math.round(e.withFileRefs / e.totalRequests * 100) : 0,
    ip: e.totalRequests > 0 ? Math.round(e.withCustomInstructions / e.totalRequests * 100) : 0,
    sp: e.totalRequests > 0 ? Math.round(e.withSkills / e.totalRequests * 100) : 0,
    tp: e.totalRequests > 0 ? Math.round(e.withTools / e.totalRequests * 100) : 0,
  }));

  return html`
    <h3 style="margin-top:24px;">Context Provision by Harness</h3>
    <p style="color:var(--text-muted);font-size:12px;margin:4px 0 8px;">Click a row to show the detailed breakdown below.</p>
    <div style="overflow-x:auto;margin:12px 0;">
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead><tr style="text-align:left;border-bottom:1px solid var(--border-color, #30363d);">
          <th style="padding:8px;">Harness</th><th style="padding:8px;">Requests</th>
          <th style="padding:8px;">File Refs</th><th style="padding:8px;">Instructions</th>
          <th style="padding:8px;">Skills</th><th style="padding:8px;">Tools</th>
          <th style="padding:8px;">Avg Context</th><th style="padding:8px;">Score</th>
        </tr></thead>
        <tbody>${currentProvisionRows.map((row, idx) => {
          const e = row.entry;
          const sc = e.score >= 45 ? COLORS.green : e.score >= 25 ? COLORS.yellow : COLORS.red;
          const pFmt = (n: number) => e.totalRequests > 0 ? `${n} (${Math.round(n / e.totalRequests * 100)}%)` : '0';
          return html`
            <tr class="ctx-provision-row" data-provision-idx=${String(idx)} data-active="false" style="border-bottom:1px solid var(--border-color, #30363d);cursor:pointer;transition:background 0.15s;" title="Click for breakdown">
              <td style="padding:8px;font-weight:500;color:${hc(e.harness)};">${e.harness}</td>
              <td style="padding:8px;">${e.totalRequests.toLocaleString()}</td>
              <td style="padding:8px;">${pFmt(e.withFileRefs)}</td>
              <td style="padding:8px;">${pFmt(e.withCustomInstructions)}</td>
              <td style="padding:8px;">${pFmt(e.withSkills)}</td>
              <td style="padding:8px;">${pFmt(e.withTools)}</td>
              <td style="padding:8px;">${e.avgContextItems.toFixed(1)}</td>
              <td style="padding:8px;font-weight:600;color:${sc};">${Math.round(e.score)}/100</td>
            </tr>`;
        })}</tbody>
      </table>
    </div>
    <div id="ctxProvisionDetailPanel" style="display:none;margin-top:12px;"></div>`;
}

function renderProvisionDetailPanel(row: ContextProvisionDetailRow): ComponentChildren {
  return html`<div style="border:1px solid var(--border-color, #30363d);border-radius:10px;overflow:hidden;background:var(--card-bg, #161b22);">
    ${renderProvisionDetail(row.entry, row.fp, row.ip, row.sp, row.tp)}
  </div>`;
}

function renderProvisionDetail(e: ContextProvisionScore, fp: number, ip: number, sp: number, tp: number): ComponentChildren {
  const sc = e.score >= 45 ? COLORS.green : e.score >= 25 ? COLORS.yellow : COLORS.red;
  const cancelColor = e.cancelRate > 30 ? COLORS.red : e.cancelRate > 15 ? COLORS.yellow : COLORS.green;
  const promptQuality = e.avgPromptLength >= 200 ? 'Detailed' : e.avgPromptLength >= 80 ? 'Moderate' : 'Brief';
  const promptColor = e.avgPromptLength >= 200 ? COLORS.green : e.avgPromptLength >= 80 ? COLORS.yellow : COLORS.red;

  return html`
    <div style="padding:16px 20px;background:var(--bg-secondary, #0d1117);">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;">
        <span style="font-size:20px;font-weight:700;color:${sc};">${Math.round(e.score)}</span>
        <span style="font-size:12px;color:var(--text-muted);">/100</span>
        <span style="font-weight:600;font-size:14px;color:${hc(e.harness)};">${e.harness}</span>
        <span style="margin-left:auto;font-size:11px;color:var(--text-muted);">${e.totalSessions.toLocaleString()} sessions \u00B7 ${e.totalRequests.toLocaleString()} requests</span>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:14px;margin-bottom:18px;">
        ${sBar('File References (30%)', fp)}${sBar('Custom Instructions (30%)', ip)}
        ${sBar('Skills Used (20%)', sp)}${sBar('Tool Usage (20%)', tp)}
      </div>

      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:18px;">
        ${metricCard('Avg Reqs / Session', String(e.avgRequestsPerSession), 'var(--text-primary, #c9d1d9)')}
        ${metricCard('Avg Prompt Length', `${e.avgPromptLength.toLocaleString()} chars`, promptColor, promptQuality)}
        ${metricCard('Avg Response Length', `${e.avgResponseLength.toLocaleString()} chars`, 'var(--text-primary, #c9d1d9)')}
        ${metricCard('Cancel Rate', `${e.cancelRate}%`, cancelColor)}
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:16px;">
        ${rankList('Mode Distribution', e.modeDistribution.map(m => ({ label: m.mode, count: m.count })), e.totalRequests)}
        ${rankList('Top Models', e.topModels.map(m => ({ label: m.model, count: m.count })), e.totalRequests)}
        ${rankList('Top Tools', e.topTools.map(t => ({ label: t.tool, count: t.count })), e.totalRequests)}
        ${rankList('Top Referenced Files', e.topReferencedFiles.map(f => ({ label: f.file, count: f.count })), e.withFileRefs || 1)}
      </div>
    </div>`;
}

function metricCard(label: string, value: string, color: string, subtitle?: string): ComponentChildren {
  return html`<div style="padding:8px 10px;border-radius:6px;background:var(--bg-tertiary, #161b22);">
    <div style="font-size:10px;color:var(--text-muted);margin-bottom:2px;">${label}</div>
    <div style="font-size:15px;font-weight:600;color:${color};">${value}</div>
    ${subtitle ? html`<div style="font-size:10px;color:var(--text-muted);margin-top:1px;">${subtitle}</div>` : null}
  </div>`;
}

function rankList(title: string, items: { label: string; count: number }[], total: number): ComponentChildren {
  if (items.length === 0) return html`<div style="padding:8px 10px;border-radius:6px;background:var(--bg-tertiary, #161b22);"><div style="font-size:11px;font-weight:500;color:var(--text-muted);margin-bottom:6px;">${title}</div><div style="font-size:11px;color:var(--text-muted);font-style:italic;">No data</div></div>`;
  return html`<div style="padding:8px 10px;border-radius:6px;background:var(--bg-tertiary, #161b22);">
    <div style="font-size:11px;font-weight:500;color:var(--text-muted);margin-bottom:6px;">${title}</div>
    ${items.map(it => {
      const pct = total > 0 ? Math.round(it.count / total * 100) : 0;
      return html`<div class="tip-left" style="display:flex;align-items:center;gap:6px;margin-bottom:4px;" data-tip=${it.label} tabindex=${0} aria-label=${it.label}>
        <div style="flex:1;min-width:0;">
          <div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:1px;min-width:0;">
            <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;">${it.label}</span>
            <span style="color:var(--text-muted);flex-shrink:0;margin-left:4px;">${it.count} (${pct}%)</span>
          </div>
          <div style="height:3px;border-radius:2px;background:var(--bg-secondary, #0d1117);overflow:hidden;">
            <div style="width:${pct}%;height:100%;background:${COLORS.blue};border-radius:2px;"></div>
          </div>
        </div>
      </div>`;
    })}
  </div>`;
}

function sBar(label: string, pct: number, tooltip?: string): ComponentChildren {
  const c = pct >= 45 ? COLORS.green : pct >= 25 ? COLORS.yellow : COLORS.red;
  return html`<div data-tip=${tooltip || undefined} tabindex=${tooltip ? 0 : undefined} aria-label=${tooltip || undefined}><div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:2px;"><span>${label}</span><span style="color:${c};font-weight:600;">${pct}%</span></div><div style="height:6px;border-radius:3px;background:var(--bg-secondary, #161b22);overflow:hidden;"><div style="width:${pct}%;height:100%;background:${c};border-radius:3px;"></div></div></div>`;
}

/* ── Config Files ─────────────────────────────────────────────────── */

function renderCfgFiles(files: ConfigFileInfo[]): ComponentChildren {
  return html`<div style="margin:8px 0;"><div style="font-weight:500;font-size:13px;margin-bottom:6px;color:var(--text-secondary, #c9d1d9);">Config Files</div><div style="display:flex;flex-direction:column;gap:4px;">${files.map(f => {
    const sc = f.sizeVerdict === 'oversized' ? COLORS.red : f.sizeVerdict === 'moderate' ? COLORS.yellow : COLORS.green;
    const sl = f.sizeVerdict === 'oversized' ? 'OVERSIZED' : f.sizeVerdict === 'moderate' ? 'moderate' : 'compact';
    const ki = fKindIcon(f.kind);
    const ic = f.markdownIssues.length;
    return html`<div style="display:flex;align-items:center;gap:8px;padding:4px 8px;border-radius:4px;background:var(--bg-secondary, #0d1117);font-size:12px;">
      <span style="width:16px;text-align:center;">${ki}</span>
      <span style="flex:1;font-family:monospace;">${f.relativePath}</span>
      <span style="color:var(--text-muted);">${f.lines} lines</span>
      <span style="color:var(--text-muted);">${fmtSz(f.chars)}</span>
      <span style="color:${sc};font-size:11px;font-weight:500;">${sl}</span>
      ${f.lastModified ? html`<span style="color:var(--text-muted);font-size:11px;" title="Last modified">${new Date(f.lastModified).toLocaleDateString()}</span>` : null}
      ${ic > 0 ? html`<span style="color:${COLORS.yellow};font-size:11px;" title=${f.markdownIssues.join('; ')}>${ic} issue${ic > 1 ? 's' : ''}</span>` : null}
    </div>`;
  })}</div></div>`;
}

/* ── Hook Coverage ────────────────────────────────────────────────── */

function renderHooks(hooks: HookCoverageInfo): ComponentChildren {
  const evts: { n: string; a: boolean; d: string }[] = [
    { n: 'PreToolUse', a: hooks.hasPreToolUse, d: 'Security boundaries' },
    { n: 'PostToolUse', a: hooks.hasPostToolUse, d: 'Auto-formatting, audit logging' },
    { n: 'SessionStart', a: hooks.hasSessionStart, d: 'Environment sync' },
    { n: 'PermissionRequest', a: hooks.hasPermissionRequest, d: 'Auto-approve/deny' },
  ];
  const extra = hooks.hookEvents.filter(e => !['PreToolUse', 'PostToolUse', 'SessionStart', 'PermissionRequest'].includes(e));
  return html`<div style="margin:8px 0;"><div style="font-weight:500;font-size:13px;margin-bottom:6px;color:var(--text-secondary);">Hook Coverage (${hooks.totalHooks})</div><div style="display:flex;flex-wrap:wrap;gap:6px;">${evts.map(e => {
    const c = e.a ? COLORS.green : COLORS.muted;
    return html`<div style="padding:4px 10px;border-radius:4px;background:var(--bg-secondary, #0d1117);font-size:12px;display:flex;align-items:center;gap:4px;" title=${e.d}><span style="color:${c};">${e.a ? '\u2713' : '\u2717'}</span><span style="color:${e.a ? 'var(--text-primary)' : 'var(--text-muted)'};">${e.n}</span></div>`;
  })}</div>${extra.length > 0 ? html`<div style="margin-top:4px;font-size:11px;color:var(--text-muted);">Additional: ${extra.join(', ')}</div>` : null}</div>`;
}

/* ── Suggestions ──────────────────────────────────────────────────── */

function renderSuggestions(suggestions: string[]): ComponentChildren {
  return html`<div style="margin:8px 0;padding:8px 12px;border-radius:6px;border-left:3px solid ${COLORS.yellow};background:rgba(210,153,34,0.05);"><div style="font-size:12px;font-weight:500;color:${COLORS.yellow};margin-bottom:4px;">Suggestions</div><ul style="margin:0;padding-left:16px;font-size:12px;color:var(--text-secondary, #8b949e);">${suggestions.slice(0, 5).map(s => html`<li style="margin:2px 0;">${s}</li>`)}</ul></div>`;
}

/* ── Helpers ──────────────────────────────────────────────────────── */

function bdg(label: string, color: string): ComponentChildren {
  return html`<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:500;color:${color};border:1px solid ${color};opacity:0.9;">${label}</span>`;
}

function fKindIcon(kind: ConfigFileInfo['kind']): string {
  switch (kind) {
    case 'instruction': return '\u{1F4DC}';
    case 'prompt': return '\u{1F4AC}';
    case 'agent': return '\u{1F916}';
    case 'skill': return '\u26A1';
    case 'hook-config': return '\u{1F517}';
    case 'claude-md': return '\u{1F4D6}';
    default: return '\u{1F4C4}';
  }
}

function fmtSz(chars: number): string {
  return chars < 1000 ? `${chars}c` : `${(chars / 1000).toFixed(1)}k`;
}
