/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Context Management's drill-down for Copilot CLI and Copilot App sessions: the session's call timeline,
 * loaded lazily through `getSessionTimeline` and drawn with the shared layered chart (context, limit and
 * thresholds, turn ends, compactions, truncated calls; output and the cache split on demand), with two text
 * equivalents: the chart's values per bar (the shared table) and a per-turn table. Responses for a superseded
 * load are dropped. */

import type { ContextVerdictThresholds, SessionContextDetail, SessionTimelineData } from '../core/types';
import { destroyChartById, formatNum, rpc } from './shared';
import { html, render, type ComponentChildren } from './render';
import { callTimelineTable, renderCallTimelineChart, type CallTimelineLayer } from './call-timeline-chart';
import { cacheBreakLayer, cacheTokenLayer } from './prompt-cache-session';
import { compactionLayer, contextLimitLayer, contextPeakLayer, outputLayer, truncationLayer, turnEndLayer } from './context-timeline-layers';

export const CONTEXT_TIMELINE_CHART_ID = 'ctxSessionTimelineChart';
/** Most turns listed in the table. */
const MAX_TABLE_TURNS = 300;

/** Where a session's context timeline opens: Context Management's workspace table, or Context Composition's session
 *  list. Each place has its own chart, turn table and loads, so both can be open at once. */
export type ContextTimelinePlace = 'workspace-table' | 'composition';

const PLACE_IDS: Record<ContextTimelinePlace, { chart: string; turns: string }> = {
  'workspace-table': { chart: CONTEXT_TIMELINE_CHART_ID, turns: 'ctxTlTurnTable' },
  composition: { chart: 'ctxCompSessionTimelineChart', turns: 'ctxCompTlTurnTable' },
};

const loadGenerations = new Map<ContextTimelinePlace, number>();

/** Start a load at a place, superseding the one before it there. */
function nextLoad(place: ContextTimelinePlace): number {
  const load = (loadGenerations.get(place) ?? 0) + 1;
  loadGenerations.set(place, load);
  return load;
}

/** Context layers first; the cache layers are off by default here (the Prompt Cache tab shows them). */
export function contextTimelineLayers(data: SessionTimelineData, thresholds: ContextVerdictThresholds): CallTimelineLayer[] {
  return [
    contextPeakLayer(),
    contextLimitLayer(thresholds),
    turnEndLayer(data),
    compactionLayer(data),
    truncationLayer(),
    outputLayer(),
    { ...cacheTokenLayer(data.unit), defaultOn: false },
    { ...cacheBreakLayer(data), defaultOn: false },
  ];
}

function describe(data: SessionTimelineData): string {
  const compactions = data.context?.compactions.length ?? 0;
  return `Context size per model call against the reported limit${compactions > 0 ? `, with ${compactions} compaction${compactions === 1 ? '' : 's'} marked` : ''}. Below the chart, show it as a table for the values of each bar, or the turns as a table for each turn.`;
}

const TABLE_CAPTION = 'Values of each bar of model calls: context, limit and thresholds, turn ends, output and reasoning per call, cache tokens, and markers';

function cell(value: number | null | undefined, format: (n: number) => string = formatNum): string {
  return value == null ? '\u2014' : format(value);
}

/** Text equivalent of the chart: one row per turn with context data or a compaction. */
export function renderTurnTable(s: SessionContextDetail): ComponentChildren {
  const compactions = new Map<number, number>();
  for (const event of s.events) if (event.type === 'compaction') compactions.set(event.requestIndex, (compactions.get(event.requestIndex) ?? 0) + 1);
  const turns = s.tokenCurve.map((_, i) => i).filter(i => s.tokenCurve[i] != null || compactions.has(i));
  const shown = turns.slice(0, MAX_TABLE_TURNS);
  return html`<table class="ctx-cache-table ctx-tl-turns" aria-label="Context per turn">
    <thead><tr>
      <th scope="col">Turn</th><th scope="col" class="num">Context at end</th><th scope="col" class="num">Largest prompt</th>
      <th scope="col" class="num">Limit</th><th scope="col" class="num">% of limit</th><th scope="col" class="num">Model calls</th>
      <th scope="col" class="num">Cache hit</th><th scope="col" class="num">Compactions</th>
    </tr></thead>
    <tbody>${shown.map(i => {
      const tokens = s.tokenCurve[i];
      const limit = s.turnLimits?.[i] ?? null;
      return html`<tr>
        <th scope="row">${i + 1}</th>
        <td class="num">${cell(tokens)}</td>
        <td class="num">${cell(s.turnPeaks?.[i])}</td>
        <td class="num">${cell(limit)}</td>
        <td class="num">${tokens != null && limit ? `${Math.round((tokens / limit) * 1000) / 10}%` : '\u2014'}</td>
        <td class="num">${cell(s.turnCalls?.[i], String)}</td>
        <td class="num">${cell(s.turnCacheHitPct?.[i], n => `${n}%`)}</td>
        <td class="num">${compactions.get(i) ?? 0}</td>
      </tr>`;
    })}</tbody>
  </table>${turns.length > shown.length ? html`<div class="ctx-cache-muted">Showing the first ${shown.length} of ${turns.length} turns.</div>` : null}`;
}

