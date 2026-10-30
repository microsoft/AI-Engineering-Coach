/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Context Composition views for the Context Management tab: what fills the prompt,
 * by category, per harness, workspace, week and session. */

import type {
  CompositionBreakdown,
  CompositionSlice,
  CompositionSource,
  ContextCategory,
  ContextCompositionData,
  DateFilter,
  HarnessComposition,
  SessionCompositionDetail,
  SessionContextDetail,
  WorkspaceContextSessionsData,
} from '../core/types';
import { COLORS, createChart, destroyChartById, formatNum, harnessColor, rpc } from './shared';
import { html, render, unmount, ComponentChildren } from './render';

const GUIDE_URL = 'https://docs.github.com/en/copilot/tutorials/optimize-ai-usage';
export const COMPOSITION_TREND_CHART_ID = 'ctxCompTrendChart';
export const SESSION_COMPOSITION_CHART_ID = 'ctxSessionCompositionChart';

/** Give the session token chart and the per-request composition chart the same y-axis width so requests line up. */
export function alignSessionChartAxis(scale: { width: number }): void {
  scale.width = 56;
}

const CATEGORY_ORDER: ContextCategory[] = ['systemInstructions', 'toolDefinitions', 'messages', 'toolResults', 'files', 'conversation', 'other'];

const CATEGORY_META: Record<ContextCategory, { label: string; color: string; help: string }> = {
  systemInstructions: { label: 'System instructions', color: COLORS.purple, help: 'The built-in system prompt plus always-on instructions such as copilot-instructions.md, AGENTS.md and memory.' },
  toolDefinitions: { label: 'Tool definitions', color: COLORS.orange, help: 'The schema of every tool offered to the model, including MCP server tools. Sent with every model call.' },
  messages: { label: 'Messages', color: COLORS.blue, help: 'Your prompts and the assistant\u2019s replies (VS Code).' },
  toolResults: { label: 'Tool results', color: COLORS.green, help: 'Output returned by tool calls: file reads, searches, terminal output (VS Code).' },
  files: { label: 'Files', color: COLORS.cyan, help: 'Attached files and editor context (VS Code).' },
  conversation: { label: 'Conversation', color: COLORS.yellow, help: 'Messages, tool results and files together. Copilot CLI does not split them.' },
  other: { label: 'Other / unattributed', color: COLORS.muted, help: 'Categories the harness added that are not recognized yet, or tokens it did not attribute to a category.' },
};

const SOURCE_HELP: Record<CompositionSource, string> = {
  vscode: 'VS Code Copilot Chat reports the share of each category for the last model call of every request (promptTokenDetails). Token estimates use that call\u2019s prompt size.',
  'copilot-cli': 'Copilot CLI counts tool-definition tokens on every main-agent model call. The system-prompt size comes from usage checkpoints, and the rest of the prompt is the conversation. Sub-agent calls are left out.',
};

const NO_DATA_HELP: Record<CompositionSource, string> = {
  vscode: 'No request in this range recorded a breakdown. Recent VS Code Copilot Chat builds record it; older builds don\u2019t.',
  'copilot-cli': 'No turn in this range recorded per-call usage. Recent Copilot CLI builds record it; older builds don\u2019t.',
};

const PARTIAL_HELP: Record<CompositionSource, string> = {
  vscode: 'Requests from older VS Code Copilot Chat builds have no breakdown.',
  'copilot-cli': 'Turns from older Copilot CLI builds have no per-call usage.',
};

const NOT_REPORTED_HELP = 'This harness does not record what fills its prompt, so nothing is shown. Nothing is estimated.';
const SESSION_NOT_REPORTED_HELP = 'No composition recorded for this session. Claude Code, Codex, OpenCode and Xcode don\u2019t report it, and older VS Code and Copilot CLI builds didn\u2019t record it.';

function pctText(pct: number): string {
  return pct >= 10 || pct === 0 ? `${Math.round(pct)}%` : `${pct.toFixed(1)}%`;
}

function countText(n: number, noun: string): string {
  return `${formatNum(n)} ${noun}${n === 1 ? '' : 's'}`;
}

