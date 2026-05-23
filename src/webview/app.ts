/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Webview entry -- runs in the browser context inside the VS Code webview */

import { setLocaleFromDocument } from './i18n';
import { AntiPatternData, DateFilter, StatsResult } from '../core/types';

setLocaleFromDocument();
import { $, $$, rpc, destroyCharts, initMessageListener, withErrorBoundary } from './shared';
import { html, render, unmount, ComponentChildren } from './render';
import { renderDashboard } from './page-dashboard';
import { renderPatterns } from './page-patterns';
import { renderOutput } from './page-output';
import { renderBurndown } from './page-burndown';
import { renderTimeline } from './page-timeline';
import { renderAntiPatterns } from './page-antipatterns';
// page-rule-editor merged into page-antipatterns
import { renderSkills } from './page-skills';
import { renderConfigHealth } from './page-config';
import { renderLevelUp } from './page-experiments';
import { renderDataExplorer } from './page-data-explorer';
import { renderRulePlayground } from './page-rule-playground';
import { renderImageGallery } from './page-image-gallery';
import { FF_TOKEN_REPORTING_ENABLED } from '../core/constants';

function normalizePageForFeatureFlags(page: string): string {
  if (!FF_TOKEN_REPORTING_ENABLED && page === 'burndown') return 'dashboard';
  return page;
}

/* ---- Feature-flag gating: hide token-reporting nav items ---- */
if (!FF_TOKEN_REPORTING_ENABLED) {
  const burndownLink = document.querySelector<HTMLElement>('[data-page="burndown"]');
  burndownLink?.parentElement?.remove();
}

/* ---- Global state ---- */
let currentPage = 'dashboard';
const currentFilter: DateFilter = {};
let _dataIsReady = false;
let matchedWorkspaceId: string | undefined;

/** Navigation hint: which sub-section to auto-open after navigating */
export let navHint: string | undefined;
export function setNavHint(hint: string | undefined): void { navHint = hint; }
export function consumeNavHint(): string | undefined { const h = navHint; navHint = undefined; return h; }

/* ---- Nav Badge Helpers ---- */
function setBadge(id: string, value: string | number): void {
  const el = document.getElementById(id);
  if (!el) return;
  const text = typeof value === 'number' ? (value > 9999 ? `${(value / 1000).toFixed(1)}k` : String(value)) : value;
  el.textContent = text;
  el.classList.add('visible');
}

/** Exported so pages (e.g. Skill Finder) can update their badge after async work. */
export function updateNavBadge(id: string, value: string | number): void { setBadge(id, value); }

/** Fetch lightweight counts and populate sidebar badges. Fire-and-forget. */
function refreshNavBadges(filter: DateFilter): void {
  void rpc<StatsResult>('getStats', filter as Record<string, unknown>).then(s => {
    setBadge('badge-sessions', s.totalSessions);
  }).catch(() => {/* best-effort */});

  void rpc<AntiPatternData>('getAntiPatterns', filter as Record<string, unknown>).then(d => {
    setBadge('badge-antipatterns', d.patterns.length);
  }).catch(() => {});

  void rpc<{ summary: { totalAiLoc: number } }>('getCodeProduction', filter as Record<string, unknown>).then(d => {
    const loc = d.summary.totalAiLoc;
    const label = loc >= 1_000_000 ? `${(loc / 1_000_000).toFixed(1)}M`
      : loc >= 1_000 ? `${(loc / 1_000).toFixed(loc >= 10_000 ? 0 : 1)}K`
      : String(loc);
    setBadge('badge-output', label);
  }).catch(() => {});

}

/* ---- Progress + Data Ready ---- */

/** Phase labels matching LOAD_PHASES from parser.ts */
const PHASE_LABELS = [
  'Discovering log directories',
  'Checking cache',
  'Parsing session logs',
  'Scanning external harnesses',
  'Preparing analytics',
  'Ready',
];

let loadStartTime = 0;
let elapsedTimerId = 0;

function setShellLoadingMode(isLoading: boolean): void {
  const app = document.getElementById('app');
  if (!app) return;
  app.classList.toggle('loading-mode', isLoading);
}

