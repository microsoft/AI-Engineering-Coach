/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { fakeVsix, jsonResponse, releaseJson } from './test-fixtures';
import { getUpdateService, registerUpdateCheck, UPDATE_STATE_KEY, UpdateService } from './update-service';

type Listener<T> = (value: T) => void;

const mocks = vi.hoisted(() => ({
  config: new Map<string, unknown>(),
  remoteName: undefined as string | undefined,
  showInformationMessage: vi.fn<(message: string, ...rest: unknown[]) => Promise<string | undefined>>(),
  showWarningMessage: vi.fn<(message: string, ...rest: unknown[]) => Promise<string | undefined>>(),
  showErrorMessage: vi.fn<(message: string, ...rest: unknown[]) => Promise<string | undefined>>(),
  executeCommand: vi.fn<(command: string, ...args: unknown[]) => Promise<unknown>>(),
  registerCommand: vi.fn<(command: string, handler: () => unknown) => { dispose(): void }>(),
  openExternal: vi.fn<(uri: { toString(): string }) => Promise<boolean>>(),
}));

vi.mock('vscode', () => {
  class EventEmitter<T> {
    private readonly listeners = new Set<Listener<T>>();
    readonly event = (listener: Listener<T>) => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    };
    fire(value: T): void { for (const listener of this.listeners) listener(value); }
    dispose(): void { this.listeners.clear(); }
  }
  const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) };
  return {
    EventEmitter,
    ExtensionMode: { Production: 1, Development: 2, Test: 3 },
    ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
    Uri: {
      file: (fsPath: string) => ({ scheme: 'file', fsPath, path: fsPath, toString: () => `file://${fsPath}` }),
      parse: (value: string) => ({ toString: () => value }),
    },
    env: {
      get remoteName() { return mocks.remoteName; },
      openExternal: mocks.openExternal,
    },
    window: {
      showInformationMessage: mocks.showInformationMessage,
      showWarningMessage: mocks.showWarningMessage,
      showErrorMessage: mocks.showErrorMessage,
      withProgress: (_options: unknown, task: (progress: { report: () => void }, cancel: typeof token) => unknown) =>
        task({ report: () => {} }, token),
    },
    commands: { executeCommand: mocks.executeCommand, registerCommand: mocks.registerCommand },
    workspace: {
      getConfiguration: (section?: string) => ({
        get: (key: string, fallback?: unknown) => {
          const name = section ? `${section}.${key}` : key;
          return mocks.config.has(name) ? mocks.config.get(name) : fallback;
        },
      }),
      onDidChangeConfiguration: () => ({ dispose: () => {} }),
    },
  };
});
vi.mock('../core/runtime-debug', () => ({ runtimeDebug: () => {} }));

type Service = UpdateService;

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-31T12:00:00Z');
const API = 'https://api.github.com/repos/microsoft/AI-Engineering-Coach/releases/latest';
const RELEASE_PAGE = 'https://github.com/microsoft/AI-Engineering-Coach/releases/tag/v0.4.0';
const VSIX_URL = 'https://github.com/microsoft/AI-Engineering-Coach/releases/download/v0.4.0/ai-engineer-coach-0.4.0.vsix';
const STORAGE_URL = 'https://release-assets.githubusercontent.com/github-production-release-asset/1/vsix?sig=x';
const RELEASE_BUILD = { version: '0.2.0', dev: false };

let downloads: string;
let services: Service[];

function sharedStore() {
  return new Map<string, unknown>();
}

function fakeContext(store = sharedStore(), mode = 1, extensionPath = '/home/u/.vscode/extensions/ai-engineer-coach.ai-engineer-coach-0.2.0') {
  return {
    extensionMode: mode,
    extensionUri: { scheme: 'file', path: extensionPath, fsPath: extensionPath },
    globalStorageUri: { scheme: 'file', path: downloads, fsPath: downloads },
    globalState: {
      get: (key: string) => {
        const value = store.get(key);
        return value === undefined ? undefined : JSON.parse(JSON.stringify(value)) as unknown;
      },
      update: (key: string, value: unknown) => {
        store.set(key, JSON.parse(JSON.stringify(value)));
        return Promise.resolve();
      },
    },
    subscriptions: [] as { dispose(): void }[],
  } as unknown as vscode.ExtensionContext & { subscriptions: { dispose(): void }[] };
}

