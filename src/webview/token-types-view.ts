/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Sections of the Token Types tab: reasoning share, compaction overhead, sub-agent tokens, truncated
 * calls and model-call latency for one source, plus what each harness reports. A type a source
 * doesn't log is shown as "Not reported", never as zero. */

import type {
  HarnessTokenTypes,
  LatencyByModel,
  ReasoningByEffort,
  SessionTokenTypes,
  SourceTokenTypes,
  TokenTypeAvailability,
  TokenTypeKey,
  TokenTypesCompaction,
  TokenTypesReasoning,
  TokenTypesSubagents,
  TokenTypesTruncation,
} from '../core/types';
import { formatNum } from './shared';
import { html, type ComponentChildren } from './render';

export const TOKEN_TYPE_META: Record<TokenTypeKey, { label: string; help: string }> = {
  reasoning: { label: 'Reasoning', help: 'Tokens the model spent thinking before it answered. They are part of the output tokens and billed as output.' },
  compaction: { label: 'Compaction', help: 'When the context fills up, the agent summarizes the conversation. The summarizing call itself reads the whole context. The share counts turns that log per-call usage.' },
  subagents: { label: 'Sub-agents', help: 'Agents your main agent delegated work to. Their transcripts stay out of your main context, but their tokens still count. The share counts turns that log per-call usage.' },
  truncation: { label: 'Truncated calls', help: 'Model calls that stopped because they hit the output-token limit, so the answer was cut off.' },
  latency: { label: 'Latency', help: 'Time until the model sent its first token, and how long each model call took.' },
};

const TOKEN_TYPES: TokenTypeKey[] = ['reasoning', 'compaction', 'subagents', 'truncation', 'latency'];

const AVAILABILITY_TEXT: Record<TokenTypeAvailability, string> = {
  reported: '\u2713 Reported',
  'not-reported': '\u2014 Not reported',
  'not-comparable': '\u2248 Not comparable',
};

const AVAILABILITY_HELP: Record<TokenTypeAvailability, string> = {
  reported: 'This harness logs it.',
  'not-reported': 'This harness does not log it, so nothing is shown and nothing is estimated.',
  'not-comparable': 'This harness logs it, but what it counts differs by model provider, so it is not compared.',
};

export function pctText(pct: number): string {
  return pct >= 10 || pct === 0 ? `${Math.round(pct)}%` : `${pct.toFixed(1)}%`;
}

