/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Output page renderer -- merges Production & Consumption into a single tabbed view */

import { DateFilter } from '../core/types';
import { TOKEN_DATA_AVAILABLE_FROM, FF_TOKEN_REPORTING_ENABLED } from '../core/constants';
import { isoWeek } from '../core/helpers';
import { rpc, createChart, formatNum, $$, PALETTE, COLORS, HARNESS_COLORS } from './shared';
import { html, render, StatCard, CanvasEl, ComponentChildren } from './render';

type AggLevel = 'daily' | 'weekly' | 'monthly';

function aggregationLevel(rangeDays: number): AggLevel {
  if (rangeDays === 0) return 'monthly';
  if (rangeDays >= 180) return 'weekly';
  return 'daily';
}

function aggregateTimeline(
  labels: string[], values: number[], level: AggLevel,
): { labels: string[]; values: number[] } {
  if (level === 'daily') return { labels, values };
  const bucketKey = level === 'weekly'
    ? (dateStr: string) => isoWeek(new Date(dateStr + 'T00:00:00'))
    : (dateStr: string) => dateStr.slice(0, 7); // YYYY-MM
  const map = new Map<string, number>();
  for (let i = 0; i < labels.length; i++) {
    const k = bucketKey(labels[i]);
    map.set(k, (map.get(k) || 0) + values[i]);
  }
  const sortedKeys = Array.from(map.keys()).sort();
  return { labels: sortedKeys, values: sortedKeys.map(k => map.get(k)!) };
}

function aggregateByWorkspace(
  labels: string[], dailyByWs: Record<string, number[]>, level: AggLevel,
): { labels: string[]; byWs: Record<string, number[]> } {
  if (level === 'daily') return { labels, byWs: dailyByWs };
  const bucketKey = level === 'weekly'
    ? (dateStr: string) => isoWeek(new Date(dateStr + 'T00:00:00'))
    : (dateStr: string) => dateStr.slice(0, 7);
  const keySet = new Set<string>();
  for (const d of labels) keySet.add(bucketKey(d));
  const sortedKeys = Array.from(keySet).sort();
  const keyIndex = new Map(sortedKeys.map((k, i) => [k, i]));
  const byWs: Record<string, number[]> = {};
  for (const [ws, vals] of Object.entries(dailyByWs)) {
    const agg = new Array<number>(sortedKeys.length).fill(0);
    for (let i = 0; i < labels.length; i++) {
      agg[keyIndex.get(bucketKey(labels[i]))!] += vals[i];
    }
    byWs[ws] = agg;
  }
  return { labels: sortedKeys, byWs };
}

interface ProdData {
  summary: { totalAiLoc: number; totalRemovedAiLoc: number; totalNetAiLoc: number; locCost2010: number };
  dailyTimeline: { labels: string[]; aiLoc: number[]; removedLoc: number[] };
  byLanguage: { labels: string[]; aiLoc: number[] };
  byWorkspace: { labels: string[]; aiLoc: number[] };
  dailyByWorkspace: Record<string, number[]>;
  dailyRemovedByWorkspace: Record<string, number[]>;
  dailyByModel: Record<string, number[]>;
  dailyRemovedByModel: Record<string, number[]>;
  dailyByHarness: Record<string, number[]>;
  dailyRemovedByHarness: Record<string, number[]>;
}

interface AiCreditRpcData {
  totalCredits: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  totalRequests: number;
  countedRequests: number;
  partialRequests: number;
  pendingRequests: number;
  noDataRequests: number;
  finalizableRequests: number;
  missingPct: number;
  avgCreditsPerRequest: number;
  avgCreditsPerDay: number;
  costByModel: Record<string, {
    requests: number; countedRequests: number;
    partialRequests: number; pendingRequests: number; noDataRequests: number;
    finalizableRequests: number;
    uncachedInputTokens: number; inputTokens: number; outputTokens: number;
    cacheReadTokens: number; cacheWriteTokens: number;
    credits: number; missingPct: number;
    harnesses: string[];
  }>;
  daily: { labels: string[]; credits: number[]; cumulative: number[]; byModel: Record<string, number[]> };
  weekly: { labels: string[]; credits: number[]; cumulative: number[]; byModel: Record<string, number[]> };
  dailyTokensByWorkspace: { labels: string[]; byWorkspace: Record<string, number[]> };
  dailyTokensByHarness: { labels: string[]; byHarness: Record<string, number[]> };
  topRequests: Array<{
    timestamp: number; model: string;
    inputTokens: number; outputTokens: number;
    credits: number;
    status: 'complete' | 'partial' | 'pending' | 'no-data' | 'missing';
    aggregationKind: 'exact' | 'session-aggregated';
    preview: string;
    workspace: string;
    harness: string;
    fullPrompt: string;
  }>;
}

// Module-level view state — survives filter/harness changes so the user's
// tab and range selection is preserved when only the backing data changes.
type OutputTab = 'production' | 'token-usage';
let activeRangeDays = 0;
let activeTab: OutputTab = 'production';

// Bumped on every render attempt (page mount, tab switch, or range change).
// A render in flight compares its captured generation against this value
// after its async gap (the `await rpc(...)` call) and bails out if a newer
// render started in the meantime — otherwise a slow, superseded response
// could still build charts against stale/detached/mismatched DOM (see #101).
let renderGeneration = 0;

