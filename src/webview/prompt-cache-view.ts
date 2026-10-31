/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Sections of the Prompt Cache tab: key figures, prompt tokens per harness, why the cache broke, where
 * cache misses come from, cache lifetime and expiry, and breakdowns by model and week. */

import type { CacheAttribution, CacheCauseSummary, CacheTotals, HarnessPromptCache, ModelPromptCache, PromptCacheData } from '../core/types';
import { CACHE_MAX_BREAKS_PER_SESSION } from '../core/constants';
import { createChart, destroyChartById, formatNum, harnessColor } from './shared';
import { html, type ComponentChildren } from './render';
import { CAUSE_META, CAUSE_NAMES, CONTROL_META, ORIGIN_META, TOKEN_META, countText, durationText, pctText, shortHarness } from './prompt-cache-labels';

export const CACHE_TREND_CHART_ID = 'ctxCacheTrendChart';

const NOT_REPORTED_HELP = 'This harness doesn’t log prompt-cache tokens, so nothing is shown. Nothing is estimated.';
const NO_DATA_HELP = 'No request in this range logged prompt-cache tokens. Older Copilot App and Copilot CLI builds don\u2019t log per-call usage.';
const REPORTING_HELP: Record<HarnessPromptCache['reporting'], string> = {
  'per-call': 'Cache tokens are logged for every model call: the main agent, subagents and compaction summaries.',
  'per-session': 'Only session totals are logged, so the cache can\u2019t be followed call by call. OpenAI caching has no cache writes.',
  none: NOT_REPORTED_HELP,
};

export function infoTip(text: string, label: string): ComponentChildren {
  return html`<span class="info-icon" tabindex="0" role="button" aria-label=${label}>${'\u24d8'}<span class="info-popup">${text}</span></span>`;
}

function kpiChip(label: string, value: string, tip: string, sub?: string): ComponentChildren {
  return html`<div class="ctx-comp-kpi" data-tip=${tip} tabindex="0" aria-label=${`${label}: ${value}${sub ? `, ${sub}` : ''}. ${tip}`}>
    <div class="ctx-comp-kpi-value">${value}</div>
    <div class="ctx-comp-kpi-label">${label}</div>
    ${sub ? html`<div class="ctx-comp-kpi-sub">${sub}</div>` : null}
  </div>`;
}

export function renderKpis(data: PromptCacheData): ComponentChildren {
  const chips: ComponentChildren[] = [];
  for (const h of data.harnesses) {
    if (!h.all) continue;
    const name = shortHarness(h.harness);
    chips.push(kpiChip('Cache hit ratio', pctText(h.all.hitPct), `Share of ${name} prompt tokens read from the cache, weighted by tokens. ${REPORTING_HELP[h.reporting]}`, name));
    if (h.cost) {
      chips.push(kpiChip('Input cost saved', pctText(h.cost.savedPct), `How much caching cut the input cost of ${name} prompts, from the per-call prices ${name} logged (rates on ${pctText(h.cost.ratedPct)} of tokens). Percentages only; no amounts are shown.`, name));
      chips.push(kpiChip('Cost on cache misses', pctText(h.cost.missCostPct), `Share of ${name} input cost spent on tokens that weren\u2019t read from the cache: ${pctText(h.all.writePct)} of tokens were written and ${pctText(h.all.uncachedPct)} uncached.`, name));
    }
    if (h.breaksPer100 != null) chips.push(kpiChip('Breaks per 100 calls', String(h.breaksPer100), `How often a ${name} main-agent call couldn\u2019t reuse most of the previous call\u2019s cached prompt.`, `${countText(h.breaks ?? 0, 'break')} \u00b7 ${name}`));
  }
  const { requestsWithData, totalRequests } = data.coverage;
  const missing = data.harnesses.filter(h => h.reporting === 'none').map(h => shortHarness(h.harness));
  chips.push(kpiChip('Coverage', pctText(totalRequests > 0 ? (requestsWithData / totalRequests) * 100 : 0),
    `${formatNum(requestsWithData)} of ${formatNum(totalRequests)} requests in range logged cache tokens.${missing.length > 0 ? ` Not reported by: ${missing.join(', ')}.` : ''}`,
    `${formatNum(requestsWithData)} of ${formatNum(totalRequests)} requests`));
  return html`<div class="ctx-comp-kpis">${chips}</div>`;
}