export function durationText(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)} min`;
  return `${(ms / 3_600_000).toFixed(1)} h`;
}

export function infoTip(text: string, label: string): ComponentChildren {
  return html`<span class="info-icon" tabindex="0" role="button" aria-label=${label}>${'\u24d8'}<span class="info-popup">${text}</span></span>`;
}

function chip(key: TokenTypeKey, value: string | null, sub: string): ComponentChildren {
  const meta = TOKEN_TYPE_META[key];
  const shown = value ?? 'Not reported';
  return html`<div class=${'ctx-tt-kpi' + (value == null ? ' muted' : '')} data-type=${key} data-tip=${meta.help} tabindex="0"
    aria-label=${`${meta.label}: ${shown}${value == null ? '' : `, ${sub}`}. ${meta.help}`}>
    <div class="ctx-tt-kpi-value">${shown}</div>
    <div class="ctx-tt-kpi-label">${meta.label}</div>
    ${value == null ? null : html`<div class="ctx-tt-kpi-sub">${sub}</div>`}
  </div>`;
}

/** The main-agent model with the most calls, for the latency chip. */
function busiestModel(latency: LatencyByModel[] | null): LatencyByModel | null {
  return latency?.length ? [...latency].sort((a, b) => b.calls - a.calls)[0] : null;
}

export function renderKpis(source: SourceTokenTypes): ComponentChildren {
  const reasoning = source.reasoning?.main ?? null;
  const compaction = source.compaction;
  const subagents = source.subagents;
  const truncation = source.truncation;
  const latency = busiestModel(source.latency);
  return html`<div class="ctx-tt-kpis" role="group" aria-label=${`${source.label} token types`}>
    ${chip('reasoning', reasoning?.sharePct == null ? null : pctText(reasoning.sharePct), 'of output tokens')}
    ${chip('compaction', compaction == null ? null : compaction.shareOfMainInputPct == null ? String(compaction.count) : pctText(compaction.shareOfMainInputPct),
      compaction?.shareOfMainInputPct == null ? 'compactions' : 'of main-agent input')}
    ${chip('subagents', subagents == null ? null : subagents.shareOfAllTokensPct == null ? formatNum(subagents.totalTokens) : pctText(subagents.shareOfAllTokensPct),
      subagents?.shareOfAllTokensPct == null ? `tokens in ${subagents?.runs ?? 0} runs` : 'of all tokens')}
    ${chip('truncation', truncation == null ? null : String(truncation.truncatedCalls), truncation ? `of ${formatNum(truncation.calls)} calls` : '')}
    ${chip('latency', latency?.ttftP50Ms == null ? null : durationText(latency.ttftP50Ms), latency ? `first token, median, ${latency.model}` : '')}
  </div>`;
}

function bar(label: string, pct: number, value: string, tip: string): ComponentChildren {
  return html`<li class="ctx-tt-bar" data-tip=${tip} tabindex="0" aria-label=${`${label}: ${value}`}>
    <span class="ctx-tt-bar-label">${label}</span>
    <span class="ctx-tt-bar-track"><span class="ctx-tt-bar-fill" style=${`width:${Math.max(0, Math.min(100, pct))}%;`}></span></span>
    <span class="ctx-tt-bar-value">${value}</span>
  </li>`;
}

function effortRow(row: ReasoningByEffort): ComponentChildren {
  const label = `${row.effort === 'unknown' ? 'Effort not logged' : row.effort} \u00b7 ${row.stream === 'main' ? 'main agent' : 'sub-agents'}`;
  const share = row.sharePct ?? 0;
  return bar(label, share, `${pctText(share)} \u00b7 ${formatNum(row.calls)} calls`,
    `${formatNum(row.reasoningTokens)} of ${formatNum(row.outputTokens)} output tokens were reasoning`);
}

export function renderReasoning(reasoning: TokenTypesReasoning | null): ComponentChildren {
  if (!reasoning) return null;
  const main = reasoning.main;
  return html`<section class="ctx-tt-section" aria-labelledby="ctxTtReasoning">
    <h4 id="ctxTtReasoning">Reasoning share of output ${infoTip(TOKEN_TYPE_META.reasoning.help, 'About reasoning tokens')}</h4>
    ${main?.sharePct == null ? null : html`<p class="ctx-tt-line">${pctText(main.sharePct)} of ${formatNum(main.outputTokens)} main-agent output tokens were reasoning${reasoning.subagent?.sharePct == null ? '' : `; sub-agents ${pctText(reasoning.subagent.sharePct)}`}.</p>`}
    ${reasoning.byEffort.length > 0
      ? html`<ul class="ctx-tt-bars" aria-label="Reasoning share by effort">${reasoning.byEffort.map(effortRow)}</ul>`
      : html`<p class="ctx-tt-note">${reasoning.basis === 'session-totals' ? 'This harness logs reasoning only as a session total, so there is no split by effort.' : 'No reasoning effort was logged.'}</p>`}
  </section>`;
}

export function renderCompaction(compaction: TokenTypesCompaction | null): ComponentChildren {
  if (!compaction) return null;
  const kinds = [`${compaction.automatic} automatic`, ...(compaction.manual > 0 ? [`${compaction.manual} other`] : []), ...(compaction.failed > 0 ? [`${compaction.failed} failed`] : [])];
  const sizes = compaction.avgTokensBefore != null && compaction.avgTokensAfter != null
    ? ` On average the context went from ${formatNum(compaction.avgTokensBefore)} to ${formatNum(compaction.avgTokensAfter)} tokens${compaction.yieldPct == null ? '' : ` (${pctText(compaction.yieldPct)} removed)`}.`
    : '';
  const usage = compaction.withUsage > 0
    ? ` The compaction calls read ${formatNum(compaction.inputTokens)} and wrote ${formatNum(compaction.outputTokens)} tokens and took ${durationText(compaction.modelTimeMs)} of model time.${compaction.shareOfMainInputPct == null ? '' : ` In turns that log per-call usage, they read ${pctText(compaction.shareOfMainInputPct)} as much as the main agent.`}`
    : '';
  return html`<section class="ctx-tt-section" aria-labelledby="ctxTtCompaction">
    <h4 id="ctxTtCompaction">Compaction overhead ${infoTip(TOKEN_TYPE_META.compaction.help, 'About compaction')}</h4>
    <p class="ctx-tt-line">${compaction.count} compaction${compaction.count === 1 ? '' : 's'}: ${kinds.join(' \u00b7 ')}.${sizes}${usage}</p>
  </section>`;
}

export function renderSubagents(subagents: TokenTypesSubagents | null): ComponentChildren {
  if (!subagents) return null;
  const top = subagents.byType[0]?.totalTokens ?? 0;
  return html`<section class="ctx-tt-section" aria-labelledby="ctxTtSubagents">
    <h4 id="ctxTtSubagents">Sub-agent tokens by type ${infoTip(`${TOKEN_TYPE_META.subagents.help} Totals are what Copilot reported when each sub-agent finished: input, including cached tokens, plus output.`, 'About sub-agent tokens')}</h4>
    <ul class="ctx-tt-bars" aria-label="Sub-agent tokens by type">
      ${subagents.byType.map(type => bar(type.agentType, top > 0 ? (type.totalTokens / top) * 100 : 0,
        `${formatNum(type.totalTokens)} \u00b7 ${type.runs} run${type.runs === 1 ? '' : 's'}`,
        `${type.toolCalls} tool calls, ${durationText(type.durationMs)}${type.background > 0 ? `, ${type.background} in the background` : ''}${type.cancelled > 0 ? `, ${type.cancelled} cancelled` : ''}`))}
    </ul>
  </section>`;
}

export function renderTruncation(truncation: TokenTypesTruncation | null): ComponentChildren {
  if (!truncation) return null;
  const pct = truncation.calls > 0 ? (truncation.truncatedCalls / truncation.calls) * 100 : 0;
  return html`<section class="ctx-tt-section" aria-labelledby="ctxTtTruncation">
    <h4 id="ctxTtTruncation">Truncated calls ${infoTip(TOKEN_TYPE_META.truncation.help, 'About truncated calls')}</h4>
    <p class="ctx-tt-line">${truncation.truncatedCalls} of ${formatNum(truncation.calls)} model calls (${pctText(pct)}) stopped at the output-token limit${truncation.filteredCalls ? `; the content filter stopped ${truncation.filteredCalls}` : ''}.</p>
  </section>`;
}

function latencyCell(p50: number | null, p90: number | null): string {
  return p50 == null ? '\u2014' : `${durationText(p50)} / ${p90 == null ? '\u2014' : durationText(p90)}`;
}

function toggleControlled(event: Event): void {
  const button = event.currentTarget as HTMLButtonElement;
  const open = button.getAttribute('aria-expanded') !== 'true';
  button.setAttribute('aria-expanded', String(open));
  const target = document.getElementById(button.getAttribute('aria-controls') ?? '');
  if (target) target.hidden = !open;
}

export function renderLatency(latency: LatencyByModel[] | null): ComponentChildren {
  if (!latency?.length) return null;
  return html`<section class="ctx-tt-section" aria-labelledby="ctxTtLatency">
    <h4 id="ctxTtLatency">
      <button type="button" class="ctx-tt-expand" aria-expanded="false" aria-controls="ctxTtLatencyTable" onClick=${toggleControlled}>Latency by model</button>
      ${infoTip(`${TOKEN_TYPE_META.latency.help} Per main-agent model call. Request-level response times for other harnesses are under Activity Patterns.`, 'About latency')}
    </h4>
    <table class="ctx-tt-table" id="ctxTtLatencyTable" hidden>
      <thead><tr><th scope="col">Model</th><th scope="col">Calls</th><th scope="col">First token p50 / p90</th><th scope="col">Call p50 / p90</th></tr></thead>
      <tbody>${latency.map(row => html`<tr>
        <th scope="row">${row.model}</th><td>${formatNum(row.calls)}</td>
        <td>${latencyCell(row.ttftP50Ms, row.ttftP90Ms)}</td><td>${latencyCell(row.durationP50Ms, row.durationP90Ms)}</td>
      </tr>`)}</tbody>
    </table>
  </section>`;
}

export function renderAvailability(harnesses: HarnessTokenTypes[]): ComponentChildren {
  if (harnesses.length === 0) return null;
  return html`<section class="ctx-tt-section" aria-labelledby="ctxTtAvailability">
    <h4 id="ctxTtAvailability">What each harness reports</h4>
    <table class="ctx-tt-table ctx-tt-matrix">
      <thead><tr><th scope="col">Harness</th>${TOKEN_TYPES.map(key => html`<th scope="col">${TOKEN_TYPE_META[key].label}</th>`)}</tr></thead>
      <tbody>${harnesses.map(h => html`<tr>
        <th scope="row">${h.harness} <span class="ctx-tt-muted">${formatNum(h.requests)} requests</span></th>
        ${TOKEN_TYPES.map(key => html`<td class=${'ctx-tt-avail ' + h.reports[key]} title=${AVAILABILITY_HELP[h.reports[key]]}>${AVAILABILITY_TEXT[h.reports[key]]}</td>`)}
      </tr>`)}</tbody>
    </table>
  </section>`;
}

/** Everything shown for one source. */
export function renderSourcePanel(source: SourceTokenTypes): ComponentChildren {
  return html`<div class="ctx-tt-source" data-source=${source.source}>
    ${renderKpis(source)}
    <div class="two-col">${renderReasoning(source.reasoning)}${renderSubagents(source.subagents)}</div>
    ${renderCompaction(source.compaction)}
    ${renderTruncation(source.truncation)}
    ${renderLatency(source.latency)}
  </div>`;
}

/** One line under Context Management's session drill-down: this session's token types. */
export function renderSessionStrip(tt: SessionTokenTypes | undefined): ComponentChildren {
  if (!tt) return null;
  const parts: string[] = [];
  if (tt.reasoningPct != null) parts.push(`reasoning ${pctText(tt.reasoningPct)} of output${tt.effort ? ` (${tt.effort} effort)` : ''}`);
  if (tt.subagentRuns > 0) {
    const types = tt.subagentTypes.map(t => `${t.agentType} ${t.runs}`).join(', ');
    parts.push(`${tt.subagentRuns} sub-agent run${tt.subagentRuns === 1 ? '' : 's'}, ${formatNum(tt.subagentTokens)} tokens${types ? ` (${types})` : ''}`);
  }
  if (tt.compactionCalls > 0) parts.push(`compaction calls ${formatNum(tt.compactionTokens)} tokens, ${durationText(tt.compactionTimeMs)}`);
  if (tt.truncatedCalls != null && tt.calls != null) parts.push(`${tt.truncatedCalls} of ${formatNum(tt.calls)} model calls truncated`);
  if (tt.ttftMedianMs != null) parts.push(`first token median ${durationText(tt.ttftMedianMs)}`);
  if (parts.length === 0) return null;
  return html`<p class="ctx-tt-strip" data-tip="Token types beyond input and output for this whole session. Model calls include sub-agent calls. The Token Types tab has them for all sessions in the range.">
    <span class="ctx-tt-strip-title">Token types in this session:</span> ${parts.join(' \u00b7 ')}</p>`;
}
