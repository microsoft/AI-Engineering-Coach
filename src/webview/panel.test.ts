/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { Analyzer } from '../core/analyzer';
import type { ParseResult } from '../core/parser';
import { DashboardPanel } from './panel';
import { panelCache } from './panel-cache';

const mocks = vi.hoisted(() => ({
  receive: (_message: unknown) => {},
  disposed: () => {},
  html: '',
  post: vi.fn<(message: unknown) => Promise<boolean>>().mockResolvedValue(true),
  parse: vi.fn<() => Promise<ParseResult>>(),
  clearCache: vi.fn<() => void>(),
  warmUp: vi.fn<Analyzer['warmUp']>(),
  heavy: vi.fn(() => ({ kind: 'heavy' })),
  light: vi.fn(() => ({ kind: 'light' })),
}));

vi.mock('vscode', () => ({
  window: { createWebviewPanel: () => ({
    webview: {
      get html() { return mocks.html; },
      set html(value: string) { mocks.html = value; },
      postMessage: mocks.post,
      onDidReceiveMessage: (listener: typeof mocks.receive) => { mocks.receive = listener; },
    },
    onDidChangeViewState: () => {},
    onDidDispose: (listener: typeof mocks.disposed) => { mocks.disposed = listener; },
    dispose: () => {},
    reveal: () => {},
  }) },
  workspace: { name: 'test-workspace' },
  ViewColumn: { One: 1 },
  Uri: { joinPath: (uri: { fsPath: string }, segment: string) => ({ fsPath: `${uri.fsPath}/${segment}` }) },
}));
vi.mock('../core/analyzer', () => ({ Analyzer: class { warmUp = mocks.warmUp; } }));
vi.mock('../core/parser', () => ({
  clearCache: mocks.clearCache, findLogsDirs: () => ['test-logs'], parseAllLogsViaWorker: mocks.parse,
}));
vi.mock('../core/parser-harnesses', () => ({ hasExternalHarnessSources: () => false }));
vi.mock('../core/cache', () => ({ saveSidebarStats: () => {} }));
vi.mock('../core/runtime-debug', () => ({ runtimeDebug: () => {} }));
vi.mock('./panel-catalog', () => ({ clearCatalogCache: () => {} }));
vi.mock('./panel-html', () => ({
  getDashboardHtml: () => '<html></html>',
  getErrorHtml: (message: string) => `<html>Error: ${message}</html>`,
}));
vi.mock('./panel-request-service', () => ({ PanelRequestService: class { tryHandle() { return false; } } }));
vi.mock('./panel-sidebar', () => ({ DashboardSidebarProvider: class {} }));
vi.mock('./panel-rpc', () => ({
  getRpcHandler: (method: string) => method === 'getAntiPatterns' || method === 'getConfigHealth' ? mocks.heavy : mocks.light,
}));

const result: ParseResult = {
  sessions: [], workspaces: new Map(), editLocIndex: new Map(), sessionSourceIndex: new Map(),
  parseWarnings: { skippedFiles: 2, skippedLines: 3 },
};
const context = {
  extensionUri: { fsPath: '/test-extension' },
  globalState: {},
} as vscode.ExtensionContext;

beforeEach(() => {
  panelCache.clear();
  vi.clearAllMocks();
  mocks.parse.mockResolvedValue(result);
  mocks.warmUp.mockResolvedValue(undefined);
});

afterEach(() => {
  mocks.disposed();
  panelCache.clear();
});

