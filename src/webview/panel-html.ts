/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as vscode from 'vscode';
import { getNonce } from './panel-shared';
import { FF_TOKEN_REPORTING_ENABLED } from '../core/constants';

const l10n = vscode.l10n;

/**
 * Read the l10n bundle for the current display language so it can be injected
 * into the webview, where `vscode.l10n` is unavailable. Returns a JSON string
 * safe to embed inside an inline <script> (no `<` to break out of the tag).
 * Falls back to `{}` for English or any locale without a bundle file — English
 * strings are the keys, so an empty bundle resolves to the source text.
 */
function loadWebviewL10nBundle(extensionUri: vscode.Uri): string {
  const locale = vscode.env.language.split(/[-_]/)[0].toLowerCase();
  if (!locale || locale === 'en') return '{}';
  const bundlePath = vscode.Uri.joinPath(extensionUri, 'l10n', `bundle.l10n.${locale}.json`).fsPath;
  try {
    return fs.readFileSync(bundlePath, 'utf8').replaceAll('<', '\\u003c');
  } catch {
    return '{}';
  }
}

export function getDashboardHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'app.js'));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'styles.css'));
  const nonce = getNonce();
  const l10nBundle = loadWebviewL10nBundle(extensionUri);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource}; require-trusted-types-for 'script'; trusted-types coach-html default;">
<link href="${String(styleUri)}" rel="stylesheet">
<title>AI Engineer Coach</title>
</head>
<body>
<div id="app">
  <nav id="sidebar">
    <ul class="nav-links">
      <li class="nav-group-header">${l10n.t('Observe')}</li>
      <li><a href="#" data-page="dashboard" class="active"><span class="nav-icon"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="1" y="8" width="3" height="6" rx="0.5" fill="currentColor"/><rect x="5.5" y="5" width="3" height="9" rx="0.5" fill="currentColor"/><rect x="10" y="2" width="3" height="12" rx="0.5" fill="currentColor"/></svg></span> ${l10n.t('Dashboard')}</a></li>
      <li><a href="#" data-page="timeline"><span class="nav-icon">&#9472;</span> ${l10n.t('Timeline')}<span class="nav-badge" id="badge-sessions"></span></a></li>
      <li><a href="#" data-page="image-gallery"><span class="nav-icon"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" stroke-width="1.2"/><circle cx="5.5" cy="6.5" r="1.2" stroke="currentColor" stroke-width="1"/><path d="M2 11l3-3 2 2 4-4 3 3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg></span> ${l10n.t('Coding Moments')}</a></li>
      <li class="nav-group-header">${l10n.t('Measure')}</li>
      <li><a href="#" data-page="output"><span class="nav-icon"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 12L6 7L9 9.5L14 3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M10.5 3H14V6.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></span> ${l10n.t('Output')}<span class="nav-badge" id="badge-output"></span></a></li>
      ${FF_TOKEN_REPORTING_ENABLED ? `<li><a href="#" data-page="burndown"><span class="nav-icon"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 3L8 8L14 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.4" stroke-dasharray="2 2"/><path d="M2 3L6 9L10 7L14 13" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><line x1="2" y1="13" x2="14" y2="13" stroke="currentColor" stroke-width="1" opacity="0.3"/></svg></span> ${l10n.t('Burndown')}<span class="nav-badge" id="badge-burndown"></span></a></li>` : ''}
      <li><a href="#" data-page="patterns"><span class="nav-icon"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="1" y="1" width="6" height="6" rx="1" fill="currentColor" opacity="0.9"/><rect x="9" y="1" width="6" height="6" rx="1" fill="currentColor" opacity="0.5"/><rect x="1" y="9" width="6" height="6" rx="1" fill="currentColor" opacity="0.5"/><rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor" opacity="0.9"/></svg></span> ${l10n.t('Patterns')}</a></li>
      <li class="nav-group-header">${l10n.t('Improve')}</li>
      <li><a href="#" data-page="anti-patterns"><span class="nav-icon">&#9888;</span> ${l10n.t('Anti-Patterns')}<span class="nav-badge" id="badge-antipatterns"></span></a></li>
      <li><a href="#" data-page="skills"><span class="nav-icon"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="4" cy="4" r="2.5" stroke="currentColor" stroke-width="1.3" fill="none"/><circle cx="12" cy="4" r="2.5" stroke="currentColor" stroke-width="1.3" fill="none"/><circle cx="8" cy="13" r="2.5" stroke="currentColor" stroke-width="1.3" fill="none"/><line x1="4" y1="6.5" x2="8" y2="10.5" stroke="currentColor" stroke-width="1.2"/><line x1="12" y1="6.5" x2="8" y2="10.5" stroke="currentColor" stroke-width="1.2"/></svg></span> ${l10n.t('Skill Finder')}<span class="nav-badge" id="badge-skills"></span></a></li>
      <li><a href="#" data-page="config-health"><span class="nav-icon"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 1L1.5 4.5V11.5L8 15L14.5 11.5V4.5Z" stroke="currentColor" stroke-width="1.3" fill="none"/><path d="M8 5.5V10.5M5.5 8H10.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></span> ${l10n.t('Context Health')}</a></li>
      <li><a href="#" data-page="level-up"><span class="nav-icon"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 1l2 5h5l-4 3.5 1.5 5L8 11.5 3.5 14.5 5 9.5 1 6h5z" stroke="currentColor" stroke-width="1.2" fill="none"/></svg></span> ${l10n.t('Level Up')}</a></li>
    </ul>
    <div class="sidebar-filters">
      <div class="sidebar-filter">
        <label>${l10n.t('Workspace')}</label>
        <div class="ws-toggle" id="ws-toggle">
          <button class="ws-toggle-btn active" data-ws="current">${l10n.t('Current')}</button>
          <button class="ws-toggle-btn" data-ws="all">${l10n.t('All')}</button>
        </div>
        <div class="combobox" id="ws-combobox">
          <input type="text" id="ws-filter-input" placeholder="${l10n.t('Search workspaces...')}" autocomplete="off" />
          <div class="combobox-list" id="ws-filter-list"></div>
          <input type="hidden" id="ws-filter" />
        </div>
      </div>
      <div class="sidebar-filter">
        <label for="harness-filter">${l10n.t('Harness')}</label>
        <select id="harness-filter"><option value="">${l10n.t('All Harnesses')}</option></select>
      </div>
    </div>
  </nav>
  <main id="content"></main>
</div>
<script nonce="${nonce}">window.__l10nBundle = ${l10nBundle};</script>
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