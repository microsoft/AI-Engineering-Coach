/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Threshold lines, event markers and bands drawn on a Chart.js chart by a small inline plugin. Chart.js ignores
 * `options.plugins.annotation` unless chartjs-plugin-annotation is registered, and the extension doesn't ship it;
 * this draws the few shapes Context Management needs without another dependency. */

import type { Chart, Plugin } from 'chart.js';

/** Horizontal line at a value of a y axis, e.g. a utilization threshold. */
export interface GuideLine {
  y: number;
  color: string;
  label?: string;
  /** Default: the line's color. */
  labelColor?: string;
  /** Where the label sits along the line. */
  labelAt?: 'start' | 'end';
  dash?: number[];
  /** Default `y`. */
  yAxisID?: string;
}

/** Vertical line at an x value (a category index), e.g. a compaction. */
export interface GuideMarker {
  x: number;
  color: string;
  label?: string;
  dash?: number[];
}

/** Bar between two x values in a row stacked up from the bottom of the chart area, e.g. a to-do item's lifetime. */
export interface GuideBand {
  xMin: number;
  xMax: number;
  /** Row from the bottom of the chart area, 0 being the lowest. */
  row: number;
  fill: string;
  stroke: string;
  label?: string;
  labelColor?: string;
}

export interface ChartGuides {
  lines?: GuideLine[];
  markers?: GuideMarker[];
  bands?: GuideBand[];
}

export interface GuideArea {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Pixel position of a value on an axis; `null` when the chart has no such axis. */
export type GuidePixel = (axisId: string, value: number) => number | null;

export interface GuideLayout {
  lines: { y: number; color: string; dash: number[]; label?: string; labelColor: string; labelX: number; align: 'left' | 'right' }[];
  markers: { x: number; color: string; dash: number[]; label?: string }[];
  bands: { x: number; y: number; width: number; height: number; fill: string; stroke: string; label?: string; labelColor: string }[];
}

/** Past this many marker positions their labels overlap, so only the lines are drawn. */
export const MAX_MARKER_LABELS = 12;
/** Height of a band row in pixels, with room for its label. */
export const BAND_ROW_PX = 11;
/** Bands fill at most this share of the chart area's height; when there are more rows, the rows get thinner. */
export const MAX_BAND_SHARE = 0.4;
/** Bands thinner than this, in pixels, are drawn without their label. */
const BAND_LABEL_MIN_PX = 8;
const EDGE = 0.5;

function within(value: number, min: number, max: number): boolean {
  return Number.isFinite(value) && value >= min - EDGE && value <= max + EDGE;
}

function layoutLines(lines: GuideLine[], pixel: GuidePixel, area: GuideArea): GuideLayout['lines'] {
  const out: GuideLayout['lines'] = [];
  for (const line of lines) {
    const y = pixel(line.yAxisID ?? 'y', line.y);
    if (y == null || !within(y, area.top, area.bottom)) continue;
    const end = line.labelAt === 'end';
    out.push({
      y, color: line.color, dash: line.dash ?? [], label: line.label, labelColor: line.labelColor ?? line.color,
      labelX: end ? area.right - 4 : area.left + 4, align: end ? 'right' : 'left',
    });
  }
  return out;
}

/** One label for markers at the same position: the first one's, and how many more there are. */
function groupLabel(group: GuideMarker[]): string | undefined {
  const labels = group.map(marker => marker.label).filter((label): label is string => !!label);
  if (labels.length === 0) return undefined;
  return labels.length === 1 ? labels[0] : `${labels[0]} +${labels.length - 1}`;
}

function layoutMarkers(markers: GuideMarker[], pixel: GuidePixel, area: GuideArea): GuideLayout['markers'] {
  const placed: { marker: GuideMarker; x: number }[] = [];
  const atPosition = new Map<number, GuideMarker[]>();
  for (const marker of markers) {
    const x = pixel('x', marker.x);
    if (x == null || !within(x, area.left, area.right)) continue;
    placed.push({ marker, x });
    const group = atPosition.get(marker.x);
    if (group) group.push(marker);
    else atPosition.set(marker.x, [marker]);
  }
  const labelled = atPosition.size <= MAX_MARKER_LABELS;
  return placed.map(({ marker, x }) => {
    const group = atPosition.get(marker.x) ?? [marker];
    const label = labelled && group[0] === marker ? groupLabel(group) : undefined;
    return { x, color: marker.color, dash: marker.dash ?? [], label };
  });
}

function layoutBands(bands: GuideBand[], pixel: GuidePixel, area: GuideArea): GuideLayout['bands'] {
  const valid = bands.filter(band => Number.isInteger(band.row) && band.row >= 0);
  const rows = valid.reduce((most, band) => Math.max(most, band.row + 1), 0);
  if (rows === 0) return [];
  const rowHeight = Math.min(BAND_ROW_PX, ((area.bottom - area.top) * MAX_BAND_SHARE) / rows);
  const height = Math.max(rowHeight - 1, 1);
  const out: GuideLayout['bands'] = [];
  for (const band of valid) {
    const x1 = pixel('x', band.xMin);
    const x2 = pixel('x', band.xMax);
    if (x1 == null || x2 == null || !Number.isFinite(x1) || !Number.isFinite(x2)) continue;
    const left = Math.max(area.left, Math.min(x1, x2));
    const right = Math.min(area.right, Math.max(x1, x2));
    if (right < left) continue;
    out.push({
      x: left, y: area.bottom - (band.row + 1) * rowHeight + 1, width: Math.max(right - left, 2), height,
      fill: band.fill, stroke: band.stroke, label: height >= BAND_LABEL_MIN_PX ? band.label : undefined, labelColor: band.labelColor ?? band.stroke,
    });
  }
  return out;
}

/** Pixel geometry of the guides inside the chart area; guides outside it are left out. */
export function layoutGuides(guides: ChartGuides, pixel: GuidePixel, area: GuideArea): GuideLayout {
  return {
    lines: layoutLines(guides.lines ?? [], pixel, area),
    markers: layoutMarkers(guides.markers ?? [], pixel, area),
    bands: layoutBands(guides.bands ?? [], pixel, area),
  };
}

/** The 2D-context calls the guides use (a subset of CanvasRenderingContext2D, so tests can record them). */
export type GuideContext = Pick<CanvasRenderingContext2D,
  'save' | 'restore' | 'beginPath' | 'rect' | 'clip' | 'moveTo' | 'lineTo' | 'stroke' | 'fillRect' | 'strokeRect' | 'fillText'
  | 'setLineDash' | 'translate' | 'rotate'>
  & { strokeStyle: unknown; fillStyle: unknown; lineWidth: number; font: string; textAlign: CanvasTextAlign; textBaseline: CanvasTextBaseline };

function clipTo(ctx: GuideContext, area: GuideArea): void {
  ctx.beginPath();
  ctx.rect(area.left, area.top, area.right - area.left, area.bottom - area.top);
  ctx.clip();
}

export function drawBands(ctx: GuideContext, layout: GuideLayout, area: GuideArea): void {
  if (layout.bands.length === 0) return;
  ctx.save();
  clipTo(ctx, area);
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.font = '8px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  for (const band of layout.bands) {
    ctx.fillStyle = band.fill;
    ctx.fillRect(band.x, band.y, band.width, band.height);
    ctx.strokeStyle = band.stroke;
    ctx.strokeRect(band.x, band.y, band.width, band.height);
    if (band.label) {
      ctx.fillStyle = band.labelColor;
      ctx.fillText(band.label, band.x + 2, band.y + band.height / 2);
    }
  }
  ctx.restore();
}