function serve(routes: Record<string, () => Response>) {
  return vi.fn<typeof globalThis.fetch>(input => new Promise<Response>(resolve => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const route = routes[url];
    if (!route) throw new Error(`Unexpected request: ${url}`);
    resolve(route());
  }));
}

const inDownloads = () => Promise.resolve(downloads);

function createService(
  fetch: typeof globalThis.fetch,
  options: { store?: Map<string, unknown>; build?: { version: string; dev: boolean }; mode?: number; extensionPath?: string } = {},
): Service {
  const service = new UpdateService(fakeContext(options.store, options.mode, options.extensionPath), {
    fetch,
    now: () => Date.now(),
    random: () => 0,
    build: options.build ?? RELEASE_BUILD,
    downloadDir: inDownloads,
  });
  services.push(service);
  return service;
}

function installCalls() {
  return mocks.executeCommand.mock.calls.filter(([command]) => command === 'workbench.extensions.installExtension');
}

beforeEach(async () => {
  vi.stubGlobal('fetch', () => { throw new Error('Network access is disabled in unit tests'); });
  vi.clearAllMocks();
  mocks.config.clear();
  mocks.config.set('extensions.autoUpdateDelay', 0);
  mocks.remoteName = undefined;
  mocks.executeCommand.mockResolvedValue(undefined);
  mocks.registerCommand.mockImplementation(() => ({ dispose: () => {} }));
  mocks.showInformationMessage.mockResolvedValue(undefined);
  mocks.showWarningMessage.mockResolvedValue(undefined);
  mocks.showErrorMessage.mockResolvedValue(undefined);
  mocks.openExternal.mockResolvedValue(true);
  downloads = await fs.mkdtemp(path.join(os.tmpdir(), 'aec-update-test-'));
  services = [];
});

afterEach(async () => {
  for (const service of services) service.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await fs.rm(downloads, { recursive: true, force: true });
});

describe('automatic checks', () => {
  it.each([
    ['the setting is off', () => mocks.config.set('aiEngineerCoach.updates.autoCheck', false), {}],
    ['VS Code extension update checks are off', () => mocks.config.set('extensions.autoCheckUpdates', false), {}],
    ['the build is a dev build', () => {}, { build: { version: '0.2.0', dev: true } }],
    ['the extension runs in development mode', () => {}, { mode: 2 }],
    ['the extension runs in a test host', () => {}, { mode: 3 }],
  ])('make zero requests when %s', async (_label, configure, options) => {
    vi.useFakeTimers({ now: NOW });
    configure();
    const fetch = vi.fn<typeof globalThis.fetch>();
    createService(fetch, options).start();
    await vi.advanceTimersByTimeAsync(7 * DAY);
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.showInformationMessage).not.toHaveBeenCalled();
  });

  it('check a few minutes after activation, announce a release once, then revalidate daily', async () => {
    vi.useFakeTimers({ now: NOW });
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse(releaseJson('0.4.0'), { headers: { etag: 'W/"v1"' } }))
      .mockResolvedValue(new Response(null, { status: 304 }));
    const service = createService(fetch);
    service.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(mocks.showInformationMessage).toHaveBeenCalledTimes(1);
    expect(mocks.showInformationMessage).toHaveBeenCalledWith(
      'AI Engineer Coach v0.4.0 is available. You have v0.2.0.', 'Update', 'Release Notes', 'Skip This Version');
    expect(service.getStatus()).toEqual({
      state: 'available', current: '0.2.0', latest: '0.4.0', publishedAt: '2026-10-01T12:00:00.000Z', canInstall: true,
    });
    expect(mocks.executeCommand).toHaveBeenCalledWith('setContext', 'aiEngineerCoach.updateAvailable', true);
    expect(installCalls()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(DAY);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][1]?.headers).toMatchObject({ 'If-None-Match': 'W/"v1"' });
    expect(mocks.showInformationMessage).toHaveBeenCalledTimes(1);
  });

  it('let one window check and notify for all windows', async () => {
    vi.useFakeTimers({ now: NOW });
    const store = sharedStore();
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(() => Promise.resolve(jsonResponse(releaseJson('0.4.0'))));
    createService(fetch, { store }).start();
    createService(fetch, { store }).start();
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(mocks.showInformationMessage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3 * DAY);
    expect(fetch.mock.calls.length).toBeLessThanOrEqual(4);
    expect(mocks.showInformationMessage).toHaveBeenCalledTimes(1);
  });

  it('stay quiet when nothing has been released yet', async () => {
    vi.useFakeTimers({ now: NOW });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('{"message":"Not Found"}', { status: 404 }));
    const service = createService(fetch);
    service.start();
    await vi.advanceTimersByTimeAsync(DAY + 3 * 60 * 60_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(service.getStatus()).toEqual({ state: 'none' });
    expect(mocks.showInformationMessage).not.toHaveBeenCalled();
    expect(mocks.showWarningMessage).not.toHaveBeenCalled();
  });

  it('back off quietly while offline', async () => {
    vi.useFakeTimers({ now: NOW });
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new TypeError('fetch failed'));
    createService(fetch).start();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60 * 60_000 + 5 * 60_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000 + 5 * 60_000);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(mocks.showWarningMessage).not.toHaveBeenCalled();
    expect(mocks.showErrorMessage).not.toHaveBeenCalled();
  });

  it('wait for VS Code\'s extension update delay before announcing', async () => {
    vi.useFakeTimers({ now: NOW });
    mocks.config.delete('extensions.autoUpdateDelay');
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse(releaseJson('0.4.0', { publishedAt: new Date(NOW).toISOString() }), { headers: { etag: 'W/"v1"' } }))
      .mockResolvedValue(new Response(null, { status: 304 }));
    const service = createService(fetch);
    service.start();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(service.getStatus()).toEqual({ state: 'none' });
    expect(mocks.showInformationMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(DAY);
    expect(mocks.showInformationMessage).toHaveBeenCalledTimes(1);
  });

  it('remember Skip This Version', async () => {
    vi.useFakeTimers({ now: NOW });
    mocks.showInformationMessage.mockResolvedValue('Skip This Version');
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse(releaseJson('0.4.0'), { headers: { etag: 'W/"v1"' } }))
      .mockResolvedValue(new Response(null, { status: 304 }));
    const service = createService(fetch);
    service.start();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(service.getStatus()).toEqual({ state: 'none' });
    await vi.advanceTimersByTimeAsync(2 * DAY);
    expect(mocks.showInformationMessage).toHaveBeenCalledTimes(1);
  });
});

