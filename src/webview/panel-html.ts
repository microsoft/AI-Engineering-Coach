/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { getNonce } from './panel-shared';
import { getDashboardShellHtml } from './dashboard-shell';

export function getDashboardHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'app.js'));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'styles.css'));
  const nonce = getNonce();

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; style-src-elem ${webview.cspSource}; style-src-attr 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data: https://github.com https://avatars.githubusercontent.com; font-src ${webview.cspSource}; require-trusted-types-for 'script'; trusted-types coach-html default;">
<link href="${String(styleUri)}" rel="stylesheet">
<title>AI Engineer Coach</title>
</head>
<body>
${getDashboardShellHtml()}
<script nonce="${nonce}" src="${String(scriptUri)}"></script>
</body>
</html>`;
}

export function getErrorHtml(message: string): string {
  const escaped = message.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
body { background: #0d1117; color: #e6edf3; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
.error { text-align: center; max-width: 500px; }
.error h2 { color: #f85149; }
.error p { color: #8b949e; }
</style>
</head>
<body><div class="error"><h2>Error</h2><p>${escaped}</p></div></body>
</html>`;
}