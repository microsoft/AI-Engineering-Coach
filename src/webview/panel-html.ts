/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { getNonce } from './panel-shared';
import { FF_TOKEN_REPORTING_ENABLED } from '../core/constants';
import { resolveLocale, t } from './i18n';

export function getDashboardHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  vscodeLanguage: string,
): string {
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'app.js'));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'styles.css'));
  const nonce = getNonce();
  const locale = resolveLocale(vscodeLanguage);
  const langAttr = locale === 'ru' ? 'ru' : 'en';
  const burndownNav = FF_TOKEN_REPORTING_ENABLED
    ? `<li><a href="#" data-page="burndown"><span class="nav-icon"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 3L8 8L14 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.4" stroke-dasharray="2 2"/><path d="M2 3L6 9L10 7L14 13" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><line x1="2" y1="13" x2="14" y2="13" stroke="currentColor" stroke-width="1" opacity="0.3"/></svg></span> ${t('nav.burndown', locale)}<span class="nav-badge" id="badge-burndown"></span></a></li>`
    : '';

  return `<!DOCTYPE html>
<html lang="${langAttr}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource}; require-trusted-types-for 'script'; trusted-types coach-html default;">
<link href="${String(styleUri)}" rel="stylesheet">
<title>${t('sidebar.title', locale)}</title>
</head>
<body>
<div id="app">
  <nav id="sidebar">
    <ul class="nav-links">
      <li class="nav-group-header">${t('nav.observe', locale)}</li>
      <li><a href="#" data-page="dashboard" class="active"><span class="nav-icon"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="1" y="8" width="3" height="6" rx="0.5" fill="currentColor"/><rect x="5.5" y="5" width="3" height="9" rx="0.5" fill="currentColor"/><rect x="10" y="2" width="3" height="12" rx="0.5" fill="currentColor"/></svg></span> ${t('nav.dashboard', locale)}</a></li>
      <li><a href="#" data-page="timeline"><span class="nav-icon">&#9472;</span> ${t('nav.timeline', locale)}<span class="nav-badge" id="badge-sessions"></span></a></li>
      <li><a href="#" data-page="image-gallery"><span class="nav-icon"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" stroke-width="1.2"/><circle cx="5.5" cy="6.5" r="1.2" stroke="currentColor" stroke-width="1"/><path d="M2 11l3-3 2 2 4-4 3 3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg></span> ${t('nav.codingMoments', locale)}</a></li>
      <li class="nav-group-header">${t('nav.measure', locale)}</li>
      <li><a href="#" data-page="output"><span class="nav-icon"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 12L6 7L9 9.5L14 3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M10.5 3H14V6.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></span> ${t('nav.output', locale)}<span class="nav-badge" id="badge-output"></span></a></li>
      ${burndownNav}
      <li><a href="#" data-page="patterns"><span class="nav-icon"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="1" y="1" width="6" height="6" rx="1" fill="currentColor" opacity="0.9"/><rect x="9" y="1" width="6" height="6" rx="1" fill="currentColor" opacity="0.5"/><rect x="1" y="9" width="6" height="6" rx="1" fill="currentColor" opacity="0.5"/><rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor" opacity="0.9"/></svg></span> ${t('nav.patterns', locale)}</a></li>
      <li class="nav-group-header">${t('nav.improve', locale)}</li>
      <li><a href="#" data-page="anti-patterns"><span class="nav-icon">&#9888;</span> ${t('nav.antiPatterns', locale)}<span class="nav-badge" id="badge-antipatterns"></span></a></li>
      <li><a href="#" data-page="skills"><span class="nav-icon"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="4" cy="4" r="2.5" stroke="currentColor" stroke-width="1.3" fill="none"/><circle cx="12" cy="4" r="2.5" stroke="currentColor" stroke-width="1.3" fill="none"/><circle cx="8" cy="13" r="2.5" stroke="currentColor" stroke-width="1.3" fill="none"/><line x1="4" y1="6.5" x2="8" y2="10.5" stroke="currentColor" stroke-width="1.2"/><line x1="12" y1="6.5" x2="8" y2="10.5" stroke="currentColor" stroke-width="1.2"/></svg></span> ${t('nav.skillFinder', locale)}<span class="nav-badge" id="badge-skills"></span></a></li>
      <li><a href="#" data-page="config-health"><span class="nav-icon"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 1L1.5 4.5V11.5L8 15L14.5 11.5V4.5Z" stroke="currentColor" stroke-width="1.3" fill="none"/><path d="M8 5.5V10.5M5.5 8H10.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></span> ${t('nav.contextHealth', locale)}</a></li>
      <li><a href="#" data-page="level-up"><span class="nav-icon"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 1l2 5h5l-4 3.5 1.5 5L8 11.5 3.5 14.5 5 9.5 1 6h5z" stroke="currentColor" stroke-width="1.2" fill="none"/></svg></span> ${t('nav.levelUpPage', locale)}</a></li>
    </ul>
    <div class="sidebar-filters">
      <div class="sidebar-filter">
        <label>${t('filter.workspace', locale)}</label>
        <div class="ws-toggle" id="ws-toggle">
          <button class="ws-toggle-btn active" data-ws="current">${t('filter.current', locale)}</button>
          <button class="ws-toggle-btn" data-ws="all">${t('filter.all', locale)}</button>
        </div>
        <div class="combobox" id="ws-combobox">
          <input type="text" id="ws-filter-input" placeholder="${t('filter.searchWs', locale)}" autocomplete="off" />
          <div class="combobox-list" id="ws-filter-list"></div>
          <input type="hidden" id="ws-filter" />
        </div>
      </div>
      <div class="sidebar-filter">
        <label for="harness-filter">${t('filter.harness', locale)}</label>
        <select id="harness-filter"><option value="">${t('filter.allHarnesses', locale)}</option></select>
      </div>
    </div>
  </nav>
  <main class="content-wrap">
    ${locale === 'ru' ? `<div class="lang-banner" id="lang-banner">${t('langBanner', locale)}</div>` : ''}
    <div id="content"></div>
  </main>
</div>
<script nonce="${nonce}" src="${String(scriptUri)}"></script>
</body>
</html>`;
}

export function getErrorHtml(message: string, vscodeLanguage?: string): string {
  const locale = resolveLocale(vscodeLanguage || 'en');
  const title = locale === 'ru' ? 'Ошибка' : 'Error';
  const escaped = message.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return `<!DOCTYPE html>
<html lang="${locale === 'ru' ? 'ru' : 'en'}">
<head>
<meta charset="UTF-8">
<style>
body { background: #0d1117; color: #e6edf3; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
.error { text-align: center; max-width: 500px; }
.error h2 { color: #f85149; }
.error p { color: #8b949e; }
</style>
</head>
<body><div class="error"><h2>${title}</h2><p>${escaped}</p></div></body>
</html>`;
}
