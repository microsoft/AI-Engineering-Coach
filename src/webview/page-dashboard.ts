/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Dashboard page renderer */

import { DateFilter, DailyActivity, PRACTICE_GROUPS, AntiPatternData, WorkflowOptimizationData, SkillTriageResult, CatalogDiscoverResult, CatalogTriageResult, GroupScore, CodeProductionData } from '../core/types';
import { FF_TOKEN_REPORTING_ENABLED } from '../core/constants';
import { rpc, rpcAllSettled, createChart, formatNum, COLORS, PALETTE, harnessColor, destroyChartById, scoreColor, scoreLabel } from './shared';
import { html, render, CanvasEl, ScoreRing, PctBadge } from './render';
import { setSkillCache, getSkillCache } from './skill-cache';
import { funScoreLabel, t, tFormat } from './i18n';

// Module-level view state — survives filter/harness changes.
let activeMetric = 'requests';

const DASHBOARD_LANGUAGE_ALIASES: Record<string, string> = {
  py: 'python',
  python3: 'python',
  pyw: 'python',
  pyi: 'python',
  pyx: 'python',
};

const DASHBOARD_LANGUAGE_LABELS: Record<string, string> = {
  python: 'Python',
  typescript: 'TypeScript',
  javascript: 'JavaScript',
  shell: 'Shell',
  csharp: 'C#',
  cpp: 'C++',
  plaintext: 'Plain Text',
};

function SkillCard({ title, subtitle }: { title: string; subtitle: string }) {
  return html`<div style="display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:6px;background:var(--bg-secondary, #0d1117);">
    <span style=${'flex-shrink:0;width:6px;height:6px;border-radius:50%;background:' + COLORS.blue + ';'}></span>
    <div style="min-width:0;">
      <div style="font-size:12px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${title}</div>
      <div style="font-size:11px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${subtitle}</div>
    </div>
  </div>`;
}

function normalizeDashboardLanguage(label: string): string {
  const normalized = label.trim().toLowerCase();
  return DASHBOARD_LANGUAGE_ALIASES[normalized] || normalized;
}

function prettyDashboardLanguage(label: string): string {
  const mapped = DASHBOARD_LANGUAGE_LABELS[label] || (label.length > 0 ? label.charAt(0).toUpperCase() + label.slice(1) : 'Unknown');
  if (mapped.length < 4) return mapped.toUpperCase();
  return mapped;
}

function PracticeCard({ g }: { g: GroupScore }) {
  const color = scoreColor(g.score);
  const name = PRACTICE_GROUPS[g.group];
  return html`
    <a href="#" data-page="anti-patterns" data-nav-hint=${g.group} class="ap-score-card" style="text-decoration:none;color:inherit;cursor:pointer;">
      <div class="ap-score-card-top">
        <${ScoreRing} score=${g.score} color=${color} size=${56} />
        <div>
          <div class="ap-score-card-name">${name}</div>
          <div class="ap-score-card-label" style=${'color:' + color}>${scoreLabel(g.score)}</div>
          <div class="ap-score-deltas"><${PctBadge} pct=${g.wowPct} label="WoW" /><${PctBadge} pct=${g.momPct} label="MoM" /></div>
        </div>
      </div>
      ${g.improvements.length > 0
        ? html`<div class="ap-score-tip ap-improvements">${g.improvements.slice(0, 2).map(i => html`<span>${i}</span>`)}</div>`
        : g.topIssue
          ? html`<div class="ap-score-tip">${g.topIssue}</div>`
          : html`<div class="ap-score-tip muted">${g.patternCount > 0 ? g.patternCount + ' finding' + (g.patternCount !== 1 ? 's' : '') : 'No issues detected'}</div>`}
    </a>`;
}

/* ── Main render ──────────────────────────────────────────────────── */

