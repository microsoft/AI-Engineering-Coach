/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Static markup of the loading screen: the status card and its details drawer. Every element
 * the screen updates has an id; ./loading-screen fills them in place. */

import { LOAD_PHASES } from '../core/load-phases';
import { STEP_LABELS, type ActivityFilter } from './loading-model';
import { html, type ComponentChildren } from './render';

export interface StatField {
  key: 'sessions' | 'requests' | 'toolCalls' | 'linesOfCode' | 'filesEdited';
  id: string;
  label: string;
}

export const STAT_FIELDS: StatField[] = [
  { key: 'sessions', id: 'loading-stat-sessions', label: 'sessions' },
  { key: 'requests', id: 'loading-stat-requests', label: 'prompts' },
  { key: 'toolCalls', id: 'loading-stat-tools', label: 'tool calls' },
  { key: 'linesOfCode', id: 'loading-stat-loc', label: 'lines written' },
  { key: 'filesEdited', id: 'loading-stat-files', label: 'files touched' },
];

const FILTERS: Array<{ id: ActivityFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'slow', label: 'Slow' },
  { id: 'skipped', label: 'Skipped' },
];

function stepperMarkup(): ComponentChildren {
  return html`
    <ol class="load-stepper" id="loading-stepper">
      ${STEP_LABELS.map((label, i) => html`
        <li class="load-seg" id=${'loading-step-' + i} data-state="pending" title=${LOAD_PHASES[i]}>
          <div class="load-seg-bar"><div class="load-seg-fill" id=${'loading-step-fill-' + i}></div></div>
          <div class="load-seg-label"><i class="load-seg-dot" aria-hidden="true"></i><span>${label}</span></div>
          <span class="visually-hidden" id=${'loading-step-status-' + i}>${LOAD_PHASES[i]}: not started</span>
        </li>`)}
    </ol>`;
}

function drawerMarkup(open: boolean): ComponentChildren {
  return html`
    <div class="load-details" id="loading-details" hidden=${!open}>
      <div class="load-box">
        <div class="load-box-head">Steps</div>
        <ul class="load-phase-list" id="loading-phase-list">
          ${LOAD_PHASES.map((label, i) => html`<li class="load-phase" id=${'loading-phase-row-' + i} data-state="pending"><i aria-hidden="true">\u25CB</i><span>${label}</span><span class="load-phase-ms" id=${'loading-phase-ms-' + i}>\u2014</span></li>`)}
        </ul>
        <div class="load-box-head load-box-head-sub">Worker</div>
        <div class="loading-telemetry" id="loading-telemetry"></div>
      </div>
      <div class="load-box load-activity">
        <div class="load-box-head">
          <span>Activity</span>
          <div class="load-filters" role="group" aria-label="Filter activity">
            ${FILTERS.map(f => html`<button type="button" class="load-filter" data-filter=${f.id} aria-pressed=${f.id === 'all' ? 'true' : 'false'}>${f.label}<span class="load-filter-count" id=${'loading-filter-count-' + f.id}></span></button>`)}
          </div>
          <button type="button" class="load-copy" id="loading-copy">Copy diagnostics</button>
        </div>
        <span class="visually-hidden" id="loading-copy-status" aria-live="polite"></span>
        <div class="load-table-wrap">
          <table class="load-table">
            <thead><tr><th scope="col" class="r">Elapsed</th><th scope="col">Folder</th><th scope="col" class="r">Sessions</th><th scope="col" class="r">Took</th><th scope="col">Status</th></tr></thead>
            <tbody id="loading-activity"></tbody>
          </table>
          <p class="load-empty" id="loading-activity-empty">Folders appear here as they are read.</p>
        </div>
      </div>
    </div>`;
}

function cardMarkup(open: boolean): ComponentChildren {
  return html`
    <section class=${'load-card' + (open ? ' details-open' : '')} id="loading-card" aria-labelledby="loading-phase-title">
      <div class="load-head">
        <div class="load-hero">
          <div class="load-kicker" id="loading-kicker"><span class="load-check" aria-hidden="true">\u2713</span><span id="loading-kicker-text">Building your activity index</span></div>
          <h2 class="load-title" id="loading-phase-title">${LOAD_PHASES[0]}</h2>
        </div>
        <div class="load-pct" id="loading-pct" role="progressbar" aria-label="Loading progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span id="loading-pct-value">0</span><small>%</small></div>
      </div>
      <div class="load-progress">
        ${stepperMarkup()}
        <div class="load-now-line">
          <span class="load-now" id="loading-phase-detail">Preparing parser and workspace inventory.</span>
          <span class="load-time" id="loading-time"></span>
        </div>
        <p class="load-note" id="loading-note" hidden>Cached sessions are loaded. Copilot CLI and App sessions are read again on every open.</p>
      </div>
      <div class="load-found" id="loading-found">
        <div class="load-section-label" id="loading-found-label">Found so far</div>
        <div class="load-stat-grid">
          ${STAT_FIELDS.map(f => html`<div class="load-stat"><b id=${f.id}>\u2014</b><span>${f.label}</span></div>`)}
        </div>
      </div>
      <div class="load-foot">
        <span class="load-health" id="loading-health" data-level="ok" hidden><i class="load-health-dot" aria-hidden="true"></i><span id="loading-health-text"></span></span>
        <button type="button" class="load-details-toggle" id="loading-details-toggle" aria-expanded=${open ? 'true' : 'false'} aria-controls="loading-details">${open ? 'Hide details' : 'Show details'}</button>
      </div>
      ${drawerMarkup(open)}
    </section>`;
}

/** The whole loading screen: tile field, clearing behind the card, and the card. */
export function loadingScreenMarkup(open: boolean): ComponentChildren {
  return html`
    <div class="loading-screen load-index" id="load-index" data-state="loading">
      <div class="loading-tile-bg" id="loading-tile-bg"></div>
      <div class="load-clearing" aria-hidden="true"></div>
      <div class="load-stage">${cardMarkup(open)}</div>
    </div>`;
}
