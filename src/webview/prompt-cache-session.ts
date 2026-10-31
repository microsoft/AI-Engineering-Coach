/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Session drill-down for the Prompt Cache tab. Session rows open into the session's call timeline, drawn
 * with the layered timeline chart (cache tokens and cache breaks), and a table of its breaks. Timelines
 * load lazily through `getSessionTimeline`; workspace rows load their sessions through
 * `getPromptCacheSessions`. Each toggle ignores responses from a superseded load. */

import type { CacheBreakDetail, CacheSessionSummary, DateFilter, PromptCacheSessionsData, SessionCacheLayer, SessionTimelineData, WorkspacePromptCache } from '../core/types';
import { bucketOfCall } from '../core/call-timeline';
import { destroyChartById, formatNum, rpc } from './shared';
import { html, render, unmount, type ComponentChildren } from './render';
import { callTimelineTable, renderCallTimelineChart, type CallTimelineLayer, type CallTimelineMarker } from './call-timeline-chart';
import { CAUSE_META, CAUSE_NAMES, TOKEN_META, countText, durationText, pctText, shortHarness } from './prompt-cache-labels';

const CHART_PREFIX = 'ctxCacheTimeline';
let panelSeq = 0;

/** Average prompt tokens per call (or per request) by cache status. */
export function cacheTokenLayer(unit: SessionTimelineData['unit']): CallTimelineLayer {
  return {
    id: 'cache-tokens',
    label: 'Cache tokens',
    help: `Prompt tokens per ${unit === 'calls' ? 'model call' : 'request'}: read from the cache, written to it, or uncached. The bar height is the prompt size.`,
    defaultOn: true,
    datasets: timeline => (['cacheRead', 'cacheWrite', 'uncached'] as const).map(key => ({
      label: TOKEN_META[key].label,
      data: timeline.buckets.map(bucket => (bucket.cacheCalls > 0 ? Math.round(bucket[key] / bucket.cacheCalls) : null)),
      backgroundColor: TOKEN_META[key].color,
      stack: 'cache',
      borderWidth: 0,
      categoryPercentage: 0.95,
      barPercentage: 1,
    })),
  };
}

export function breakSentence(brk: CacheBreakDetail): string {
  const idle = brk.idleSeconds == null ? '' : `, ${durationText(brk.idleSeconds)} after the cache was last refreshed${brk.ttlSeconds ? ` (cache lifetime ${durationText(brk.ttlSeconds)})` : ''}`;
  return `${CAUSE_META[brk.key].label}: ${formatNum(brk.rebuiltTokens)} tokens rebuilt${idle}`;
}

/** Break markers keyed by the bucket of the call (or request) that broke the cache. */
export function cacheBreakLayer(data: SessionTimelineData): CallTimelineLayer {
  const breaks = data.cache?.breaks ?? [];
  return {
    id: 'cache-breaks',
    label: 'Cache breaks',
    help: 'Calls that couldn’t reuse most of the previous call’s cached prompt, labelled with the logged cause.',
    defaultOn: true,
    markers: timeline => {
      const markers = new Map<number, CallTimelineMarker[]>();
      for (const brk of breaks) {
        const index = data.unit === 'calls'
          ? bucketOfCall(timeline, brk.callIndex)
          : timeline.buckets.findIndex(bucket => brk.requestIndex >= bucket.firstRequest && brk.requestIndex <= bucket.lastRequest);
        if (index < 0) continue;
        markers.set(index, [...(markers.get(index) ?? []), { label: CAUSE_META[brk.key].short, detail: breakSentence(brk), color: CAUSE_META[brk.key].color }]);
      }
      return markers;
    },
  };
}

function sparkline(values: number[]): ComponentChildren {
  if (values.length < 2) return html`<span class="ctx-cache-spark"></span>`;
  const max = Math.max(1, ...values);
  const points = values.map((v, i) => `${((i / (values.length - 1)) * 60).toFixed(1)},${(16 - (v / max) * 14).toFixed(1)}`).join(' ');
  return html`<svg class="ctx-cache-spark" viewBox="0 0 60 18" width="60" height="18" aria-hidden="true" focusable="false"><polyline points=${points} fill="none" stroke="#da7756" stroke-width="1.5" /></svg>`;
}