function renderDashboardMarkup(
  container: HTMLElement,
  stats: { totalWorkspaces: number },
  daily: DailyActivity,
  harnessBreakdown: { labels: string[]; requests: number[] },
  scores: import('../core/types').GroupScore[],
  langs: { label: string; display: string; loc: number }[],
  totalReqs: number,
  totalSessions: number,
  totalLoc: number,
  skillCache: ReturnType<typeof getSkillCache>,
): void {
  const harnesses = harnessBreakdown.labels || [];
  const overallScore = scores.length > 0 ? Math.round(scores.reduce((s, g) => s + g.score, 0) / scores.length) : 0;
  const overallColor = scoreColor(overallScore);
  render(html`
    <div class="dash-hero">
      <div class="dash-hero-left">
        <div class="dash-identity">
          <div class="dash-score-ring"><${ScoreRing} score=${overallScore} color=${overallColor} size=${64} /></div>
          <div class="dash-identity-info">
            <div class="dash-identity-label">${funScoreLabel(overallScore)}</div>
            <div class="dash-identity-sub">${scores.length > 0 ? tFormat('dash.vibes', { n: scores.length }) : t('dash.calibrating')}</div>
          </div>
        </div>
        ${langs.length > 0 && html`
        <div class="dash-tech-stack">
          ${langs.map(l => html`<span class="dash-lang-pill" title=${l.display + ': ' + formatNum(l.loc) + ' AI LoC'}>${l.display}</span>`)}
        </div>`}
      </div>
      <div class="dash-hero-right">
        <div class="dash-hero-stats">
          <div class="dash-stat"><div class="dash-stat-val">${formatNum(totalReqs)}</div><div class="dash-stat-lbl">${t('dash.requests')}</div></div>
          <div class="dash-stat"><div class="dash-stat-val">${formatNum(totalSessions)}</div><div class="dash-stat-lbl">${t('dash.sessions')}</div></div>
          <div class="dash-stat"><div class="dash-stat-val">${formatNum(totalLoc)}</div><div class="dash-stat-lbl">${t('dash.loc')}</div></div>
          <div class="dash-stat"><div class="dash-stat-val">${stats.totalWorkspaces}</div><div class="dash-stat-lbl">${t('dash.workspaces')}</div></div>
        </div>
        ${harnesses.length > 0 && html`<div class="dash-harnesses dash-harnesses-right">${harnesses.map((h, i) => html`<span class="dash-harness-tag" style=${'border-color:' + harnessColor(h, i) + ';color:' + harnessColor(h, i)}>${h}</span>`)}</div>`}
      </div>
    </div>
    ${!FF_TOKEN_REPORTING_ENABLED && html`<div class="dash-info-banner"><span class="dash-info-icon">\u2139</span><div><strong>${t('dash.tokenHidden')}</strong><p>${t('dash.tokenHiddenDesc')}</p></div></div>`}
    ${scores.length > 0 && html`<section class="dash-section"><div class="dash-section-header"><h3>${t('dash.apSummary')}</h3><a href="#" data-page="anti-patterns" style=${'font-size:12px;color:' + COLORS.blue + ';text-decoration:none;'}>${t('dash.viewAllAp')}</a></div><div class="ap-score-grid">${scores.map(g => html`<${PracticeCard} g=${g} />`)}</div></section>`}
    <section class="dash-section"><div class="dash-section-header"><h3>${t('dash.skillFinder')}</h3><a href="#" data-page="skills" style=${'font-size:12px;color:' + COLORS.blue + ';text-decoration:none;'}>${t('dash.openSkills')}</a></div><p class="dash-section-desc">${t('dash.skillDesc')}</p><div id="dashSkillContent" class="dash-card">${!skillCache && html`<div style="text-align:center;"><p style="color:var(--text-muted);margin:0 0 12px 0;font-size:13px;">${t('dash.skillAnalyze')}</p><button id="dashScanBtn" class="dash-scan-btn">${t('dash.scanSkills')}</button></div>`}</div></section>
    <section class="dash-section"><div style="display:flex;align-items:baseline;gap:16px;margin-bottom:8px;flex-wrap:wrap;"><h3 style="margin:0;">${t('dash.dailyActivity')}</h3><div id="activityTabs" class="dash-tabs"><button class=${'dash-tab' + (activeMetric === 'requests' ? ' dash-tab-active' : '')} data-metric="requests">${t('dash.requests')} <strong>${formatNum(totalReqs)}</strong></button><button class=${'dash-tab' + (activeMetric === 'sessions' ? ' dash-tab-active' : '')} data-metric="sessions">${t('dash.sessions')} <strong>${formatNum(totalSessions)}</strong></button><button class=${'dash-tab' + (activeMetric === 'loc' ? ' dash-tab-active' : '')} data-metric="loc">${t('dash.loc')} <strong>${formatNum(totalLoc)}</strong></button><button class=${'dash-tab' + (activeMetric === 'workspaces' ? ' dash-tab-active' : '')} data-metric="workspaces">${t('dash.workspaces')} <strong>${formatNum(stats.totalWorkspaces)}</strong></button></div></div><${CanvasEl} id="dailyChart" height=${160} /></section>
    <div class="two-col" style="margin-bottom:16px;"><${CanvasEl} id="wsChart" height=${140} title=${t('dash.topWs')} /><${CanvasEl} id="harnessChart" height=${140} title=${t('dash.byHarness')} /></div>
    <div class="chart-modal-overlay" id="wsChartModal"><div class="chart-modal"><div class="chart-modal-header"><span class="chart-title" style="margin:0;">${t('dash.topWs')}</span><button class="chart-modal-close" id="wsChartModalClose" title=${t('dash.close')}>\u00d7</button></div><div class="chart-modal-body"><div style="position:relative;height:360px;"><canvas id="wsChartFull"></canvas></div></div></div></div>
  `, container);
}