function sliceTip(slice: CompositionSlice, unit: string): string {
  const tokens = slice.tokens == null ? '' : ` \u00b7 \u2248${formatNum(slice.tokens)} tokens${unit}`;
  return `${CATEGORY_META[slice.category].label}: ${pctText(slice.pct)}${tokens}`;
}

function describeSlices(slices: CompositionSlice[]): string {
  return slices.map(slice => `${CATEGORY_META[slice.category].label} ${pctText(slice.pct)}`).join(', ');
}

function shareOf(breakdown: CompositionBreakdown | null | undefined, category: ContextCategory): number | null {
  return breakdown?.slices.find(slice => slice.category === category)?.pct ?? null;
}

/** 100% stacked bar. Segments carry hover tooltips; the bar itself carries the text equivalent.
 *  Pass `focusable: false` when the bar sits inside another control. */
function compositionBar(slices: CompositionSlice[], label: string, opts: { height?: number; labels?: boolean; unit?: string; focusable?: boolean } = {}): ComponentChildren {
  const visible = slices.filter(slice => slice.pct > 0);
  const unit = opts.unit ?? ' per request';
  return html`<div class="ctx-comp-bar" role="img" tabindex=${opts.focusable === false ? undefined : 0} aria-label=${`${label}: ${describeSlices(slices)}`} style=${`height:${opts.height ?? 18}px;`}>
    ${visible.map((slice, i) => html`<div class=${'ctx-comp-seg' + (i === 0 ? ' first' : '') + (i === visible.length - 1 ? ' last' : '')}
      data-category=${slice.category} data-tip=${sliceTip(slice, unit)}
      style=${`width:${slice.pct}%;background:${CATEGORY_META[slice.category].color};`}>
      ${opts.labels !== false && slice.pct >= 9 ? html`<span class="ctx-comp-seg-label">${Math.round(slice.pct)}%</span>` : null}
    </div>`)}
  </div>`;
}

function infoTip(text: string, label: string): ComponentChildren {
  return html`<span class="info-icon" tabindex="0" role="button" aria-label=${label}>${'\u24d8'}<span class="info-popup">${text}</span></span>`;
}

function legend(categories: ContextCategory[]): ComponentChildren {
  return html`<ul class="ctx-comp-legend" aria-label="Composition categories">
    ${categories.map(category => html`<li data-tip=${CATEGORY_META[category].help} tabindex="0" aria-label=${`${CATEGORY_META[category].label}: ${CATEGORY_META[category].help}`}>
      <span class="ctx-comp-swatch" style=${`background:${CATEGORY_META[category].color};`}></span>${CATEGORY_META[category].label}
    </li>`)}
  </ul>`;
}

function categoriesIn(breakdowns: (CompositionBreakdown | null | undefined)[]): ContextCategory[] {
  const present = new Set<ContextCategory>();
  for (const breakdown of breakdowns) for (const slice of breakdown?.slices ?? []) present.add(slice.category);
  return CATEGORY_ORDER.filter(category => present.has(category));
}

function kpiChip(label: string, value: string, tip: string, sub?: string): ComponentChildren {
  return html`<div class="ctx-comp-kpi" data-tip=${tip} tabindex="0" aria-label=${`${label}: ${value}${sub ? `, ${sub}` : ''}. ${tip}`}>
    <div class="ctx-comp-kpi-value">${value}</div>
    <div class="ctx-comp-kpi-label">${label}</div>
    ${sub ? html`<div class="ctx-comp-kpi-sub">${sub}</div>` : null}
  </div>`;
}