export function renderSessionList(sessions: CacheSessionSummary[], label: string): ComponentChildren {
  const list = `ctxCacheSessions${++panelSeq}`;
  return html`<ul class="ctx-cache-sessions" aria-label=${label}>
    ${sessions.map((s, i) => html`<li class="ctx-cache-session" data-session-id=${s.sessionId}>
      <button type="button" class="ctx-cache-session-toggle" aria-expanded="false" aria-controls=${`${list}-${i}`}>
        <span>${s.date}</span>
        <span class="ctx-cache-session-ws" title=${s.workspaceName}>${s.workspaceName}</span>
        <span class="ctx-cache-muted">${shortHarness(s.harness)}</span>
        <span class="num">${countText(s.calls, 'call')}</span>
        <span class="num">${pctText(s.hitPct)} hit</span>
        <span class="num">${s.breaks == null ? '\u2014' : countText(s.breaks, 'break')}</span>
        <span class="num">${s.rebuiltTokens == null ? `${formatNum(s.misses)} missed` : `${formatNum(s.rebuiltTokens)} rebuilt`}</span>
        <span class="ctx-cache-muted">${s.topCause ? CAUSE_META[s.topCause].short : ''}</span>
        ${sparkline(s.sparkline)}
      </button>
      <div class="ctx-cache-session-panel" id=${`${list}-${i}`} hidden></div>
    </li>`)}
  </ul>`;
}

function streamText(label: string, totals: SessionCacheLayer['main']): ComponentChildren {
  if (!totals) return null;
  return html`<li>${label}: <strong>${pctText(totals.hitPct)}</strong> hit over ${totals.calls > 0 ? `${countText(totals.calls, 'call')}, ` : ''}${formatNum(totals.input)} tokens</li>`;
}