function renderWorkspaceCharts(wsBreakdown: { labels: string[]; values: number[] }, harnessBreakdown: { labels: string[]; requests: number[] }): void {
  const wsColors = wsBreakdown.labels.map((_: string, i: number) => PALETTE[i % PALETTE.length]);
  createChart('wsChart', 'doughnut', {
    labels: wsBreakdown.labels,
    datasets: [{ data: wsBreakdown.values, backgroundColor: wsColors }],
  }, { plugins: { legend: { position: 'right' } } });

  const wsChartWrap = document.getElementById('wsChart')?.closest('.chart-wrap') as HTMLElement | null;
  const wsModal = document.getElementById('wsChartModal');
  if (wsChartWrap && wsModal) {
    wsChartWrap.style.cursor = 'pointer';
    wsChartWrap.addEventListener('click', () => {
      wsModal.classList.add('chart-modal-open');
      destroyChartById('wsChartFull');
      createChart('wsChartFull', 'doughnut', {
        labels: wsBreakdown.labels,
        datasets: [{ data: wsBreakdown.values, backgroundColor: wsColors }],
      }, { plugins: { legend: { position: 'bottom', labels: { font: { size: 12 }, padding: 8, boxWidth: 14 } } } });
    });
    document.getElementById('wsChartModalClose')?.addEventListener('click', () => {
      wsModal.classList.remove('chart-modal-open');
      destroyChartById('wsChartFull');
    });
    wsModal.addEventListener('click', (e) => {
      if (e.target === wsModal) {
        wsModal.classList.remove('chart-modal-open');
        destroyChartById('wsChartFull');
      }
    });
  }

  createChart('harnessChart', 'doughnut', {
    labels: harnessBreakdown.labels,
    datasets: [{
      data: harnessBreakdown.requests,
      backgroundColor: harnessBreakdown.labels.map((l: string, i: number) => harnessColor(l, i)),
    }],
  }, { plugins: { legend: { position: 'right' } } });
}

function renderDashboardSkillFinder(skillCache: ReturnType<typeof getSkillCache>, currentFilter: DateFilter): void {
  if (skillCache) {
    renderSkillResults(skillCache.triaged, skillCache.clusters, skillCache.catalogMatches);
    return;
  }
  document.getElementById('dashScanBtn')?.addEventListener('click', () => {
    void loadDashSkills(currentFilter);
  });
}

