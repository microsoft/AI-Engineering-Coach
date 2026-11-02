/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * @vitest-environment jsdom
 */

/* The shared call-timeline chart treats datasets that share a label as one series: one legend entry that shows or
 * hides all of them, and one table column listing all their values (several turn ends in one bar). */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallTimeline } from '../core/types';

interface LegendItem { text: string; datasetIndex?: number }
interface FakeChart {
  data: CapturedConfig['data'];
  isDatasetVisible: (index: number) => boolean;
  setDatasetVisibility: (index: number, visible: boolean) => void;
  update: () => void;
}
interface CapturedConfig {
  data: { datasets: { label?: string }[] };
  options: { plugins: { legend: {
    labels: { filter(item: LegendItem, data: CapturedConfig['data']): boolean };
    onClick(event: unknown, item: LegendItem, legend: { chart: FakeChart }): void;
  } } };
}

const mocks = vi.hoisted(() => ({ configs: [] as unknown[] }));
vi.mock('./shared', () => ({
  Chart: class {
    constructor(_canvas: unknown, config: unknown) {
      mocks.configs.push(config);
    }
  },
  destroyChartById: vi.fn(),
  trackChart: vi.fn(),
  formatNum: (n: number) => `${Math.round(n / 1000)}K`,
}));

import { render } from './render';
import { callTimelineTable, renderCallTimelineChart, type CallTimelineLayer } from './call-timeline-chart';

function bucket(firstCall: number, lastCall: number, firstRequest: number, lastRequest: number): CallTimeline['buckets'][number] {
  return { firstCall, lastCall, firstRequest, lastRequest, startTs: null, endTs: null, cacheCalls: 0, cacheRead: 0, cacheWrite: 0, uncached: 0 };
}

const TIMELINE: CallTimeline = { calls: 4, bucketSize: 2, buckets: [bucket(0, 1, 0, 1), bucket(2, 3, 2, 2)] };

/** Two turns end in the first bar and one in the second: the turn-end series has two datasets. */
const LAYER: CallTimelineLayer = {
  id: 'turns',
  label: 'Turn ends',
  help: '',
  defaultOn: true,
  datasets: () => [
    { label: 'Context at turn end', data: [300_000, 120_000] },
    { label: 'Context at turn end', data: [90_000, null] },
    { label: 'Context limit (reported)', data: [968_000, 968_000] },
  ],
};

beforeEach(() => {
  mocks.configs.length = 0;
  document.body.innerHTML = '<canvas id="tl"></canvas>';
});

describe('call timeline series', () => {
  it('lists every value of a series in one table column, in dataset order', () => {
    const el = document.createElement('div');
    render(callTimelineTable(TIMELINE, [LAYER], 'calls', 'Values of each bar'), el);
    expect([...el.querySelectorAll('thead th')].map(th => th.textContent)).toEqual(['Model calls', 'Time', 'Context at turn end', 'Context limit (reported)']);
    expect([...el.querySelectorAll('tbody tr')].map(tr => [...tr.querySelectorAll('td.num')].map(td => td.textContent))).toEqual([
      ['300K, 90K', '968K'],
      ['120K', '968K'],
    ]);
  });

  it('gives a series one legend entry that shows or hides all of its datasets', () => {
    renderCallTimelineChart('tl', TIMELINE, [LAYER], { unit: 'calls', yTitle: 'Prompt tokens', enabled: new Set(['turns']) });
    const config = mocks.configs.at(-1) as CapturedConfig;
    const { data } = config;
    const legend = config.options.plugins.legend;
    expect(data.datasets.map((dataset, index) => legend.labels.filter({ text: dataset.label ?? '', datasetIndex: index }, data))).toEqual([true, false, true]);

    const visible = [true, true, true];
    const update = vi.fn();
    const chart: FakeChart = {
      data,
      isDatasetVisible: index => visible[index],
      setDatasetVisibility: (index, shown) => { visible[index] = shown; },
      update,
    };
    legend.onClick(null, { text: 'Context at turn end', datasetIndex: 0 }, { chart });
    expect(visible).toEqual([false, false, true]);
    expect(update).toHaveBeenCalledTimes(1);
    legend.onClick(null, { text: 'Context at turn end', datasetIndex: 0 }, { chart });
    expect(visible).toEqual([true, true, true]);
    legend.onClick(null, { text: 'Context limit (reported)', datasetIndex: 2 }, { chart });
    expect(visible).toEqual([true, true, false]);
  });
});