/** Render the loading screen with progress bar, phase list, and session counter */
function ensureLoadingUI(): void {
  const content = $('#content');
  if (!content) return;
  if (document.getElementById('load-progress-bar')) return; // already rendered
  setShellLoadingMode(true);
  loadStartTime = Date.now();
  render(html`
    <div class="loading-screen">
      <div class="loading-tile-bg" id="loading-tile-bg"></div>
      <div class="loading-tile-vignette"></div>
      <div class="loading-card-wrap">
        <div class="loading-status-card">
          <div class="loading-status-head">
            <div class="loading-hero">
              <div class="loading-kicker">Building Activity Index</div>
              <div class="loading-title" id="loading-phase-title">${PHASE_LABELS[0]}</div>
              <div class="loading-phase-detail" id="loading-phase-detail">Preparing parser and workspace inventory.</div>
            </div>
            <div class="loading-meta">
              <span class="loading-pct" id="loading-pct">0%</span>
              <span class="loading-sessions" id="loading-sessions"></span>
              <span class="loading-elapsed" id="loading-elapsed"></span>
            </div>
          </div>
          <div class="progress-bar-track"><div class="progress-bar-fill" id="load-progress-bar"></div></div>
          <div class="loading-stats-ticker" id="loading-stats-ticker"></div>
          <div class="loading-body">
            <ul class="progress-checklist" id="progress-checklist">
              ${PHASE_LABELS.map((label, i) => html`<li class="progress-step" id=${'pstep-' + i}><span class="step-icon">\u25CB</span> <span class="step-label">${label}</span></li>`)}
            </ul>
            <div class="loading-log" id="loading-log"><div class="loading-log-placeholder">Parser events will appear here as workspaces are scanned.</div></div>
          </div>
        </div>
      </div>
    </div>`, content);

  // Start elapsed timer
  clearInterval(elapsedTimerId);
  elapsedTimerId = window.setInterval(() => {
    const el = document.getElementById('loading-elapsed');
    if (!el) return;
    const sec = Math.round((Date.now() - loadStartTime) / 1000);
    el.textContent = sec > 0 ? `${sec}s` : '';
  }, 1000);
}

/* ---- Workspace loading grid state ---- */
let workspacePlan: string[] = [];
let workspaceDone = new Set<string>();
let workspaceRendered = false;
let workspaceSlotIndex = new Map<string, number>();
let loadingGridResizeBound = false;

interface WorkspacePlanMeta {
  key: string;
  order: number;
  date: string | null;
  month: string;
  workspace: string;
  workspaceKey: string;
  size: number;
}

let workspaceGroupSlots = new Map<string, number[]>();

function layoutWorkspaceGrid(): void {
  const container = document.getElementById('loading-tile-bg');
  const grid = document.getElementById('loading-bg-grid');
  if (!container || !grid) return;

  const W = container.clientWidth;
  const H = container.clientHeight;
  const N = workspacePlan.length;
  if (N === 0 || W < 20 || H < 20) return;

  // Compute rows & cols proportional to viewport aspect ratio
  const aspect = W / H;
  const rows = Math.max(1, Math.ceil(Math.sqrt(N / aspect)));
  const cols = Math.max(1, Math.ceil(N / rows));

  // Cell size: fill ~60% of space with tiles, rest is breathing room via space-evenly
  const maxCellW = W / cols;
  const maxCellH = H / rows;
  const stride = Math.min(maxCellW, maxCellH);
  const size = Math.max(2, Math.min(16, Math.floor(stride * 0.6)));

  grid.style.setProperty('--bg-rows', String(rows));
  grid.style.setProperty('--bg-cols', String(cols));
  grid.style.setProperty('--bg-cell', `${size}px`);
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const weight = idx - lo;
  return sorted[lo] * (1 - weight) + sorted[hi] * weight;
}

function sessionIntensityLevel(size: number, breakpoints: { q25: number; q50: number; q75: number }): 1 | 2 | 3 | 4 {
  if (size >= breakpoints.q75 && breakpoints.q75 > 0) return 4;
  if (size >= breakpoints.q50 && breakpoints.q50 > 0) return 3;
  if (size >= breakpoints.q25 && breakpoints.q25 > 0) return 2;
  return 1;
}