export async function renderDashboard(container: HTMLElement, currentFilter: DateFilter): Promise<void> {
  const emptyDaily: DailyActivity = { labels: [], values: [], sessions: [], loc: [], workspaces: [], byHarness: [] };
  const emptyCodeProd: CodeProductionData = { summary: { totalAiLoc: 0, totalUserLoc: 0, totalLoc: 0, aiBlocks: 0, userBlocks: 0, aiRatio: 0, locCost2010: 0, costPerLoc: 0 }, byLanguage: { labels: [], aiLoc: [], userLoc: [] }, dailyTimeline: { labels: [], aiLoc: [], userLoc: [] }, byWorkspace: { labels: [], aiLoc: [], userLoc: [] }, dailyByWorkspace: {}, dailyByModel: {}, dailyByHarness: {} };
  const [stats, daily, wsBreakdown, harnessBreakdown, antiPatterns, codeProd] = await rpcAllSettled([
    rpc<{ totalSessions: number; totalWorkspaces: number; totalRequests: number }>('getStats', currentFilter as Record<string, unknown>),
    rpc<DailyActivity>('getDailyActivity', currentFilter as Record<string, unknown>),
    rpc<{ labels: string[]; values: number[] }>('getWorkspaceBreakdown', currentFilter as Record<string, unknown>),
    rpc<{ labels: string[]; requests: number[] }>('getHarnessBreakdown', currentFilter as Record<string, unknown>),
    rpc<AntiPatternData>('getAntiPatterns', currentFilter as Record<string, unknown>),
    rpc<CodeProductionData>('getCodeProduction', currentFilter as Record<string, unknown>),
  ] as const, [
    { totalSessions: 0, totalWorkspaces: 0, totalRequests: 0 },
    emptyDaily,
    { labels: [], values: [] },
    { labels: [], requests: [] },
    { patterns: [], totalOccurrences: 0, groupScores: [], weeklyScores: { labels: [], series: [] } } as unknown as AntiPatternData,
    emptyCodeProd,
  ] as const);

  const totalLoc = daily.loc.reduce((a, b) => a + b, 0);
  const totalReqs = daily.values.reduce((a, b) => a + b, 0);
  const totalSessions = daily.sessions.reduce((a, b) => a + b, 0);
  const scores = antiPatterns.groupScores || [];
  const mergedLangs = new Map<string, number>();
  for (let i = 0; i < codeProd.byLanguage.labels.length; i++) {
    const raw = codeProd.byLanguage.labels[i] || '';
    const label = normalizeDashboardLanguage(raw);
    const loc = codeProd.byLanguage.aiLoc[i] ?? 0;
    if (!label || loc <= 0) continue;
    mergedLangs.set(label, (mergedLangs.get(label) || 0) + loc);
  }

  // Tech stack: top languages by AI LoC
  const langs = Array.from(mergedLangs.entries())
    .map(([label, loc]) => ({ label, display: prettyDashboardLanguage(label), loc }))
    .filter(l => !['unknown', 'other', 'text', 'plaintext', 'markdown'].includes(l.label))
    .sort((a, b) => b.loc - a.loc)
    .slice(0, 8);

  const skillCache = getSkillCache(currentFilter);

  renderDashboardMarkup(
    container,
    stats,
    daily,
    harnessBreakdown,
    scores,
    langs,
    totalReqs,
    totalSessions,
    totalLoc,
    skillCache,
  );

  // ── Activity chart with switchable metrics ──

  function renderActivityChart(): void {
    destroyChartById('dailyChart');

    const isWorkspaces = activeMetric === 'workspaces';
    let chartDatasets: { label: string; data: number[]; backgroundColor: string; borderColor: string; borderWidth: number }[];
    let metricLabel: string;
    let stacked: boolean;

    if (isWorkspaces) {
      // Workspaces: single dataset, not stacked
      chartDatasets = [{
        label: 'Active Workspaces',
        data: daily.workspaces,
        backgroundColor: COLORS.blue + 'B3',
        borderColor: COLORS.blue,
        borderWidth: 1,
      }];
      metricLabel = 'Workspaces';
      stacked = false;
    } else {
      // Requests, Sessions, LoC: stacked by harness
      const metricKey = activeMetric as 'requests' | 'sessions' | 'loc';
      metricLabel = { requests: 'Requests', sessions: 'Sessions', loc: 'Lines of Code' }[metricKey];
      chartDatasets = daily.byHarness.map((h, i) => {
        const color = harnessColor(h.harness, i);
        return {
          label: h.harness,
          data: h[metricKey],
          backgroundColor: color + 'B3',
          borderColor: color,
          borderWidth: 1,
        };
      });
      stacked = true;
    }

    const showLegend = chartDatasets.length > 1;
    createChart('dailyChart', 'bar', {
      labels: daily.labels,
      datasets: chartDatasets,
    }, {
      plugins: {
        legend: { display: showLegend, position: 'top', labels: { boxWidth: 10, font: { size: 10 }, padding: 6 } },
        tooltip: { mode: 'index' },
      },
      layout: { padding: { top: showLegend ? 0 : 20 } },
      scales: {
        x: { display: true, stacked, ticks: { maxTicksLimit: 15 } },
        y: { beginAtZero: true, stacked, title: { display: true, text: metricLabel, font: { size: 10 } } },
      },
    });
  }

  renderActivityChart();

  // Tab switching
  document.getElementById('activityTabs')?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-metric]');
    const metric = btn?.dataset.metric;
    if (!btn || !metric || metric === activeMetric) return;
    activeMetric = metric;
    for (const t of document.querySelectorAll<HTMLElement>('.dash-tab')) t.classList.remove('dash-tab-active');
    btn.classList.add('dash-tab-active');
    renderActivityChart();
  });

  renderWorkspaceCharts(wsBreakdown, harnessBreakdown);
  renderDashboardSkillFinder(skillCache, currentFilter);
}