function kpis(data: ContextCompositionData): ComponentChildren {
  const chips: ComponentChildren[] = [];
  const tools = shareOf(data.overall, 'toolDefinitions');
  if (tools != null) {
    chips.push(kpiChip('Tool definitions', pctText(tools), 'Share of prompt tokens spent on tool definitions, across every harness that reports composition (weighted by prompt size).'));
  }
  const heavyRows = data.harnesses.filter(h => h.toolHeavyPct != null && h.requestsWithData > 0);
  const heavySamples = heavyRows.reduce((sum, h) => sum + h.requestsWithData, 0);
  if (heavySamples > 0) {
    const heavy = heavyRows.reduce((sum, h) => sum + (h.toolHeavyPct ?? 0) * h.requestsWithData, 0) / heavySamples;
    chips.push(kpiChip(`Requests \u2265${data.toolHeavyThreshold}% tools`, pctText(heavy), `Share of requests whose prompt is at least ${data.toolHeavyThreshold}% tool definitions.`));
  }
  const cli = data.harnesses.find(h => h.avgToolDefinitionTokens != null);
  if (cli?.avgToolDefinitionTokens != null) {
    chips.push(kpiChip('Tool tokens per call', formatNum(cli.avgToolDefinitionTokens),
      `Average tool-definition tokens sent with every ${cli.harness} model call.`,
      cli.maxAvailableTools == null ? cli.harness : `up to ${cli.maxAvailableTools} tools \u00b7 ${cli.harness}`));
  }
  const { requestsWithData, totalRequests } = data.coverage;
  const coverage = totalRequests > 0 ? (requestsWithData / totalRequests) * 100 : 0;
  const missing = data.harnesses.filter(h => h.source == null).map(h => h.harness);
  chips.push(kpiChip('Coverage', pctText(coverage),
    `${formatNum(requestsWithData)} of ${formatNum(totalRequests)} requests in range carry composition data.${missing.length > 0 ? ` Not reported by: ${missing.join(', ')}.` : ''}`,
    `${formatNum(requestsWithData)} of ${formatNum(totalRequests)} requests`));
  return html`<div class="ctx-comp-kpis">${chips}</div>`;
}

function harnessRow(h: HarnessComposition, index: number): ComponentChildren {
  const name = html`<div class="ctx-comp-harness" style=${`border-left-color:${harnessColor(h.harness, index)};`}>
    <span class="ctx-comp-harness-name" title=${h.harness}>${h.harness}</span>
    ${h.source ? infoTip(SOURCE_HELP[h.source], `How ${h.harness} reports composition`) : null}
  </div>`;
  if (h.source == null) {
    return html`<div class="ctx-comp-row ctx-comp-row-muted" data-harness=${h.harness}>${name}
      <div class="ctx-comp-empty" data-tip=${NOT_REPORTED_HELP} tabindex="0">Not reported by this harness</div>
      <div class="ctx-comp-meta">${countText(h.totalRequests, 'request')}</div>
    </div>`;
  }
  if (!h.breakdown) {
    return html`<div class="ctx-comp-row ctx-comp-row-muted" data-harness=${h.harness}>${name}
      <div class="ctx-comp-empty" data-tip=${NO_DATA_HELP[h.source]} tabindex="0">No composition recorded in this range</div>
      <div class="ctx-comp-meta">${countText(h.totalRequests, 'request')}</div>
    </div>`;
  }
  const coverage = h.totalRequests > 0 ? (h.requestsWithData / h.totalRequests) * 100 : 0;
  const partial = h.requestsWithData < h.totalRequests;
  const unit = h.source === 'copilot-cli' ? ' per call' : ' per request';
  const noun = h.source === 'copilot-cli' ? 'turns' : 'requests';
  const partialTip = `${formatNum(h.totalRequests - h.requestsWithData)} ${noun} in range have no composition data. ${PARTIAL_HELP[h.source]}`;
  return html`<div class="ctx-comp-row" data-harness=${h.harness}>${name}
    ${compositionBar(h.breakdown.slices, `${h.harness} prompt composition`, { unit })}
    <div class="ctx-comp-meta">
      ${h.breakdown.avgPromptTokens == null ? null : html`<span title="Average prompt size">\u2248${formatNum(h.breakdown.avgPromptTokens)} tokens${unit}</span>`}
      <span class=${partial ? 'ctx-comp-partial' : ''} data-tip=${partial ? partialTip : undefined} tabindex=${partial ? 0 : undefined}>
        ${formatNum(h.requestsWithData)} of ${formatNum(h.totalRequests)} ${noun}${partial ? ` (${pctText(coverage)})` : ''}
      </span>
    </div>
  </div>`;
}