function toggleControlled(event: Event): void {
  const button = event.currentTarget as HTMLButtonElement;
  const open = button.getAttribute('aria-expanded') !== 'true';
  button.setAttribute('aria-expanded', String(open));
  const target = document.getElementById(button.getAttribute('aria-controls') ?? '');
  if (target) target.hidden = !open;
}

/** What a loaded timeline panel shows, and where. */
interface TimelineView {
  s: SessionContextDetail;
  data: SessionTimelineData;
  thresholds: ContextVerdictThresholds;
  place: ContextTimelinePlace;
}

function renderPanel(panel: HTMLElement, { s, data, thresholds, place }: TimelineView): void {
  const timeline = data.timeline;
  if (!timeline) {
    render(html`<div class="ctx-comp-note">Nothing to plot for this session.</div>`, panel);
    return;
  }
  const ids = PLACE_IDS[place];
  const layers = contextTimelineLayers(data, thresholds);
  const enabled = new Set(layers.filter(layer => layer.defaultOn).map(layer => layer.id));
  const draw = () => renderCallTimelineChart(ids.chart, timeline, layers, { unit: data.unit, yTitle: 'Prompt tokens', y1Title: 'Output tokens per call', enabled });
  const toggleLayer = (event: Event) => {
    const button = event.currentTarget as HTMLButtonElement;
    const id = button.dataset.layer ?? '';
    if (enabled.has(id)) enabled.delete(id);
    else enabled.add(id);
    button.setAttribute('aria-pressed', String(enabled.has(id)));
    draw();
  };
  const omitted = data.context?.omittedCompactions ?? 0;
  render(html`<div class="ctx-tl" data-session-id=${s.sessionId}>
    <div class="ctx-cache-layers ctx-tl-layers" role="group" aria-label="Chart layers">
      ${layers.map(layer => html`<button type="button" class="ctx-cache-layer" data-layer=${layer.id} aria-pressed=${String(enabled.has(layer.id))} data-tip=${layer.help} onClick=${toggleLayer}>${layer.label}</button>`)}
    </div>
    <div class="ctx-cache-timeline ctx-tl-chart"><canvas id=${ids.chart} role="img" aria-label=${describe(data)}></canvas></div>
    ${callTimelineTable(timeline, layers, data.unit, TABLE_CAPTION)}
    <div class="ctx-tl-foot">
      ${timeline.bucketSize > 1 ? html`<span class="ctx-cache-muted">Each bar covers ${timeline.bucketSize} model calls of ${formatNum(timeline.calls)}.</span>` : null}
      ${omitted > 0 ? html`<span class="ctx-cache-muted">${omitted} more compactions are counted but not marked.</span>` : null}
      <button type="button" class="ctx-tt-expand ctx-tl-turns-toggle" aria-expanded="false" aria-controls=${ids.turns} onClick=${toggleControlled}>Turns as a table</button>
    </div>
    <div id=${ids.turns} hidden>${renderTurnTable(s)}</div>
  </div>`, panel);
  draw();
}

/** Load and draw the session's call timeline into `panel`, at one of the places it opens. */
export function renderContextTimeline(
  panel: HTMLElement,
  s: SessionContextDetail,
  thresholds: ContextVerdictThresholds,
  place: ContextTimelinePlace = 'workspace-table',
): void {
  const load = nextLoad(place);
  render(html`<div class="ctx-comp-note">Loading the session timeline\u2026</div>`, panel);
  const isCurrent = () => load === loadGenerations.get(place) && panel.isConnected;
  void rpc<SessionTimelineData | null>('getSessionTimeline', { sessionId: s.sessionId })
    .then(data => {
      if (!isCurrent()) return;
      if (data) renderPanel(panel, { s, data, thresholds, place });
      else render(html`<div class="ctx-comp-note">This session is no longer loaded.</div>`, panel);
    })
    .catch(() => {
      if (isCurrent()) render(html`<div class="ctx-comp-note">Could not load the session timeline.</div>`, panel);
    });
}

/** Drop the timeline drawn at a place (when its drill-down closes). */
export function closeContextTimeline(place: ContextTimelinePlace = 'workspace-table'): void {
  nextLoad(place);
  destroyChartById(PLACE_IDS[place].chart);
}
