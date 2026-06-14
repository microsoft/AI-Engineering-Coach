/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { loadSidebarStats } from '../core/cache';
import { getNonce, escapeHtmlAttr } from './panel-shared';

export class DashboardSidebarProvider implements vscode.WebviewViewProvider {
  public static instance: DashboardSidebarProvider | undefined;

  private readonly extensionUri: vscode.Uri;
  private webviewView: vscode.WebviewView | undefined;

  constructor(extensionUri: vscode.Uri) {
    this.extensionUri = extensionUri;
    DashboardSidebarProvider.instance = this;
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.webviewView = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')],
    };

    webviewView.webview.html = this.renderHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((msg: { command: string }) => {
      if (msg.command === 'aiEngineerCoach.open' || msg.command === 'aiEngineerCoach.reload') {
        void vscode.commands.executeCommand(msg.command);
      }
    });
  }

  refresh(): void {
    if (!this.webviewView) return;
    this.webviewView.webview.html = this.renderHtml(this.webviewView.webview);
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'sidebar.css'));
    const stats = loadSidebarStats();
    const statsHtml = stats
      ? `
      <div class="sidebar-card">
        <p class="sidebar-label">Detected harnesses</p>
        <p class="sidebar-harnesses">${stats.harnesses.map(h => escapeHtmlAttr(h)).join(' \u00b7 ')}</p>
        <p class="sidebar-note">Last synced ${new Date(stats.savedAt).toLocaleString()}</p>
      </div>`
      : `
      <div class="sidebar-card">
        <p class="sidebar-note">No data yet — sync your sessions to get started.</p>
      </div>`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link href="${String(styleUri)}" rel="stylesheet">
</head>
<body>
<h3>AI Engineer Coach</h3>
<div id="content">${statsHtml}</div>
<button id="open">Explore AI Insights</button>
<button id="reload" class="secondary">Sync Sessions</button>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  document.getElementById('open').addEventListener('click', function() {
    vscode.postMessage({ command: 'aiEngineerCoach.open' });
  });
  document.getElementById('reload').addEventListener('click', function() {
    vscode.postMessage({ command: 'aiEngineerCoach.reload' });
  });
</script>
</body>
</html>`;
  }
}