function workspaceList(data: ContextCompositionData): ComponentChildren {
  if (data.workspaces.length === 0) return html`<div class="ctx-comp-note">No workspace has composition data in this range.</div>`;
  return html`<div class="ctx-comp-ws-list">
    ${data.workspaces.map((w, i) => {
      const tools = shareOf(w.breakdown, 'toolDefinitions');
      const panelId = `ctxCompWsSessions${i}`;
      return html`<div class="ctx-comp-ws" data-workspace=${w.workspaceName}>
        <div class="ctx-comp-ws-head">
          <span class="ctx-comp-ws-name" title=${w.workspaceName}>${w.workspaceName}</span>
          <span class="ctx-comp-ws-stat">${tools == null ? '' : `${pctText(tools)} tools \u00b7 `}${formatNum(w.breakdown.samples)} req</span>
          <button type="button" class="ctx-comp-ws-toggle" aria-expanded="false" aria-controls=${panelId}
            aria-label=${`Show sessions for ${w.workspaceName}`}>Sessions</button>
        </div>
        ${compositionBar(w.breakdown.slices, `${w.workspaceName} prompt composition (${w.harnesses.join(', ')})`, { height: 10, labels: false })}
        <div class="ctx-comp-ws-sessions" id=${panelId} hidden></div>
      </div>`;
    })}
  </div>`;
}

function segmentList(data: ContextCompositionData): ComponentChildren {
  if (data.systemSegments.length === 0) return null;
  // Bars show each segment's overall weight (size × sessions), matching the list order.
  const maxWeight = Math.max(...data.systemSegments.map(segment => segment.avgTokens * segment.sessions));
  return html`<div class="ctx-comp-segments">
    <div class="chart-title">Copilot CLI system prompt ${infoTip('Size of each part of the Copilot CLI system prompt (the GitHub Copilot App uses the same one), from the latest usage checkpoint of each session. Bars show the overall weight across sessions; numbers show the size when the segment is present. custom_instructions holds your instruction files, memory your stored memories, and tool_instructions the built-in tool guidance.', 'About the Copilot CLI system prompt')}</div>
    <ol class="ctx-comp-segment-list">
      ${data.systemSegments.slice(0, 8).map(segment => {
        const tip = `${segment.name}: about ${formatNum(segment.avgTokens)} tokens, in ${segment.sessions} of ${data.systemSegmentSessions} sessions`;
        return html`<li aria-label=${tip} data-tip=${tip}>
          <code>${segment.name}</code>
          <span class="ctx-comp-segment-bar"><span style=${`width:${Math.max(2, ((segment.avgTokens * segment.sessions) / maxWeight) * 100)}%;`}></span></span>
          <span class="ctx-comp-segment-tokens">\u2248${formatNum(segment.avgTokens)}</span>
          <span class="ctx-comp-segment-sessions">${segment.sessions}/${data.systemSegmentSessions}</span>
        </li>`;
      })}
    </ol>
  </div>`;
}

function openGuide(event: Event): void {
  event.preventDefault();
  void rpc('openExternal', { url: GUIDE_URL }).catch(() => undefined);
}

/** The Context Composition section of the Context Management tab. */
export function renderCompositionSection(data: ContextCompositionData): ComponentChildren {
  const reporting = data.harnesses.filter(h => h.breakdown != null);
  const weighting = data.overall?.weighting === 'requests'
    ? 'Each request counts equally because prompt sizes were not recorded.'
    : 'Shares are weighted by prompt size, so larger prompts count more.';
  return html`<section class="ctx-comp" id="ctxComposition" aria-labelledby="ctxCompositionTitle">
    <h3 id="ctxCompositionTitle" style="margin-top:24px;">Context Composition
      ${infoTip('What fills your prompts, by category, as each harness reports it. VS Code splits the conversation into messages, tool results and files; Copilot CLI reports it as one conversation bucket. Claude Code, Codex, OpenCode and Xcode don\u2019t report it. Only category names and token counts are read, never prompt text.', 'About context composition')}
    </h3>
    <p class="ctx-comp-intro">What fills your prompts, by category. ${weighting}</p>
    ${data.overall == null
      ? html`<div class="ctx-comp-note">No request in this range carries composition data. Recent VS Code Copilot Chat and Copilot CLI builds record it.</div>`
      : html`${kpis(data)}${legend(categoriesIn(reporting.map(h => h.breakdown)))}`}
    <div class="ctx-comp-rows" aria-label="Prompt composition by harness">
      ${data.harnesses.map((h, i) => harnessRow(h, i))}
    </div>
    ${data.overall == null ? null : html`<div class="two-col ctx-comp-detail">
      <div class="chart-wrap">
        <div class="chart-title">Tool-definition share by week ${infoTip('Weekly share of prompt tokens spent on tool definitions, per harness. Watch it drop after you disable MCP servers or switch to smaller tool sets.', 'About the tool-definition trend')}</div>
        ${data.trend.labels.length > 1
          ? html`<div style="position:relative;height:200px;"><canvas id=${COMPOSITION_TREND_CHART_ID} role="img" aria-label="Weekly tool-definition share per harness"></canvas></div>`
          : html`<div class="ctx-comp-note">Not enough weekly data for a trend yet.</div>`}
      </div>
      <div class="chart-wrap">
        <div class="chart-title">By workspace</div>
        ${workspaceList(data)}
      </div>
    </div>`}
    ${segmentList(data)}
    <a class="ctx-comp-guide" href=${GUIDE_URL} onClick=${openGuide}>Keep your context lean: GitHub\u2019s guide to optimizing AI usage \u2192</a>
  </section>`;
}

