/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Chart guides: Chart.js ignores annotation options without chartjs-plugin-annotation, so Context Management
 * draws its threshold lines, event markers and to-do bands with this inline plugin. */

import { describe, expect, it } from 'vitest';
import type { Chart } from 'chart.js';
import {
  BAND_ROW_PX,
  MAX_BAND_SHARE,
  MAX_MARKER_LABELS,
  chartGuidesPlugin,
  describeGuides,
  layoutGuides,
  type ChartGuides,
  type GuideArea,
  type GuideBand,
  type GuideContext,
  type GuidePixel,
} from './chart-guides';

const AREA: GuideArea = { left: 40, right: 440, top: 10, bottom: 210 };
/** y: 0-100 % over the 200 px tall area; x: category i at 40 + 20 * i + 10. */
const PIXEL: GuidePixel = (axis, value) => (axis === 'y' ? 210 - value * 2 : axis === 'x' ? 50 + value * 20 : null);
/** The chart area of a session chart in its 226 px container: about 195 px tall. */
const SESSION_AREA: GuideArea = { left: 48, right: 1100, top: 8, bottom: 203 };

interface Call { op: string; args: unknown[]; strokeStyle?: unknown; fillStyle?: unknown }

/** A 2D context that records the calls the guides make. */
function recordingContext(): { ctx: GuideContext; calls: Call[] } {
  const calls: Call[] = [];
  const state = { strokeStyle: '' as unknown, fillStyle: '' as unknown, lineWidth: 1, font: '', textAlign: 'left' as CanvasTextAlign, textBaseline: 'alphabetic' as CanvasTextBaseline };
  const record = (op: string) => (...args: unknown[]) => { calls.push({ op, args, strokeStyle: state.strokeStyle, fillStyle: state.fillStyle }); };
  const ctx = Object.assign(state, {
    save: record('save'), restore: record('restore'), beginPath: record('beginPath'), rect: record('rect'), clip: record('clip'),
    moveTo: record('moveTo'), lineTo: record('lineTo'), stroke: record('stroke'), fillRect: record('fillRect'), strokeRect: record('strokeRect'),
    fillText: record('fillText'), setLineDash: record('setLineDash'), translate: record('translate'), rotate: record('rotate'),
  }) as unknown as GuideContext;
  return { ctx, calls };
}

const GUIDES: ChartGuides = {
  lines: [
    { y: 50, color: 'rgba(210,153,34,0.5)', labelColor: '#d29922', label: 'Degraded (50%)', dash: [6, 4] },
    { y: 80, color: 'rgba(248,81,73,0.5)', label: '80%', labelAt: 'end' },
  ],
  markers: [{ x: 3, color: '#f85149', label: 'Compaction 120K\u219240K' }],
  bands: [{ xMin: 1, xMax: 4, row: 0, fill: '#3fb95030', stroke: '#3fb95080', label: '\u2714 Write tests' }],
};

const band = (row: number): GuideBand => ({ xMin: 0, xMax: 2, row, fill: 'f', stroke: 's', label: `To-do ${row}` });

describe('layoutGuides', () => {
  it('places threshold lines, markers and bands in pixels', () => {
    const layout = layoutGuides(GUIDES, PIXEL, AREA);
    expect(layout.lines).toEqual([
      { y: 110, color: 'rgba(210,153,34,0.5)', dash: [6, 4], label: 'Degraded (50%)', labelColor: '#d29922', labelX: 44, align: 'left' },
      { y: 50, color: 'rgba(248,81,73,0.5)', dash: [], label: '80%', labelColor: 'rgba(248,81,73,0.5)', labelX: 436, align: 'right' },
    ]);
    expect(layout.markers).toEqual([{ x: 110, color: '#f85149', dash: [], label: 'Compaction 120K\u219240K' }]);
    expect(layout.bands).toEqual([{ x: 70, y: 200, width: 60, height: 10, fill: '#3fb95030', stroke: '#3fb95080', label: '\u2714 Write tests', labelColor: '#3fb95080' }]);
  });

  it('leaves out guides outside the chart area or on a missing axis', () => {
    const layout = layoutGuides({
      lines: [{ y: 120, color: 'red' }, { y: 10, color: 'red', yAxisID: 'y1' }],
      markers: [{ x: -2, color: 'red' }, { x: 40, color: 'red' }],
      bands: [{ xMin: 30, xMax: 40, row: 0, fill: 'f', stroke: 's' }],
    }, PIXEL, AREA);
    expect(layout).toEqual({ lines: [], markers: [], bands: [] });
  });

  it('clips a band to the chart area and drops marker labels once there are too many to read', () => {
    const layout = layoutGuides({
      markers: Array.from({ length: MAX_MARKER_LABELS + 1 }, (_, i) => ({ x: i, color: 'red', label: `M${i}` })),
      bands: [{ xMin: -1, xMax: 2, row: 0, fill: 'f', stroke: 's' }],
    }, PIXEL, AREA);
    expect(layout.markers).toHaveLength(MAX_MARKER_LABELS + 1);
    expect(layout.markers.every(marker => marker.label === undefined)).toBe(true);
    expect(layout.bands[0]).toMatchObject({ x: 40, width: 50 });
  });
});