/* ── Skill results rendering ──────────────────────────────────────── */

function renderSkillResults(
  triaged: import('../core/types').TriagedCluster[],
  clusters: import('../core/types').WorkflowCluster[],
  catalogMatches: import('../core/types').CatalogItem[],
): void {
  const contentEl = document.getElementById('dashSkillContent');
  if (!contentEl) return;

  const strong = triaged.filter(t => t.verdict === 'strong').slice(0, 2);
  const catTop = catalogMatches.slice(0, 2);

  const hasCustom = strong.length > 0;
  const hasCatalog = catTop.length > 0;

  if (!hasCustom && !hasCatalog) {
    render(html`<p style="color:var(--text-muted);margin:0;font-size:13px;">No skill opportunities found. Your prompts may already be well-served or too diverse.</p>
      <div style="text-align:center;margin-top:10px;"><a href="#" data-page="skills" style=${'font-size:12px;color:' + COLORS.blue + ';text-decoration:none;'}>Open Skill Finder for full analysis \u2192</a></div>`, contentEl);
    return;
  }

  render(html`
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
      <div>
        <div style="font-size:11px;font-weight:600;color:var(--text-muted);margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px;">Custom Opportunities</div>
        ${hasCustom
          ? html`<div style="display:flex;flex-direction:column;gap:4px;">
              ${strong.map(t => {
                const cluster = clusters.find(c => c.id === t.id);
                const sub = cluster ? cluster.occurrences + ' repetitions / ' + cluster.sessions + ' sessions' : t.reason.substring(0, 80);
                return html`<${SkillCard} title=${t.suggestedSkillName || t.label} subtitle=${sub} />`;
              })}
              ${triaged.filter(t => t.verdict === 'strong').length > 2 && html`<div style="font-size:11px;color:var(--text-muted);text-align:center;">+${triaged.filter(t => t.verdict === 'strong').length - 2} more</div>`}
            </div>`
          : html`<p style="color:var(--text-muted);margin:0;font-size:12px;">None detected</p>`}
      </div>
      <div>
        <div style="font-size:11px;font-weight:600;color:var(--text-muted);margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px;">Community Matches</div>
        ${hasCatalog
          ? html`<div style="display:flex;flex-direction:column;gap:4px;">
              ${catTop.map(item => html`<${SkillCard} title=${item.title} subtitle=${item.description?.substring(0, 80) || item.kind} />`)}
              ${catalogMatches.length > 2 && html`<div style="font-size:11px;color:var(--text-muted);text-align:center;">+${catalogMatches.length - 2} more</div>`}
            </div>`
          : html`<p style="color:var(--text-muted);margin:0;font-size:12px;">None matched</p>`}
      </div>
    </div>
    <div style="text-align:center;margin-top:10px;">
      <a href="#" data-page="skills" style=${'font-size:12px;color:' + COLORS.blue + ';text-decoration:none;'}>Explore details in Skill Finder \u2192</a>
    </div>`, contentEl);
}