function sessionTileVars(level: 1 | 2 | 3 | 4): { pendingBg: string; pendingBorder: string; doneBg: string; doneBorder: string; doneGlow: string } {
  const strengths = {
    1: { pending: 6, border: 14, done: 35, glow: 18 },
    2: { pending: 9, border: 18, done: 48, glow: 24 },
    3: { pending: 12, border: 24, done: 62, glow: 30 },
    4: { pending: 16, border: 30, done: 78, glow: 38 },
  }[level];

  return {
    pendingBg: `color-mix(in srgb, var(--accent-blue) ${strengths.pending}%, var(--vscode-editor-background, #1e1e1e))`,
    pendingBorder: `color-mix(in srgb, var(--accent-blue) ${strengths.border}%, var(--border))`,
    doneBg: `color-mix(in srgb, var(--vscode-progressBar-background, var(--accent-blue)) ${strengths.done}%, var(--vscode-editor-background, #1e1e1e))`,
    doneBorder: `color-mix(in srgb, var(--vscode-progressBar-background, var(--accent-blue)) ${Math.min(90, strengths.done + 8)}%, var(--border))`,
    doneGlow: `color-mix(in srgb, var(--vscode-progressBar-background, var(--accent-blue)) ${strengths.glow}%, transparent)`,
  };
}

function parseWorkspacePlanKey(key: string, fallbackOrder: number): WorkspacePlanMeta {
  try {
    const parsed = JSON.parse(key) as { order?: number; date?: string | null; wsId?: string; workspaceKey?: string; size?: number };
    const order = typeof parsed.order === 'number' ? parsed.order : fallbackOrder;
    const date = typeof parsed.date === 'string' ? parsed.date : null;
    return {
      key,
      order,
      date,
      month: date ? date.slice(0, 7) : `chunk-${Math.floor(fallbackOrder / 28)}`,
      workspace: typeof parsed.wsId === 'string' && parsed.wsId.length > 0 ? parsed.wsId : `Workspace ${fallbackOrder + 1}`,
      workspaceKey: typeof parsed.workspaceKey === 'string' && parsed.workspaceKey.length > 0 ? parsed.workspaceKey : `workspace-${fallbackOrder}`,
      size: typeof parsed.size === 'number' ? parsed.size : 0,
    };
  } catch {
    return {
      key,
      order: fallbackOrder,
      date: null,
      month: `chunk-${Math.floor(fallbackOrder / 28)}`,
      workspace: `Workspace ${fallbackOrder + 1}`,
      workspaceKey: `workspace-${fallbackOrder}`,
      size: 0,
    };
  }
}

function renderWorkspaceGrid(plan: string[]): void {
  workspacePlan = plan;
  workspaceDone = new Set();
  workspaceRendered = true;
  workspaceSlotIndex = new Map();
  workspaceGroupSlots = new Map();

  const container = document.getElementById('loading-tile-bg');
  if (!container) return;
  if (plan.length === 0) { container.style.display = 'none'; return; }

  const items = plan.map((key, index) => parseWorkspacePlanKey(key, index))
    .sort((a, b) => a.order - b.order);
  const sizes = items.map(item => item.size).filter(size => size > 0);
  const intensityBreakpoints = {
    q25: percentile(sizes, 0.25),
    q50: percentile(sizes, 0.5),
    q75: percentile(sizes, 0.75),
  };

  for (const item of items) {
    workspaceSlotIndex.set(item.key, item.order);
    const existingSlots = workspaceGroupSlots.get(item.workspaceKey) ?? [];
    existingSlots.push(item.order);
    workspaceGroupSlots.set(item.workspaceKey, existingSlots);
  }

  const gridCells = items.map(item => {
    const level = sessionIntensityLevel(item.size, intensityBreakpoints);
    const vars = sessionTileVars(level);
    const titleParts = [item.date ? item.date : '', item.workspace, item.size > 0 ? `${Math.round(item.size / 1024)} KB session` : 'session'];
    return html`<div class="cal-cell cal-workspace-cell cal-workspace-pending" data-slot=${item.order} title=${titleParts.filter(Boolean).join(' \u2014 ')} style=${`--pending-bg:${vars.pendingBg};--pending-border:${vars.pendingBorder};--done-bg:${vars.doneBg};--done-border:${vars.doneBorder};--done-glow:${vars.doneGlow};`}></div>`;
  });
  render(html`<div class="loading-bg-grid" id="loading-bg-grid">${gridCells}</div>`, container);
  container.style.display = '';

  requestAnimationFrame(() => layoutWorkspaceGrid());

  if (!loadingGridResizeBound) {
    window.addEventListener('resize', layoutWorkspaceGrid);
    loadingGridResizeBound = true;
  }
}