export async function renderOutput(container: HTMLElement, currentFilter: DateFilter): Promise<void> {
  if (!FF_TOKEN_REPORTING_ENABLED && activeTab === 'token-usage') {
    activeTab = 'production';
  }

  // Disclaimer banner shown above the Token Usage tab.
  // Computed from local session files only, so cannot see activity from
  // other devices, cloud-hosted agents, or harnesses we don't read.
  const APPROXIMATION_NOTICE = html`
    <div class="approximation-notice">
      <strong>Approximation only.</strong>${' '}
      Token usage is estimated from the session data this extension can read
      on your machine. It shows token consumption across all harnesses and
      may not be fully accurate — it cannot reflect activity on other devices,
      cloud-hosted agents, or harnesses this extension doesn't ingest.
      Use it as a workflow optimization signal, not as a billing reference.
    </div>
  `;

  // Range options shown in the bar. Order matters: longest range last so
  // "All time" (0) lives on the right. The 7/28-day buttons are short enough
  // to always be valid; longer ranges get auto-disabled for token-data tabs
  // when their nominal start dips below the cutoff.
  const RANGES: { days: number; label: string }[] = [
    { days: 7, label: 'Last 7 days' },
    { days: 28, label: 'Last 4 weeks' },
    { days: 90, label: 'Last 3 months' },
    { days: 180, label: 'Last 6 months' },
    { days: 0, label: 'All time' },
  ];

  function rangeStartDate(days: number): string {
    if (days === 0) return '0001-01-01';
    const d = new Date();
    d.setDate(d.getDate() - days);
    return d.toISOString().slice(0, 10);
  }

  function isRangeDisabled(tab: OutputTab, days: number): boolean {
    if (tab !== 'token-usage') return false;
    return rangeStartDate(days) < TOKEN_DATA_AVAILABLE_FROM;
  }

  function buildRangeFilter(): Record<string, unknown> {
    const f: Record<string, unknown> = { ...currentFilter };
    const days = activeRangeDays;
    if (days > 0) {
      f.fromDate = rangeStartDate(days);
    }
    // Only clamp to TOKEN_DATA_AVAILABLE_FROM on the token-usage tab
    if (activeTab === 'token-usage') {
      const fromDate = (f.fromDate as string | undefined) ?? '';
      if (!fromDate || fromDate < TOKEN_DATA_AVAILABLE_FROM) {
        f.fromDate = TOKEN_DATA_AVAILABLE_FROM;
      }
    }
    return f;
  }

  function creditChartTitle(): string {
    const rangeLabel = RANGES.find(r => r.days === activeRangeDays)?.label ?? 'All time';
    const granularity = activeRangeDays > 0 && activeRangeDays <= 28 ? 'Daily' : 'Weekly';
    return `${granularity} Token Consumption — ${rangeLabel}`;
  }

  function tokenByWsChartTitle(): string {
    const rangeLabel = RANGES.find(r => r.days === activeRangeDays)?.label ?? 'All time';
    const level = aggregationLevel(activeRangeDays);
    const granularity = level === 'daily' ? 'Daily' : level === 'weekly' ? 'Weekly' : 'Monthly';
    return `${granularity} Token Consumption by Workspace — ${rangeLabel}`;
  }

  function tokenByHarnessChartTitle(): string {
    const rangeLabel = RANGES.find(r => r.days === activeRangeDays)?.label ?? 'All time';
    const level = aggregationLevel(activeRangeDays);
    const granularity = level === 'daily' ? 'Daily' : level === 'weekly' ? 'Weekly' : 'Monthly';
    return `${granularity} Token Consumption by Harness — ${rangeLabel}`;
  }

  function renderRangeBar(): ComponentChildren {
    const cur = activeRangeDays;
    const disabledTitle = `Sessions before ${TOKEN_DATA_AVAILABLE_FROM} did not capture per-request token data, so this range can’t show meaningful coverage. It will become available again once enough recent data falls within the range.`;
    const buttons = RANGES.map(r => {
      const disabled = isRangeDisabled(activeTab, r.days);
      const isActive = cur === r.days && !disabled;
      const cls = `cons-range-btn${isActive ? ' active' : ''}${disabled ? ' disabled' : ''}`;
      return disabled
        ? html`<button class=${cls} data-range=${r.days} disabled aria-disabled="true" title=${disabledTitle} style="opacity:0.4;cursor:not-allowed;">${r.label}</button>`
        : html`<button class=${cls} data-range=${r.days}>${r.label}</button>`;
    });
    return html`${buttons}`;
  }

  function refreshRangeBar(): void {
    const bar = document.getElementById('outputRange');
    if (bar) render(html`<span>${renderRangeBar()}</span>`, bar);
  }

  // When switching to a token-data tab, snap the active range to the nearest
  // valid range if the current one is disabled. Prefer the largest enabled
  // range that's <= current selection (so widening into a token-data tab
  // doesn't silently shrink the window beyond user expectation).
  function snapActiveRangeIfDisabled(): void {
    if (!isRangeDisabled(activeTab, activeRangeDays)) return;
    const enabled = RANGES.filter(r => !isRangeDisabled(activeTab, r.days));
    if (enabled.length === 0) return;
    // Pick the longest enabled range (most data) — for token-data tabs
    // today this is "Last 3 months".
    const longest = enabled.reduce((a, b) => {
      const aSpan = a.days === 0 ? Number.POSITIVE_INFINITY : a.days;
      const bSpan = b.days === 0 ? Number.POSITIVE_INFINITY : b.days;
      return bSpan > aSpan ? b : a;
    });
    activeRangeDays = longest.days;
  }

  render(html`
    <h1>Output</h1>
    <div class="cons-range-bar" id="outputRange"></div>
    <div class="tab-bar" id="output-tabs">
      <button class=${`tab${activeTab === 'production' ? ' active' : ''}`} data-tab="production">Code Output</button>
      ${FF_TOKEN_REPORTING_ENABLED ? html`<button class=${`tab${activeTab === 'token-usage' ? ' active' : ''}`} data-tab="token-usage">Token Usage</button>` : ''}
    </div>
    <div id="output-tab-content"></div>
  `, container);
  refreshRangeBar();

  // Populate range bar from its own Preact root so there is exactly one
  // owner of #outputRange's children (avoids duplicate buttons).
  refreshRangeBar();

  async function renderProductionTab(gen: number): Promise<void> {
    const target = document.getElementById('output-tab-content')!;
    render(html`<div class="loading-spinner"></div>`, target);

    const prod = await rpc<ProdData>('getCodeProduction', buildRangeFilter());
    if (gen !== renderGeneration) return; // superseded by a newer render (tab/range/nav change)
    const s = prod.summary;
    const level = aggregationLevel(activeRangeDays);
    const chartTitle = level === 'weekly' ? 'Weekly AI Code Output' : level === 'monthly' ? 'Monthly AI Code Output' : 'Daily AI Code Output';
    const yLabel = level === 'weekly' ? 'LoC/week' : level === 'monthly' ? 'LoC/month' : 'LoC/day';
    const cadence = level === 'weekly' ? 'week' : level === 'monthly' ? 'month' : 'day';
    const outputInfo = html`<span class="info-icon" tabindex="0" role="button" aria-label="AI code output info">${'\u24d8'}<span class="info-popup">Counts the net new lines of code the AI assistant actually wrote, aggregated per ${cadence}. Each edit is compared against the previous version of the file, so only added lines are counted ${'\u2014'} re-saving an unchanged file or rewriting the same lines is not double-counted. Taller bars mean more AI-authored code in that period; hover a bar to see the exact line count, and use the tabs below to split output by model, workspace, or harness.</span></span>`;
    const netInfo = html`<span class="info-icon" tabindex="0" role="button" aria-label="Net AI code output info">${'\u24d8'}<span class="info-popup">Net AI LoC is lines the AI added minus lines the AI removed, aggregated per ${cadence}. A ${cadence} where the assistant deleted or rewrote more than it added shows a bar below zero. This reflects the lasting footprint of AI edits on your files, not just gross output.</span></span>`;
    const netTitle = level === 'weekly' ? 'Weekly Net AI Code Output' : level === 'monthly' ? 'Monthly Net AI Code Output' : 'Daily Net AI Code Output';

    render(html`
      <div class="stat-grid">
        <${StatCard} label="AI-Generated LoC" value=${formatNum(s.totalAiLoc)} accent="var(--accent-blue)" />
        <${StatCard} label="Net AI LoC" value=${formatNum(s.totalNetAiLoc)} accent="var(--accent-green)" />
      </div>
      <div class="chart-tabs" style="margin-top:18px">
        <button class="chart-tab active" data-prod-tab="model">Code Output</button>
        <button class="chart-tab" data-prod-tab="workspace">Output by Workspace</button>
        <button class="chart-tab" data-prod-tab="harness">Output by Harness</button>
      </div>
      <div id="prodTabModel" class="chart-tab-panel active">
        <div class="chart-wrap">
          <div class="chart-title">${chartTitle} ${outputInfo}</div>
          <canvas id="prodModelChart" height=${300}></canvas>
        </div>
      </div>
      <div id="prodTabWorkspace" class="chart-tab-panel"><${CanvasEl} id="prodDailyChart" height=${300} title=${chartTitle} /></div>
      <div id="prodTabHarness" class="chart-tab-panel"><${CanvasEl} id="prodHarnessChart" height=${300} title=${chartTitle} /></div>
      <div class="chart-tabs" style="margin-top:24px">
        <button class="chart-tab active" data-net-tab="total">Net Code Output</button>
        <button class="chart-tab" data-net-tab="model">Net by Model</button>
        <button class="chart-tab" data-net-tab="workspace">Net by Workspace</button>
        <button class="chart-tab" data-net-tab="harness">Net by Harness</button>
      </div>
      <div id="netTabTotal" class="chart-tab-panel active">
        <div class="chart-wrap">
          <div class="chart-title">${netTitle} ${netInfo}</div>
          <canvas id="netTotalChart" height=${300}></canvas>
        </div>
      </div>
      <div id="netTabModel" class="chart-tab-panel"><${CanvasEl} id="netModelChart" height=${300} title=${netTitle} /></div>
      <div id="netTabWorkspace" class="chart-tab-panel"><${CanvasEl} id="netWorkspaceChart" height=${300} title=${netTitle} /></div>
      <div id="netTabHarness" class="chart-tab-panel"><${CanvasEl} id="netHarnessChart" height=${300} title=${netTitle} /></div>
      <div class="two-col">
        <${CanvasEl} id="prodLangChart" height=${300} title="By Language" />
        <${CanvasEl} id="prodWsChart" height=${300} title="By Workspace" />
      </div>
    `, target);

    const wsColor = (i: number) => PALETTE[i % PALETTE.length];

    // --- By Model chart (default) ---
    const { labels: modelLabels, byWs: modelBuckets } = aggregateByWorkspace(
      prod.dailyTimeline.labels, prod.dailyByModel, level,
    );
    const modelNames = Object.keys(modelBuckets).sort((a, b) => {
      const sumA = modelBuckets[a].reduce((sum, v) => sum + v, 0);
      const sumB = modelBuckets[b].reduce((sum, v) => sum + v, 0);
      return sumB - sumA;
    });
    const topModels = modelNames.slice(0, 8);
    const otherModels = modelNames.slice(8);
    const otherModelData = modelLabels.map((_, i) => otherModels.reduce((sum, m) => sum + (modelBuckets[m]?.[i] ?? 0), 0));
    const modelDatasets: Record<string, unknown>[] = topModels.map((m, i) => ({
      label: m, data: modelBuckets[m], backgroundColor: PALETTE[i % PALETTE.length] + '99',
      borderColor: PALETTE[i % PALETTE.length], borderWidth: 1, stack: 'models',
    }));
    if (otherModels.length > 0) {
      modelDatasets.push({ label: `Other (${otherModels.length})`, data: otherModelData, backgroundColor: COLORS.muted + '60', borderColor: COLORS.muted, borderWidth: 1, stack: 'models' });
    }
    if (modelDatasets.length === 0) {
      const { values: aggTotals } = aggregateTimeline(prod.dailyTimeline.labels, prod.dailyTimeline.aiLoc, level);
      modelDatasets.push({ label: 'AI LoC', data: aggTotals, backgroundColor: PALETTE[0] + '99', borderColor: PALETTE[0], borderWidth: 1, stack: 'models' });
    }
    createChart('prodModelChart', 'bar', { labels: modelLabels, datasets: modelDatasets }, {
      plugins: { legend: { position: 'top' } },
      scales: { x: { stacked: true, ticks: { maxTicksLimit: 15 } }, y: { stacked: true, beginAtZero: true, title: { display: true, text: yLabel } } },
    });

    // --- By Workspace chart ---
    const { labels: aggLabels, byWs: aggByWs } = aggregateByWorkspace(
      prod.dailyTimeline.labels, prod.dailyByWorkspace, level,
    );
    const { values: aggTotals } = aggregateTimeline(
      prod.dailyTimeline.labels, prod.dailyTimeline.aiLoc, level,
    );
    const allWsNames = Object.keys(aggByWs).sort((a, b) => {
      const sumA = aggByWs[a].reduce((s, v) => s + v, 0);
      const sumB = aggByWs[b].reduce((s, v) => s + v, 0);
      return sumB - sumA;
    });
    const topWsNames = allWsNames.slice(0, 15);
    const otherWsNames = allWsNames.slice(15);
    const otherWsData = aggLabels.map((_, i) => otherWsNames.reduce((sum, ws) => sum + (aggByWs[ws]?.[i] ?? 0), 0));
    const dailyDatasets: { label: string; data: number[]; backgroundColor: string; borderColor: string; borderWidth: number }[] = topWsNames
      .filter(ws => aggByWs[ws])
      .map((ws, i) => ({
        label: ws,
        data: aggByWs[ws],
        backgroundColor: wsColor(i) + '80',
        borderColor: wsColor(i),
        borderWidth: 1,
      }));
    if (otherWsNames.length > 0) {
      dailyDatasets.push({
        label: `Other (${otherWsNames.length})`,
        data: otherWsData,
        backgroundColor: COLORS.muted + '60',
        borderColor: COLORS.muted,
        borderWidth: 1,
      });
    }
    if (dailyDatasets.length === 0) {
      dailyDatasets.push({
        label: 'AI LoC',
        data: aggTotals,
        backgroundColor: PALETTE[0] + '80',
        borderColor: PALETTE[0],
        borderWidth: 1,
      });
    }
    createChart('prodDailyChart', 'bar', {
      labels: aggLabels,
      datasets: dailyDatasets,
    }, {
      plugins: { legend: { display: dailyDatasets.length > 1, position: 'bottom', labels: { boxWidth: 12, padding: 8 } } },
      scales: { x: { stacked: true, ticks: { maxTicksLimit: 15 } }, y: { stacked: true, beginAtZero: true, title: { display: true, text: yLabel } } },
    });

    // --- By Harness chart ---
    const { labels: hLabels, byWs: hBuckets } = aggregateByWorkspace(
      prod.dailyTimeline.labels, prod.dailyByHarness, level,
    );
    const hNames = Object.keys(hBuckets).sort((a, b) => {
      const sumA = hBuckets[a].reduce((sum, v) => sum + v, 0);
      const sumB = hBuckets[b].reduce((sum, v) => sum + v, 0);
      return sumB - sumA;
    });
    const hDatasets: Record<string, unknown>[] = hNames.map((h) => ({
      label: h, data: hBuckets[h],
      backgroundColor: (harnessColor(h)) + '99',
      borderColor: harnessColor(h), borderWidth: 1, stack: 'harness',
    }));
    if (hDatasets.length > 0) {
      createChart('prodHarnessChart', 'bar', { labels: hLabels, datasets: hDatasets }, {
        plugins: { legend: { position: 'top' } },
        scales: { x: { stacked: true, ticks: { maxTicksLimit: 15 } }, y: { stacked: true, beginAtZero: true, title: { display: true, text: yLabel } } },
      });
    }

    // --- Sidebar charts ---
    createChart('prodLangChart', 'bar', {
      labels: prod.byLanguage.labels,
      datasets: [{ label: 'AI LoC', data: prod.byLanguage.aiLoc, backgroundColor: PALETTE[0] }],
    }, {
      indexAxis: 'y',
      plugins: { legend: { display: false } },
      scales: { x: { beginAtZero: true } },
    });

    const wsBarColors = prod.byWorkspace.labels.map((_, i) => wsColor(i));
    createChart('prodWsChart', 'bar', {
      labels: prod.byWorkspace.labels,
      datasets: [{ label: 'AI LoC', data: prod.byWorkspace.aiLoc, backgroundColor: wsBarColors }],
    }, {
      indexAxis: 'y',
      plugins: { legend: { display: false } },
      scales: { x: { beginAtZero: true } },
    });

    // --- Net total chart (diverging added / removed) ---
    const { labels: netLabels, values: addedTotals } = aggregateTimeline(
      prod.dailyTimeline.labels, prod.dailyTimeline.aiLoc, level,
    );
    const { values: removedTotals } = aggregateTimeline(
      prod.dailyTimeline.labels, prod.dailyTimeline.removedLoc, level,
    );
    const removedNeg = removedTotals.map(v => -v);
    const netTotals = addedTotals.map((v, i) => v - removedTotals[i]);
    createChart('netTotalChart', 'bar', {
      labels: netLabels,
      datasets: [
        { label: 'Added', data: addedTotals, backgroundColor: COLORS.green + '99', borderColor: COLORS.green, borderWidth: 1, stack: 'net' },
        { label: 'Removed', data: removedNeg, backgroundColor: COLORS.red + '99', borderColor: COLORS.red, borderWidth: 1, stack: 'net' },
        { type: 'line', label: 'Net', data: netTotals, borderColor: COLORS.blue, backgroundColor: COLORS.blue, borderWidth: 2, pointRadius: 2, fill: false, stack: undefined },
      ],
    }, {
      plugins: { legend: { position: 'top' } },
      scales: { x: { stacked: true, ticks: { maxTicksLimit: 15 } }, y: { stacked: true, beginAtZero: false, title: { display: true, text: yLabel } } },
    });

    // --- Net stacked charts by dimension ---
    const buildNetDatasets = (
      grossMap: Record<string, number[]>,
      removedMap: Record<string, number[]>,
      colorFor: (name: string, i: number) => string,
      limit: number,
    ): { labels: string[]; datasets: Record<string, unknown>[] } => {
      const { labels, byWs: grossBuckets } = aggregateByWorkspace(prod.dailyTimeline.labels, grossMap, level);
      const { byWs: removedBuckets } = aggregateByWorkspace(prod.dailyTimeline.labels, removedMap, level);
      const names = Object.keys(grossBuckets).sort((a, b) => {
        const sumA = grossBuckets[a].reduce((s, v) => s + v, 0) - (removedBuckets[a]?.reduce((s, v) => s + v, 0) ?? 0);
        const sumB = grossBuckets[b].reduce((s, v) => s + v, 0) - (removedBuckets[b]?.reduce((s, v) => s + v, 0) ?? 0);
        return sumB - sumA;
      });
      const top = names.slice(0, limit);
      const other = names.slice(limit);
      const netOf = (name: string) => grossBuckets[name].map((v, i) => v - (removedBuckets[name]?.[i] ?? 0));
      const datasets: Record<string, unknown>[] = top.map((name, i) => ({
        label: name, data: netOf(name),
        backgroundColor: colorFor(name, i) + '99', borderColor: colorFor(name, i), borderWidth: 1, stack: 'net',
      }));
      if (other.length > 0) {
        const otherData = labels.map((_, i) => other.reduce((s, name) => s + (grossBuckets[name][i] - (removedBuckets[name]?.[i] ?? 0)), 0));
        datasets.push({ label: `Other (${other.length})`, data: otherData, backgroundColor: COLORS.muted + '60', borderColor: COLORS.muted, borderWidth: 1, stack: 'net' });
      }
      return { labels, datasets };
    };

    const netChartOpts = {
      plugins: { legend: { position: 'top' } },
      scales: { x: { stacked: true, ticks: { maxTicksLimit: 15 } }, y: { stacked: true, beginAtZero: false, title: { display: true, text: yLabel } } },
    };

    const netModel = buildNetDatasets(prod.dailyByModel, prod.dailyRemovedByModel, (_, i) => PALETTE[i % PALETTE.length], 8);
    createChart('netModelChart', 'bar', { labels: netModel.labels, datasets: netModel.datasets }, netChartOpts);

    const netWs = buildNetDatasets(prod.dailyByWorkspace, prod.dailyRemovedByWorkspace, (_, i) => wsColor(i), 15);
    createChart('netWorkspaceChart', 'bar', { labels: netWs.labels, datasets: netWs.datasets }, netChartOpts);

    const netHarness = buildNetDatasets(prod.dailyByHarness, prod.dailyRemovedByHarness, (name) => harnessColor(name), 12);
    createChart('netHarnessChart', 'bar', { labels: netHarness.labels, datasets: netHarness.datasets }, netChartOpts);

    // Wire production chart tab switching
    for (const btn of target.querySelectorAll<HTMLButtonElement>('.chart-tab[data-prod-tab]')) {
      btn.addEventListener('click', () => {
        for (const b of target.querySelectorAll<HTMLButtonElement>('.chart-tab[data-prod-tab]')) b.classList.remove('active');
        btn.classList.add('active');
        const tab = btn.dataset.prodTab;
        const panelMap: Record<string, string> = { model: 'prodTabModel', workspace: 'prodTabWorkspace', harness: 'prodTabHarness' };
        for (const p of target.querySelectorAll<HTMLElement>('#prodTabModel, #prodTabWorkspace, #prodTabHarness')) p.classList.remove('active');
        document.getElementById(panelMap[tab || 'model'])!.classList.add('active');
      });
    }

    // Wire net chart tab switching
    for (const btn of target.querySelectorAll<HTMLButtonElement>('.chart-tab[data-net-tab]')) {
      btn.addEventListener('click', () => {
        for (const b of target.querySelectorAll<HTMLButtonElement>('.chart-tab[data-net-tab]')) b.classList.remove('active');
        btn.classList.add('active');
        const tab = btn.dataset.netTab;
        const panelMap: Record<string, string> = { total: 'netTabTotal', model: 'netTabModel', workspace: 'netTabWorkspace', harness: 'netTabHarness' };
        for (const p of target.querySelectorAll<HTMLElement>('#netTabTotal, #netTabModel, #netTabWorkspace, #netTabHarness')) p.classList.remove('active');
        document.getElementById(panelMap[tab || 'total'])!.classList.add('active');
      });
    }
  }

  function buildCreditCoverageSummary(data: AiCreditRpcData): { missingLabel: ComponentChildren; partialLabel: ComponentChildren; pendingLabel: ComponentChildren; noDataLabel: ComponentChildren } {
    const trulyMissing = data.finalizableRequests - data.countedRequests - data.partialRequests;
    return {
      missingLabel: data.finalizableRequests > 0 && data.missingPct > 0
        ? html`<span class="missing-badge badge-popup-trigger" tabindex="0">missing ${data.missingPct}%<span class="badge-popup"><strong>Missing (${data.missingPct}%)</strong><br/>${formatNum(trulyMissing)} of ${formatNum(data.finalizableRequests)} finalizable requests have no token data (neither input nor output tokens recorded). These requests are excluded from totals.</span></span>`
        : data.finalizableRequests === 0 && data.totalRequests > 0
          ? html`<span class="missing-badge badge-popup-trigger" tabindex="0">no finalizable requests<span class="badge-popup"><strong>No finalizable requests</strong><br/>All requests in this period are either still pending (active/aborted sessions) or from sources that don\u2019t record token usage. No token totals can be computed yet.</span></span>`
          : '',
      partialLabel: data.partialRequests > 0
        ? html` <span class="pending-badge badge-popup-trigger" tabindex="0">+${formatNum(data.partialRequests)} partial<span class="badge-popup"><strong>Partial (${formatNum(data.partialRequests)} requests)</strong><br/>These requests captured output tokens but not input tokens \u2014 cost cannot be estimated exactly. The output token cost is still included in totals, but input cost is unknown. This is common with VS Code Copilot auto-completions and inline suggestions.</span></span>`
        : '',
      pendingLabel: data.pendingRequests > 0
        ? html` <span class="pending-badge badge-popup-trigger" tabindex="0">+${formatNum(data.pendingRequests)} pending<span class="badge-popup"><strong>Pending (${formatNum(data.pendingRequests)} requests)</strong><br/>Requests in active or aborted sessions where token data was never finalized. These are excluded from the missing % calculation because they may still receive data when sessions close. Common with long-running or interrupted agentic sessions.</span></span>`
        : '',
      noDataLabel: data.noDataRequests > 0
        ? html` <span class="pending-badge badge-popup-trigger" tabindex="0">+${formatNum(data.noDataRequests)} no-data<span class="badge-popup"><strong>No Data (${formatNum(data.noDataRequests)} requests)</strong><br/>Requests where the harness or source does not record token usage at all (e.g. Xcode, CLI turns aborted before any model output). This is permanent and expected \u2014 these are excluded from the missing % calculation.</span></span>`
        : '',
    };
  }

  function renderAiCreditsEmptyState(target: HTMLElement, data: AiCreditRpcData): boolean {
    if (data.countedRequests !== 0 || data.totalRequests === 0) return false;
    const heading = data.pendingRequests > 0
      ? 'No finalized billing data yet'
      : data.noDataRequests === data.totalRequests
        ? 'No token-bearing requests in this period'
        : 'No native token data available';
    const body = data.pendingRequests > 0
      ? `All ${formatNum(data.totalRequests)} request${data.totalRequests === 1 ? '' : 's'} in this period are still pending or were aborted before any model output. Token data may yet arrive once sessions finalize.`
      : data.noDataRequests === data.totalRequests
        ? `All ${formatNum(data.totalRequests)} request${data.totalRequests === 1 ? '' : 's'} are from sources that don't record token usage (e.g. Xcode), so token usage cannot be computed.`
        : `None of the ${formatNum(data.totalRequests)} request${data.totalRequests === 1 ? '' : 's'} in this period have both input and output token counts reported by the harness, so token usage cannot be computed.`;
    render(html`${APPROXIMATION_NOTICE}<div class="empty-state"><h2>${heading}</h2><p>${body}</p></div>`, target);
    return true;
  }

  function harnessColor(h: string): string {
    return HARNESS_COLORS[h] || '#6b7280';
  }

  function renderAiCreditsCharts(data: AiCreditRpcData): { modelEntries: [string, AiCreditRpcData['costByModel'][string]][] } {
    const uncachedInput = Math.max(0, data.totalInputTokens - data.totalCacheReadTokens - data.totalCacheWriteTokens);
    const cacheRead = data.totalCacheReadTokens;
    const cacheWrite = data.totalCacheWriteTokens;
    const hasCached = cacheRead + cacheWrite > 0;
    createChart('creditTokenPie', 'bar', {
      labels: hasCached ? ['Input (uncached)', 'Cache Read', 'Cache Write', 'Output'] : ['Input', 'Output'],
      datasets: [{
        label: 'Tokens',
        data: hasCached ? [uncachedInput, cacheRead, cacheWrite, data.totalOutputTokens] : [data.totalInputTokens, data.totalOutputTokens],
        backgroundColor: hasCached ? [PALETTE[0], PALETTE[2], PALETTE[4] || PALETTE[2], PALETTE[1]] : [PALETTE[0], PALETTE[1]],
      }],
    }, { plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx: { label: string; raw: number }) => `${ctx.label}: ${formatNum(ctx.raw)}` } } }, scales: { y: { beginAtZero: true, ticks: { callback: (v: number) => formatNum(v) } } } });

    const modelEntries = Object.entries(data.costByModel).sort((a, b) => (b[1].inputTokens + b[1].outputTokens) - (a[1].inputTokens + a[1].outputTokens));

    const useDaily = activeRangeDays > 0 && activeRangeDays <= 28;
    const series = useDaily ? data.daily : data.weekly;
    const yLabel = useDaily ? 'Tokens/day' : 'Tokens/week';
    const byModel = series.byModel;
    const modelNames = Object.keys(byModel).sort((a, b) => byModel[b].reduce((s: number, v: number) => s + v, 0) - byModel[a].reduce((s: number, v: number) => s + v, 0));
    const topCreditModels = modelNames.slice(0, 12);
    const otherCreditModels = modelNames.slice(12);
    const otherCreditData = series.labels.map((_: string, i: number) => otherCreditModels.reduce((sum: number, m: string) => sum + (byModel[m]?.[i] ?? 0), 0));
    const creditDatasets: Record<string, unknown>[] = topCreditModels.map((model, i) => ({ label: model, data: byModel[model], backgroundColor: PALETTE[i % PALETTE.length] + '99', borderColor: PALETTE[i % PALETTE.length], borderWidth: 1, order: 2, stack: 'models' }));
    if (otherCreditModels.length > 0) {
      creditDatasets.push({ label: `Other (${otherCreditModels.length})`, data: otherCreditData, backgroundColor: COLORS.muted + '60', borderColor: COLORS.muted, borderWidth: 1, order: 2, stack: 'models' });
    }
    createChart('creditWeeklyChart', 'bar', {
      labels: series.labels,
      datasets: [
        ...creditDatasets as { label: string; data: number[]; backgroundColor: string; borderColor: string; borderWidth: number; order: number; stack: string }[],
        { label: 'Cumulative', data: series.cumulative, type: 'line' as const, borderColor: COLORS.yellow, backgroundColor: 'transparent', borderWidth: 2, pointRadius: 0, order: 1, yAxisID: 'y1' },
      ],
    }, { plugins: { legend: { position: 'top' } }, scales: { x: { stacked: true, ticks: { maxTicksLimit: 15 } }, y: { stacked: true, beginAtZero: true, position: 'left', title: { display: true, text: yLabel } }, y1: { beginAtZero: true, position: 'right', grid: { drawOnChartArea: false }, title: { display: true, text: 'Cumulative' } } } });

    // Token Consumption by Workspace chart
    const level = aggregationLevel(activeRangeDays);
    const { labels: wsLabels, byWs: wsBuckets } = aggregateByWorkspace(
      data.dailyTokensByWorkspace.labels, data.dailyTokensByWorkspace.byWorkspace, level,
    );
    const wsNames = Object.keys(wsBuckets).sort((a, b) => {
      const sumA = wsBuckets[a].reduce((s, v) => s + v, 0);
      const sumB = wsBuckets[b].reduce((s, v) => s + v, 0);
      return sumB - sumA;
    });
    const topWs = wsNames.slice(0, 20);
    const otherWs = wsNames.slice(20);
    const otherWsData = wsLabels.map((_, i) => otherWs.reduce((sum, ws) => sum + (wsBuckets[ws]?.[i] ?? 0), 0));
    const wsDatasets: Record<string, unknown>[] = topWs.map((ws, i) => ({
      label: ws, data: wsBuckets[ws], backgroundColor: PALETTE[i % PALETTE.length] + '99',
      borderColor: PALETTE[i % PALETTE.length], borderWidth: 1, stack: 'ws',
    }));
    if (otherWs.length > 0) {
      wsDatasets.push({ label: `Other (${otherWs.length})`, data: otherWsData, backgroundColor: COLORS.muted + '60', borderColor: COLORS.muted, borderWidth: 1, stack: 'ws' });
    }
    if (wsDatasets.length > 0) {
      const wsYLabel = level === 'daily' ? 'Tokens/day' : level === 'weekly' ? 'Tokens/week' : 'Tokens/month';
      createChart('creditTokenByWsChart', 'bar', {
        labels: wsLabels,
        datasets: wsDatasets as { label: string; data: number[]; backgroundColor: string; borderColor: string; borderWidth: number; stack: string }[],
      }, { plugins: { legend: { position: 'top' }, tooltip: { callbacks: { label: (ctx: { dataset: { label: string }; raw: number }) => `${ctx.dataset.label}: ${formatNum(ctx.raw)} tokens` } } }, scales: { x: { stacked: true, ticks: { maxTicksLimit: 15 } }, y: { stacked: true, beginAtZero: true, title: { display: true, text: wsYLabel }, ticks: { callback: (v: number) => formatNum(v) } } } });
    }

    // Token Consumption by Harness chart
    const { labels: hLabels, byWs: hBuckets } = aggregateByWorkspace(
      data.dailyTokensByHarness.labels, data.dailyTokensByHarness.byHarness, level,
    );
    const hNames = Object.keys(hBuckets).sort((a, b) => {
      const sumA = hBuckets[a].reduce((s, v) => s + v, 0);
      const sumB = hBuckets[b].reduce((s, v) => s + v, 0);
      return sumB - sumA;
    });
    const hDatasets: Record<string, unknown>[] = hNames.map((h) => ({
      label: h, data: hBuckets[h],
      backgroundColor: (harnessColor(h)) + '99',
      borderColor: harnessColor(h), borderWidth: 1, stack: 'harness',
    }));
    if (hDatasets.length > 0) {
      const hYLabel = level === 'daily' ? 'Tokens/day' : level === 'weekly' ? 'Tokens/week' : 'Tokens/month';
      createChart('creditTokenByHarnessChart', 'bar', {
        labels: hLabels,
        datasets: hDatasets,
      }, { plugins: { legend: { position: 'top' }, tooltip: { callbacks: { label: (ctx: { dataset: { label: string }; raw: number }) => `${ctx.dataset.label}: ${formatNum(ctx.raw)} tokens` } } }, scales: { x: { stacked: true, ticks: { maxTicksLimit: 15 } }, y: { stacked: true, beginAtZero: true, title: { display: true, text: hYLabel }, ticks: { callback: (v: number) => formatNum(v) } } } });
    }

    return { modelEntries };
  }

  function renderCreditModelTable(target: HTMLElement, modelEntries: [string, AiCreditRpcData['costByModel'][string]][]): void {
    const visibleModelEntries = modelEntries.filter(([, info]) => info.countedRequests > 0 || info.partialRequests > 0);
    const hiddenModelCount = modelEntries.length - visibleModelEntries.length;
    const anyCached = visibleModelEntries.some(([, info]) => (info.cacheReadTokens + info.cacheWriteTokens) > 0);
    render(html`
      <table class="data-table"><thead><tr><th>Model</th><th>Source</th><th>Requests</th><th>Input Tokens</th>${anyCached && html`<th title="Cached input tokens (read + write).">Cached</th>`}<th>Output Tokens</th><th>Data</th></tr></thead><tbody>
        ${visibleModelEntries.map(([model, info]) => {
          const dataTag = info.finalizableRequests === 0 && info.requests > 0
            ? html`<span class="missing-badge-inline" title="No finalizable requests for this model \u2014 all are pending or from a source that doesn't record tokens.">N/A</span>`
            : info.missingPct > 0
              ? html`<span class="missing-badge" title=${info.missingPct + '% of finalizable requests for this model have no token data'}>missing ${info.missingPct}%</span>`
              : '\u2713';
          const cachedTotal = info.cacheReadTokens + info.cacheWriteTokens;
          return html`<tr>
            <td>${model}</td>
            <td>${(info.harnesses ?? []).map(h => html`<span class="harness-badge" style="--harness-color:${harnessColor(h)}" title=${h}>${h}</span> `)}</td>
            <td>${formatNum(info.requests)}</td>
            <td>${formatNum(info.inputTokens)}</td>
            ${anyCached && html`<td>${cachedTotal > 0 ? formatNum(cachedTotal) : html`<span class="missing-badge-inline">\u2014</span>`}</td>`}
            <td>${formatNum(info.outputTokens)}</td>
            <td>${dataTag}${info.partialRequests > 0 && html` <span class="pending-badge" title=${formatNum(info.partialRequests) + ' output-only requests (input not captured) \u2014 output tokens shown but credits cannot be billed.'}>+${formatNum(info.partialRequests)} partial</span>`}${info.pendingRequests > 0 && html` <span class="pending-badge" title=${formatNum(info.pendingRequests) + ' requests in active/aborted sessions (excluded from missing %)'}>+${formatNum(info.pendingRequests)} pending</span>`}${info.noDataRequests > 0 && html` <span class="pending-badge" title=${formatNum(info.noDataRequests) + " requests where the harness/source did not record token data (excluded from missing %)"}>+${formatNum(info.noDataRequests)} no-data</span>`}</td>
          </tr>`;
        })}
      </tbody></table>
      ${hiddenModelCount > 0 && html`<p class="credits-note" style="margin-top:6px;"><span title="Models hidden because every request is pending or from a source that doesn't record token data \u2014 there's nothing to display in the cost columns.">${hiddenModelCount} model${hiddenModelCount === 1 ? '' : 's'} hidden (no token data)</span></p>`}
    `, target);
  }

  function showPromptPopup(e: MouseEvent, fullPrompt: string): void {
    // Remove any existing popup
    document.querySelector('.prompt-popup-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.className = 'prompt-popup-overlay';

    const popup = document.createElement('div');
    popup.className = 'prompt-popup';

    const header = document.createElement('div');
    header.className = 'prompt-popup-header';
    header.textContent = 'Full Prompt';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'prompt-popup-close';
    closeBtn.textContent = '\u00d7';
    closeBtn.onclick = () => close();
    header.appendChild(closeBtn);

    const body = document.createElement('div');
    body.className = 'prompt-popup-body';
    body.textContent = fullPrompt;

    popup.appendChild(header);
    popup.appendChild(body);
    overlay.appendChild(popup);
    document.body.appendChild(overlay);

    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);

    function close() {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
    }

    // Close on overlay click (outside popup)
    overlay.addEventListener('click', (ev) => {
      if (ev.target === overlay) close();
    });
  }

  function renderTopRequestsTable(target: HTMLElement, data: AiCreditRpcData): void {
    render(html`
      <table class="data-table"><thead><tr><th>Date</th><th>Workspace</th><th>Source</th><th>Model</th><th>Total Tokens</th><th>Prompt</th></tr></thead><tbody>
        ${data.topRequests.map(req => {
          const d = new Date(req.timestamp).toLocaleDateString();
          const aggregated = req.aggregationKind === 'session-aggregated';
          const aggTitle = 'Estimated share of session-level totals reported by the harness \u2014 exact per-request input is not available.';
          const totalTokens = req.inputTokens + req.outputTokens;
          const tokensCell = req.status === 'complete'
            ? (aggregated ? html`<span class="aggregated-badge" title=${aggTitle}>~${formatNum(totalTokens)}</span>` : formatNum(totalTokens))
            : req.status === 'pending' ? html`<span class="missing-badge" title="Token data not yet finalized.">pending</span>`
            : req.status === 'no-data' ? html`<span class="missing-badge" title="Source structurally does not record token counts.">no-data</span>`
            : req.status === 'partial' ? html`<span class="missing-badge" title="Only output captured \u2014 total incomplete.">partial</span>`
            : html`<span class="missing-badge" title="No native token count.">missing</span>`;
          const wsCell = req.workspace || html`<span class="missing-badge">unknown</span>`;
          const harnessCell = req.harness ? html`<span class="harness-badge" style="--harness-color:${harnessColor(req.harness)}" title=${req.harness}>${req.harness}</span>` : '';
          return html`<tr><td>${d}</td><td>${wsCell}</td><td>${harnessCell}</td><td>${req.model}</td><td>${tokensCell}</td><td><span class="prompt-preview-trigger" onclick=${(e: MouseEvent) => showPromptPopup(e, req.fullPrompt)}>${req.preview.slice(0, 50)}\u2026</span></td></tr>`;
        })}
      </tbody></table>
      ${data.topRequests.some(r => r.aggregationKind === 'session-aggregated') && html`<p class="credits-note"><span class="aggregated-badge">~value</span> = derived share of session-level totals (per-request data not reported by harness).</p>`}
    `, target);
  }

  async function renderTokenUsageTab(gen: number): Promise<void> {
    const target = document.getElementById('output-tab-content')!;
    render(html`<div class="loading-spinner"></div>`, target);

    const data = await rpc<AiCreditRpcData>('getAiCredits', buildRangeFilter());
    if (gen !== renderGeneration) return; // superseded by a newer render (tab/range/nav change)

    const { missingLabel, partialLabel, pendingLabel, noDataLabel } = buildCreditCoverageSummary(data);
    if (renderAiCreditsEmptyState(target, data)) return;

    const totalTokens = data.totalInputTokens + data.totalOutputTokens;

    render(html`
      ${APPROXIMATION_NOTICE}
      <div class="stat-grid" id="creditStats">
        <${StatCard} label="Total Tokens" value=${formatNum(totalTokens)} accent="var(--accent-blue)" />
        <${StatCard} label="Input Tokens" value=${formatNum(data.totalInputTokens)} accent="var(--accent-green)" />
        <${StatCard} label="Output Tokens" value=${formatNum(data.totalOutputTokens)} accent="var(--accent-purple)" />
      </div>
      <p class="credits-note">Totals reflect ${formatNum(data.countedRequests)} of ${formatNum(data.finalizableRequests)} finalizable requests with token data. Code completions are free and not counted. ${missingLabel}${partialLabel}${pendingLabel}${noDataLabel}</p>
      <div class="chart-tabs" style="margin-top:18px">
        <button class="chart-tab active" data-chart-tab="tokens">Token Consumption</button>
        <button class="chart-tab" data-chart-tab="tokens-ws">Tokens by Workspace</button>
        <button class="chart-tab" data-chart-tab="tokens-harness">Tokens by Harness</button>
      </div>
      <div id="chartTabCredits" class="chart-tab-panel active"><${CanvasEl} id="creditWeeklyChart" height=${300} title=${creditChartTitle()} /></div>
      <div id="chartTabTokensWs" class="chart-tab-panel"><${CanvasEl} id="creditTokenByWsChart" height=${350} title=${tokenByWsChartTitle()} /></div>
      <div id="chartTabTokensHarness" class="chart-tab-panel"><${CanvasEl} id="creditTokenByHarnessChart" height=${350} title=${tokenByHarnessChartTitle()} /></div>
      <div class="chart-wrap"><div class="chart-title">Token Breakdown <span class="info-icon" tabindex="0" role="button" aria-label="Token breakdown info">${'\u24d8'}<span class="info-popup">Cache token breakdown (cache read / cache write) is only available for harnesses that report it natively, such as Claude Code and Copilot CLI. VS Code Copilot chat sessions report a single aggregated input token count and do not break out cached vs. uncached tokens — this is a limitation of the upstream data format, not a bug.</span></span></div><canvas id="creditTokenPie" height=${250}></canvas></div>
      <h2>Model Token Breakdown</h2>
      <div id="creditModelTable"></div>
      <h2>Top Requests by Token Usage</h2>
      <div id="topRequestsTable"></div>
    `, target);

    const { modelEntries } = renderAiCreditsCharts(data);
    renderCreditModelTable(document.getElementById('creditModelTable')!, modelEntries);
    renderTopRequestsTable(document.getElementById('topRequestsTable')!, data);

    // Wire chart tab switching
    for (const btn of target.querySelectorAll<HTMLButtonElement>('.chart-tab')) {
      btn.addEventListener('click', () => {
        for (const b of target.querySelectorAll<HTMLButtonElement>('.chart-tab')) b.classList.remove('active');
        btn.classList.add('active');
        const tab = btn.dataset.chartTab;
        const panels = target.querySelectorAll<HTMLElement>('.chart-tab-panel');
        for (const p of panels) p.classList.remove('active');
        const panelMap: Record<string, string> = { tokens: 'chartTabCredits', 'tokens-ws': 'chartTabTokensWs', 'tokens-harness': 'chartTabTokensHarness' };
        document.getElementById(panelMap[tab || 'tokens'])!.classList.add('active');
      });
    }
  }


  async function renderActiveTab(): Promise<void> {
    const gen = ++renderGeneration;
    if (!FF_TOKEN_REPORTING_ENABLED && activeTab === 'token-usage') {
      activeTab = 'production';
    }
    if (activeTab === 'production') await renderProductionTab(gen);
    else if (!FF_TOKEN_REPORTING_ENABLED) renderTokenUsageGated();
    else await renderTokenUsageTab(gen);
  }

  /** Shown when token-usage is gated behind the feature flag. */
  function renderTokenUsageGated(): void {
    const target = document.getElementById('output-tab-content')!;
    render(html`
      <div class="feature-gated-notice">
        <h2>Token Usage is temporarily disabled</h2>
        <p>
          This feature has been disabled temporarily until we are able to verify
          that the reporting is aligned with what is reported by GitHub.
          It will be re-enabled once the billing system is active and numbers
          can be validated.
        </p>
      </div>
    `, target);
  }

  // Initial render — honour the persisted active tab
  await renderActiveTab();

  // Viewport-aware badge popup positioning — uses position:fixed and
  // clamps to viewport edges so popups never overflow off-screen.
  document.body.addEventListener('mouseenter', (e) => {
    const trigger = (e.target as HTMLElement).closest?.('.badge-popup-trigger');
    if (!trigger) return;
    const popup = trigger.querySelector('.badge-popup') as HTMLElement | null;
    if (!popup) return;
    popup.style.left = '';
    popup.style.top = '';
    const tr = trigger.getBoundingClientRect();
    const pw = 280;
    const pad = 8;
    let left = tr.left + tr.width / 2 - pw / 2;
    if (left < pad) left = pad;
    if (left + pw > window.innerWidth - pad) left = window.innerWidth - pad - pw;
    const top = tr.top - 6;
    popup.style.left = `${left}px`;
    popup.style.top = `${top}px`;
    popup.style.transform = 'translateY(-100%)';
    // After display, verify it doesn't overflow top; if so, show below.
    requestAnimationFrame(() => {
      const pr = popup.getBoundingClientRect();
      if (pr.top < pad) {
        popup.style.top = `${tr.bottom + 6}px`;
        popup.style.transform = 'none';
      }
    });
  }, true);

  // Date range switching — re-renders the active tab. Disabled buttons
  // (greyed out for token-data tabs whose nominal start lies before the
  // TOKEN_DATA_AVAILABLE_FROM cutoff) are ignored on click.
  document.getElementById('outputRange')!.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('.cons-range-btn');
    if (!btn) return;
    if (btn.hasAttribute('disabled')) return;
    const days = Number(btn.dataset.range);
    if (isRangeDisabled(activeTab, days)) return;
    activeRangeDays = days;
    refreshRangeBar();
    void renderActiveTab();
  });

  // Tab switching — refresh range bar so disabled state matches the new tab,
  // and snap the active range to a valid one if the user's previous choice
  // is no longer available on this tab.
  document.getElementById('output-tabs')!.addEventListener('click', (e) => {
    void (async () => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('.tab');
      if (!btn) return;
      for (const t of $$('#output-tabs .tab')) t.classList.remove('active');
      btn.classList.add('active');
      const tab = btn.dataset.tab;
      if (!tab) return;
      if (!FF_TOKEN_REPORTING_ENABLED && tab === 'token-usage') return;
      activeTab = tab as OutputTab;
      snapActiveRangeIfDisabled();
      refreshRangeBar();
      await renderActiveTab();
    })();
  });
}