describe('Check for Updates', () => {
  it('reveals a newer release even on a dev build and installs it only after Update', async () => {
    const bytes = fakeVsix(512);
    const fetch = serve({
      [API]: () => jsonResponse(releaseJson('0.4.0', { bytes })),
      [VSIX_URL]: () => new Response(null, { status: 302, headers: { location: STORAGE_URL } }),
      [STORAGE_URL]: () => new Response(bytes),
    });
    mocks.showInformationMessage.mockResolvedValueOnce('Update').mockResolvedValueOnce('Reload Window');
    const service = createService(fetch, { build: { version: '0.2.0', dev: true } });
    service.start();
    await service.checkNow();

    const [install] = installCalls();
    expect(install[1]).toMatchObject({ scheme: 'file' });
    const vsix = (install[1] as { fsPath: string }).fsPath;
    expect(path.dirname(vsix)).toBe(downloads);
    expect(path.basename(vsix)).toMatch(/^ai-engineer-coach-0\.4\.0-[0-9a-f]{12}\.vsix$/);
    expect(await fs.readdir(downloads)).toEqual([]);
    expect(mocks.showInformationMessage).toHaveBeenLastCalledWith(
      'AI Engineer Coach v0.4.0 is installed. Reload the window to start using it.', 'Reload Window');
    expect(mocks.executeCommand).toHaveBeenCalledWith('workbench.action.reloadWindow');
    expect(service.getStatus()).toEqual({ state: 'installed', latest: '0.4.0' });
  });

  it('never installs without a click', async () => {
    const fetch = serve({ [API]: () => jsonResponse(releaseJson('0.4.0')) });
    const service = createService(fetch);
    service.start();
    await service.checkNow();
    expect(installCalls()).toHaveLength(0);
    expect(mocks.executeCommand).not.toHaveBeenCalledWith('workbench.action.reloadWindow');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('refuses a download whose checksum does not match, and offers the release page', async () => {
    const fetch = serve({
      [API]: () => jsonResponse(releaseJson('0.4.0', { bytes: fakeVsix(64, 1) })),
      [VSIX_URL]: () => new Response(fakeVsix(64, 2)),
    });
    mocks.showInformationMessage.mockResolvedValueOnce('Update');
    mocks.showErrorMessage.mockResolvedValueOnce('Open Release Page');
    const service = createService(fetch);
    service.start();
    await service.checkNow();
    expect(installCalls()).toHaveLength(0);
    expect(mocks.showErrorMessage).toHaveBeenCalledWith(
      "Couldn't install AI Engineer Coach v0.4.0: the download's SHA-256 checksum doesn't match the release.", 'Open Release Page');
    expect(mocks.openExternal.mock.calls.map(([uri]) => uri.toString())).toEqual([RELEASE_PAGE]);
    expect(await fs.readdir(downloads)).toEqual([]);
    expect(service.getStatus()).toMatchObject({ state: 'available', latest: '0.4.0' });
  });

  it('reports a failed install from VS Code', async () => {
    const bytes = fakeVsix();
    const fetch = serve({ [API]: () => jsonResponse(releaseJson('0.4.0', { bytes })), [VSIX_URL]: () => new Response(bytes) });
    mocks.executeCommand.mockImplementation(command => command === 'workbench.extensions.installExtension'
      ? Promise.reject(new Error('Extension is not allowed'))
      : Promise.resolve(undefined));
    mocks.showInformationMessage.mockResolvedValueOnce('Update');
    const service = createService(fetch);
    service.start();
    await service.checkNow();
    expect(mocks.showErrorMessage).toHaveBeenCalledWith(
      "Couldn't install AI Engineer Coach v0.4.0: Extension is not allowed.", 'Open Release Page');
    expect(await fs.readdir(downloads)).toEqual([]);
  });

  it('sends releases that are not immutable to the release page', async () => {
    const fetch = serve({ [API]: () => jsonResponse(releaseJson('0.4.0', { immutable: false })) });
    mocks.showInformationMessage.mockResolvedValueOnce('Open Release Page');
    const service = createService(fetch);
    service.start();
    await service.checkNow();
    expect(mocks.showInformationMessage).toHaveBeenCalledWith(
      'AI Engineer Coach v0.4.0 is available. You have v0.2.0.', 'Open Release Page', 'Skip This Version');
    expect(mocks.openExternal.mock.calls.map(([uri]) => uri.toString())).toEqual([RELEASE_PAGE]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(service.getStatus()).toMatchObject({ state: 'available', canInstall: false });
  });

  it.each([
    ['nothing is released', () => new Response(null, { status: 404 }), 'showInformationMessage',
      'No AI Engineer Coach releases have been published yet.'],
    ['the latest release is current', () => jsonResponse(releaseJson('0.2.0')), 'showInformationMessage',
      'AI Engineer Coach is up to date (v0.2.0).'],
    ['this build is ahead', () => jsonResponse(releaseJson('0.1.0')), 'showInformationMessage',
      'This build (v0.2.0) is newer than the latest AI Engineer Coach release (v0.1.0).'],
    ['GitHub is unreachable', () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); },
      'showWarningMessage', "Couldn't check for AI Engineer Coach updates: fetch failed (ENOTFOUND)."],
    ['the release is malformed', () => jsonResponse({ ...releaseJson('0.4.0'), tag_name: 'nightly' }), 'showWarningMessage',
      "The latest AI Engineer Coach release can't be used: the latest release tag is not vX.Y.Z."],
  ] as const)('reports when %s', async (_label, respond, method, message) => {
    const service = createService(serve({ [API]: respond }));
    service.start();
    await service.checkNow();
    expect(mocks[method]).toHaveBeenCalledWith(message, ...(method === 'showWarningMessage' ? ['Open Release Page'] : []));
  });

  it('does not ask GitHub again while the rate limit is exhausted', async () => {
    const fetch = serve({
      [API]: () => new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 1800) } }),
    });
    const service = createService(fetch);
    service.start();
    await service.checkNow();
    await service.checkNow();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(mocks.showWarningMessage).toHaveBeenCalledTimes(2);
    expect(mocks.showWarningMessage.mock.calls[1][0]).toMatch(/^GitHub's limit for anonymous requests was reached\. Try again after /);
  });
});