function renderPageLater(page: string): void {
  void renderPage(page);
}

function updateWorkspaceCell(workspaceKey: string, detail?: string): void {
  if (!workspaceRendered || workspaceDone.has(workspaceKey)) return;
  const slots = workspaceGroupSlots.get(workspaceKey);
  if (!slots || slots.length === 0) return;
  workspaceDone.add(workspaceKey);

  for (const slotIdx of slots) {
    const cell = document.querySelector<HTMLElement>(`[data-slot="${slotIdx}"]`);
    if (!cell) continue;
    cell.className = 'cal-cell cal-workspace-cell cal-workspace-done cal-pop';
    if (detail) cell.title = detail;
  }
}

function updateLoadingLog(phase: string, detail: string): void {
  const log = document.getElementById('loading-log');
  if (!log) return;

  log.querySelector<HTMLElement>('.loading-log-placeholder')?.remove();
  const line = document.createElement('div');
  line.className = 'log-line';
  if (detail.includes('Skipped ') || detail.includes('skipping in ')) line.classList.add('log-skip');
  else if (detail.match(/\(\d+\.\d+s\)/)) line.classList.add('log-slow');

  const now = new Date();
  const ts = `${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
  line.textContent = `[${ts}] ${phase}${detail ? ' \u2014 ' + detail : ''}`;
  log.appendChild(line);
  while (log.children.length > 200) log.removeChild(log.firstChild!);
  log.scrollTop = log.scrollHeight;
}

function updatePhaseChecklist(currentPhase: number): void {
  for (let i = 0; i < PHASE_LABELS.length; i++) {
    const stepEl = document.getElementById(`pstep-${i}`);
    if (!stepEl) continue;
    const icon = stepEl.querySelector<HTMLElement>('.step-icon');
    if (!icon) continue;

    if (i < currentPhase) {
      stepEl.className = 'progress-step step-done';
      icon.textContent = '\u2713';
    } else if (i === currentPhase) {
      stepEl.className = 'progress-step step-active';
      icon.textContent = '\u25B6';
    } else {
      stepEl.className = 'progress-step';
      icon.textContent = '\u25CB';
    }
  }
}

/** Update UI based on progress message */
function handleProgress(msg: { phase: number; detail?: string; pct: number; sessions?: number; linesOfCode?: number; toolCalls?: number; imagesAnalyzed?: number; filesEdited?: number; requests?: number; workspacePlan?: string[]; workspaceDone?: string }): void {
  ensureLoadingUI();
  const phase = PHASE_LABELS[msg.phase] ?? `Phase ${msg.phase}`;
  const detail = msg.detail ?? '';

  if (msg.workspacePlan) renderWorkspaceGrid(msg.workspacePlan);
  if (msg.workspaceDone) updateWorkspaceCell(msg.workspaceDone, msg.detail);

  const phaseTitleEl = document.getElementById('loading-phase-title');
  if (phaseTitleEl) phaseTitleEl.textContent = phase;
  const phaseDetailEl = document.getElementById('loading-phase-detail');
  if (phaseDetailEl) phaseDetailEl.textContent = detail || 'Working through your workspace history.';

  const bar = document.getElementById('load-progress-bar');
  if (bar) bar.style.width = `${Math.min(100, msg.pct)}%`;

  const pctEl = document.getElementById('loading-pct');
  if (pctEl) pctEl.textContent = `${Math.min(100, msg.pct)}%`;

  const sessEl = document.getElementById('loading-sessions');
  if (sessEl && msg.sessions && msg.sessions > 0) {
    sessEl.textContent = `${msg.sessions.toLocaleString()} sessions`;
  }

  // Update fun stats ticker (update values in-place, no re-render)
  const tickerEl = document.getElementById('loading-stats-ticker');
  if (tickerEl && msg.sessions && msg.sessions > 0) {
    if (!tickerEl.dataset.init) {
      tickerEl.dataset.init = '1';
      tickerEl.innerHTML = [
        `<span class="ticker-stat" id="ts-loc"><svg class="ticker-icon" viewBox="0 0 16 16" fill="none"><path d="M4 2h5l3 3v9H4V2z" stroke="currentColor" stroke-width="1.3"/><path d="M6 8h4M6 10.5h3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg><span class="ticker-value" id="tv-loc">0</span> lines generated</span>`,
        `<span class="ticker-stat" id="ts-tools"><svg class="ticker-icon" viewBox="0 0 16 16" fill="none"><path d="M10.3 2.5a2.2 2.2 0 0 0-3 3.1L3.5 9.4l-.9 3.1 3.1-.9 3.8-3.8a2.2 2.2 0 0 0 3.1-3l-1.6 1.6-1.1-1.1L11.5 3.7z" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg><span class="ticker-value" id="tv-tools">0</span> tool calls</span>`,
        `<span class="ticker-stat" id="ts-images"><svg class="ticker-icon" viewBox="0 0 16 16" fill="none"><rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" stroke-width="1.2"/><circle cx="5.5" cy="6.5" r="1.2" stroke="currentColor" stroke-width="1"/><path d="M2 11l3-3 2 2 4-4 3 3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg><span class="ticker-value" id="tv-images">0</span> images analyzed</span>`,
        `<span class="ticker-stat" id="ts-files"><svg class="ticker-icon" viewBox="0 0 16 16" fill="none"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3H7l1 1.5h4.5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5V4.5z" stroke="currentColor" stroke-width="1.2"/></svg><span class="ticker-value" id="tv-files">0</span> files touched</span>`,
        `<span class="ticker-stat" id="ts-reqs"><svg class="ticker-icon" viewBox="0 0 16 16" fill="none"><path d="M3 3h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H5l-3 2.5V4a1 1 0 0 1 1-1z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg><span class="ticker-value" id="tv-reqs">0</span> prompts sent</span>`,
      ].join('');
    }
    const locEl = document.getElementById('tv-loc');
    const toolsEl = document.getElementById('tv-tools');
    const imagesEl = document.getElementById('tv-images');
    const filesEl = document.getElementById('tv-files');
    const reqsEl = document.getElementById('tv-reqs');
    if (locEl && msg.linesOfCode) {
      const locLabel = msg.linesOfCode >= 1_000_000
        ? `${(msg.linesOfCode / 1_000_000).toFixed(1)}M`
        : msg.linesOfCode >= 1_000 ? `${(msg.linesOfCode / 1_000).toFixed(0)}K` : String(msg.linesOfCode);
      locEl.textContent = locLabel;
    }
    if (toolsEl && msg.toolCalls) toolsEl.textContent = msg.toolCalls.toLocaleString();
    if (imagesEl && msg.imagesAnalyzed) imagesEl.textContent = msg.imagesAnalyzed.toLocaleString();
    if (filesEl && msg.filesEdited) filesEl.textContent = msg.filesEdited.toLocaleString();
    if (reqsEl && msg.requests) reqsEl.textContent = msg.requests.toLocaleString();
    // Show/hide stats that have no data
    document.getElementById('ts-loc')?.classList.toggle('ticker-hidden', !msg.linesOfCode);
    document.getElementById('ts-tools')?.classList.toggle('ticker-hidden', !msg.toolCalls);
    document.getElementById('ts-images')?.classList.toggle('ticker-hidden', !msg.imagesAnalyzed);
    document.getElementById('ts-files')?.classList.toggle('ticker-hidden', !msg.filesEdited);
    document.getElementById('ts-reqs')?.classList.toggle('ticker-hidden', !msg.requests);
  }

  updateLoadingLog(phase, detail);
  updatePhaseChecklist(msg.phase);
}