/** Draw the weekly tool-definition share chart after the section is in the DOM. */
export function renderCompositionTrendChart(data: ContextCompositionData): void {
  destroyChartById(COMPOSITION_TREND_CHART_ID);
  if (data.trend.labels.length <= 1 || !document.getElementById(COMPOSITION_TREND_CHART_ID)) return;
  const series = data.trend.series.filter(s => s.toolDefinitions.some(v => v != null));
  createChart(COMPOSITION_TREND_CHART_ID, 'line', {
    labels: data.trend.labels,
    datasets: series.map((s, i) => ({
      label: s.harness,
      data: s.toolDefinitions,
      borderColor: harnessColor(s.harness, i),
      backgroundColor: harnessColor(s.harness, i) + '22',
      tension: 0.3,
      spanGaps: true,
      pointRadius: 3,
    })),
  }, {
    interaction: { mode: 'index', intersect: false },
    scales: {
      y: { beginAtZero: true, max: 100, title: { display: true, text: 'Tool definitions %', color: '#8b949e' }, ticks: { color: '#8b949e' }, grid: { color: 'rgba(48,54,61,0.6)' } },
      x: { ticks: { color: '#8b949e', maxRotation: 45 }, grid: { color: 'rgba(48,54,61,0.3)' } },
    },
    plugins: {
      legend: { position: 'top', labels: { boxWidth: 10 } },
      tooltip: {
        callbacks: {
          label: (item: { datasetIndex: number; dataIndex: number; parsed: { y: number | null } }) => {
            const s = series[item.datasetIndex];
            if (!s || item.parsed.y == null) return '';
            const system = s.systemInstructions[item.dataIndex];
            return `${s.harness}: tools ${pctText(item.parsed.y)}${system == null ? '' : ` \u00b7 system ${pctText(system)}`} \u00b7 ${s.samples[item.dataIndex]} requests`;
          },
        },
      },
    },
  });
}

/** Small stacked bar for the session table; a dash when the harness reports nothing. */
export function compositionMiniBar(detail: SessionCompositionDetail | undefined, focusable = true): ComponentChildren {
  if (!detail?.breakdown) {
    const tip = detail ? 'No per-turn composition recorded; expand for system prompt and compaction details.' : SESSION_NOT_REPORTED_HELP;
    return html`<span class="ctx-comp-dash" data-tip=${tip} tabindex=${focusable ? 0 : undefined} aria-label=${tip}>\u2014</span>`;
  }
  return html`<div class="ctx-comp-mini">${compositionBar(detail.breakdown.slices, 'Session prompt composition', { height: 8, labels: false, focusable })}</div>`;
}

function sessionLegend(slices: CompositionSlice[], unit: string): ComponentChildren {
  return html`<ul class="ctx-comp-values">
    ${slices.map(slice => html`<li><span class="ctx-comp-swatch" style=${`background:${CATEGORY_META[slice.category].color};`}></span>${CATEGORY_META[slice.category].label} <strong>${pctText(slice.pct)}</strong>${slice.tokens == null ? null : html`<span class="ctx-comp-tokens"> \u2248${formatNum(slice.tokens)}${unit}</span>`}</li>`)}
  </ul>`;
}

