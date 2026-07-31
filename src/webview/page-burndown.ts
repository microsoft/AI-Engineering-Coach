/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Burndown page renderer — token consumption only */

import { DateFilter } from '../core/types';
import { rpc, createChart, destroyChartById, COLORS, formatNum, vscode } from './shared';
import { html, render, CanvasEl, StatCard } from './render';

interface AiCreditBdData {
  dayOfMonth: number;
  daysInMonth: number;
  dailyConsumption: { labels: string[]; cumulative: number[] };
  projectedLine: number[];
  budgetLine: number[];
  status: string;
  consumed: number;
  budget: number;
  projected: number;
  recommendation: string;
  daysUntilExhaustion: number | null;
  safeDailyBudget: number;
  projectedOverage: number;
  missingPct: number;
  totalRequests: number;
  countedRequests: number;
  partialRequests: number;
  pendingRequests: number;
  noDataRequests: number;
  finalizableRequests: number;
  coverageByDay: {
    complete: number[];
    partial: number[];
    pending: number[];
    noData: number[];
    missing: number[];
  };
  byModel: Record<string, { cumulative: number[]; budget: number }>;
}

function renderBurndownChartLater(renderBurndownChart: () => Promise<void>): void {
  void renderBurndownChart();
}

function ExtraInfo({ bd }: { bd: AiCreditBdData }) {
  const trulyMissing = bd.finalizableRequests - bd.countedRequests - bd.partialRequests;
  return html`
    <p>
      ${bd.daysUntilExhaustion != null && html`<strong>Days to exhaustion:</strong> ${bd.daysUntilExhaustion} | `}
      <strong>Safe daily budget:</strong> ${formatNum(Math.round(bd.safeDailyBudget))} tokens/day |${' '}
      ${bd.projectedOverage > 0 && html`<strong>Projected overage:</strong> ${formatNum(Math.round(bd.projectedOverage))} tokens | `}
      ${bd.finalizableRequests > 0 && bd.missingPct > 0 && html` <span class="missing-badge" title=${trulyMissing + ' of ' + bd.finalizableRequests + ' finalizable requests have no token data and were not counted.'}>missing ${bd.missingPct}%</span>`}
      ${bd.partialRequests > 0 && html` <span class="pending-badge" title=${bd.partialRequests + ' output-only requests in this period (excluded from missing %)'}>+${bd.partialRequests} partial</span>`}
      ${bd.pendingRequests > 0 && html` <span class="pending-badge" title=${bd.pendingRequests + ' requests in active/aborted sessions (excluded from missing %)'}>+${bd.pendingRequests} pending</span>`}
      ${bd.noDataRequests > 0 && html` <span class="pending-badge" title=${bd.noDataRequests + ' requests where the harness/source did not record token data (excluded from missing %)'}>+${bd.noDataRequests} no-data</span>`}
    </p>
  `;
}

// Module-level view state — survives filter/harness changes.
const _now = new Date();
let selectedYear = _now.getFullYear();
let selectedMonth = _now.getMonth() + 1;
let activeBurndownTab: 'chart' | 'budget' = 'chart';

/** Per-model monthly token budgets — persisted to disk via extension globalState. */
const modelBudgets: Record<string, number> = loadModelBudgetsFromWebviewState();

/** Whether disk budgets have been loaded into modelBudgets yet. */
let diskBudgetsLoaded = false;

/** Selected model filter for burndown chart: 'all' or a model name. */
let selectedBurndownModel = 'all';

/** Fast local restore from webview state (survives tab switches). */
function loadModelBudgetsFromWebviewState(): Record<string, number> {
  const s = vscode.getState() as Record<string, unknown> | null;
  return (s?.modelBudgets as Record<string, number>) ?? {};
}