function onDataReady(currentWorkspace: string): void {
  _dataIsReady = true;
  clearInterval(elapsedTimerId);
  setShellLoadingMode(false);
  void rpc<{ id: string; name: string; recent?: boolean; harnesses?: string[] }[]>('getWorkspaces').then((wss) => {
    wsOptions = wss;
    for (const ws of wss) {
      if (currentWorkspace && ws.name.toLowerCase().includes(currentWorkspace.toLowerCase())) {
        matchedWorkspaceId = ws.id;
        break;
      }
    }
    updateToggleState();
  }).catch(() => {});

  void rpc<string[]>('getHarnesses').then((harnesses) => {
    if (!harnessFilter) return;
    // Preact's render() doesn't work well inside <select> — use native DOM
    harnessFilter.length = 1; // keep "All Harnesses" default option
    for (const h of harnesses) {
      harnessFilter.add(new Option(h, h));
    }
  }).catch(() => {});

  navigateTo(currentPage);
  refreshNavBadges(currentFilter);
}

initMessageListener(handleProgress, onDataReady);

/* ---- Navigation ---- */
document.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  const link = target.closest<HTMLElement>('[data-page]');
  if (link) {
    e.preventDefault();
    const hint = link.dataset.navHint;
    if (hint) setNavHint(hint);
    const page = link.dataset.page;
    if (page) navigateTo(page);
  }
});