/** Read, written and uncached shares of a prompt-token total, as a 100% bar with a text equivalent. */
export function tokenBar(totals: CacheTotals, label: string, height = 18): ComponentChildren {
  const parts = (['cacheRead', 'cacheWrite', 'uncached'] as const)
    .map(key => ({ key, pct: totals.input > 0 ? (totals[key] / totals.input) * 100 : 0 }))
    .filter(part => part.pct > 0);
  const text = parts.map(part => `${TOKEN_META[part.key].label} ${pctText(part.pct)}`).join(', ');
  return html`<div class="ctx-comp-bar" role="img" tabindex="0" aria-label=${`${label}: ${text}`} style=${`height:${height}px;`}>
    ${parts.map((part, i) => html`<div class=${'ctx-comp-seg' + (i === 0 ? ' first' : '') + (i === parts.length - 1 ? ' last' : '')} data-tip=${`${TOKEN_META[part.key].label}: ${pctText(part.pct)} \u00b7 ${formatNum(totals[part.key])} tokens`}
      style=${`width:${part.pct}%;background:${TOKEN_META[part.key].color};`}>${part.pct >= 9 && height >= 14 ? html`<span class="ctx-comp-seg-label">${Math.round(part.pct)}%</span>` : null}</div>`)}
  </div>`;
}

export function tokenLegend(): ComponentChildren {
  return html`<ul class="ctx-comp-legend" aria-label="Prompt token categories">
    ${(Object.keys(TOKEN_META) as (keyof typeof TOKEN_META)[]).map(key => html`<li data-tip=${TOKEN_META[key].help} tabindex="0" aria-label=${`${TOKEN_META[key].label}: ${TOKEN_META[key].help}`}>
      <span class="ctx-comp-swatch" style=${`background:${TOKEN_META[key].color};`}></span>${TOKEN_META[key].label}</li>`)}
  </ul>`;
}

function harnessRow(h: HarnessPromptCache, index: number): ComponentChildren {
  const name = html`<div class="ctx-comp-harness" style=${`border-left-color:${harnessColor(h.harness, index)};`}>
    <span class="ctx-comp-harness-name" title=${h.harness}>${shortHarness(h.harness)}</span>${infoTip(REPORTING_HELP[h.reporting], `How ${h.harness} reports the prompt cache`)}
  </div>`;
  const requests = html`<div class="ctx-comp-meta">${formatNum(h.totalRequests)} requests</div>`;
  if (!h.all) {
    const notReported = h.reporting === 'none';
    return html`<div class="ctx-comp-row ctx-comp-row-muted" data-harness=${h.harness}>${name}
      <div class="ctx-comp-empty" data-tip=${notReported ? NOT_REPORTED_HELP : NO_DATA_HELP} tabindex="0">${notReported ? 'Not reported by this harness' : 'No cache usage logged in this range'}</div>${requests}</div>`;
  }
  const partial = h.requestsWithData < h.totalRequests;
  const noun = h.reporting === 'per-session' ? 'session totals' : `${formatNum(h.all.calls)} model calls`;
  return html`<div class="ctx-comp-row" data-harness=${h.harness}>${name}
    ${tokenBar(h.all, `${h.harness} prompt tokens`)}
    <div class="ctx-comp-meta">
      <span>${noun}</span>
      <span class=${partial ? 'ctx-comp-partial' : ''} data-tip=${partial ? `${formatNum(h.totalRequests - h.requestsWithData)} requests in range logged no cache tokens. ${NO_DATA_HELP}` : undefined} tabindex=${partial ? 0 : undefined}>
        ${formatNum(h.requestsWithData)} of ${formatNum(h.totalRequests)} requests
      </span>
    </div>
  </div>`;
}

export function renderHarnessRows(data: PromptCacheData): ComponentChildren {
  return html`<div class="ctx-comp-rows" aria-label="Prompt tokens by harness">${data.harnesses.map(harnessRow)}</div>`;
}

/** Disclosure buttons toggle their detail row without re-rendering. */
function toggleDetails(event: Event): void {
  const button = event.currentTarget as HTMLButtonElement;
  const open = button.getAttribute('aria-expanded') !== 'true';
  button.setAttribute('aria-expanded', String(open));
  const panel = document.getElementById(button.getAttribute('aria-controls') ?? '');
  if (panel) panel.hidden = !open;
}