function breakTable(data: SessionTimelineData): ComponentChildren {
  const cache = data.cache;
  if (!cache || data.unit !== 'calls') return html`<div class="ctx-comp-note">Cache breaks are logged only by Copilot App and Copilot CLI.</div>`;
  if (cache.breaks.length === 0) return html`<div class="ctx-comp-note">No cache breaks in this session.</div>`;
  return html`<table class="ctx-cache-table ctx-cache-breaks" aria-label="Cache breaks in this session">
    <thead><tr><th scope="col">Time</th><th scope="col">Cause</th><th scope="col" class="num" title="Time since the cache was last refreshed (from the previous call’s start to this call’s start), against the cache lifetime">Since refresh / lifetime</th><th scope="col" class="num">Rebuilt</th><th scope="col">Confidence</th></tr></thead>
    <tbody>${cache.breaks.map(brk => html`<tr data-cause=${brk.key}>
      <td>${brk.timestamp == null ? `#${brk.callIndex + 1}` : new Date(brk.timestamp).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
      <td><span class="ctx-comp-swatch" style=${`background:${CAUSE_META[brk.key].color};`}></span> ${CAUSE_META[brk.key].label}
        ${brk.causes.length > 1 ? html`<span class="ctx-cache-muted"> \u00b7 also ${brk.causes.slice(1).map(c => CAUSE_NAMES[c]).join(', ')}</span>` : null}
        ${brk.segments?.length ? html`<span class="ctx-cache-muted"> (${brk.segments.join(', ')})</span>` : null}</td>
      <td class="num">${durationText(brk.idleSeconds)} / ${durationText(brk.ttlSeconds)}</td>
      <td class="num">${formatNum(brk.rebuiltTokens)}</td>
      <td>${brk.confidence === 'checkpoint' ? 'Checkpoint window' : brk.confidence === 'logged' ? 'Logged' : 'Not logged'}</td>
    </tr>`)}</tbody>
  </table>${cache.omittedBreaks > 0 ? html`<div class="ctx-cache-muted">${countText(cache.omittedBreaks, 'more break is', 'more breaks are')} counted but not listed.</div>` : null}`;
}

function describeTimeline(data: SessionTimelineData): string {
  const count = data.cache?.breaks.length ?? 0;
  return `Prompt tokens per ${data.unit === 'calls' ? 'model call' : 'request'}, split by cache status${count > 0 ? `, with ${countText(count, 'cache break')} marked` : ''}. Show the chart as a table, below it, for the values${count > 0 ? '; the break table lists the breaks' : ''}.`;
}

function tableCaption(data: SessionTimelineData): string {
  return `Average prompt tokens per ${data.unit === 'calls' ? 'model call' : 'request'} in each bar, by cache status${data.unit === 'calls' ? ', with cache breaks' : ''}`;
}

function renderPanel(panel: HTMLElement, data: SessionTimelineData): void {
  const chartId = `${CHART_PREFIX}${++panelSeq}`;
  panel.dataset.chartId = chartId;
  const layers = [cacheTokenLayer(data.unit), cacheBreakLayer(data)];
  const enabled = new Set(layers.filter(layer => layer.defaultOn).map(layer => layer.id));
  const draw = () => {
    if (data.timeline) renderCallTimelineChart(chartId, data.timeline, layers, { unit: data.unit, yTitle: data.unit === 'calls' ? 'Tokens per call' : 'Tokens per request', enabled });
  };
  const toggleLayer = (event: Event) => {
    const button = event.currentTarget as HTMLButtonElement;
    const id = button.dataset.layer ?? '';
    if (enabled.has(id)) enabled.delete(id);
    else enabled.add(id);
    button.setAttribute('aria-pressed', String(enabled.has(id)));
    draw();
  };
  render(html`<div class="ctx-cache-session-detail">
    <ul class="ctx-comp-values">${streamText('Main agent', data.cache?.main ?? null)}${streamText('Subagents', data.cache?.subagents ?? null)}${streamText('Compaction', data.cache?.compaction ?? null)}</ul>
    ${data.timeline ? html`
      <div class="ctx-cache-layers" role="group" aria-label="Chart layers">
        ${layers.map(layer => html`<button type="button" class="ctx-cache-layer" data-layer=${layer.id} aria-pressed=${String(enabled.has(layer.id))} data-tip=${layer.help} onClick=${toggleLayer}>${layer.label}</button>`)}
      </div>
      <div class="ctx-cache-timeline"><canvas id=${chartId} role="img" aria-label=${describeTimeline(data)}></canvas></div>
      ${callTimelineTable(data.timeline, layers, data.unit, tableCaption(data))}` : html`<div class="ctx-comp-note">Nothing to plot for this session.</div>`}
    ${breakTable(data)}
  </div>`, panel);
  draw();
}

function closePanel(toggle: HTMLButtonElement): void {
  toggle.setAttribute('aria-expanded', 'false');
  const panel = document.getElementById(toggle.getAttribute('aria-controls') ?? '');
  if (!panel) return;
  // Also destroy the charts of session panels nested in a workspace panel.
  for (const el of [panel, ...panel.querySelectorAll<HTMLElement>('[data-chart-id]')]) {
    if (el.dataset.chartId) destroyChartById(el.dataset.chartId);
  }
  unmount(panel);
  panel.hidden = true;
}

/** Wire session rows below `root`: one open session at a time, timelines loaded on demand. */
export function attachSessionToggles(root: HTMLElement): void {
  const toggles = [...root.querySelectorAll<HTMLButtonElement>('.ctx-cache-session-toggle')];
  for (const toggle of toggles) {
    let generation = 0;
    toggle.addEventListener('click', () => {
      const load = ++generation;
      const wasOpen = toggle.getAttribute('aria-expanded') === 'true';
      for (const other of toggles) if (other.getAttribute('aria-expanded') === 'true') closePanel(other);
      if (wasOpen) return;
      const panel = document.getElementById(toggle.getAttribute('aria-controls') ?? '');
      const sessionId = toggle.closest<HTMLElement>('.ctx-cache-session')?.dataset.sessionId;
      if (!panel || !sessionId) return;
      toggle.setAttribute('aria-expanded', 'true');
      panel.hidden = false;
      render(html`<div class="ctx-comp-note">Loading the session timeline\u2026</div>`, panel);
      const isCurrent = () => load === generation && toggle.getAttribute('aria-expanded') === 'true' && panel.isConnected;
      void rpc<SessionTimelineData | null>('getSessionTimeline', { sessionId })
        .then(data => {
          if (!isCurrent()) return;
          if (data) renderPanel(panel, data);
          else render(html`<div class="ctx-comp-note">This session is no longer loaded.</div>`, panel);
        })
        .catch(() => {
          if (isCurrent()) render(html`<div class="ctx-comp-note">Could not load the session timeline.</div>`, panel);
        });
    });
  }
}

export function renderWorkspaceList(workspaces: WorkspacePromptCache[]): ComponentChildren {
  if (workspaces.length === 0) return html`<div class="ctx-comp-note">No workspace logged cache usage in this range.</div>`;
  return html`<div class="ctx-comp-ws-list">
    ${workspaces.map((w, i) => html`<div class="ctx-cache-ws" data-workspace=${w.workspaceId} data-harness=${w.harness}>
      <div class="ctx-comp-ws-head">
        <span class="ctx-comp-ws-name" title=${w.workspaceName}>${w.workspaceName}</span>
        <span class="ctx-comp-ws-stat">${pctText(w.hitPct)} hit \u00b7 ${w.breaks == null ? `${formatNum(w.misses)} missed` : `${countText(w.breaks, 'break')}, ${formatNum(w.rebuiltTokens ?? 0)} rebuilt`}${w.topCause ? ` \u00b7 ${CAUSE_META[w.topCause].short}` : ''} \u00b7 ${shortHarness(w.harness)}</span>
        <button type="button" class="ctx-comp-ws-toggle ctx-cache-ws-toggle" aria-expanded="false" aria-controls=${`ctxCacheWsSessions${i}`}
          aria-label=${`Show ${shortHarness(w.harness)} sessions for ${w.workspaceName}`}>Sessions</button>
      </div>
      <div class="ctx-cache-ws-sessions" id=${`ctxCacheWsSessions${i}`} hidden></div>
    </div>`)}
  </div>`;
}

/** Wire workspace "Sessions" buttons: each loads that workspace's sessions with cache data. */
export function attachWorkspaceToggles(root: HTMLElement, filter: DateFilter): void {
  const toggles = [...root.querySelectorAll<HTMLButtonElement>('.ctx-cache-ws-toggle')];
  for (const toggle of toggles) {
    let generation = 0;
    toggle.addEventListener('click', () => {
      const load = ++generation;
      const wasOpen = toggle.getAttribute('aria-expanded') === 'true';
      for (const other of toggles) if (other.getAttribute('aria-expanded') === 'true') closePanel(other);
      if (wasOpen) return;
      const workspace = toggle.closest<HTMLElement>('.ctx-cache-ws');
      const panel = document.getElementById(toggle.getAttribute('aria-controls') ?? '');
      if (!workspace || !panel) return;
      toggle.setAttribute('aria-expanded', 'true');
      panel.hidden = false;
      render(html`<div class="ctx-comp-note">Loading sessions\u2026</div>`, panel);
      const isCurrent = () => load === generation && toggle.getAttribute('aria-expanded') === 'true' && panel.isConnected;
      void rpc<PromptCacheSessionsData>('getPromptCacheSessions', { workspaceId: workspace.dataset.workspace, harness: workspace.dataset.harness, filter })
        .then(data => {
          if (!isCurrent()) return;
          render(data.sessions.length === 0
            ? html`<div class="ctx-comp-note">No session in this workspace logged cache usage in this range.</div>`
            : html`${renderSessionList(data.sessions, `Sessions in ${data.workspaceName}`)}${data.total > data.sessions.length ? html`<div class="ctx-comp-note">Showing the ${data.sessions.length} most recent of ${data.total} sessions.</div>` : null}`, panel);
          attachSessionToggles(panel);
        })
        .catch(() => {
          if (isCurrent()) render(html`<div class="ctx-comp-note">Could not load sessions.</div>`, panel);
        });
    });
  }
}