/** Save to both webview state (fast) and disk (persistent). */
function saveModelBudgets(): void {
  const toSave: Record<string, number> = {};
  for (const [k, v] of Object.entries(modelBudgets)) {
    if (v > 0) toSave[k] = v;
  }
  // Webview state (fast, survives tab switch)
  const s = (vscode.getState() as Record<string, unknown>) ?? {};
  vscode.setState({ ...s, modelBudgets: toSave });
  // Disk persistence (survives reload/restart)
  rpc('saveModelBudgets', { budgets: toSave }).catch(() => { /* best effort */ });
}

/** Load budgets from disk (extension globalState) on first use. */
async function loadModelBudgetsFromDisk(): Promise<void> {
  if (diskBudgetsLoaded) return;
  diskBudgetsLoaded = true;
  try {
    const saved = await rpc<Record<string, number>>('loadModelBudgets', {});
    if (saved && typeof saved === 'object') {
      // Merge: disk values win over in-memory zeros, but don't overwrite user edits from this session
      for (const [k, v] of Object.entries(saved)) {
        if (v > 0 && !(k in modelBudgets && modelBudgets[k] > 0)) {
          modelBudgets[k] = v;
        }
      }
      // Also update webview state with merged result
      const s = (vscode.getState() as Record<string, unknown>) ?? {};
      const toSave: Record<string, number> = {};
      for (const [k2, v2] of Object.entries(modelBudgets)) {
        if (v2 > 0) toSave[k2] = v2;
      }
      vscode.setState({ ...s, modelBudgets: toSave });
    }
  } catch { /* first load, no data yet */ }
}