function confidenceText(cause: CacheCauseSummary): string {
  if (cause.key === 'unattributed') return 'Not logged: nothing on these calls, or in the events since the previous call, explains why the cache broke.';
  return cause.checkpoint > 0
    ? `${cause.checkpoint} of ${cause.breaks} known only from a usage-checkpoint window, so the change happened somewhere in that window.`
    : 'Logged on the call itself or in an event just before it.';
}

function causeDetail(cause: CacheCauseSummary): ComponentChildren {
  const meta = CAUSE_META[cause.key];
  return html`<div class="ctx-cache-cause-detail">
    <p>${meta.help}</p>
    <p><strong>What you can do:</strong> ${meta.action}</p>
    <p class="ctx-cache-muted">Confidence: ${confidenceText(cause)}</p>
    ${cause.segments.length > 0 ? html`<p class="ctx-cache-muted">System-prompt parts that changed: ${cause.segments.map((s, i) => html`${i > 0 ? ', ' : ''}<code>${s.name}</code> (${s.breaks})`)}</p>` : null}
    ${cause.alsoSeen.length > 0 ? html`<p class="ctx-cache-muted">Also logged on these breaks: ${cause.alsoSeen.map(a => `${CAUSE_NAMES[a.cause]} (${a.breaks})`).join(', ')}</p>` : null}
  </div>`;
}

function causeRows(cause: CacheCauseSummary, index: number): ComponentChildren {
  const meta = CAUSE_META[cause.key];
  const detailId = `ctxCacheCause${index}`;
  return html`<tr class="ctx-cache-cause" data-cause=${cause.key}>
      <th scope="row"><button type="button" class="ctx-cache-expand" aria-expanded="false" aria-controls=${detailId} onClick=${toggleDetails}>
        <span class="ctx-comp-swatch" style=${`background:${meta.color};`}></span>${meta.label}</button></th>
      <td class="num">${formatNum(cause.breaks)}</td>
      <td class="num">${formatNum(cause.rebuiltTokens)} <span class="ctx-cache-muted">(${pctText(cause.pctOfRebuilt)})</span></td>
      <td class="num">${pctText(cause.costPct)}</td>
      <td><span class=${`ctx-cache-control ctx-cache-control-${cause.control}`} data-tip=${CONTROL_META[cause.control].help} tabindex="0">${CONTROL_META[cause.control].label}</span></td>
    </tr>
    <tr id=${detailId} class="ctx-cache-cause-row" hidden><td colspan="5">${causeDetail(cause)}</td></tr>`;
}

/** Breaks counted in range whose causes aren't listed: each session lists only its first breaks. */
function unlistedNote(a: CacheAttribution): string {
  const one = a.breaks === 1;
  return `${countText(a.breaks, 'cache break')} in this range ${one ? 'isn’t' : 'aren’t'} listed, because each session lists only its first ${CACHE_MAX_BREAKS_PER_SESSION} breaks. ${one ? 'It counts' : 'They count'} toward rebuilt tokens and break rates, but ${one ? 'its cause is' : 'their causes are'} unknown.`;
}

function causesTable(a: CacheAttribution): ComponentChildren {
  if (a.causes.length === 0) {
    return a.breaks > 0
      ? html`<div class="ctx-comp-note" id="ctxCacheUnlisted">${unlistedNote(a)}</div>`
      : html`<div class="ctx-comp-note">No cache breaks in this range: every main-agent call reused the previous call’s cache.</div>`;
  }
  return html`<table class="ctx-cache-table" aria-label="Why the cache broke">
    <thead><tr><th scope="col">Cause</th><th scope="col" class="num">Breaks</th><th scope="col" class="num">Rebuilt tokens</th><th scope="col" class="num" title="Share of input cost, from logged prices">Cost</th><th scope="col">Who</th></tr></thead>
    <tbody>${a.causes.map(causeRows)}</tbody>
  </table>
  <p class="ctx-cache-muted ctx-cache-summary">${pctText(a.controlPct.you)} of rebuilt tokens came from causes you can change, and ${pctText(a.controlPct.partly)} partly.
    ${a.confidence.checkpoint > 0 ? ` ${countText(a.confidence.checkpoint, 'break is', 'breaks are')} attributed from a checkpoint window.` : ''}${a.omittedBreaks > 0 ? ` ${countText(a.omittedBreaks, 'more break is', 'more breaks are')} counted but not listed, because each session lists only its first ${CACHE_MAX_BREAKS_PER_SESSION}; ${a.omittedBreaks === 1 ? 'its' : 'their'} rebuilt tokens count as unknown cause.` : ''}</p>`;
}