function formatWhen(ts: number | null): string {
  return ts == null ? 'Compaction' : new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Composition panel shown when a session row is expanded. */
export function renderSessionCompositionPanel(s: SessionContextDetail, chartId = SESSION_COMPOSITION_CHART_ID): ComponentChildren {
  const detail = s.composition;
  if (!detail) return null;
  const unit = detail.source === 'copilot-cli' ? ' per call' : ' per request';
  const hasPerRequest = detail.perRequest.some(entry => entry != null);
  return html`<div class="ctx-comp-session" data-session-composition=${s.sessionId}>
    <div class="ctx-comp-session-title">Prompt composition ${infoTip(SOURCE_HELP[detail.source], 'How this session\u2019s composition was measured')}</div>
    ${detail.breakdown ? html`
      ${compositionBar(detail.breakdown.slices, 'Session prompt composition', { unit })}
      ${sessionLegend(detail.breakdown.slices, unit)}` : null}
    ${hasPerRequest ? html`<div class="ctx-comp-session-chart"><canvas id=${chartId} role="img" aria-label="Prompt composition per request, 100% stacked"></canvas></div>` : null}
    ${detail.systemSegments.length > 0 ? html`<div class="ctx-comp-session-sub">
      <div class="ctx-comp-session-title">System prompt (latest checkpoint)${detail.toolCount == null ? '' : ` \u00b7 ${detail.toolCount} tools sent${detail.toolTokens == null ? '' : `, \u2248${formatNum(detail.toolTokens)} tokens`}`}</div>
      <ul class="ctx-comp-values">${detail.systemSegments.map(segment => html`<li><code>${segment.name}</code> <strong>\u2248${formatNum(segment.tokens)}</strong></li>`)}</ul>
    </div>` : null}
    ${detail.compactions.length > 0 ? html`<div class="ctx-comp-session-sub">
      <div class="ctx-comp-session-title">Context when compaction started</div>
      ${detail.compactions.map(snapshot => html`<div class="ctx-comp-snapshot">
        <div class="ctx-comp-snapshot-head">${formatWhen(snapshot.timestamp)} \u00b7 ${formatNum(snapshot.currentTokens)}${snapshot.tokenLimit == null ? '' : ` of ${formatNum(snapshot.tokenLimit)} tokens (${pctText((snapshot.currentTokens / snapshot.tokenLimit) * 100)})`}</div>
        ${compositionBar(snapshot.slices, 'Context at compaction', { height: 12, unit: '' })}
      </div>`)}
    </div>` : null}
  </div>`;
}

/** Per-request 100% stacked bars, aligned with the token curve (R1..Rn). */
export function renderSessionCompositionChart(s: SessionContextDetail, chartId = SESSION_COMPOSITION_CHART_ID): void {
  destroyChartById(chartId);
  const detail = s.composition;
  if (!detail || !document.getElementById(chartId)) return;
  const categories = CATEGORY_ORDER.filter(category => detail.perRequest.some(entry => (entry?.[category] ?? 0) > 0));
  createChart(chartId, 'bar', {
    labels: detail.perRequest.map((_, i) => `R${i + 1}`),
    datasets: categories.map(category => ({
      label: CATEGORY_META[category].label,
      data: detail.perRequest.map(entry => entry?.[category] ?? null),
      backgroundColor: CATEGORY_META[category].color,
      borderWidth: 0,
      barPercentage: 0.9,
      categoryPercentage: 1,
    })),
  }, {
    interaction: { mode: 'index', intersect: false },
    scales: {
      x: { stacked: true, ticks: { color: '#8b949e', maxRotation: 0, autoSkip: true }, grid: { display: false } },
      y: {
        stacked: true, beginAtZero: true, max: 100,
        title: { display: true, text: 'Share %', color: '#8b949e' },
        ticks: { color: '#8b949e' },
        grid: { color: 'rgba(48,54,61,0.4)' },
        afterFit: alignSessionChartAxis,
      },
    },
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          title: (items: { dataIndex: number }[]) => items.length > 0 ? `Request ${items[0].dataIndex + 1}` : '',
          afterTitle: (items: { dataIndex: number }[]) => items.length > 0 ? (s.requestQueries[items[0].dataIndex] ?? '') : '',
          label: (item: { dataset: { label?: string }; parsed: { y: number | null } }) => item.parsed.y == null ? '' : `${item.dataset.label ?? ''}: ${pctText(item.parsed.y)}`,
        },
      },
    },
  });
}