/* ── Skill scan ───────────────────────────────────────────────────── */

async function loadDashSkills(currentFilter: DateFilter): Promise<void> {
  const contentEl = document.getElementById('dashSkillContent');
  if (!contentEl) return;

  render(html`<div style="text-align:center;padding:8px;">
    <div class="loading-spinner" style="width:24px;height:24px;margin:0 auto 8px;"></div>
    <p style="color:var(--text-muted);margin:0;font-size:12px;">Scanning prompt history...</p>
  </div>`, contentEl);

  try {
    const data = await rpc<WorkflowOptimizationData>('getWorkflowOptimization', currentFilter as Record<string, unknown>);
    const clusters = data.clusters || [];

    let triagedResults: import('../core/types').TriagedCluster[] = [];
    let catalogMatches: import('../core/types').CatalogItem[] = [];

    if (clusters.length > 0) {
      contentEl.querySelector('p')!.textContent = 'AI triage in progress...';
      const top = clusters.slice(0, 20);
      const topClusters = top.map(c => ({
        id: c.id, label: c.label, occurrences: c.occurrences,
        sessions: c.sessions, cancelRate: c.cancelRate,
        avgCorrectionTurns: c.avgCorrectionTurns,
        workspaces: c.workspaces,
        examples: c.examples.slice(0, 5),
      }));

      // Run custom triage and catalog discovery in parallel
      const [triageResult, catResult] = await Promise.all([
        rpc<SkillTriageResult>('triageSkills', { clusters: topClusters } as Record<string, unknown>).catch(() => null),
        rpc<CatalogDiscoverResult>('discoverCatalog', {} as Record<string, unknown>).catch(() => null),
      ]);

      if (triageResult) {
        triagedResults = (triageResult.triaged || []).filter(t => t.verdict === 'strong');
      }

      // Triage catalog if available
      if (catResult?.items && catResult.items.length > 0) {
        contentEl.querySelector('p')!.textContent = 'Matching community catalog...';
        try {
          const triaged = await rpc<CatalogTriageResult>('triageCatalog', {
            items: catResult.items,
            clusters: topClusters.map(c => ({
              label: c.label, occurrences: c.occurrences,
              workspaces: c.workspaces, examples: c.examples.slice(0, 3),
            })),
          } as Record<string, unknown>);
          catalogMatches = triaged.items || [];
        } catch { /* catalog triage failed */ }
      }
    }

    setSkillCache({ clusters, triaged: triagedResults, catalogMatches, timestamp: Date.now() }, currentFilter);
    renderSkillResults(triagedResults, clusters, catalogMatches);
  } catch {
    render(html`<p style="color:var(--text-muted);margin:0;font-size:13px;">Scan failed. Try again later.</p>`, contentEl);
  }
}