export function navigateTo(page: string): void {
  page = normalizePageForFeatureFlags(page);
  currentPage = page;
  for (const a of $$<HTMLAnchorElement>('.nav-links a')) a.classList.toggle('active', a.dataset.page === page);
  void renderPage(page);
}

/* ---- Workspace toggle + filter ---- */
const wsFilterHidden = document.getElementById('ws-filter') as HTMLInputElement | null;
const wsFilterInput = document.getElementById('ws-filter-input') as HTMLInputElement | null;
const wsFilterList = document.getElementById('ws-filter-list');
const wsCombobox = document.getElementById('ws-combobox');
const wsToggle = document.getElementById('ws-toggle');
const harnessFilter = document.getElementById('harness-filter') as HTMLSelectElement | null;

let wsOptions: { id: string; name: string; recent?: boolean; harnesses?: string[] }[] = [];

function updateToggleState(): void {
  if (!wsToggle) return;
  const btns = wsToggle.querySelectorAll('.ws-toggle-btn');
  for (const b of btns) b.classList.remove('active');
  if (currentFilter.workspaceId && currentFilter.workspaceId === matchedWorkspaceId) {
    btns[0]?.classList.add('active');
  } else if (!currentFilter.workspaceId) {
    btns[1]?.classList.add('active');
  }
}

function setWsSelection(value: string, label: string): void {
  if (wsFilterHidden) wsFilterHidden.value = value;
  if (wsFilterInput) wsFilterInput.value = value ? label : '';
  currentFilter.workspaceId = value || undefined;
  if (wsCombobox) wsCombobox.classList.remove('open');
  updateToggleState();
  renderPageLater(currentPage);
  refreshNavBadges(currentFilter);
}

function renderWsList(query: string): void {
  if (!wsFilterList) return;
  const q = query.toLowerCase();
  // Filter workspaces by selected harness, then by search query
  const harnessScoped = currentFilter.harness
    ? wsOptions.filter(ws => ws.harnesses?.includes(currentFilter.harness!))
    : wsOptions;
  const filtered = q
    ? harnessScoped.filter(ws => ws.name.toLowerCase().includes(q))
    : harnessScoped;

  const show = filtered.slice(0, 100); // cap rendered items

  const vnodes = [html`<div class="combobox-item" data-value="">All Workspaces</div>`];

  if (!q) {
    // No search query: show "Recent" section header before recent items,
    // "All Workspaces" section header before the alphabetical list
    const recent = show.filter(ws => ws.recent);
    const rest = show.filter(ws => !ws.recent);
    if (recent.length > 0) {
      vnodes.push(html`<div class="combobox-section-header">Recent</div>`);
      vnodes.push(...recent.map(ws =>
        html`<div class=${'combobox-item' + (ws.id === currentFilter.workspaceId ? ' selected' : '')} data-value=${ws.id}>${ws.name}</div>`
      ));
      if (rest.length > 0) {
        vnodes.push(html`<div class="combobox-section-header">All Workspaces</div>`);
      }
    }
    vnodes.push(...rest.map(ws =>
      html`<div class=${'combobox-item' + (ws.id === currentFilter.workspaceId ? ' selected' : '')} data-value=${ws.id}>${ws.name}</div>`
    ));
  } else {
    vnodes.push(...show.map(ws => {
      const label = highlightMatch(ws.name, q);
      return html`<div class=${'combobox-item' + (ws.id === currentFilter.workspaceId ? ' selected' : '')} data-value=${ws.id}>${label}</div>`;
    }));
  }

  if (filtered.length > 100) {
    vnodes.push(html`<div class="combobox-item" style="color:var(--text-muted);pointer-events:none;">${filtered.length - 100} more — keep typing to narrow</div>`);
  }

  render(html`<span>${vnodes}</span>`, wsFilterList);
}

function highlightMatch(text: string, query: string): ComponentChildren {
  const idx = text.toLowerCase().indexOf(query);
  if (idx < 0) return text;
  return [text.slice(0, idx), html`<mark>${text.slice(idx, idx + query.length)}</mark>`, text.slice(idx + query.length)];
}