describe('dashboard startup', () => {
  it('keeps all requests behind the progress screen until analytics finish', async () => {
    let finish = () => {};
    mocks.warmUp.mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
    DashboardPanel.createOrShow(context.extensionUri, context);
    mocks.receive({ type: 'request', id: 'stats', method: 'getStats' });
    mocks.receive({ type: 'request', id: 'patterns', method: 'getAntiPatterns' });
    await vi.waitFor(() => expect(mocks.warmUp).toHaveBeenCalled());
    expect(mocks.post).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'dataReady' }));
    expect(mocks.post).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'response' }));
    mocks.receive({ type: 'ready' });
    expect(mocks.post).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'progress', phase: 4 }));
    const onProgress = mocks.warmUp.mock.calls[0][0]!;
    onProgress(4, 'Computing analytics', 10);
    await vi.waitFor(() => expect(mocks.post).toHaveBeenCalledWith(expect.objectContaining({
      type: 'progress', phase: 4, pct: 91,
    })));
    onProgress(5, 'Cache ready', 100);
    expect(mocks.post).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'progress', phase: 4, pct: 100 }));
    expect(mocks.post).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'progress', phase: 5 }));
    expect(mocks.heavy).not.toHaveBeenCalled();
    finish();
    await vi.waitFor(() => expect(mocks.post).toHaveBeenCalledWith({ type: 'response', id: 'patterns', data: { kind: 'heavy' } }));
    expect(mocks.post).toHaveBeenCalledWith({ type: 'response', id: 'stats', data: { kind: 'light' } });
    expect(mocks.post).toHaveBeenCalledWith(expect.objectContaining({ type: 'dataReady' }));
    expect(mocks.warmUp).toHaveBeenCalledWith(expect.any(Function), expect.any(Function));
  });

  it('replays ready state after cached data loaded before the webview listener', async () => {
    panelCache.store(result, new Analyzer([]));
    DashboardPanel.createOrShow(context.extensionUri, context);
    await vi.waitFor(() => expect(mocks.post).toHaveBeenCalledWith(expect.objectContaining({ type: 'dataReady' })));
    mocks.post.mockClear();
    mocks.receive({ type: 'ready' });
    expect(mocks.post).toHaveBeenCalledWith({
      type: 'dataReady', currentWorkspace: 'test-workspace', skippedFiles: 2, skippedLines: 3,
    });
    expect(mocks.parse).not.toHaveBeenCalled();
    expect(mocks.warmUp).not.toHaveBeenCalled();
  });

  it('starts a fresh sync after closing a cached dashboard', async () => {
    panelCache.store(result, new Analyzer([]));
    DashboardPanel.createOrShow(context.extensionUri, context);
    mocks.disposed();
    mocks.post.mockClear();
    let finish = (_result: ParseResult) => {};
    mocks.parse.mockReturnValue(new Promise<ParseResult>(resolve => { finish = resolve; }));

    DashboardPanel.createOrShow(context.extensionUri, context, true);
    await vi.waitFor(() => expect(mocks.parse).toHaveBeenCalledTimes(1));
    expect(mocks.clearCache).toHaveBeenCalledTimes(1);
    expect(panelCache.result).toBeUndefined();
    expect(mocks.post).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'dataReady' }));
    mocks.receive({ type: 'ready' });
    expect(mocks.post).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'progress', phase: 0 }));

    finish(result);
    await vi.waitFor(() => expect(mocks.post).toHaveBeenCalledWith(expect.objectContaining({ type: 'dataReady' })));
  });

  it('forces an existing dashboard to sync without replacing it', async () => {
    DashboardPanel.createOrShow(context.extensionUri, context);
    await vi.waitFor(() => expect(panelCache.result).toBe(result));
    const panel = DashboardPanel.current;
    DashboardPanel.createOrShow(context.extensionUri, context, true);
    expect(DashboardPanel.current).toBe(panel);
    await vi.waitFor(() => expect(mocks.parse).toHaveBeenCalledTimes(2));
    expect(mocks.clearCache).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(panelCache.result).toBe(result));
  });

  it('reuses in-flight analytics after reopening and releases every queued request together', async () => {
    let finish = () => {};
    mocks.warmUp.mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
    DashboardPanel.createOrShow(context.extensionUri, context);
    await vi.waitFor(() => expect(mocks.warmUp).toHaveBeenCalledTimes(1));
    mocks.disposed();
    mocks.post.mockClear();
    DashboardPanel.createOrShow(context.extensionUri, context);
    mocks.receive({ type: 'request', id: 'health', method: 'getConfigHealth' });
    mocks.receive({ type: 'request', id: 'stats', method: 'getStats' });
    expect(mocks.heavy).not.toHaveBeenCalled();
    expect(mocks.post).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'dataReady' }));
    expect(mocks.post).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'response' }));
    mocks.receive({ type: 'ready' });
    expect(mocks.post).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'progress', phase: 4 }));
    finish();
    await vi.waitFor(() => expect(mocks.post).toHaveBeenCalledWith({
      type: 'response', id: 'health', data: { kind: 'heavy' },
    }));
    expect(mocks.post).toHaveBeenCalledWith({ type: 'response', id: 'stats', data: { kind: 'light' } });
    expect(mocks.post).toHaveBeenCalledWith(expect.objectContaining({ type: 'dataReady' }));
    expect(mocks.parse).toHaveBeenCalledTimes(1);
    expect(mocks.warmUp).toHaveBeenCalledTimes(1);
  });

  it('shows a loading error and clears failed analytics instead of publishing partial readiness', async () => {
    let fail = (_error: Error) => {};
    mocks.warmUp.mockReturnValue(new Promise<void>((_resolve, reject) => { fail = reject; }));
    DashboardPanel.createOrShow(context.extensionUri, context);
    await vi.waitFor(() => expect(mocks.warmUp).toHaveBeenCalled());
    mocks.receive({ type: 'request', id: 'patterns', method: 'getAntiPatterns' });
    fail(new Error('Worker unavailable'));
    await vi.waitFor(() => expect(mocks.html).toContain('Worker unavailable'));
    expect(mocks.post).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'dataReady' }));
    expect(panelCache.result).toBeUndefined();
    expect(mocks.heavy).not.toHaveBeenCalled();
  });

  it('reports a failed cached job and removes it from the cache', async () => {
    panelCache.store(result, new Analyzer([]), Promise.reject(new Error('Cached worker failed')));
    DashboardPanel.createOrShow(context.extensionUri, context);
    await vi.waitFor(() => expect(mocks.html).toContain('Cached worker failed'));
    expect(mocks.post).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'dataReady' }));
    expect(panelCache.result).toBeUndefined();
    expect(mocks.parse).not.toHaveBeenCalled();
    expect(mocks.warmUp).not.toHaveBeenCalled();
  });

  it('does not clear a newer cache when a disposed panel analytics job fails', async () => {
    let fail = (_error: Error) => {};
    mocks.warmUp.mockReturnValue(new Promise<void>((_resolve, reject) => { fail = reject; }));
    DashboardPanel.createOrShow(context.extensionUri, context);
    await vi.waitFor(() => expect(mocks.warmUp).toHaveBeenCalled());
    mocks.disposed();
    const newerAnalyzer = new Analyzer([]);
    panelCache.store(result, newerAnalyzer);
    DashboardPanel.createOrShow(context.extensionUri, context);
    await vi.waitFor(() => expect(mocks.post).toHaveBeenCalledWith(expect.objectContaining({ type: 'dataReady' })));
    fail(new Error('Old worker failed'));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(panelCache.analyzerInstance).toBe(newerAnalyzer);
    expect(mocks.html).not.toContain('Old worker failed');
  });
});
