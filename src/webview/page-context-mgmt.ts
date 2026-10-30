/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Context Management sub-page within Context Health — token utilization,
 * compaction tracking, per-workspace context scores, and anti-patterns. */

import { DateFilter, ContextManagementData, ContextVerdictThresholds, WorkspaceContextScore, WorkspaceContextSessionsData, SessionContextDetail } from '../core/types';
import { rpc, COLORS, createChart, destroyChartById, formatNum, PALETTE } from './shared';
import { html, render, StatCard, CanvasEl, ComponentChildren } from './render';
import {
  SESSION_COMPOSITION_CHART_ID,
  alignSessionChartAxis,
  attachCompositionDrilldown,
  compositionMiniBar,
  renderCompositionSection,
  renderCompositionTrendChart,
  renderSessionCompositionChart,
  renderSessionCompositionPanel,
} from './context-composition-view';

const VERDICT_COLORS: Record<string, string> = {
  optimal: COLORS.green,
  degraded: COLORS.yellow,
  limited: COLORS.red,
};

function contextColor(utilization: number, thresholds: ContextVerdictThresholds): string {
  if (utilization >= thresholds.limitedUtilization) return COLORS.red;
  if (utilization >= thresholds.optimalUtilization) return COLORS.yellow;
  return COLORS.green;
}

function buildContextGradient(canvas: HTMLCanvasElement, thresholds: ContextVerdictThresholds): CanvasGradient | string {
  const ctx2d = canvas.getContext('2d');
  if (!ctx2d) return 'rgba(88,166,255,0.1)';

  const grad = ctx2d.createLinearGradient(0, 0, 0, canvas.height);
  const limitedStop = Math.max(0, Math.min(1, 1 - thresholds.limitedUtilization / 100));
  const optimalStop = Math.max(0, Math.min(1, 1 - thresholds.optimalUtilization / 100));

  grad.addColorStop(0, 'rgba(248,81,73,0.25)');
  grad.addColorStop(limitedStop, 'rgba(248,81,73,0.18)');
  grad.addColorStop(limitedStop, 'rgba(210,153,34,0.18)');
  grad.addColorStop(optimalStop, 'rgba(210,153,34,0.12)');
  grad.addColorStop(optimalStop, 'rgba(63,185,80,0.12)');
  grad.addColorStop(1, 'rgba(63,185,80,0.05)');
  return grad;
}

function sortWorkspacesBySessions(workspaces: WorkspaceContextScore[]): WorkspaceContextScore[] {
  return [...workspaces].sort((a, b) =>
    b.sessionCount - a.sessionCount
    || b.requestsWithTokens - a.requestsWithTokens
    || a.workspaceName.localeCompare(b.workspaceName)
  );
}