export function drawLinesAndMarkers(ctx: GuideContext, layout: GuideLayout, area: GuideArea): void {
  if (layout.lines.length === 0 && layout.markers.length === 0) return;
  ctx.save();
  clipTo(ctx, area);
  ctx.lineWidth = 1;
  ctx.font = '10px sans-serif';
  for (const line of layout.lines) {
    ctx.strokeStyle = line.color;
    ctx.setLineDash(line.dash);
    ctx.beginPath();
    ctx.moveTo(area.left, line.y);
    ctx.lineTo(area.right, line.y);
    ctx.stroke();
    if (line.label) {
      ctx.setLineDash([]);
      ctx.fillStyle = line.labelColor;
      ctx.textAlign = line.align;
      ctx.textBaseline = 'bottom';
      ctx.fillText(line.label, line.labelX, line.y - 2);
    }
  }
  ctx.font = '9px sans-serif';
  for (const marker of layout.markers) {
    ctx.strokeStyle = marker.color;
    ctx.setLineDash(marker.dash);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(marker.x, area.top);
    ctx.lineTo(marker.x, area.bottom);
    ctx.stroke();
    if (marker.label) {
      ctx.save();
      ctx.setLineDash([]);
      ctx.fillStyle = marker.color;
      ctx.translate(marker.x + 3, area.top + 4);
      ctx.rotate(Math.PI / 2);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillText(marker.label, 0, 0);
      ctx.restore();
    }
  }
  ctx.restore();
}

/** Chart.js plugin that draws the guides: bands behind the datasets, lines and markers over them. */
export function chartGuidesPlugin(guides: ChartGuides): Plugin {
  const layoutFor = (chart: Chart): { layout: GuideLayout; area: GuideArea } | null => {
    const area = chart.chartArea;
    if (!area) return null;
    const pixel: GuidePixel = (axisId, value) => {
      const scale = chart.scales[axisId];
      return scale ? scale.getPixelForValue(value) : null;
    };
    return { layout: layoutGuides(guides, pixel, area), area };
  };
  return {
    id: 'contextChartGuides',
    beforeDatasetsDraw(chart: Chart): void {
      const laid = layoutFor(chart);
      if (laid) drawBands(chart.ctx, laid.layout, laid.area);
    },
    afterDatasetsDraw(chart: Chart): void {
      const laid = layoutFor(chart);
      if (!laid) return;
      drawLinesAndMarkers(chart.ctx, laid.layout, laid.area);
      // What was drawn, for debugging and the end-to-end tests (the canvas pixels can't be inspected).
      if (chart.canvas) chart.canvas.dataset.guides = `lines=${laid.layout.lines.length} markers=${laid.layout.markers.length} bands=${laid.layout.bands.length}`;
    },
  };
}

/** Text equivalent of the guides for screen readers, e.g. "Lines: Degraded from 50%, Limited from 80%." */
export function describeGuides(guides: ChartGuides): string {
  const parts: string[] = [];
  const lines = (guides.lines ?? []).map(line => line.label).filter((label): label is string => !!label);
  if (lines.length > 0) parts.push(`Lines: ${lines.join(', ')}.`);
  const markers = (guides.markers ?? []).map(marker => marker.label).filter((label): label is string => !!label);
  if (markers.length > 0) parts.push(`Markers: ${markers.join(', ')}.`);
  const bands = (guides.bands ?? []).map(band => band.label).filter((label): label is string => !!label);
  if (bands.length > 0) parts.push(`Bands: ${bands.join(', ')}.`);
  return parts.join(' ');
}
