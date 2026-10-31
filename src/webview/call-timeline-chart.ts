/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Reusable, layered chart of a session's call timeline (`CallTimeline`). Each layer contributes datasets
 * (one value per bucket) and/or markers keyed by bucket; markers that several layers put on the same bucket
 * merge into one labelled marker. The prompt-cache view adds cache-token and cache-break layers; other
 * views can add their own (for example a context limit or compaction markers) on the same chart. */

import type { CallTimeline, CallTimelineBucket } from '../core/types';
import { Chart, destroyChartById, formatNum, trackChart } from './shared';
import { html, type ComponentChildren } from './render';

export interface CallTimelineMarker {
  /** Short label drawn next to the marker line, e.g. "Expired". */
  label: string;
  /** Full text for the tooltip and accessible descriptions. */
  detail: string;
  color: string;
}

export interface CallTimelineLayer {
  id: string;
  label: string;
  /** Explains what the layer shows; used for the toggle's tooltip. */
  help: string;
  defaultOn: boolean;
  /** Chart.js datasets for this layer, one value per bucket. */
  datasets?: (timeline: CallTimeline) => Record<string, unknown>[];
  /** Markers keyed by bucket index. */
  markers?: (timeline: CallTimeline) => Map<number, CallTimelineMarker[]>;
}

export interface CallTimelineChartOptions {
  /** `calls`: one point per main-agent model call; `requests`: one per request. */
  unit: 'calls' | 'requests';
  yTitle: string;
  /** Title of the right-hand axis, for datasets with `yAxisID: 'y1'`; the axis shows only when one is drawn. */
  y1Title?: string;
}

const MAX_MARKER_LABELS = 12;

/** "#12" or "#12–15" for model calls, "R3" or "R3–4" for requests (1-based). */
export function bucketLabel(bucket: CallTimelineBucket, unit: CallTimelineChartOptions['unit']): string {
  const prefix = unit === 'calls' ? '#' : 'R';
  const first = (unit === 'calls' ? bucket.firstCall : bucket.firstRequest) + 1;
  const last = (unit === 'calls' ? bucket.lastCall : bucket.lastRequest) + 1;
  return first === last ? `${prefix}${first}` : `${prefix}${first}\u2013${last}`;
}