export function renderBurndown(container: HTMLElement, currentFilter: DateFilter): void {
  // Load disk-persisted budgets on first render
  void loadModelBudgetsFromDisk();

  const now = new Date();

  function formatMonthLabel(year: number, month: number): string {
    return new Date(year, month - 1).toLocaleString('default', { month: 'long', year: 'numeric' });
  }

  function isCurrentMonth(): boolean {
    return selectedYear === now.getFullYear() && selectedMonth === now.getMonth() + 1;
  }

  function navigateMonth(delta: number) {
    selectedMonth += delta;
    if (selectedMonth < 1) { selectedMonth = 12; selectedYear--; }
    else if (selectedMonth > 12) { selectedMonth = 1; selectedYear++; }
    document.getElementById('monthLabel')!.textContent = formatMonthLabel(selectedYear, selectedMonth);
    (document.getElementById('nextMonth') as HTMLButtonElement).disabled = isCurrentMonth();
    renderBurndownChartLater(renderBurndownChart);
  }

  async function fetchHistoricalBudgets(): Promise<Record<string, number>> {
    const now = new Date();
    const months: string[] = [];
    // Include current month + last 3 months
    months.push(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`);
    for (let i = 1; i <= 3; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }
    const peakByModel: Record<string, number> = {};
    for (const m of months) {
      const [yr, mo] = m.split('-').map(Number);
      const daysInMonth = new Date(yr, mo, 0).getDate();
      const fromDate = `${m}-01`;
      const toDate = `${m}-${String(daysInMonth).padStart(2, '0')}`;
      try {
        const data = await rpc<{ costByModel: Record<string, { inputTokens: number; outputTokens: number }> }>('getAiCredits', { fromDate, toDate });
        for (const [model, entry] of Object.entries(data.costByModel)) {
          const tokens = Math.ceil(entry.inputTokens + entry.outputTokens);
          if (tokens > (peakByModel[model] || 0)) peakByModel[model] = tokens;
        }
      } catch { /* month may have no data */ }
    }
    return peakByModel;
  }

  /** Discovered models from history — cached across budget tab re-renders. */
  let discoveredModels: Record<string, number> = {};
  let modelsLoaded = false;

  function renderBudgetTab(): void {
    const target = document.getElementById('burndown-tab-content')!;

    // Auto-discover models on first render
    if (!modelsLoaded) {
      render(html`<div class="budget-loading">Loading models\u2026</div>`, target);
      void fetchHistoricalBudgets().then(peak => {
        discoveredModels = peak;
        modelsLoaded = true;
        // Seed modelBudgets with discovered models (keep existing budgets)
        for (const model of Object.keys(peak)) {
          if (!(model in modelBudgets)) modelBudgets[model] = 0;
        }
        renderBudgetTab();
      });
      return;
    }

    // Merge: all discovered models + any with budgets already set
    const allModels = new Set([...Object.keys(discoveredModels), ...Object.keys(modelBudgets)]);
    // Sort by peak usage desc, then alphabetically
    const sortedModels = Array.from(allModels).sort((a, b) => {
      const ua = discoveredModels[a] || 0, ub = discoveredModels[b] || 0;
      return ub - ua || a.localeCompare(b);
    });

    const totalBudget = Object.values(modelBudgets).reduce((a, b) => a + b, 0);
    const configuredCount = Object.values(modelBudgets).filter(v => v > 0).length;

    render(html`
      <div class="budget-header">
        <div class="stat-grid" style="margin-bottom:0;">
          <${StatCard} label="Total Monthly Budget" value=${formatNum(totalBudget) + ' tokens'} accent="var(--accent-blue)" />
          <${StatCard} label="Models with Budget" value=${configuredCount + ' / ' + sortedModels.length} accent="var(--accent-green)" />
        </div>
      </div>

      <div class="budget-actions">
        <button class="dash-scan-btn budget-autofill-btn" id="btnAutoFill" onClick=${() => {
          for (const [model, val] of Object.entries(discoveredModels)) {
            modelBudgets[model] = Math.ceil(val * 1.2);
          }
          saveModelBudgets();
          renderBudgetTab();
        }}>Auto-fill (+20% of peak)</button>
        <button class="dash-scan-btn budget-clear-btn" onClick=${() => {
          for (const k of Object.keys(modelBudgets)) modelBudgets[k] = 0;
          saveModelBudgets();
          renderBudgetTab();
        }}>Clear all</button>
        <button class="dash-scan-btn" onClick=${() => {
          activeBurndownTab = 'chart';
          renderTabs();
          renderBurndownChartLater(renderBurndownChart);
        }}>Apply to Burndown \u2192</button>
      </div>

      <p class="budget-hint">
        Models are auto-discovered from your usage history.
        <strong>Peak usage</strong> shows the highest monthly consumption across the last 4 months.
        Use <strong>Auto-fill</strong> to set budgets at peak + 20% buffer.
      </p>

      <table class="data-table budget-table" id="budgetTable">
        <thead><tr>
          <th>Model</th>
          <th class="budget-usage-col">Peak Usage</th>
          <th class="budget-col">Monthly Budget (tokens)</th>
        </tr></thead>
        <tbody>
          ${sortedModels.map(model => {
            const val = modelBudgets[model] || 0;
            const peak = discoveredModels[model] || 0;
            const pct = val > 0 && peak > 0 ? Math.min(100, Math.round(peak / val * 100)) : 0;
            const barColor = pct >= 90 ? 'var(--accent-red)' : pct >= 70 ? 'var(--accent-orange)' : 'var(--accent-green)';
            return html`<tr class=${val > 0 ? 'budget-row-active' : ''}>
              <td class="budget-model-name">${model}</td>
              <td class="budget-usage-col">
                <div class="budget-usage-cell">
                  <span class="budget-usage-value">${formatNum(peak)}</span>
                  ${val > 0 && html`<div class="budget-usage-bar"><div class="budget-usage-bar-fill" style=${`width:${pct}%;background:${barColor}`}></div></div>`}
                </div>
              </td>
              <td class="budget-col">
                <input type="number" class="budget-input" data-model=${model}
                  value=${val || ''}
                  placeholder="\u2014" min="0"
                  onInput=${(e: InputEvent) => {
                    const v = Number((e.target as HTMLInputElement).value);
                    if (v > 0) modelBudgets[model] = v;
                    else { modelBudgets[model] = 0; }
                    saveModelBudgets();
                    const newTotal = Object.values(modelBudgets).reduce((a, b) => a + b, 0);
                    const newCount = Object.values(modelBudgets).filter(x => x > 0).length;
                    const totalEl = target.querySelector('.stat-grid .stat-card:first-child .stat-value');
                    const countEl = target.querySelector('.stat-grid .stat-card:last-child .stat-value');
                    if (totalEl) totalEl.textContent = formatNum(newTotal) + ' tokens';
                    if (countEl) countEl.textContent = newCount + ' / ' + sortedModels.length;
                    const row = (e.target as HTMLElement).closest('tr');
                    if (row) row.classList.toggle('budget-row-active', v > 0);
                  }} />
              </td>
            </tr>`;
          })}
        </tbody>
      </table>
    `, target);
  }

  function renderTabs(): void {
    // Update tab active state
    for (const btn of container.querySelectorAll<HTMLButtonElement>('#burndown-tabs .tab')) {
      btn.classList.toggle('active', btn.dataset.tab === activeBurndownTab);
    }
    if (activeBurndownTab === 'budget') {
      renderBudgetTab();
    } else {
      const target = document.getElementById('burndown-tab-content')!;
      render(html`
        <div class="approximation-notice">
          <strong>Approximation only.</strong>
          This shows token consumption across all harnesses and may not be fully
          accurate. It cannot reflect activity on other devices, cloud-hosted
          agents, or harnesses this extension doesn't ingest.
          Use it as a workflow optimization signal, not as a billing reference.
        </div>
        <div class="burndown-controls">
          <div class="month-nav">
            <button id="prevMonth" title="Previous month" onClick=${() => navigateMonth(-1)}>\u2190</button>
            <span id="monthLabel">${formatMonthLabel(selectedYear, selectedMonth)}</span>
            <button id="nextMonth" title="Next month" disabled onClick=${() => navigateMonth(1)}>\u2192</button>
          </div>
          <select id="modelFilter" class="burndown-model-select" onChange=${() => {
            selectedBurndownModel = (document.getElementById('modelFilter') as HTMLSelectElement).value;
            renderBurndownChartLater(renderBurndownChart);
          }}>
            <option value="all" selected=${selectedBurndownModel === 'all'}>All Models</option>
          </select>
        </div>
        <${CanvasEl} id="burndownChart" height=${350} />
        <div id="burndownStatus"></div>
      `, target);
      renderBurndownChartLater(renderBurndownChart);
    }
  }

  render(html`
    <h1>Burndown</h1>
    <div class="tab-bar" id="burndown-tabs">
      <button class=${`tab${activeBurndownTab === 'chart' ? ' active' : ''}`} data-tab="chart">Burndown Chart</button>
      <button class=${`tab${activeBurndownTab === 'budget' ? ' active' : ''}`} data-tab="budget">Token Budget</button>
    </div>
    <div id="burndown-tab-content"></div>
  `, container);

  // Wire tab switching
  container.querySelector('#burndown-tabs')!.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('.tab');
    if (!btn || !btn.dataset.tab) return;
    activeBurndownTab = btn.dataset.tab as 'chart' | 'budget';
    renderTabs();
  });

  renderTabs();

  async function renderBurndownChart() {
    const month = `${selectedYear}-${String(selectedMonth).padStart(2, '0')}`;
    // Only send non-zero budgets to the backend
    const activeBudgets: Record<string, number> = {};
    for (const [k, v] of Object.entries(modelBudgets)) {
      if (v > 0) activeBudgets[k] = v;
    }
    const hasBudgets = Object.keys(activeBudgets).length > 0;
    const config: Record<string, unknown> = { sku: 'pro', month };
    if (hasBudgets) config.modelBudgets = activeBudgets;

    const bd = await rpc<AiCreditBdData>('getAiCreditBurndown', { config, filter: { ...currentFilter, workspaceId: undefined } });
    destroyChartById('burndownChart');

    const CHART_PALETTE = [COLORS.blue, COLORS.green, COLORS.purple, COLORS.yellow, '#f97316', '#06b6d4', '#ec4899', '#8b5cf6', '#14b8a6', '#f43f5e'];

    // Populate model filter dropdown with actual models
    const filterSelect = document.getElementById('modelFilter') as HTMLSelectElement | null;
    if (filterSelect) {
      const prevVal = selectedBurndownModel;
      filterSelect.innerHTML = '';
      const allOpt = document.createElement('option');
      allOpt.value = 'all'; allOpt.textContent = 'All Models';
      filterSelect.appendChild(allOpt);
      const sortedModels = Object.entries(bd.byModel)
        .sort((a, b) => (b[1].cumulative[bd.dayOfMonth - 1] || 0) - (a[1].cumulative[bd.dayOfMonth - 1] || 0));
      for (const [model] of sortedModels) {
        const opt = document.createElement('option');
        opt.value = model; opt.textContent = model;
        filterSelect.appendChild(opt);
      }
      // Restore previous selection if still valid
      if (prevVal !== 'all' && bd.byModel[prevVal]) filterSelect.value = prevVal;
      else { filterSelect.value = 'all'; selectedBurndownModel = 'all'; }
    }

    const isSingleModel = selectedBurndownModel !== 'all' && bd.byModel[selectedBurndownModel];
    const datasets: Record<string, unknown>[] = [];

    if (isSingleModel) {
      // ---- Single model view ----
      const entry = bd.byModel[selectedBurndownModel];
      const data = entry.cumulative.map((value, idx) => idx < bd.dayOfMonth ? value : null);
      datasets.push({
        label: selectedBurndownModel,
        data,
        borderColor: CHART_PALETTE[0],
        backgroundColor: CHART_PALETTE[0] + '30',
        fill: true,
        borderWidth: 2,
        pointRadius: 1,
        spanGaps: false,
      });
      // Model-specific projection
      const modelConsumed = entry.cumulative[bd.dayOfMonth - 1] || 0;
      const modelDailyRate = bd.dayOfMonth > 0 ? modelConsumed / bd.dayOfMonth : 0;
      const modelProjectedLine = bd.dailyConsumption.labels.map((_, i) => Math.round(modelDailyRate * (i + 1)));
      datasets.push({
        label: 'Projected',
        data: modelProjectedLine,
        borderColor: COLORS.yellow,
        borderDash: [5, 5],
        borderWidth: 2,
        pointRadius: 0,
        fill: false,
      });
      // Model budget line
      if (entry.budget > 0) {
        datasets.push({
          label: 'Budget',
          data: bd.dailyConsumption.labels.map(() => entry.budget),
          borderColor: COLORS.red,
          borderDash: [10, 5],
          borderWidth: 2,
          pointRadius: 0,
          fill: false,
        });
      }
    } else {
      // ---- All models view (stacked) ----
      const modelEntries = Object.entries(bd.byModel)
        .sort((a, b) => (b[1].cumulative[bd.dayOfMonth - 1] || 0) - (a[1].cumulative[bd.dayOfMonth - 1] || 0));
      const topModels = modelEntries.slice(0, 10);
      const otherModels = modelEntries.slice(10);

      for (const [model, entry] of topModels) {
        const i = topModels.findIndex(([m]) => m === model);
        const data = entry.cumulative.map((value, idx) => idx < bd.dayOfMonth ? value : null);
        datasets.push({
          label: model,
          data,
          borderColor: CHART_PALETTE[i % CHART_PALETTE.length],
          backgroundColor: CHART_PALETTE[i % CHART_PALETTE.length] + '30',
          fill: true,
          borderWidth: 2,
          pointRadius: 0,
          spanGaps: false,
          stack: 'models',
        });
      }
      if (otherModels.length > 0) {
        const otherCumulative = bd.dailyConsumption.labels.map((_, i) =>
          otherModels.reduce((sum, [, entry]) => sum + (entry.cumulative[i] || 0), 0)
        );
        const data = otherCumulative.map((value, idx) => idx < bd.dayOfMonth ? value : null);
        datasets.push({
          label: `Other (${otherModels.length})`,
          data,
          borderColor: COLORS.muted,
          backgroundColor: COLORS.muted + '30',
          fill: true,
          borderWidth: 1,
          pointRadius: 0,
          spanGaps: false,
          stack: 'models',
        });
      }

      // Total projected
      datasets.push({
        label: 'Projected',
        data: bd.projectedLine,
        borderColor: COLORS.yellow,
        borderDash: [5, 5],
        borderWidth: 2,
        pointRadius: 0,
        fill: false,
      });

      // Total budget line
      if (bd.budget > 0) {
        datasets.push({
          label: 'Budget',
          data: bd.budgetLine,
          borderColor: COLORS.red,
          borderDash: [10, 5],
          borderWidth: 2,
          pointRadius: 0,
          fill: false,
        });
      }

      // Per-model budget annotations
      for (const [model, entry] of topModels) {
        if (entry.budget > 0) {
          const color = CHART_PALETTE[topModels.findIndex(([m]) => m === model) % CHART_PALETTE.length];
          datasets.push({
            label: `${model} budget`,
            data: bd.dailyConsumption.labels.map(() => entry.budget),
            borderColor: color,
            borderDash: [4, 4],
            borderWidth: 1,
            pointRadius: 0,
            fill: false,
          });
        }
      }
    }

    createChart('burndownChart', 'line', {
      labels: bd.dailyConsumption.labels,
      datasets,
    }, {
      plugins: {
        legend: { position: 'top', labels: { filter: (item: { text: string }) => !item.text.endsWith(' budget') } },
        tooltip: { callbacks: { label: (ctx: { dataset: { label: string }; raw: number | null }) => ctx.raw != null ? `${ctx.dataset.label}: ${formatNum(ctx.raw)} tokens` : '' } },
      },
      scales: {
        x: { ticks: { maxTicksLimit: 31 } },
        y: { beginAtZero: true, stacked: !isSingleModel, ticks: { callback: (v: number) => formatNum(v) } },
      },
    });

    // ---- Status section ----
    const statusEl = document.getElementById('burndownStatus')!;

    if (bd.status === 'no-data' || bd.status === 'pending-only') {
      render(html`
        <div class="burndown-info status-nodata">
          <p><strong>Status:</strong> ${bd.status} \u2014 ${bd.status === 'pending-only' ? 'all requests in this period are still pending.' : 'no native token data available for this period.'}</p>
          <${ExtraInfo} bd=${bd} />
          <p>${bd.recommendation}</p>
        </div>
      `, statusEl);
      return;
    }

    const isPartial = bd.missingPct > 0;

    if (isSingleModel) {
      // Single model status
      const entry = bd.byModel[selectedBurndownModel];
      const used = entry.cumulative[bd.dayOfMonth - 1] || 0;
      const modelDailyRate = bd.dayOfMonth > 0 ? used / bd.dayOfMonth : 0;
      const modelProjected = Math.round(modelDailyRate * bd.daysInMonth);
      const modelBudget = entry.budget;
      const remaining = modelBudget > 0 ? modelBudget - used : 0;
      const modelSafeDailyBudget = modelBudget > 0 && bd.daysInMonth > bd.dayOfMonth
        ? Math.round(remaining / (bd.daysInMonth - bd.dayOfMonth)) : 0;
      const modelDaysToExhaustion = modelBudget > 0 && modelDailyRate > 0
        ? Math.round(remaining / modelDailyRate) : null;
      const modelOverage = modelBudget > 0 ? Math.max(0, modelProjected - modelBudget) : 0;
      const pct = modelBudget > 0 ? Math.round(used / modelBudget * 100) : 0;
      const modelStatus = modelBudget === 0 ? 'no-budget'
        : pct >= 100 ? 'will-exceed'
        : modelProjected > modelBudget ? 'warning' : 'on-track';
      const statusClass = modelStatus === 'on-track' ? 'status-good'
        : modelStatus === 'warning' ? 'status-warn'
        : modelStatus === 'no-budget' ? 'status-nodata'
        : 'status-bad';

      render(html`
        <div class=${'burndown-info ' + statusClass}>
          <p>
            <strong>${selectedBurndownModel}</strong> |
            <strong>Status:</strong> ${modelStatus} |
            <strong>Consumed:</strong> ${formatNum(Math.round(used))} tokens${modelBudget > 0 ? ` / ${formatNum(modelBudget)}` : ''}${modelBudget > 0 ? ` (${pct}%)` : ''}${isPartial && html` <span class="missing-badge">lower bound</span>`} |
            <strong>Projected:</strong> ${formatNum(modelProjected)} tokens
          </p>
          ${modelBudget > 0 && html`<p>
            ${modelDaysToExhaustion != null && html`<strong>Days to exhaustion:</strong> ${modelDaysToExhaustion} | `}
            <strong>Safe daily budget:</strong> ${formatNum(modelSafeDailyBudget)} tokens/day
            ${modelOverage > 0 && html` | <strong>Projected overage:</strong> ${formatNum(modelOverage)} tokens`}
          </p>`}
        </div>
      `, statusEl);
    } else {
      // All models status with per-model breakdown
      const statusClass = bd.status === 'on-track' ? 'status-good'
        : bd.status === 'warning' ? 'status-warn'
        : 'status-bad';

      // Build per-model status rows for models with budgets
      const budgetedModels = Object.entries(bd.byModel)
        .filter(([, e]) => e.budget > 0)
        .sort((a, b) => (b[1].cumulative[bd.dayOfMonth - 1] || 0) - (a[1].cumulative[bd.dayOfMonth - 1] || 0));

      const modelRows = budgetedModels.map(([model, entry]) => {
        const used = entry.cumulative[bd.dayOfMonth - 1] || 0;
        const modelDailyRate = bd.dayOfMonth > 0 ? used / bd.dayOfMonth : 0;
        const modelProjected = Math.round(modelDailyRate * bd.daysInMonth);
        const remaining = entry.budget - used;
        const safeDailyBudget = bd.daysInMonth > bd.dayOfMonth
          ? Math.round(remaining / (bd.daysInMonth - bd.dayOfMonth)) : 0;
        const pct = Math.round(used / entry.budget * 100);
        const cls = pct >= 100 ? 'status-bad' : modelProjected > entry.budget ? 'status-warn' : 'status-good';
        return html`<span class=${'model-budget-pill ' + cls} title=${`${model}: ${formatNum(used)} / ${formatNum(entry.budget)} (${pct}%) | safe: ${formatNum(safeDailyBudget)}/day`}>${model}: ${pct}%</span> `;
      });

      render(html`
        <div class=${'burndown-info ' + statusClass}>
          <p>
            <strong>Status:</strong> ${bd.status} |
            <strong>Consumed:</strong> ${formatNum(Math.round(bd.consumed))} tokens${bd.budget > 0 ? ` / ${formatNum(bd.budget)}` : ''}${isPartial && html` <span class="missing-badge">lower bound</span>`} |
            <strong>Projected:</strong> ${formatNum(Math.round(bd.projected))} tokens
          </p>
          ${modelRows.length > 0 && html`<div class="model-budget-status">${modelRows}</div>`}
          <${ExtraInfo} bd=${bd} />
          <p>${bd.recommendation}</p>
        </div>
      `, statusEl);
    }
  }

  renderBurndownChartLater(renderBurndownChart);
}
