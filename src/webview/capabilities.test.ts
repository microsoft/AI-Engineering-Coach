/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('./shared', () => ({ rpc: mocks.rpc }));

type CapabilitiesModule = typeof import('./capabilities');

/** Fresh module per test: capabilities are module-level state. */
async function loadModule(): Promise<CapabilitiesModule> {
  vi.resetModules();
  return import('./capabilities');
}

function pushFromHost(data: unknown): void {
  window.dispatchEvent(new MessageEvent('message', { data }));
}

const aiControlsHidden = () => document.documentElement.classList.contains('llm-unavailable');

beforeEach(() => {
  mocks.rpc.mockReset();
  document.documentElement.classList.remove('llm-unavailable');
});

describe('webview capabilities', () => {
  it('hides AI controls when the VS Code host reports no Copilot model', async () => {
    const caps = await loadModule();
    mocks.rpc.mockResolvedValue({ host: 'vscode', llm: false });

    await caps.loadCapabilities();

    expect(mocks.rpc).toHaveBeenCalledWith('getCapabilities');
    expect(caps.llmAvailable()).toBe(false);
    expect(aiControlsHidden()).toBe(true);
    expect(caps.llmUnavailableNote()).toBe('Sign in to GitHub Copilot in VS Code to use this.');
  });

  it('keeps AI controls visible when Copilot is available', async () => {
    const caps = await loadModule();
    mocks.rpc.mockResolvedValue({ host: 'vscode', llm: true });

    await caps.loadCapabilities();

    expect(caps.llmAvailable()).toBe(true);
    expect(aiControlsHidden()).toBe(false);
  });

  it('keeps full capabilities when the probe RPC fails', async () => {
    const caps = await loadModule();
    mocks.rpc.mockRejectedValue(new Error('RPC timeout: getCapabilities'));

    await caps.loadCapabilities();

    expect(caps.capabilities()).toEqual({ host: 'vscode', llm: true });
    expect(aiControlsHidden()).toBe(false);
  });

  it('points canvas users to VS Code', async () => {
    const caps = await loadModule();
    mocks.rpc.mockResolvedValue({ host: 'canvas', llm: false });

    await caps.loadCapabilities();

    expect(caps.capabilities()).toEqual({ host: 'canvas', llm: false });
    expect(aiControlsHidden()).toBe(true);
    expect(caps.llmUnavailableNote()).toBe('Open in VS Code with the local Copilot agent to use this.');
  });
});

describe('capabilities pushed by the host', () => {
  it('shows and hides AI controls in place and ignores unrelated messages', async () => {
    const caps = await loadModule();
    mocks.rpc.mockResolvedValue({ host: 'vscode', llm: true });
    await caps.loadCapabilities();

    pushFromHost({ type: 'capabilities', host: 'vscode', llm: false });
    expect(caps.llmAvailable()).toBe(false);
    expect(aiControlsHidden()).toBe(true);

    pushFromHost({ type: 'response', id: '1', data: { llm: true } });
    expect(caps.llmAvailable()).toBe(false);
    expect(aiControlsHidden()).toBe(true);

    pushFromHost({ type: 'capabilities', host: 'vscode', llm: true });
    expect(caps.llmAvailable()).toBe(true);
    expect(aiControlsHidden()).toBe(false);
  });
});