describe('Install Update', () => {
  it('asks for native confirmation before installing', async () => {
    const fetch = serve({ [API]: () => jsonResponse(releaseJson('0.4.0')) });
    const service = createService(fetch);
    service.start();
    await service.checkNow();
    mocks.showInformationMessage.mockClear();
    await service.promptInstall();
    expect(mocks.showInformationMessage).toHaveBeenCalledWith('Update AI Engineer Coach to v0.4.0?', {
      modal: true,
      detail: 'This downloads ai-engineer-coach-0.4.0.vsix from GitHub Releases, checks its SHA-256 checksum, and installs it. '
        + 'Reload the window afterwards to start using it.',
    }, 'Install', 'Release Notes', 'Skip This Version');
    expect(installCalls()).toHaveLength(0);
  });

  it('checks first when no update is known', async () => {
    const fetch = serve({ [API]: () => new Response(null, { status: 404 }) });
    const service = createService(fetch);
    service.start();
    await service.promptInstall();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(mocks.showInformationMessage).toHaveBeenCalledWith('No AI Engineer Coach releases have been published yet.');
  });

  it('reloads only after an install', async () => {
    const service = createService(vi.fn<typeof globalThis.fetch>());
    service.start();
    await service.reloadAfterUpdate();
    expect(mocks.executeCommand).not.toHaveBeenCalledWith('workbench.action.reloadWindow');
  });
});

