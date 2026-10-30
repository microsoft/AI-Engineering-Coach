/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * @vitest-environment jsdom
 *
 * Copilot-backed requests must outlast the extension host's request budget. If
 * the webview gave up first, it would discard the late reply, or the host's
 * actionable error, and show a bare "RPC timeout" instead.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { COPILOT_REQUEST_BUDGET_MS } from '../core/copilot-model';

/** Time the host needs after its budget to post the reply back to the webview. */
const DELIVERY_MARGIN_MS = 60_000;

let rpc: typeof import('./shared').rpc;

beforeAll(async () => {
  (globalThis as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
    postMessage: () => { /* the host never answers in these tests */ },
    getState: () => null,
    setState: () => { /* noop */ },
  });
  ({ rpc } = await import('./shared'));
});

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

function start(method: string): ReturnType<typeof vi.fn<(outcome: string) => void>> {
  const outcome = vi.fn<(outcome: string) => void>();
  rpc(method).then(() => outcome('resolved'), (err: unknown) => outcome(err instanceof Error ? err.message : String(err)));
  return outcome;
}

describe('webview RPC timeouts', () => {
  it.each(['explainOccurrence', 'generateRule', 'generateSkillContent'])(
    'waits longer than the host budget for the Copilot-backed %s request',
    async (method) => {
      const outcome = start(method);

      await vi.advanceTimersByTimeAsync(COPILOT_REQUEST_BUDGET_MS + DELIVERY_MARGIN_MS);
      expect(outcome).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(300_000);
      expect(outcome).toHaveBeenCalledWith(`RPC timeout: ${method}`);
    },
  );

  it('keeps the default timeout for other requests', async () => {
    const outcome = start('getStats');

    await vi.advanceTimersByTimeAsync(119_999);
    expect(outcome).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toHaveBeenCalledWith('RPC timeout: getStats');
  });
});
