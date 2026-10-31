/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { DashboardSidebarProvider } from './panel-sidebar';

const mocks = vi.hoisted(() => ({
  executeCommand: vi.fn<(command: string) => Promise<unknown>>(),
  receive: (_message: unknown) => {},
}));

vi.mock('vscode', () => ({
  Uri: { joinPath: (base: { path: string }, ...segments: string[]) => ({ path: [base.path, ...segments].join('/') }) },
  commands: { executeCommand: mocks.executeCommand },
}));
vi.mock('../core/cache', () => ({ loadSidebarStats: () => null }));

function resolveSidebar() {
  const view = {
    webview: {
      options: {},
      html: '',
      cspSource: 'vscode-webview:',
      asWebviewUri: (uri: { path: string }) => `vscode-webview:${uri.path}`,
      onDidReceiveMessage: (listener: (message: unknown) => void) => { mocks.receive = listener; },
    },
  };
  new DashboardSidebarProvider({ path: '/extension' } as unknown as vscode.Uri)
    .resolveWebviewView(view as unknown as vscode.WebviewView);
  return view.webview;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.executeCommand.mockResolvedValue(undefined);
});

describe('DashboardSidebarProvider', () => {
  it('shows the build stamp with a detailed tooltip and a What\'s new link', () => {
    const webview = resolveSidebar();
    expect(webview.html).toContain(
      '<p class="sidebar-note sidebar-build" id="build-info" title="AI Engineer Coach 0.0.0 (dev build)\nCommit unknown">v0.0.0 (dev) · unknown</p>');
    expect(webview.html).toContain('<button id="whatsNew" class="link">What\'s new</button>');
    expect(webview.html).toContain("vscode.postMessage({ command: 'aiEngineerCoach.showReleaseNotes' })");
  });

  it('runs only the sidebar\'s own commands', () => {
    resolveSidebar();
    mocks.receive({ command: 'aiEngineerCoach.showReleaseNotes' });
    mocks.receive({ command: 'aiEngineerCoach.open' });
    mocks.receive({ command: 'workbench.action.reloadWindow' });
    mocks.receive({ command: 42 });
    mocks.receive('aiEngineerCoach.reload');
    mocks.receive(null);
    expect(mocks.executeCommand.mock.calls).toEqual([['aiEngineerCoach.showReleaseNotes'], ['aiEngineerCoach.open']]);
  });
});