describe('installed marker', () => {
  it('shows "reload" in other windows of the same installation only', () => {
    const store = sharedStore();
    store.set(UPDATE_STATE_KEY, {
      installedVersion: '0.4.0',
      installedLocation: 'local:/home/u/.vscode/extensions',
    });
    const local = createService(vi.fn<typeof globalThis.fetch>(), { store });
    local.start();
    expect(local.getStatus()).toEqual({ state: 'installed', latest: '0.4.0' });
    mocks.remoteName = 'wsl';
    const remote = createService(vi.fn<typeof globalThis.fetch>(), { store, extensionPath: '/home/u/.vscode-server/extensions/x' });
    remote.start();
    expect(remote.getStatus()).toEqual({ state: 'none' });
  });

  it('is cleared once the new version runs', async () => {
    const store = sharedStore();
    store.set(UPDATE_STATE_KEY, { installedVersion: '0.4.0', installedLocation: 'local:/home/u/.vscode/extensions' });
    const service = createService(vi.fn<typeof globalThis.fetch>(), {
      store, build: { version: '0.4.0', dev: false }, extensionPath: '/home/u/.vscode/extensions/ai-engineer-coach.ai-engineer-coach-0.4.0',
    });
    service.start();
    await vi.waitFor(() => expect(store.get(UPDATE_STATE_KEY)).toEqual({}));
    expect(service.getStatus()).toEqual({ state: 'none' });
  });

  it('ignores a cached release it cannot read and fetches it again in full', async () => {
    const store = sharedStore();
    store.set(UPDATE_STATE_KEY, { release: { version: '0.4.0' }, etag: 'W/"old"' });
    const fetch = serve({ [API]: () => new Response(null, { status: 404 }) });
    const service = createService(fetch, { store });
    service.start();
    expect(service.getStatus()).toEqual({ state: 'none' });
    await service.checkNow();
    expect(fetch.mock.calls[0][1]?.headers).not.toHaveProperty('If-None-Match');
  });
});

describe('downloads folder', () => {
  it('removes packages left over from an interrupted install', async () => {
    const stale = path.join(downloads, 'ai-engineer-coach-0.3.0-aaaaaaaaaaaa.vsix');
    const fresh = path.join(downloads, 'ai-engineer-coach-0.4.0-bbbbbbbbbbbb.vsix');
    await fs.writeFile(stale, 'old');
    await fs.writeFile(fresh, 'new');
    const old = new Date(Date.now() - 2 * DAY);
    await fs.utimes(stale, old, old);
    createService(vi.fn<typeof globalThis.fetch>()).start();
    await vi.waitFor(async () => expect(await fs.readdir(downloads)).toEqual([path.basename(fresh)]));
  });
});

describe('registerUpdateCheck', () => {
  it('registers both commands and exposes the service to the dashboard', () => {
    const context = fakeContext();
    mocks.config.set('aiEngineerCoach.updates.autoCheck', false);
    const service = registerUpdateCheck(context, { fetch: vi.fn<typeof globalThis.fetch>(), downloadDir: inDownloads });
    services.push(service);
    expect(mocks.registerCommand.mock.calls.map(([command]) => command))
      .toEqual(['aiEngineerCoach.checkForUpdates', 'aiEngineerCoach.installUpdate']);
    expect(getUpdateService()).toBe(service);
    for (const disposable of context.subscriptions) disposable.dispose();
    expect(getUpdateService()).toBeUndefined();
  });
});
