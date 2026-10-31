/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mountBuildInfoFooter } from './build-info-footer';

const mocks = vi.hoisted(() => ({ rpc: vi.fn<(method: string) => Promise<unknown>>() }));
vi.mock('./shared', () => ({ rpc: mocks.rpc }));

type UpdateStatusModule = typeof import('./update-status');

/** Fresh module per test: the push listener is module-level state. */
async function loadModule(): Promise<UpdateStatusModule> {
  vi.resetModules();
  return import('./update-status');
}

const available = { state: 'available', current: '0.2.0', latest: '0.4.0', publishedAt: '2026-10-01T12:00:00.000Z', canInstall: true };

function slot(): HTMLElement {
  return document.getElementById('build-info-status')!;
}

function push(data: unknown): void {
  window.dispatchEvent(new MessageEvent('message', { data }));
}

beforeEach(() => {
  mocks.rpc.mockReset();
  mocks.rpc.mockResolvedValue({ state: 'none' });
  document.body.innerHTML = '<nav id="sidebar"></nav>';
  mountBuildInfoFooter(document.getElementById('sidebar')!, {
    version: '0.2.0', commit: 'abc1234', dirty: false, branch: '', builtAt: '2026-10-31T11:15:00.000Z', dev: false,
  });
});

describe('update status in the build stamp footer', () => {
  it('stays hidden when there is nothing to do', async () => {
    const { initUpdateStatus } = await loadModule();
    await initUpdateStatus();
    expect(mocks.rpc).toHaveBeenCalledWith('getUpdateStatus');
    expect(slot().hidden).toBe(true);
  });

  it('offers an available update and lets the host confirm it', async () => {
    mocks.rpc.mockResolvedValueOnce(available);
    const { initUpdateStatus } = await loadModule();
    await initUpdateStatus();
    expect(slot().hidden).toBe(false);
    expect(slot().querySelector('.build-info-status-text')?.textContent).toBe('v0.4.0 available');
    expect(slot().title).toMatch(/^You have v0\.2\.0\. v0\.4\.0 was published on /);
    const action = slot().querySelector<HTMLButtonElement>('.build-info-action')!;
    expect(action.textContent).toBe('Update…');
    action.click();
    expect(mocks.rpc).toHaveBeenLastCalledWith('promptUpdate');
  });

  it('follows the host through updating and installed', async () => {
    const { initUpdateStatus } = await loadModule();
    await initUpdateStatus();
    push({ type: 'updateStatus', status: available });
    expect(slot().textContent).toBe('v0.4.0 availableUpdate…');
    push({ type: 'updateStatus', status: { state: 'updating', latest: '0.4.0' } });
    expect(slot().textContent).toBe('Updating to v0.4.0…');
    expect(slot().querySelector('button')).toBeNull();
    push({ type: 'updateStatus', status: { state: 'installed', latest: '0.4.0' } });
    expect(slot().textContent).toBe('v0.4.0 installedReload');
    slot().querySelector<HTMLButtonElement>('.build-info-action')!.click();
    expect(mocks.rpc).toHaveBeenLastCalledWith('reloadAfterUpdate');
    push({ type: 'updateStatus', status: { state: 'none' } });
    expect(slot().hidden).toBe(true);
  });

  it('ignores other messages and malformed states', async () => {
    const { initUpdateStatus } = await loadModule();
    await initUpdateStatus();
    push({ type: 'updateStatus', status: available });
    push({ type: 'capabilities', host: 'vscode', llm: true });
    expect(slot().hidden).toBe(false);
    push({ type: 'updateStatus', status: { ...available, latest: '<img src=x onerror=alert(1)>' } });
    expect(slot().hidden).toBe(true);
    push({ type: 'updateStatus', status: { state: 'installed', latest: 4 } });
    expect(slot().hidden).toBe(true);
    push({ type: 'updateStatus', status: 'available' });
    expect(slot().hidden).toBe(true);
  });

  it('keeps the slot hidden when the host never answers', async () => {
    mocks.rpc.mockRejectedValueOnce(new Error('RPC timeout: getUpdateStatus'));
    const { initUpdateStatus } = await loadModule();
    await initUpdateStatus();
    expect(slot().hidden).toBe(true);
  });

  it('survives a refused action', async () => {
    mocks.rpc.mockResolvedValueOnce(available).mockRejectedValueOnce(new Error('This feature requires the local agent in VS Code.'));
    const { initUpdateStatus } = await loadModule();
    await initUpdateStatus();
    slot().querySelector<HTMLButtonElement>('.build-info-action')!.click();
    await Promise.resolve();
    expect(slot().textContent).toBe('v0.4.0 availableUpdate…');
  });
});

describe('parseUpdateStatus', () => {
  it('accepts only the shapes the host sends', async () => {
    const { parseUpdateStatus } = await loadModule();
    expect(parseUpdateStatus(available)).toEqual(available);
    expect(parseUpdateStatus({ ...available, canInstall: 'yes' })).toEqual({ ...available, canInstall: false });
    expect(parseUpdateStatus({ state: 'available', latest: '0.4.0' })).toEqual({ state: 'none' });
    expect(parseUpdateStatus({ state: 'updating', latest: 'v0.4.0' })).toEqual({ state: 'none' });
    expect(parseUpdateStatus({ state: 'mystery', latest: '0.4.0' })).toEqual({ state: 'none' });
    expect(parseUpdateStatus(null)).toEqual({ state: 'none' });
  });
});
