/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* The dashboard shell DOM (sidebar nav + content host). Shared by the VS Code
 * webview (panel-html.ts) and the Copilot app canvas host so both render the
 * exact structure that app.ts wires into. Contains no host-specific markup. */

import { FF_TOKEN_REPORTING_ENABLED } from '../core/constants';

export function getDashboardShellHtml(opts?: { includeSkillFinder?: boolean; includeLevelUp?: boolean }): string {
  const includeSkillFinder = opts?.includeSkillFinder !== false;
  const includeLevelUp = opts?.includeLevelUp !== false;
  return `<div id="app">
  <nav id="sidebar">
    <ul class="nav-links">
      <li class="nav-group-header">Observe</li>
      <li><a href="#" data-page="dashboard" class="active"><span class="nav-icon"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="1" y="8" width="3" height="6" rx="0.5" fill="currentColor"/><rect x="5.5" y="5" width="3" height="9" rx="0.5" fill="currentColor"/><rect x="10" y="2" width="3" height="12" rx="0.5" fill="currentColor"/></svg></span> Dashboard</a></li>
      <li><a href="#" data-page="timeline"><span class="nav-icon">&#9472;</span> Timeline<span class="nav-badge" id="badge-sessions" aria-live="polite" aria-atomic="true" aria-label="Timeline sessions"></span></a></li>
      <li><a href="#" data-page="image-gallery"><span class="nav-icon"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" stroke-width="1.2"/><circle cx="5.5" cy="6.5" r="1.2" stroke="currentColor" stroke-width="1"/><path d="M2 11l3-3 2 2 4-4 3 3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg></span> Coding Moments</a></li>
      <li class="nav-group-header">Measure</li>
      <li><a href="#" data-page="output"><span class="nav-icon"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 12L6 7L9 9.5L14 3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M10.5 3H14V6.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></span> Output<span class="nav-badge" id="badge-output" aria-live="polite" aria-atomic="true" aria-label="Output"></span></a></li>
      ${FF_TOKEN_REPORTING_ENABLED ? '<li><a href="#" data-page="burndown"><span class="nav-icon"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 3L8 8L14 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.4" stroke-dasharray="2 2"/><path d="M2 3L6 9L10 7L14 13" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><line x1="2" y1="13" x2="14" y2="13" stroke="currentColor" stroke-width="1" opacity="0.3"/></svg></span> Burndown<span class="nav-badge" id="badge-burndown" aria-live="polite" aria-atomic="true" aria-label="Burndown"></span></a></li>' : ''}
      <li><a href="#" data-page="patterns"><span class="nav-icon"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="1" y="1" width="6" height="6" rx="1" fill="currentColor" opacity="0.9"/><rect x="9" y="1" width="6" height="6" rx="1" fill="currentColor" opacity="0.5"/><rect x="1" y="9" width="6" height="6" rx="1" fill="currentColor" opacity="0.5"/><rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor" opacity="0.9"/></svg></span> Patterns</a></li>
      <li class="nav-group-header">Improve</li>
      <li><a href="#" data-page="anti-patterns"><span class="nav-icon">&#9888;</span> Anti-Patterns<span class="nav-badge" id="badge-antipatterns" aria-live="polite" aria-atomic="true" aria-label="Anti-patterns"></span></a></li>
      ${includeSkillFinder ? '<li><a href="#" data-page="skills"><span class="nav-icon"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="4" cy="4" r="2.5" stroke="currentColor" stroke-width="1.3" fill="none"/><circle cx="12" cy="4" r="2.5" stroke="currentColor" stroke-width="1.3" fill="none"/><circle cx="8" cy="13" r="2.5" stroke="currentColor" stroke-width="1.3" fill="none"/><line x1="4" y1="6.5" x2="8" y2="10.5" stroke="currentColor" stroke-width="1.2"/><line x1="12" y1="6.5" x2="8" y2="10.5" stroke="currentColor" stroke-width="1.2"/></svg></span> Skill Finder<span class="nav-badge" id="badge-skills" aria-live="polite" aria-atomic="true" aria-label="Skill Finder"></span></a></li>' : ''}
      <li><a href="#" data-page="config-health"><span class="nav-icon"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 1L1.5 4.5V11.5L8 15L14.5 11.5V4.5Z" stroke="currentColor" stroke-width="1.3" fill="none"/><path d="M8 5.5V10.5M5.5 8H10.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></span> Context Health</a></li>
      ${includeLevelUp ? '<li><a href="#" data-page="level-up"><span class="nav-icon"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 1l2 5h5l-4 3.5 1.5 5L8 11.5 3.5 14.5 5 9.5 1 6h5z" stroke="currentColor" stroke-width="1.2" fill="none"/></svg></span> Level Up</a></li>' : ''}
    </ul>
    <div class="sidebar-filters">
      <div class="sidebar-filter">
        <label>Workspace</label>
        <div class="ws-toggle" id="ws-toggle">
          <button class="ws-toggle-btn active" data-ws="current">Current</button>
          <button class="ws-toggle-btn" data-ws="all">All</button>
        </div>
        <div class="combobox" id="ws-combobox">
          <input type="text" id="ws-filter-input" placeholder="Search workspaces..." autocomplete="off" />
          <div class="combobox-list" id="ws-filter-list"></div>
          <input type="hidden" id="ws-filter" />
        </div>
      </div>
      <div class="sidebar-filter">
        <label for="harness-filter">Harness</label>
        <select id="harness-filter"><option value="">All Harnesses</option></select>
      </div>
    </div>
  </nav>
  <main id="content"></main>
</div>`;
}