function originsCard(a: CacheAttribution): ComponentChildren {
  const visible = a.origins.filter(o => o.pct > 0);
  return html`<div class="chart-wrap ctx-cache-card">
    <div class="chart-title">Where cache misses come from ${infoTip('Prompt tokens not read from the cache, by where they came from. In parentheses: the share of input cost, from per-call prices the harness logged.', 'About cache misses')}</div>
    <div class="ctx-comp-bar" role="img" tabindex="0" style="height:14px;" aria-label=${`Cache misses: ${visible.map(o => `${ORIGIN_META[o.origin].label} ${pctText(o.pct)}`).join(', ')}`}>
      ${visible.map((o, i) => html`<div class=${'ctx-comp-seg' + (i === 0 ? ' first' : '') + (i === visible.length - 1 ? ' last' : '')} style=${`width:${o.pct}%;background:${ORIGIN_META[o.origin].color};`} data-tip=${`${ORIGIN_META[o.origin].label}: ${pctText(o.pct)}`}></div>`)}
    </div>
    <ul class="ctx-cache-list">
      ${visible.map(o => html`<li data-origin=${o.origin} data-tip=${ORIGIN_META[o.origin].help} tabindex="0">
        <span class="ctx-comp-swatch" style=${`background:${ORIGIN_META[o.origin].color};`}></span>
        <span>${ORIGIN_META[o.origin].label}</span><strong>${pctText(o.pct)}</strong><span class="ctx-cache-muted">${o.costPct == null ? '' : `(${pctText(o.costPct)} of cost)`}</span>
      </li>`)}
    </ul>
    <div class="ctx-cache-muted">${formatNum(a.misses)} tokens missed the cache.</div>
  </div>`;
}

function idleCard(a: CacheAttribution): ComponentChildren {
  const { idle } = a;
  const max = Math.max(1, ...idle.buckets.map(b => b.user + b.agent));
  return html`<div class="chart-wrap ctx-cache-card">
    <div class="chart-title">Cache lifetime and expiry ${infoTip('A call refreshes the cache when it starts, and the cache lasts for the lifetime below from then. The time since the cache was last refreshed runs from the previous call’s start to the next call’s start; when it is longer than the lifetime, the cache had expired. The lifetimes are the ones your logs show, which can differ from general documentation.', 'About the cache lifetime')}</div>
    <ul class="ctx-cache-list">
      ${idle.ttlByModel.map(t => html`<li><code>${t.model}</code><strong>${durationText(t.ttlSeconds)}</strong><span class="ctx-cache-muted">${countText(t.calls, 'call')}</span></li>`)}
    </ul>
    <p class="ctx-cache-idle-stat">${idle.returns > 0 ? html`You came back after the cache expired in <strong>${formatNum(idle.expiredReturns)}</strong> of ${formatNum(idle.returns)} returns (${pctText((idle.expiredReturns / idle.returns) * 100)}).` : 'No returns to an earlier call in this range.'}
      ${idle.medianIdleMinutes == null ? '' : ` At an expiry break, the cache had last been refreshed ${durationText(idle.medianIdleMinutes * 60)} earlier (median).`}</p>
    <div class="ctx-cache-idle" role="table" aria-label="Expiry breaks by time since the cache was last refreshed, in multiples of the cache lifetime">
      ${idle.buckets.map(b => html`<div class="ctx-cache-idle-row" role="row">
        <span role="rowheader">${b.label} lifetime</span>
        <span class="ctx-cache-idle-bar" role="cell" aria-label=${`${b.user} you away, ${b.agent} agent waiting`}>
          <span style=${`width:${(b.user / max) * 100}%;background:${CAUSE_META['ttl-user'].color};`}></span><span style=${`width:${(b.agent / max) * 100}%;background:${CAUSE_META['ttl-agent'].color};`}></span>
        </span>
        <span role="cell" class="ctx-cache-muted">${b.user} / ${b.agent}</span>
      </div>`)}
    </div>
    <div class="ctx-cache-muted">Expiry breaks by time since the cache was last refreshed. Bars: you away / agent waiting.</div>
  </div>`;
}