function formatClock(ts: number | null): string {
  return ts == null ? '' : new Date(ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

/** Markers of all enabled layers, merged per bucket. */
export function mergeMarkers(timeline: CallTimeline, layers: CallTimelineLayer[]): Map<number, CallTimelineMarker[]> {
  const merged = new Map<number, CallTimelineMarker[]>();
  for (const layer of layers) {
    for (const [index, markers] of layer.markers?.(timeline) ?? []) {
      if (index < 0 || index >= timeline.buckets.length) continue;
      merged.set(index, [...(merged.get(index) ?? []), ...markers]);
    }
  }
  return merged;
}

/** One combined label per bucket: repeated labels collapse into "Expired ×2". */
export function markerText(markers: CallTimelineMarker[]): string {
  const counts = new Map<string, number>();
  for (const marker of markers) counts.set(marker.label, (counts.get(marker.label) ?? 0) + 1);
  return [...counts].map(([label, n]) => (n > 1 ? `${label} \u00d7${n}` : label)).join(' \u00b7 ');
}

/** Dashed line per marked bucket, with a label when there are few enough to read. */
function markerPlugin(markers: Map<number, CallTimelineMarker[]>) {
  return {
    id: 'callTimelineMarkers',
    afterDatasetsDraw(chart: Chart): void {
      const xScale = chart.scales.x;
      const area = chart.chartArea;
      if (!xScale || !area) return;
      const ctx = chart.ctx;
      ctx.save();
      ctx.font = '10px sans-serif';
      for (const [index, list] of markers) {
        const x = xScale.getPixelForValue(index);
        ctx.strokeStyle = list[0].color;
        ctx.fillStyle = list[0].color;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(x, area.top);
        ctx.lineTo(x, area.bottom);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(x - 4, area.top - 6);
        ctx.lineTo(x + 4, area.top - 6);
        ctx.lineTo(x, area.top);
        ctx.fill();
        if (markers.size <= MAX_MARKER_LABELS) ctx.fillText(markerText(list), x + 4, area.top + 10);
      }
      ctx.restore();
    },
  };
}

interface TooltipItem { dataIndex: number; dataset: { label?: string }; parsed: { y: number | null } }

/** Right-hand axis for datasets with `yAxisID: 'y1'`, which are on a much smaller scale than the bars. */
function rightAxis(title: string | undefined): Record<string, unknown> {
  return {
    y1: { position: 'right', beginAtZero: true, title: { display: Boolean(title), text: title ?? '', color: '#8b949e' }, ticks: { color: '#8b949e', callback: (value: number | string) => formatNum(Number(value)) }, grid: { drawOnChartArea: false } },
  };
}

/** Draw the chart for the enabled layers; returns the chart, or `null` when the canvas isn't in the DOM. */
export function renderCallTimelineChart(
  canvasId: string,
  timeline: CallTimeline,
  layers: CallTimelineLayer[],
  options: CallTimelineChartOptions & { enabled: ReadonlySet<string> },
): Chart | null {
  destroyChartById(canvasId);
  const canvas = document.getElementById(canvasId) as HTMLCanvasElement | null;
  if (!canvas) return null;
  const active = layers.filter(layer => options.enabled.has(layer.id));
  const markers = mergeMarkers(timeline, active);
  const labels = timeline.buckets.map(bucket => bucketLabel(bucket, options.unit));
  const datasets = active.flatMap(layer => layer.datasets?.(timeline) ?? []);
  const chart = new Chart(canvas, {
    type: 'bar',
    data: { labels, datasets: datasets as never },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      layout: { padding: { top: 8 } },
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { stacked: true, ticks: { color: '#8b949e', maxRotation: 0, autoSkip: true, maxTicksLimit: 12 }, grid: { display: false } },
        y: { stacked: true, beginAtZero: true, title: { display: true, text: options.yTitle, color: '#8b949e' }, ticks: { color: '#8b949e', callback: (value: number | string) => formatNum(Number(value)) }, grid: { color: 'rgba(48,54,61,0.6)' } },
        ...(datasets.some(dataset => dataset.yAxisID === 'y1') ? rightAxis(options.y1Title) : {}),
      },
      plugins: {
        legend: { position: 'top', labels: { boxWidth: 10 } },
        tooltip: {
          callbacks: {
            title: (items: TooltipItem[]) => {
              const bucket = timeline.buckets[items[0]?.dataIndex ?? 0];
              if (!bucket) return '';
              const span = [formatClock(bucket.startTs), formatClock(bucket.endTs)].filter(Boolean);
              return `${bucketLabel(bucket, options.unit)}${span.length > 0 ? ` \u00b7 ${[...new Set(span)].join('\u2013')}` : ''}`;
            },
            label: (item: TooltipItem) => (item.parsed.y == null ? '' : `${item.dataset.label ?? ''}: ${formatNum(item.parsed.y)}`),
            afterBody: (items: TooltipItem[]) => (markers.get(items[0]?.dataIndex ?? -1) ?? []).map(marker => marker.detail),
          },
        },
      },
    } as never,
    plugins: [markerPlugin(markers)] as never,
  });
  trackChart(chart);
  return chart;
}

function seriesOf(dataset: Record<string, unknown>): unknown[] {
  const data: unknown = dataset.data;
  return Array.isArray(data) ? (data as unknown[]) : [];
}

function cellText(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? formatNum(value) : '\u2014';
}

/** Text equivalent of the chart for keyboard and screen-reader users, in a collapsed disclosure below it: one
 *  row per bar with its time span, every layer's values (toggled on or not) and the markers' full text. */
export function callTimelineTable(
  timeline: CallTimeline,
  layers: CallTimelineLayer[],
  unit: CallTimelineChartOptions['unit'],
  caption: string,
): ComponentChildren {
  const datasets = layers.flatMap(layer => layer.datasets?.(timeline) ?? []);
  const columns = datasets.map(dataset => (typeof dataset.label === 'string' ? dataset.label : ''));
  const series = datasets.map(seriesOf);
  const markers = mergeMarkers(timeline, layers);
  return html`<details class="call-timeline-data">
    <summary>Show the chart as a table</summary>
    <div class="call-timeline-data-scroll" role="region" tabindex="0" aria-label=${caption}>
      <table class="call-timeline-table">
        <caption>${caption}</caption>
        <thead><tr>
          <th scope="col">${unit === 'calls' ? 'Model calls' : 'Requests'}</th>
          <th scope="col">Time</th>
          ${columns.map(column => html`<th scope="col" class="num">${column}</th>`)}
          ${markers.size > 0 ? html`<th scope="col">Markers</th>` : null}
        </tr></thead>
        <tbody>${timeline.buckets.map((bucket, index) => html`<tr>
          <th scope="row">${bucketLabel(bucket, unit)}</th>
          <td>${[...new Set([formatClock(bucket.startTs), formatClock(bucket.endTs)].filter(Boolean))].join('\u2013')}</td>
          ${series.map(values => html`<td class="num">${cellText(values[index])}</td>`)}
          ${markers.size > 0 ? html`<td class="call-timeline-markers">${(markers.get(index) ?? []).map(marker => marker.detail).join('; ')}</td>` : null}
        </tr>`)}</tbody>
      </table>
    </div>
  </details>`;
}