describe('layoutGuides bands', () => {
  it('stacks the rows up from the bottom of a session chart, tall enough for their labels', () => {
    const { bands } = layoutGuides({ bands: [0, 1, 2, 3].map(band) }, PIXEL, SESSION_AREA);
    expect(bands.map(b => [b.y, b.height, b.label])).toEqual([
      [193, 10, 'To-do 0'],
      [182, 10, 'To-do 1'],
      [171, 10, 'To-do 2'],
      [160, 10, 'To-do 3'],
    ]);
  });

  it('thins the rows to keep them in the bottom of the chart, and leaves out labels too small to read', () => {
    const rows = 10;
    const { bands } = layoutGuides({ bands: Array.from({ length: rows }, (_, row) => band(row)) }, PIXEL, SESSION_AREA);
    const rowHeight = ((SESSION_AREA.bottom - SESSION_AREA.top) * MAX_BAND_SHARE) / rows;
    expect(rowHeight).toBeLessThan(BAND_ROW_PX);
    expect(bands).toHaveLength(rows);
    expect(bands.every(b => b.label === undefined && b.height === rowHeight - 1)).toBe(true);
    const top = Math.min(...bands.map(b => b.y));
    expect(SESSION_AREA.bottom - top).toBeLessThanOrEqual((SESSION_AREA.bottom - SESSION_AREA.top) * MAX_BAND_SHARE);
  });

  it('ignores bands with an invalid row', () => {
    const { bands } = layoutGuides({ bands: [band(Number.NaN), band(-1), band(1.5), band(0)] }, PIXEL, SESSION_AREA);
    expect(bands.map(b => [b.y, b.label])).toEqual([[193, 'To-do 0']]);
  });
});

describe('chartGuidesPlugin', () => {
  function fakeChart(ctx: GuideContext, canvas?: { dataset: Record<string, string> }): Chart {
    const scale = (axis: string) => ({ getPixelForValue: (value: number) => PIXEL(axis, value) as number });
    return { ctx, canvas, chartArea: AREA, scales: { x: scale('x'), y: scale('y') } } as unknown as Chart;
  }

  it('draws labelled bands before the datasets, and lines and markers after them, inside the chart area', () => {
    const plugin = chartGuidesPlugin(GUIDES) as unknown as { id: string; beforeDatasetsDraw(chart: Chart): void; afterDatasetsDraw(chart: Chart): void };
    const before = recordingContext();
    plugin.beforeDatasetsDraw(fakeChart(before.ctx));
    expect(before.calls.find(c => c.op === 'rect')?.args).toEqual([40, 10, 400, 200]);
    expect(before.calls.find(c => c.op === 'fillRect')).toMatchObject({ args: [70, 200, 60, 10], fillStyle: '#3fb95030' });
    expect(before.calls.filter(c => c.op === 'fillText')).toEqual([expect.objectContaining({ args: ['\u2714 Write tests', 72, 205], fillStyle: '#3fb95080' })]);
    expect(before.calls.some(c => c.op === 'moveTo')).toBe(false);

    const after = recordingContext();
    const canvas = { dataset: {} as Record<string, string> };
    plugin.afterDatasetsDraw(fakeChart(after.ctx, canvas));
    expect(canvas.dataset.guides).toBe('lines=2 markers=1 bands=1');
    const moves = after.calls.filter(c => c.op === 'moveTo').map(c => c.args);
    expect(moves).toEqual([[40, 110], [40, 50], [110, 10]]);
    expect(after.calls.filter(c => c.op === 'lineTo').map(c => c.args)).toEqual([[440, 110], [440, 50], [110, 210]]);
    expect(after.calls.find(c => c.op === 'setLineDash')?.args).toEqual([[6, 4]]);
    const texts = after.calls.filter(c => c.op === 'fillText');
    expect(texts.map(c => c.args[0])).toEqual(['Degraded (50%)', '80%', 'Compaction 120K\u219240K']);
    expect(texts[0]).toMatchObject({ fillStyle: '#d29922' });
    expect(after.calls.filter(c => c.op === 'save').length).toBe(after.calls.filter(c => c.op === 'restore').length);
    expect(plugin.id).toBe('contextChartGuides');
  });

  it('draws nothing before the chart is laid out', () => {
    const plugin = chartGuidesPlugin(GUIDES) as unknown as { afterDatasetsDraw(chart: Chart): void };
    const { ctx, calls } = recordingContext();
    plugin.afterDatasetsDraw({ ctx, chartArea: undefined, scales: {} } as unknown as Chart);
    expect(calls).toEqual([]);
  });
});

describe('describeGuides', () => {
  it('names the lines, markers and bands for screen readers', () => {
    expect(describeGuides(GUIDES)).toBe('Lines: Degraded (50%), 80%. Markers: Compaction 120K\u219240K. Bands: \u2714 Write tests.');
    expect(describeGuides({})).toBe('');
  });
});
