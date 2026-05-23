/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { loadSidebarStats } from '../core/cache';
import { getNonce } from './panel-shared';
import { getUiLanguageTag } from '../ui-locale';
import { resolveLocale, t } from './i18n';

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

    const nonce = getNonce();

    webviewView.webview.html = this.renderHtml(nonce);

    webviewView.webview.onDidReceiveMessage((msg: { command: string }) => {
      vscode.commands.executeCommand(msg.command);
    });
  }

  refresh(): void {
    if (!this.webviewView) return;
    this.webviewView.webview.html = this.renderHtml(getNonce());
  }

  private renderHtml(nonce: string): string {
    const locale = resolveLocale(getUiLanguageTag());
    const langAttr = locale === 'ru' ? 'ru' : 'en';
    const stats = loadSidebarStats();
    const statsHtml = stats
      ? `
      <div class="sidebar-card">
        <p class="sidebar-label">${t('sidebar.harnesses', locale)}</p>
        <p class="sidebar-harnesses">${stats.harnesses.join(' · ')}</p>
        <p class="sidebar-note">${t('sidebar.lastSync', locale)} ${new Date(stats.savedAt).toLocaleString(langAttr)}</p>
      </div>`
      : `
      <div class="sidebar-card">
        <p class="sidebar-note">${t('sidebar.noData', locale)}</p>
      </div>`;

    return `<!DOCTYPE html>
<html lang="${langAttr}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
body {
  background: transparent;
  color: var(--vscode-foreground);
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  padding: 12px;
  margin: 0;
}
h3 { margin: 0 0 6px; font-weight: 600; font-size: 13px; }
.sidebar-desc { margin: 0 0 12px; color: var(--vscode-descriptionForeground); font-size: 11px; line-height: 1.4; }
.sidebar-card {
  padding: 12px;
  border-radius: 8px;
  background: var(--vscode-editor-background);
  border: 1px solid var(--vscode-widget-border, rgba(255,255,255,0.06));
  margin-bottom: 12px;
}
.sidebar-label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--vscode-descriptionForeground);
  margin: 0 0 4px;
}
.sidebar-harnesses {
  font-size: 12px;
  line-height: 1.5;
  margin: 0 0 10px;
  color: var(--vscode-foreground);
}
.sidebar-note {
  color: var(--vscode-descriptionForeground);
  font-size: 11px;
  line-height: 1.5;
  margin: 0;
}
button {
  display: block;
  width: 100%;
  padding: 8px 12px;
  margin-bottom: 6px;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
  font-family: var(--vscode-font-family);
  color: var(--vscode-button-foreground);
  background: var(--vscode-button-background);
}
button:hover { background: var(--vscode-button-hoverBackground); }
button.secondary {
  color: var(--vscode-button-secondaryForeground);
  background: var(--vscode-button-secondaryBackground);
}
button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
</style>
</head>
<body>
<h3>${t('sidebar.title', locale)}</h3>
<div id="content">${statsHtml}</div>
<button id="open">${t('sidebar.explore', locale)}</button>
<button id="reload" class="secondary">${t('sidebar.sync', locale)}</button>
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