export async function renderContextManagement(container: HTMLElement, currentFilter: DateFilter): Promise<void> {
  const data = await rpc<ContextManagementData>('getContextManagement', { filter: currentFilter } as Record<string, unknown>);

  if (data.totalSessions === 0) {
    render(html`
      <div style="text-align:center;padding:60px 20px;color:var(--text-muted);">
        <div style="font-size:40px;margin-bottom:12px;">&#128202;</div>
        <div style="font-size:18px;margin-bottom:8px;">No Session Data</div>
        <div style="max-width:420px;margin:0 auto;line-height:1.5;">
          No sessions found for the selected time period.
          Adjust the date filter or use AI coding tools to generate data.
        </div>
      </div>`, container);
    return;
  }

  const scoreColor = data.overallScore >= 70 ? COLORS.green : data.overallScore >= 40 ? COLORS.yellow : COLORS.red;
  const compactionLabel = String(data.totalCompactions);

  render(html`
    <div>
      <div class="stat-grid">
        <${StatCard} label="Context Score" value=${data.overallScore + '/100'} accent=${scoreColor} />
        <${StatCard} label="Compactions" value=${compactionLabel} accent=${data.totalCompactions > 10 ? COLORS.red : data.totalCompactions > 0 ? COLORS.yellow : COLORS.green} />
      </div>

      ${renderTips(data.tips)}

      ${data.composition ? renderCompositionSection(data.composition) : null}

      <h3 style="margin-top:24px;display:flex;align-items:center;gap:12px;">
        Context Utilization Trend
        ${data.workspaceTrend.length > 0 && data.trend.length > 1 ? html`
          <div id="ctxTrendToggle" style="display:inline-flex;border:1px solid var(--border-color, #30363d);border-radius:6px;overflow:hidden;font-size:11px;margin-left:auto;">
            <button class="ctx-trend-mode active" data-mode="avg" style="padding:4px 10px;border:none;background:var(--list-active);color:var(--text-primary, #c9d1d9);cursor:pointer;font-size:11px;">Total Avg</button>
            <button class="ctx-trend-mode" data-mode="workspace" style="padding:4px 10px;border:none;background:transparent;color:var(--text-muted, #8b949e);cursor:pointer;font-size:11px;">Per Workspace</button>
          </div>` : null}
      </h3>
      <p style="color:var(--text-muted);font-size:12px;margin:4px 0 12px;">Weekly average context utilization (% of window) and compaction events over time.</p>
      ${data.trend.length > 1 ? html`<${CanvasEl} id="ctxMgmtTrendChart" height=${280} />` : html`<div style="color:var(--text-muted);font-size:13px;padding:20px;">Not enough weekly data for trend chart.</div>`}

      <h3 style="margin-top:24px;">Per-Workspace Context Session Health</h3>
      <p style="color:var(--text-muted);font-size:12px;margin:4px 0 12px;">How efficiently each workspace manages its context window. Click a workspace to expand session-level details inline.</p>
      <div id="ctxMgmtWsTable"></div>
    </div>
  `, container);

  // Trend chart rendering
  const trendLabels = data.trend.map(t => t.label);
  if (data.composition) {
    renderCompositionTrendChart(data.composition);
    const compositionSection = document.getElementById('ctxComposition');
    if (compositionSection) attachCompositionDrilldown(compositionSection, currentFilter);
  }

  function renderTrendChart(mode: 'avg' | 'workspace'): void {
    destroyChartById('ctxMgmtTrendChart');

    if (mode === 'workspace' && data.workspaceTrend.length > 0) {
      // Per-workspace lines
      const datasets = data.workspaceTrend.map((ws, i) => ({
        label: ws.workspaceName.length > 25 ? ws.workspaceName.slice(0, 23) + '\u2026' : ws.workspaceName,
        data: ws.data,
        borderColor: PALETTE[i % PALETTE.length],
        backgroundColor: PALETTE[i % PALETTE.length] + '18',
        fill: false,
        tension: 0.3,
        borderWidth: 2,
        pointRadius: 2,
        spanGaps: true,
      }));
      createChart('ctxMgmtTrendChart', 'line', {
        labels: trendLabels,
        datasets,
      }, {
        interaction: { mode: 'index', intersect: false },
        scales: {
          y: {
            beginAtZero: true,
            max: 100,
            title: { display: true, text: 'Utilization %', color: '#8b949e' },
            ticks: { color: '#8b949e' },
            grid: { color: 'rgba(48,54,61,0.6)' },
          },
          x: {
            ticks: { color: '#8b949e', maxRotation: 45 },
            grid: { color: 'rgba(48,54,61,0.3)' },
          },
        },
        plugins: {
          annotation: {
            annotations: {
              warnLine: {
                type: 'line', yMin: 50, yMax: 50,
                borderColor: 'rgba(210,153,34,0.5)', borderWidth: 1, borderDash: [6, 4],
                label: { display: true, content: `Degraded (${data.thresholds.optimalUtilization}%)`, position: 'start', backgroundColor: 'transparent', color: COLORS.yellow, font: { size: 10 } },
              },
              dangerLine: {
                type: 'line', yMin: data.thresholds.limitedUtilization, yMax: data.thresholds.limitedUtilization,
                borderColor: 'rgba(248,81,73,0.5)', borderWidth: 1, borderDash: [6, 4],
                label: { display: true, content: `Limited (${data.thresholds.limitedUtilization}%)`, position: 'start', backgroundColor: 'transparent', color: COLORS.red, font: { size: 10 } },
              },
            },
          },
        },
      });
    } else {
      // Total average + compactions (default) — with color-coded area fill
      const canvas = document.getElementById('ctxMgmtTrendChart') as HTMLCanvasElement | null;
      let gradientFill: CanvasGradient | string = 'rgba(88,166,255,0.1)';
      if (canvas) {
        gradientFill = buildContextGradient(canvas, data.thresholds);
      }
      createChart('ctxMgmtTrendChart', 'line', {
        labels: trendLabels,
        datasets: [
          {
            label: 'Avg Utilization %',
            data: data.trend.map(t => t.avgUtilization),
            borderColor: COLORS.blue,
            backgroundColor: gradientFill,
            fill: true,
            tension: 0.3,
            yAxisID: 'y',
          },
          {
            label: 'Compactions',
            data: data.trend.map(t => t.compactions),
            borderColor: '#6e7681',
            backgroundColor: 'rgba(110,118,129,0.25)',
            type: 'bar',
            yAxisID: 'y1',
          },
        ],
      }, {
        interaction: { mode: 'index', intersect: false },
        scales: {
          y: {
            position: 'left',
            beginAtZero: true,
            max: 100,
            title: { display: true, text: 'Utilization %', color: '#8b949e' },
            ticks: { color: '#8b949e' },
            grid: { color: 'rgba(48,54,61,0.6)' },
          },
          y1: {
            position: 'right',
            beginAtZero: true,
            title: { display: true, text: 'Compactions', color: '#8b949e' },
            ticks: { color: '#8b949e', stepSize: 1 },
            grid: { drawOnChartArea: false },
          },
          x: {
            ticks: { color: '#8b949e', maxRotation: 45 },
            grid: { color: 'rgba(48,54,61,0.3)' },
          },
        },
        plugins: {
          annotation: {
            annotations: {
              warnLine: {
                type: 'line', yMin: data.thresholds.optimalUtilization, yMax: data.thresholds.optimalUtilization,
                borderColor: 'rgba(210,153,34,0.5)', borderWidth: 1, borderDash: [6, 4],
                label: { display: true, content: `Degraded (${data.thresholds.optimalUtilization}%)`, position: 'start', backgroundColor: 'transparent', color: COLORS.yellow, font: { size: 10 } },
              },
              dangerLine: {
                type: 'line', yMin: data.thresholds.limitedUtilization, yMax: data.thresholds.limitedUtilization,
                borderColor: 'rgba(248,81,73,0.5)', borderWidth: 1, borderDash: [6, 4],
                label: { display: true, content: `Limited (${data.thresholds.limitedUtilization}%)`, position: 'start', backgroundColor: 'transparent', color: COLORS.red, font: { size: 10 } },
              },
            },
          },
        },
      });
    }
  }

  if (data.trend.length > 1) {
    renderTrendChart('avg');

    // Toggle event
    for (const btn of container.querySelectorAll('.ctx-trend-mode')) {
      btn.addEventListener('click', () => {
        for (const b of container.querySelectorAll('.ctx-trend-mode')) {
          (b as HTMLElement).classList.remove('active');
          (b as HTMLElement).style.background = 'transparent';
          (b as HTMLElement).style.color = 'var(--text-muted, #8b949e)';
        }
        (btn as HTMLElement).classList.add('active');
        (btn as HTMLElement).style.background = 'var(--list-active)';
        (btn as HTMLElement).style.color = 'var(--text-primary, #c9d1d9)';
        renderTrendChart((btn as HTMLElement).dataset.mode as 'avg' | 'workspace');
      });
    }
  }

  // Paging for workspace table
  const tableWrap = document.getElementById('ctxMgmtWsTable')!;

  // Track expanded workspace and session data
  let expandedWs: string | null = null;
  let expandedSessionData: WorkspaceContextSessionsData | null = null;
  let sessionPage = 0;
  let expandedSessionIdx: number | null = null;

  function getFilteredWorkspaces(): WorkspaceContextScore[] {
    return sortWorkspacesBySessions(data.workspaces);
  }

  function getFilteredSessions(): SessionContextDetail[] {
    if (!expandedSessionData) return [];
    return expandedSessionData.sessions;
  }

  function attachWorkspaceClickHandlers(): void {
    for (const row of tableWrap.querySelectorAll<HTMLElement>('.ctx-ws-row')) {
      row.addEventListener('click', () => {
        void (async () => {
          const wsId = row.dataset.wsId;
          if (!wsId) return;

          // Collapse if clicking the same row again
          if (expandedWs === wsId) {
            expandedWs = null;
            expandedSessionData = null;
            expandedSessionIdx = null;
            collapseInlineSessions();
            return;
          }

          // Show loading in a temp row
          expandedWs = wsId;
          expandedSessionIdx = null;
          collapseInlineSessions();
          const parentRow = row;
          const loadingTr = document.createElement('tr');
          loadingTr.className = 'ctx-session-inline';
          render(html`<td colspan="9" style="padding:16px;text-align:center;color:var(--text-muted);font-size:12px;">Loading sessions...</td>`, loadingTr);
          parentRow.after(loadingTr);

          const sessionData = await rpc<WorkspaceContextSessionsData>('getWorkspaceContextSessions', { workspaceId: wsId, filter: currentFilter });
          expandedSessionData = sessionData;
          sessionPage = 0;
          renderInlineSessions(parentRow);
        })();
      });
    }
  }

  function collapseInlineSessions(): void {
    destroyChartById('ctxSessionTokenChart');
    destroyChartById(SESSION_COMPOSITION_CHART_ID);
    expandedSessionIdx = null;
    for (const el of tableWrap.querySelectorAll('.ctx-session-inline')) el.remove();
  }

  function renderInlineSessions(parentRow: HTMLElement): void {
    collapseInlineSessions();

    const sessions = getFilteredSessions();
    if (!expandedSessionData) return;

    const totalPages = Math.ceil(sessions.length / SESSION_PAGE_SIZE);
    const start = sessionPage * SESSION_PAGE_SIZE;
    const pageItems = sessions.slice(start, start + SESSION_PAGE_SIZE);

    // Summary row
    const summaryTr = document.createElement('tr');
    summaryTr.className = 'ctx-session-inline';

    const totalSessions = sessions.length;
    const avgUtil = totalSessions > 0 ? sessions.reduce((s, d) => s + d.avgUtilization, 0) / totalSessions : 0;
    const totalCompactions = sessions.reduce((s, d) => s + d.compactionCount, 0);
    const limitedCount = sessions.filter(s => s.verdict === 'limited').length;
    const avgSaturation = totalSessions > 0 ? sessions.reduce((s, d) => s + d.saturation, 0) / totalSessions : 0;
    const todoEvents = sessions.reduce((s, d) => s + d.events.filter(e => e.type === 'todo-add' || e.type === 'todo-complete').length, 0);

    render(html`<td colspan="9" style="padding:12px 16px;background:rgba(88,166,255,0.03);border-bottom:1px solid var(--border-color, #30363d);">
      <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap;">
        <span style="font-size:12px;color:var(--text-muted);"><strong style="color:var(--text-primary, #c9d1d9);">${totalSessions}</strong> sessions</span>
        <span style="font-size:12px;color:var(--text-muted);">Avg util: <strong style=${'color:' + contextColor(avgUtil, expandedSessionData.thresholds) + ';'}>${avgUtil.toFixed(1)}%</strong></span>
        <span style="font-size:12px;color:var(--text-muted);">Saturation: <strong style=${'color:' + (avgSaturation > 30 ? COLORS.red : avgSaturation > 10 ? COLORS.yellow : COLORS.green) + ';'}>${avgSaturation.toFixed(1)}%</strong></span>
        <span style="font-size:12px;color:var(--text-muted);">Compactions: <strong style=${'color:' + (totalCompactions > 0 ? COLORS.yellow : 'var(--text-primary, #c9d1d9)') + ';'}>${totalCompactions}</strong></span>
        ${limitedCount > 0 ? html`<span style=${'font-size:12px;color:' + COLORS.red + ';'}><strong>${limitedCount}</strong> limited</span>` : null}
        ${todoEvents > 0 ? html`<span style=${'font-size:12px;color:' + (COLORS.purple ?? COLORS.blue) + ';'}>${todoEvents} todo events</span>` : null}
      </div>
    </td>`, summaryTr);
    parentRow.after(summaryTr);

    // Session header row
    const headerTr = document.createElement('tr');
    headerTr.className = 'ctx-session-inline';
    render(html`
      <td colspan="9" style="padding:0;background:rgba(88,166,255,0.02);">
        <table style="width:100%;border-collapse:collapse;font-size:11px;">
          <thead>
            <tr style="border-bottom:1px solid var(--border-color, #30363d);color:var(--text-muted);">
              <th style="text-align:left;padding:6px 10px;font-weight:600;">Date</th>
              <th style="text-align:left;padding:6px 6px;font-weight:600;">Harness</th>
              <th style="text-align:center;padding:6px 6px;font-weight:600;">Verdict</th>
              <th style="text-align:right;padding:6px 6px;font-weight:600;">Reqs</th>
              <th style="text-align:right;padding:6px 6px;font-weight:600;" title="Average native prompt tokens per request">Avg Tokens</th>
              <th style="text-align:center;padding:6px 6px;font-weight:600;">Avg Util</th>
              <th style="text-align:center;padding:6px 6px;font-weight:600;">Sat.</th>
              <th style="text-align:center;padding:6px 6px;font-weight:600;">Events</th>
              <th style="text-align:left;padding:6px 6px;font-weight:600;">Token Curve</th>
              <th style="text-align:left;padding:6px 6px;font-weight:600;" title="What filled this session's prompts, by category">Composition</th>
            </tr>
          </thead>
          <tbody>
            ${pageItems.map((s, idx) => renderSessionRow(s, expandedSessionData!.estimatedContextWindow, start + idx, expandedSessionData!.thresholds))}
          </tbody>
        </table>
        ${totalPages > 1 ? html`<div style="display:flex;justify-content:center;gap:6px;padding:8px;">
          ${Array.from({ length: totalPages }, (_, i) => {
            const active = i === sessionPage;
            return html`<button class=${'ctx-sess-page-btn cons-range-btn' + (active ? ' active' : '')} data-pg=${String(i)} style="min-width:28px;padding:3px 6px;font-size:10px;">${i + 1}</button>`;
          })}
        </div>` : null}
      </td>`, headerTr);
    summaryTr.after(headerTr);

    // Attach session row click handlers — expand chart inline below the clicked row
    for (const row of headerTr.querySelectorAll('.ctx-session-row')) {
      row.addEventListener('click', () => {
        const clickable = (row as HTMLElement).dataset.clickable === 'true';
        if (!clickable) return;

        const idx = Number.parseInt((row as HTMLElement).dataset.sessionIdx!, 10);
        const s = sessions[idx];
        if (!s) return;

        // Collapse previous if any
        const existingChart = headerTr.querySelector('.ctx-session-chart-row');
        if (existingChart) {
          destroyChartById('ctxSessionTokenChart');
          destroyChartById(SESSION_COMPOSITION_CHART_ID);
          existingChart.remove();
        }

        // Toggle off if same session
        if (expandedSessionIdx === idx) {
          expandedSessionIdx = null;
          return;
        }

        expandedSessionIdx = idx;

        // Find the inner table row and insert chart row after it
        const innerRows = headerTr.querySelectorAll('.ctx-session-row');
        const pageRelIdx = idx - start;
        const targetRow = innerRows[pageRelIdx] as HTMLElement | null;
        if (!targetRow) return;

        const chartRow = document.createElement('tr');
        chartRow.className = 'ctx-session-chart-row';
        const chartId = 'ctxSessionTokenChart';
        const todoEvents = s.events.filter(e => e.type !== 'compaction');
        render(html`<td colspan="10" style="padding:12px 16px;background:rgba(22,27,34,0.6);border-bottom:1px solid var(--border-color, #30363d);">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
            <span style="font-size:12px;font-weight:600;color:var(--text-primary,#c9d1d9);">${s.date} — ${s.harness}</span>
            <span style="font-size:11px;color:var(--text-muted);">${s.requestCount} reqs, ${s.compactionCount} compactions${todoEvents.length > 0 ? ', ' + todoEvents.length + ' todo events' : ''}</span>
          </div>
          ${s.hasPerRequestTokens ? html`<div style="position:relative;height:226px;"><${CanvasEl} id=${chartId} height=${180} /></div>` : null}
          ${renderSessionCompositionPanel(s)}
        </td>`, chartRow);
        targetRow.after(chartRow);

        if (expandedSessionData && s.hasPerRequestTokens) {
          renderSessionTokenChart(chartId, s, expandedSessionData.estimatedContextWindow ?? 1, expandedSessionData.thresholds);
        }
        renderSessionCompositionChart(s);
        chartRow.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
    }

    // Attach pagination
    for (const btn of headerTr.querySelectorAll('.ctx-sess-page-btn')) {
      btn.addEventListener('click', () => {
        sessionPage = Number.parseInt((btn as HTMLElement).dataset.pg!, 10);
        renderInlineSessions(parentRow);
      });
    }


  }



  let currentPage = 0;
  const updateTable = () => {
    expandedWs = null;
    expandedSessionData = null;
    expandedSessionIdx = null;
    const filtered = getFilteredWorkspaces();
    render(html`<div>${renderWorkspaceTable(filtered, currentPage, data.thresholds)}</div>`, tableWrap);
    for (const btn of tableWrap.querySelectorAll('.ctx-ws-page-btn')) {
      btn.addEventListener('click', () => {
        currentPage = Number.parseInt((btn as HTMLElement).dataset.pg!, 10);
        updateTable();
      });
    }
    attachWorkspaceClickHandlers();
  };
  updateTable();

}

function renderSessionTokenChart(chartId: string, s: SessionContextDetail, ctxWindow: number, thresholds: ContextVerdictThresholds): void {
  destroyChartById(chartId);

  const eventMarkers = s.events.map(ev => {
    const color = ev.type === 'compaction' ? COLORS.red
      : ev.type === 'todo-complete' ? COLORS.green
      : ev.type === 'todo-progress' ? COLORS.yellow
      : COLORS.blue;
    return {
      type: 'line' as const,
      xMin: ev.requestIndex,
      xMax: ev.requestIndex,
      borderColor: color,
      borderWidth: 1.5,
      borderDash: ev.type === 'compaction' ? undefined : [4, 3],
      label: {
        display: true,
        content: ev.label.length > 20 ? ev.label.slice(0, 18) + '\u2026' : ev.label,
        position: 'start' as const,
        backgroundColor: 'transparent',
        color,
        font: { size: 9 },
        rotation: -90,
        yAdjust: -10,
      },
    };
  });

  const annotations: Record<string, unknown> = {
    warnLine: {
      type: 'line', yMin: thresholds.optimalUtilization, yMax: thresholds.optimalUtilization,
      borderColor: 'rgba(210,153,34,0.4)', borderWidth: 1, borderDash: [6, 4],
      label: { display: true, content: `${thresholds.optimalUtilization}%`, position: 'end', backgroundColor: 'transparent', color: COLORS.yellow, font: { size: 9 } },
    },
    dangerLine: {
      type: 'line', yMin: thresholds.limitedUtilization, yMax: thresholds.limitedUtilization,
      borderColor: 'rgba(248,81,73,0.4)', borderWidth: 1, borderDash: [6, 4],
      label: { display: true, content: `${thresholds.limitedUtilization}%`, position: 'end', backgroundColor: 'transparent', color: COLORS.red, font: { size: 9 } },
    },
  };
  for (const [i, m] of eventMarkers.entries()) { annotations['ev' + i] = m; }

  // Embed TODO lifecycle bars as box annotations at the bottom of the chart
  const todoEvts = s.events.filter(e => e.type !== 'compaction');
  if (todoEvts.length > 0) {
    interface TodoLife { title: string; addedAt: number; startedAt: number | null; completedAt: number | null }
    const todoItems: TodoLife[] = [];
    const todoMap = new Map<string, TodoLife>();
    for (const ev of todoEvts) {
      const key = ev.label;
      if (ev.type === 'todo-add') {
        if (!todoMap.has(key)) {
          const item: TodoLife = { title: key, addedAt: ev.requestIndex, startedAt: null, completedAt: null };
          todoItems.push(item);
          todoMap.set(key, item);
        }
      } else if (ev.type === 'todo-progress') {
        const it = todoMap.get(key);
        if (it && it.startedAt == null) it.startedAt = ev.requestIndex;
      } else if (ev.type === 'todo-complete') {
        const it = todoMap.get(key);
        if (it) it.completedAt = ev.requestIndex;
        else {
          const item: TodoLife = { title: key, addedAt: 0, startedAt: null, completedAt: ev.requestIndex };
          todoItems.push(item);
          todoMap.set(key, item);
        }
      }
    }
    const bandH = 3; // % height per todo item
    for (const [i, it] of todoItems.entries()) {
      const yBase = i * bandH;
      const endReq = it.completedAt ?? (s.requestCount - 1);
      const barColor = it.completedAt != null ? COLORS.green
        : it.startedAt != null ? COLORS.yellow
        : COLORS.blue;
      annotations['todo_' + i] = {
        type: 'box',
        xMin: it.addedAt,
        xMax: endReq,
        yMin: yBase,
        yMax: yBase + bandH - 0.5,
        backgroundColor: barColor + '30',
        borderColor: barColor + '80',
        borderWidth: 1,
        borderRadius: 2,
        label: {
          display: true,
          content: (it.completedAt != null ? '\u2714 ' : it.startedAt != null ? '\u25B6 ' : '') + (it.title.length > 30 ? it.title.slice(0, 28) + '\u2026' : it.title),
          position: 'start',
          color: barColor,
          font: { size: 8 },
          padding: { left: 2, top: 0, bottom: 0, right: 0 },
        },
      };
    }
  }

  const utilData = s.tokenCurve.map(t => t == null ? null : Math.round((t / ctxWindow) * 1000) / 10);
  const queries = s.requestQueries;

  // Color-coded gradient fill (same green/yellow/red zones as trend chart)
  const canvas = document.getElementById(chartId) as HTMLCanvasElement | null;
  let gradientFill: CanvasGradient | string = 'rgba(88,166,255,0.08)';
  if (canvas) {
    gradientFill = buildContextGradient(canvas, thresholds);
  }

  // Point colors per data point based on zone (null entries default to muted)
  const pointColors = utilData.map(v => v == null ? 'transparent' : contextColor(v, thresholds));

  createChart(chartId, 'line', {
    labels: utilData.map((_, i) => `R${i + 1}`),
    datasets: [{
      label: 'Utilization %',
      data: utilData,
      borderColor: COLORS.blue,
      backgroundColor: gradientFill,
      fill: true,
      tension: 0.3,
      pointRadius: 3,
      pointHoverRadius: 5,
      pointBackgroundColor: pointColors,
      pointBorderColor: pointColors,
      // Bridge requests that lack native token data so the trend reads as a
      // continuous line. Missing points stay invisible (transparent point
      // colors) so users can still see *where* data is missing — but the
      // line keeps flowing across them rather than fragmenting the chart.
      spanGaps: true,
    }],
  }, {
    interaction: { mode: 'index', intersect: false },
    scales: {
      y: {
        beginAtZero: true,
        max: 100,
        title: { display: true, text: 'Utilization %', color: '#8b949e' },
        ticks: { color: '#8b949e' },
        grid: { color: 'rgba(48,54,61,0.6)' },
        afterFit: alignSessionChartAxis,
      },
      x: {
        // Offset like the bar chart below so request N lines up in both charts.
        offset: true,
        ticks: { color: '#8b949e', maxRotation: 0 },
        grid: { color: 'rgba(48,54,61,0.3)' },
      },
    },
    plugins: {
      legend: { display: false },
      annotation: { annotations },
      tooltip: {
        callbacks: {
          title: (items: { dataIndex: number }[]) => {
            if (items.length === 0) return '';
            const i = items[0].dataIndex;
            return `Request ${i + 1}`;
          },
          afterTitle: (items: { dataIndex: number }[]) => {
            if (items.length === 0) return '';
            const i = items[0].dataIndex;
            const q = queries[i];
            return q ? q : '';
          },
          label: (item: { parsed: { y: number | null }; dataIndex: number }) => {
            const val = item.parsed.y;
            const tokens = s.tokenCurve[item.dataIndex];
            if (val == null || tokens == null) return 'no token data';
            const zone = val >= thresholds.limitedUtilization ? 'limited' : val >= thresholds.optimalUtilization ? 'degraded' : 'optimal';
            return `${val.toFixed(1)}% (${formatNum(tokens)} tokens) — ${zone}`;
          },
        },
      },
    },
  });
}

function renderTips(tips: string[]): ComponentChildren {
  if (tips.length === 0) return null;
  return html`
    <div style="margin:16px 0;padding:14px 16px;border-radius:8px;background:rgba(88,166,255,0.06);border:1px solid rgba(88,166,255,0.2);">
      <div style="font-weight:600;font-size:13px;margin-bottom:8px;color:${COLORS.blue};">Insights</div>
      ${tips.map(t => html`<div style="font-size:12px;color:var(--text-secondary, #8b949e);line-height:1.5;margin-bottom:4px;">• ${t}</div>`)}
    </div>`;
}

const WS_PAGE_SIZE = 10;

function renderWorkspaceTable(workspaces: WorkspaceContextScore[], page: number, thresholds: ContextVerdictThresholds): ComponentChildren {
  if (workspaces.length === 0) {
    return html`<div style="color:var(--text-muted);font-size:13px;padding:20px;">No workspaces with token data found.</div>`;
  }

  const totalPages = Math.ceil(workspaces.length / WS_PAGE_SIZE);
  const start = page * WS_PAGE_SIZE;
  const pageItems = workspaces.slice(start, start + WS_PAGE_SIZE);

  const utilBar = (pct: number) => {
    const clamp = Math.min(pct, 100);
    const barColor = contextColor(pct, thresholds);
    return html`<div style="display:flex;align-items:center;gap:4px;justify-content:center;">
      <div style=${'width:40px;height:6px;border-radius:3px;background:rgba(48,54,61,0.6);overflow:hidden;'}>
        <div style=${'width:' + clamp + '%;height:100%;border-radius:3px;background:' + barColor + ';'}></div>
      </div>
      <span>${pct.toFixed(1)}%</span>
    </div>`;
  };

  return html`
    <div style="overflow-x:auto;margin:8px 0 4px;">
      <table style="width:100%;border-collapse:collapse;font-size:12px;">
        <thead>
          <tr style="border-bottom:1px solid var(--border-color, #30363d);color:var(--text-muted);">
            <th style="text-align:left;padding:8px 12px;font-weight:600;">Workspace</th>
            <th style="text-align:center;padding:8px 6px;font-weight:600;">Score</th>
            <th style="text-align:center;padding:8px 6px;font-weight:600;">Verdict</th>
            <th style="text-align:right;padding:8px 6px;font-weight:600;" title="Average native prompt tokens per request">Avg Tokens</th>
            <th style="text-align:center;padding:8px 6px;font-weight:600;">Avg Util</th>
            <th style="text-align:center;padding:8px 6px;font-weight:600;">Saturation</th>
            <th style="text-align:center;padding:8px 6px;font-weight:600;">Compactions</th>
            <th style="text-align:right;padding:8px 6px;font-weight:600;">Sessions</th>
          </tr>
        </thead>
        <tbody>
          ${pageItems.map(w => {
            const vc = VERDICT_COLORS[w.verdict] || COLORS.muted;
            const sc = w.score >= 70 ? COLORS.green : w.score >= 40 ? COLORS.yellow : COLORS.red;
            const satColor = w.saturation > 30 ? COLORS.red : w.saturation > 10 ? COLORS.yellow : COLORS.green;
            return html`
              <tr class="ctx-ws-row" data-ws-id=${w.workspaceId} style="border-bottom:1px solid var(--border-color, #30363d);cursor:pointer;transition:background 0.15s;"
                onMouseOver=${(e: Event) => { (e.currentTarget as HTMLElement).style.background = 'rgba(88,166,255,0.06)'; }}
                onMouseOut=${(e: Event) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}>
                <td style=${'padding:8px 12px;font-weight:500;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:' + COLORS.blue + ';'} title=${w.workspaceName}>${w.workspaceName}</td>
                <td style=${'text-align:center;padding:8px 6px;font-weight:700;color:' + sc + ';'}>${w.score}</td>
                <td style="text-align:center;padding:8px 6px;"><span style=${'padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;background:' + vc + '22;color:' + vc + ';text-transform:capitalize;'}>${w.verdict}</span></td>
                <td style="text-align:right;padding:8px 6px;">${formatNum(w.avgPromptTokens)}</td>
                <td style="padding:8px 6px;">${utilBar(w.avgUtilization)}</td>
                <td style=${'text-align:center;padding:8px 6px;color:' + satColor + ';font-weight:' + (w.saturation > 10 ? '600' : '400') + ';'}>${w.saturation.toFixed(1)}%</td>
                <td style=${'text-align:center;padding:8px 6px;' + (w.compactionCount > 0 ? 'color:' + COLORS.yellow + ';font-weight:600;' : '')}>${w.compactionCount}</td>
                <td style="text-align:right;padding:8px 6px;">${w.sessionCount}</td>
              </tr>`;
          })}
        </tbody>
      </table>
    </div>
    ${totalPages > 1 ? html`
      <div style="display:flex;justify-content:center;gap:6px;margin:12px 0 4px;">
        ${Array.from({ length: totalPages }, (_, i) => {
          const active = i === page;
          return html`<button class=${'ctx-ws-page-btn cons-range-btn' + (active ? ' active' : '')} data-pg=${String(i)} style="min-width:32px;padding:4px 8px;font-size:11px;">${i + 1}</button>`;
        })}
      </div>` : null}`;
}

/* ── Session-level inline rows ───────────────────────────────────── */

const SESSION_PAGE_SIZE = 10;

function renderSessionRow(s: SessionContextDetail, ctxWindow: number, idx: number, thresholds: ContextVerdictThresholds): ComponentChildren {
  const vc = VERDICT_COLORS[s.verdict] || COLORS.muted;
  const utilBar = (pct: number) => {
    const clamp = Math.min(pct, 100);
    const barColor = contextColor(pct, thresholds);
    return html`<div style="display:flex;align-items:center;gap:4px;justify-content:center;">
      <div style=${'width:36px;height:5px;border-radius:3px;background:rgba(48,54,61,0.6);overflow:hidden;'}>
        <div style=${'width:' + clamp + '%;height:100%;border-radius:3px;background:' + barColor + ';'}></div>
      </div>
      <span>${pct.toFixed(1)}%</span>
    </div>`;
  };
  const satColor = s.saturation > 30 ? COLORS.red : s.saturation > 10 ? COLORS.yellow : COLORS.green;

  // Event summary icons
  const compEvts = s.events.filter(e => e.type === 'compaction').length;
  const todoEvts = s.events.filter(e => e.type === 'todo-add' || e.type === 'todo-complete').length;
  const evtContent: ComponentChildren = compEvts > 0 || todoEvts > 0
    ? html`<span>${compEvts > 0 ? html`<span style=${'color:' + COLORS.yellow + ';'} title=${compEvts + ' compaction(s)'}>${compEvts}C</span>` : null}${compEvts > 0 && todoEvts > 0 ? ' ' : ''}${todoEvts > 0 ? html`<span style=${'color:' + COLORS.blue + ';'} title=${todoEvts + ' todo event(s)'}>${todoEvts}T</span>` : null}</span>`
    : html`<span style="color:var(--text-muted);">-</span>`;

  const clickable = s.hasPerRequestTokens || s.composition != null;
  const cursorStyle = clickable ? 'cursor:pointer;' : 'cursor:default;opacity:0.85;';
  const sparklineContent = s.hasPerRequestTokens
    ? renderSparkline(s.tokenCurve, s.contextWindow || ctxWindow, thresholds)
    : html`<span style="color:var(--text-muted);font-size:10px;" title="Session-level data only — no per-turn breakdown available">—</span>`;

  const utilContent = s.hasPerRequestTokens
    ? utilBar(s.avgUtilization)
    : html`<span style="color:var(--text-muted);" title="No per-turn token data">—</span>`;
  const satContent = s.hasPerRequestTokens
    ? html`<span style=${'color:' + satColor + ';font-weight:' + (s.saturation > 10 ? '600' : '400') + ';'}>${s.saturation.toFixed(1)}%</span>`
    : html`<span style="color:var(--text-muted);">—</span>`;
  const tokensContent = s.hasPerRequestTokens
    ? formatNum(s.avgPromptTokens)
    : html`<span style="color:var(--text-muted);">—</span>`;

  return html`
    <tr class="ctx-session-row" data-session-idx=${String(idx)} data-clickable=${String(clickable)} style=${'border-bottom:1px solid var(--border-color, #30363d);' + cursorStyle + 'transition:background 0.15s;'}
      onMouseOver=${(e: Event) => { (e.currentTarget as HTMLElement).style.background = 'rgba(88,166,255,0.06)'; }}
      onMouseOut=${(e: Event) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}>
      <td style="padding:6px 10px;white-space:nowrap;">${s.date}</td>
      <td style="padding:6px 6px;max-width:90px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title=${s.harness}>${s.harness}</td>
      <td style="text-align:center;padding:6px 6px;"><span style=${'padding:1px 6px;border-radius:8px;font-size:10px;font-weight:600;background:' + vc + '22;color:' + vc + ';text-transform:capitalize;'}>${s.verdict}</span></td>
      <td style="text-align:right;padding:6px 6px;">${s.requestCount}</td>
      <td style="text-align:right;padding:6px 6px;">${tokensContent}</td>
      <td style="padding:6px 6px;">${utilContent}</td>
      <td style="text-align:center;padding:6px 6px;">${satContent}</td>
      <td style="text-align:center;padding:6px 6px;font-size:10px;">${evtContent}</td>
      <td style="padding:6px 6px;">${sparklineContent}</td>
      <td style="padding:6px 6px;">${compositionMiniBar(s.composition)}</td>
    </tr>`;
}

/** Render an inline SVG sparkline showing token usage across a session's requests.
 *  Null entries (requests with no native token data) are bridged so the curve
 *  reads as continuous — gaps in source data shouldn't visually look like
 *  a request was made with zero tokens. */
    function renderSparkline(tokenCurve: (number | null)[], ctxWindow: number, thresholds: ContextVerdictThresholds): ComponentChildren {
  const validValues = tokenCurve.filter((v): v is number => v != null && v > 0);
  if (validValues.length === 0) return html`<span style="color:var(--text-muted);">-</span>`;

  const width = 80;
  const height = 20;
  const maxVal = Math.max(ctxWindow, ...validValues);
  const step = tokenCurve.length > 1 ? width / (tokenCurve.length - 1) : 0;

  // Project every non-null point to (x, y); skip nulls. Drawing a single
  // polyline through these points bridges across gaps (Chart.js spanGaps
  // equivalent) so the sparkline reads as a continuous trend.
  const points: { x: number; y: number }[] = [];
  for (const [i, v] of tokenCurve.entries()) {
    if (v == null || v <= 0) continue;
    const x = tokenCurve.length === 1 ? width / 2 : i * step;
    const y = height - (v / maxVal) * height;
    points.push({ x, y });
  }
  if (points.length === 0) return html`<span style="color:var(--text-muted);">-</span>`;

  const peakUtil = (Math.max(...validValues) / ctxWindow) * 100;
  const color = contextColor(peakUtil, thresholds);

  const pointsStr = points.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const firstX = points[0].x;
  const lastX = points[points.length - 1].x;
  const fillPath = `M${firstX.toFixed(1)},${height} ${points.map(p => `L${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')} L${lastX.toFixed(1)},${height} Z`;

  return html`<svg width=${width} height=${height} style="vertical-align:middle;" title=${'Token usage across ' + validValues.length + ' of ' + tokenCurve.length + ' requests'}>
    <path d=${fillPath} fill=${color} fill-opacity="0.15"/>
    <polyline points=${pointsStr} fill="none" stroke=${color} stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
  </svg>`;
}