export function renderAttribution(a: CacheAttribution | null): ComponentChildren {
  if (!a) {
    return html`<div class="ctx-comp-note" id="ctxCacheNoAttribution">Why the cache broke is logged only by Copilot App and Copilot CLI builds that record per-call usage. Other harnesses show efficiency only.</div>`;
  }
  return html`<div class="ctx-cache-attribution" id="ctxCacheAttribution">
    <h4>Why the cache broke <span class="ctx-cache-muted">\u00b7 ${a.label} \u00b7 ${countText(a.breaks, 'break')}, ${a.breaksPer100} per 100 calls</span>
      ${infoTip('A break is a main-agent call that couldn\u2019t reuse most of the previous call\u2019s cached prompt (at least 30% of a prompt of 20K tokens or more). Each break is attributed to the most explanatory logged cause; open a row for details.', 'About cache breaks')}</h4>
    ${causesTable(a)}
    <div class="two-col ctx-cache-cards">${originsCard(a)}${idleCard(a)}</div>
  </div>`;
}

export function renderModelTable(models: ModelPromptCache[]): ComponentChildren {
  if (models.length === 0) return null;
  return html`<div class="chart-wrap"><div class="chart-title">By model</div>
    <table class="ctx-cache-table" aria-label="Prompt cache by model">
      <thead><tr><th scope="col">Model</th><th scope="col">Harness</th><th scope="col" class="num">Calls</th><th scope="col" class="num">Hit ratio</th><th scope="col" class="num">Written</th><th scope="col" class="num">Breaks / 100</th><th scope="col" class="num">Lifetime</th></tr></thead>
      <tbody>${models.map(m => html`<tr><th scope="row"><code>${m.model}</code></th><td>${shortHarness(m.harness)}</td><td class="num">${formatNum(m.calls)}</td><td class="num">${pctText(m.hitPct)}</td><td class="num">${pctText(m.writePct)}</td><td class="num">${m.breaksPer100 ?? '\u2014'}</td><td class="num">${durationText(m.ttlSeconds)}</td></tr>`)}</tbody>
    </table></div>`;
}

export function renderTrendPanel(data: PromptCacheData): ComponentChildren {
  return html`<div class="chart-wrap"><div class="chart-title">Cache hit ratio by week ${infoTip('Weekly share of prompt tokens read from the cache, per harness. The tooltip also shows breaks per 100 main-agent calls.', 'About the weekly trend')}</div>
    ${data.trend.labels.length > 1
      ? html`<div style="position:relative;height:200px;"><canvas id=${CACHE_TREND_CHART_ID} role="img" aria-label="Weekly cache hit ratio per harness"></canvas></div>`
      : html`<div class="ctx-comp-note">Not enough weekly data for a trend yet.</div>`}
  </div>`;
}

export function renderTrendChart(data: PromptCacheData): void {
  destroyChartById(CACHE_TREND_CHART_ID);
  if (data.trend.labels.length <= 1 || !document.getElementById(CACHE_TREND_CHART_ID)) return;
  const series = data.trend.series.filter(s => s.hitPct.some(v => v != null));
  const lows = series.flatMap(s => s.hitPct.filter((v): v is number => v != null));
  createChart(CACHE_TREND_CHART_ID, 'line', {
    labels: data.trend.labels,
    datasets: series.map((s, i) => ({ label: shortHarness(s.harness), data: s.hitPct, borderColor: harnessColor(s.harness, i), backgroundColor: harnessColor(s.harness, i) + '22', tension: 0.3, spanGaps: true, pointRadius: 3 })),
  }, {
    interaction: { mode: 'index', intersect: false },
    scales: {
      y: { min: Math.max(0, Math.floor(Math.min(...lows, 100) / 10) * 10 - 10), max: 100, title: { display: true, text: 'Hit ratio %', color: '#8b949e' }, ticks: { color: '#8b949e' }, grid: { color: 'rgba(48,54,61,0.6)' } },
      x: { ticks: { color: '#8b949e', maxRotation: 45 }, grid: { color: 'rgba(48,54,61,0.3)' } },
    },
    plugins: {
      legend: { position: 'top', labels: { boxWidth: 10 } },
      tooltip: {
        callbacks: {
          label: (item: { datasetIndex: number; dataIndex: number; parsed: { y: number | null } }) => {
            const s = series[item.datasetIndex];
            if (!s || item.parsed.y == null) return '';
            const breaks = s.breaksPer100[item.dataIndex];
            return `${shortHarness(s.harness)}: ${pctText(item.parsed.y)} hit${breaks == null ? '' : ` \u00b7 ${breaks} breaks per 100 calls`} \u00b7 ${countText(s.calls[item.dataIndex], 'main call')}`;
          },
        },
      },
    },
  });
}