const WORKSPACE_SESSION_CHART_ID = 'ctxCompWsSessionChart';
const MAX_DRILLDOWN_SESSIONS = 10;

function hasSessionComposition(s: SessionContextDetail): boolean {
  const detail = s.composition;
  return detail != null && (detail.breakdown != null || detail.systemSegments.length > 0 || detail.compactions.length > 0);
}

function renderWorkspaceSessions(panel: HTMLElement, sessions: SessionContextDetail[], total: number, selected: string | null): void {
  destroyChartById(WORKSPACE_SESSION_CHART_ID);
  const select = (id: string) => renderWorkspaceSessions(panel, sessions, total, id === selected ? null : id);
  render(sessions.length === 0
    ? html`<div class="ctx-comp-note">No session in this workspace has composition data in this range.</div>`
    : html`<ul class="ctx-comp-ws-session-list" aria-label="Sessions with composition data">
      ${sessions.map(s => html`<li>
        <button type="button" class="ctx-comp-ws-session" data-session-id=${s.sessionId} aria-expanded=${String(s.sessionId === selected)} onClick=${() => select(s.sessionId)}>
          <span>${s.date}</span>
          <span class="ctx-comp-ws-session-harness">${s.harness}</span>
          <span>${countText(s.requestCount, 'request')}</span>
          ${compositionMiniBar(s.composition, false)}
        </button>
        ${s.sessionId === selected ? renderSessionCompositionPanel(s, WORKSPACE_SESSION_CHART_ID) : null}
      </li>`)}
      ${total > sessions.length ? html`<li class="ctx-comp-note">Showing the ${sessions.length} most recent of ${total} sessions.</li>` : null}
    </ul>`, panel);
  const current = sessions.find(s => s.sessionId === selected);
  if (current) renderSessionCompositionChart(current, WORKSPACE_SESSION_CHART_ID);
}

function closeWorkspacePanels(toggles: HTMLButtonElement[]): void {
  destroyChartById(WORKSPACE_SESSION_CHART_ID);
  for (const toggle of toggles) {
    toggle.setAttribute('aria-expanded', 'false');
    const panel = toggle.closest('.ctx-comp-ws')?.querySelector<HTMLElement>('.ctx-comp-ws-sessions');
    if (!panel) continue;
    unmount(panel);
    panel.hidden = true;
  }
}

/** Wire the workspace "Sessions" buttons to an inline per-session drill-down. This also reaches
 *  Copilot CLI workspaces, which the utilization table omits because they lack per-request tokens. */
export function attachCompositionDrilldown(root: HTMLElement, filter: DateFilter): void {
  const toggles = [...root.querySelectorAll<HTMLButtonElement>('.ctx-comp-ws-toggle')];
  for (const toggle of toggles) {
    toggle.addEventListener('click', () => {
      const workspace = toggle.closest<HTMLElement>('.ctx-comp-ws');
      const panel = workspace?.querySelector<HTMLElement>('.ctx-comp-ws-sessions');
      if (!workspace || !panel) return;
      const wasOpen = toggle.getAttribute('aria-expanded') === 'true';
      closeWorkspacePanels(toggles);
      if (wasOpen) return;
      toggle.setAttribute('aria-expanded', 'true');
      panel.hidden = false;
      render(html`<div class="ctx-comp-note">Loading sessions\u2026</div>`, panel);
      void rpc<WorkspaceContextSessionsData>('getWorkspaceContextSessions', { workspaceId: workspace.dataset.workspace, filter })
        .then(data => {
          if (toggle.getAttribute('aria-expanded') !== 'true') return;
          const sessions = data.sessions.filter(hasSessionComposition);
          renderWorkspaceSessions(panel, sessions.slice(0, MAX_DRILLDOWN_SESSIONS), sessions.length, null);
        })
        .catch(() => render(html`<div class="ctx-comp-note">Could not load sessions.</div>`, panel));
    });
  }
}
