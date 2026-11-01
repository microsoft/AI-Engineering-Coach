/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * @vitest-environment jsdom
 * cspell:ignore unstub
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

beforeAll(() => {
  vi.stubGlobal('acquireVsCodeApi', () => ({
    postMessage: vi.fn(),
    getState: () => null,
    setState: vi.fn(),
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('createChart', () => {
  it.each(['missing', 'detached'])('skips a %s canvas without registering an invalid chart', async (state) => {
    const { Chart, createChart } = await import('./shared');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const before = Object.keys(Chart.instances);
    if (state === 'detached') {
      const canvas = document.createElement('canvas');
      canvas.id = 'output-chart';
      document.body.appendChild(canvas);
      canvas.remove();
    }

    expect(createChart('output-chart', 'bar', { labels: [], datasets: [] })).toBeNull();
    expect(Object.keys(Chart.instances)).toEqual(before);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "createChart: canvas 'output-chart' not in DOM (stale render?)",
    );
  });
});