if (wsFilterInput && wsCombobox && wsFilterList) {
  wsFilterInput.addEventListener('focus', () => {
    renderWsList(wsFilterInput.value);
    wsCombobox.classList.add('open');
  });

  wsFilterInput.addEventListener('input', () => {
    renderWsList(wsFilterInput.value);
    wsCombobox.classList.add('open');
  });

  wsFilterList.addEventListener('click', (e) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>('.combobox-item');
    if (!item || item.style.pointerEvents === 'none') return;
    const val = item.dataset.value || '';
    const label = val ? (wsOptions.find(w => w.id === val)?.name || val) : '';
    setWsSelection(val, label);
  });

  document.addEventListener('click', (e) => {
    if (!wsCombobox.contains(e.target as Node)) {
      wsCombobox.classList.remove('open');
      // Restore display to current selection
      if (currentFilter.workspaceId) {
        const ws = wsOptions.find(w => w.id === currentFilter.workspaceId);
        if (ws) wsFilterInput.value = ws.name;
      } else {
        wsFilterInput.value = '';
      }
    }
  });

  wsFilterInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      wsCombobox.classList.remove('open');
      wsFilterInput.blur();
    }
  });
}

if (wsToggle) {
  wsToggle.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('.ws-toggle-btn');
    if (!btn) return;
    if (btn.dataset.ws === 'current' && matchedWorkspaceId) {
      const ws = wsOptions.find(w => w.id === matchedWorkspaceId);
      setWsSelection(matchedWorkspaceId, ws?.name || matchedWorkspaceId);
    } else {
      setWsSelection('', '');
    }
  });
}

if (harnessFilter) {
  harnessFilter.addEventListener('change', () => {
    currentFilter.harness = harnessFilter.value || undefined;
    if (currentFilter.workspaceId && currentFilter.harness) {
      const ws = wsOptions.find(w => w.id === currentFilter.workspaceId);
      if (ws && !ws.harnesses?.includes(currentFilter.harness)) {
        setWsSelection('', '');
      }
    }
    renderPageLater(currentPage);
    refreshNavBadges(currentFilter);
  });
}

/* ---- Page Router ---- */
function renderPage(page: string): void {
  page = normalizePageForFeatureFlags(page);
  currentPage = page;
  const content = $('#content')!;
  // Unmount the previous Preact tree and clear imperative children (e.g. the
  // loading-screen workspace grid with thousands of cells) so the diff doesn't
  // hang trying to reconcile the old complex DOM.
  unmount(content);
  content.textContent = '';
  render(html`
    <div class="loading-screen">
      <div class="loading-spinner"></div>
      <div class="loading-text">Loading\u2026</div>
    </div>`, content);
  destroyCharts();

  switch (page) {
    case 'dashboard': withErrorBoundary('Dashboard', content, () => renderDashboard(content, currentFilter)); break;
    case 'patterns': withErrorBoundary('Patterns', content, () => renderPatterns(content, currentFilter)); break;
    case 'output': withErrorBoundary('Output', content, () => renderOutput(content, currentFilter)); break;
    case 'burndown':
      withErrorBoundary('Burndown', content, () => renderBurndown(content, currentFilter)); break;
    case 'timeline': withErrorBoundary('Timeline', content, () => renderTimeline(content, currentFilter)); break;
    case 'anti-patterns': withErrorBoundary('Anti-Patterns', content, () => renderAntiPatterns(content, currentFilter)); break;
    case 'rule-editor': withErrorBoundary('Rule Editor', content, () => renderAntiPatterns(content, currentFilter)); break;
    case 'skills': withErrorBoundary('Skills', content, () => renderSkills(content, currentFilter)); break;
    case 'config-health': withErrorBoundary('Config Health', content, () => renderConfigHealth(content, currentFilter)); break;
    case 'level-up': withErrorBoundary('Level Up', content, () => renderLevelUp(content, currentFilter)); break;
    case 'data-explorer': withErrorBoundary('Data Explorer', content, () => renderDataExplorer(content, currentFilter)); break;
    case 'rule-playground': withErrorBoundary('Rule Playground', content, () => renderRulePlayground(content, currentFilter)); break;
    case 'image-gallery': withErrorBoundary('Image Gallery', content, () => renderImageGallery(content, currentFilter)); break;
    default: render(html`<p>Unknown page</p>`, content);
  }
}

/* ---- Init ---- */
