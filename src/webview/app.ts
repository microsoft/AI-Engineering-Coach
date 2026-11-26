/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Webview entry -- runs in the browser context inside the VS Code webview */

import {
  AntiPatternData,
  DateFilter,
  GitHubAppIssueCreditsSnapshot,
  GitHubAppSnapshot,
  StatsResult,
} from '../core/types';
import { FF_TOKEN_REPORTING_ENABLED } from '../core/constants';
import { $, $$, rpc, destroyCharts, initMessageListener, withErrorBoundary, vscode } from './shared';
import { renderWorkspaceGrid, updateWorkspaceCell } from './loading-grid-view';
import {
  disposeLoadingScreen,
  isLoadingScreenMounted,
  leaveLoadingScreen,
  mountLoadingScreen,
  recordLoadingProgress,
  renderLoadingScreen,
  showLoadingReady,
  type DetailsStore,
  type LoadingProgress,
} from './loading-screen';
import { buildSkippedBanner } from './skipped-banner';
import { loadCapabilities, llmAvailable } from './capabilities';
import { html, render, unmount, ComponentChildren } from './render';
import { setNavHint } from './nav-hint';
import { renderDashboard } from './page-dashboard';
import { renderPatterns } from './page-patterns';
import { renderCuriosity } from './page-curiosity';
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
import { renderGitHubApp } from './page-github-app';
import { renderGitHubAppIssueCredits } from './page-github-app-issue-credits';

let githubAppSnapshot: GitHubAppSnapshot = { status: 'absent' };
let githubAppIssueCreditsSnapshot: GitHubAppIssueCreditsSnapshot = { status: 'absent' };

function isGitHubAppPage(page: string): boolean {
  return page === 'github-app' || page === 'github-app-issue-credits';
}

function normalizePageForFeatureFlags(page: string): string {
  if (!FF_TOKEN_REPORTING_ENABLED && page === 'burndown') return 'dashboard';
  if (githubAppSnapshot.status === 'absent' && isGitHubAppPage(page)) return 'dashboard';
  return page;
}

/* ---- Feature-flag gating: hide token-reporting nav items ---- */
if (!FF_TOKEN_REPORTING_ENABLED) {
  const burndownLink = document.querySelector<HTMLElement>('[data-page="burndown"]');
  burndownLink?.parentElement?.remove();
}

/* ---- Global state ---- */
/** A Timeline link in the address (`#view=range&from=…&to=…`, or a day, week or the families). */
const TIMELINE_LINK = /^#view=(day|week|range|families)(&|$)/;

/** The page the dashboard opens on: the one its address names, else the Dashboard. */
function startPage(): string {
  if (new URLSearchParams(window.location.search).get('page') === 'curiosity') return 'curiosity';
  return TIMELINE_LINK.test(window.location.hash) ? 'timeline' : 'dashboard';
}

let currentPage = startPage();
const currentFilter: DateFilter = {};
let _dataIsReady = false;
let matchedWorkspaceId: string | undefined;

/** Last parse-warning counts seen in worker telemetry, used to surface a post-load banner. */
let lastSkippedFiles = 0;
let lastSkippedLines = 0;

export { consumeNavHint } from './nav-hint';

/* ---- Nav Badge Helpers ---- */
function setBadge(id: string, value: string | number): void {
  const el = document.getElementById(id);
  if (!el) return;
  const text = typeof value === 'number' ? (value > 9999 ? `${(value / 1000).toFixed(1)}k` : String(value)) : value;
  el.textContent = text;
  el.classList.add('visible');
}

function clearBadge(id: string): void {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = '';
  el.classList.remove('visible');
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

function applyGitHubAppSnapshot(snapshot: GitHubAppSnapshot): void {
  githubAppSnapshot = snapshot;
  const visible = snapshot.status !== 'absent';
  for (const item of $$<HTMLElement>('.github-app-nav-item')) item.hidden = !visible;
  if (snapshot.status === 'ready') setBadge('badge-github-app', snapshot.metrics.delivery.totalProjectSessions);
  else clearBadge('badge-github-app');
  if (
    !visible
    && isGitHubAppPage(currentPage)
  ) navigateTo('dashboard');
}

function applyGitHubAppIssueCreditsSnapshot(snapshot: GitHubAppIssueCreditsSnapshot): void {
  githubAppIssueCreditsSnapshot = snapshot;
  if (snapshot.status === 'ready') {
    setBadge('badge-github-app-issue-credits', snapshot.metrics.issues.length);
  } else {
    clearBadge('badge-github-app-issue-credits');
  }
}

async function refreshGitHubAppSnapshot(): Promise<void> {
  const [productivity, issueCredits] = await Promise.all([
    rpc<GitHubAppSnapshot>('getGitHubAppMetrics').catch((): GitHubAppSnapshot => ({ status: 'unavailable' })),
    rpc<GitHubAppIssueCreditsSnapshot>('getGitHubAppIssueCredits')
      .catch((): GitHubAppIssueCreditsSnapshot => ({ status: 'unavailable' })),
  ]);
  applyGitHubAppSnapshot(productivity);
  applyGitHubAppIssueCreditsSnapshot(issueCredits);
}

/* ---- Progress + Data Ready ---- */

function setShellLoadingMode(isLoading: boolean): void {
  const app = document.getElementById('app');
  if (!app) return;
  app.classList.toggle('loading-mode', isLoading);
}

/** The details drawer's open/closed choice, remembered in webview state across reloads. */
const loadingDetailsStore: DetailsStore = {
  get: () => Boolean((vscode.getState() as Record<string, unknown> | null)?.loadingDetailsOpen),
  set: (open) => {
    const s = (vscode.getState() as Record<string, unknown> | null) ?? {};
    vscode.setState({ ...s, loadingDetailsOpen: open });
  },
};

/** Render the loading screen (tile field, status card, details drawer) once. */
function ensureLoadingUI(): void {
  const content = $('#content');
  if (!content) return;
  if (isLoadingScreenMounted()) return;
  setShellLoadingMode(true);
  mountLoadingScreen(content, loadingDetailsStore);
}

function renderPageLater(page: string): void {
  void renderPage(page);
}

/** Update UI based on progress message */
interface ProgressMessage extends LoadingProgress {
  imagesAnalyzed?: number;
  workspacePlan?: string[];
  workspaceDone?: string;
}

let progressFrame = 0;

function handleProgress(msg: ProgressMessage): void {
  if (_dataIsReady) return;
  ensureLoadingUI();
  if (msg.telemetry) {
    lastSkippedFiles = msg.telemetry.skippedFiles ?? lastSkippedFiles;
    lastSkippedLines = msg.telemetry.skippedLines ?? lastSkippedLines;
  }
  if (msg.workspacePlan) renderWorkspaceGrid(msg.workspacePlan);
  if (msg.workspaceDone) updateWorkspaceCell(msg.workspaceDone, msg.detail);
  recordLoadingProgress(msg);

  if (progressFrame) return;
  progressFrame = requestAnimationFrame(() => {
    progressFrame = 0;
    if (!_dataIsReady) renderLoadingScreen();
  });
}

function onDataReady(currentWorkspace: string, skipped?: { skippedFiles: number; skippedLines: number }): void {
  if (_dataIsReady) return;
  _dataIsReady = true;
  cancelAnimationFrame(progressFrame);
  progressFrame = 0;
  // Prefer the authoritative counts sent with `dataReady` (present even on a cache hit, where no
  // progress telemetry tick ever fires); fall back to whatever a telemetry tick captured.
  if (skipped) {
    if (skipped.skippedFiles > 0) lastSkippedFiles = skipped.skippedFiles;
    if (skipped.skippedLines > 0) lastSkippedLines = skipped.skippedLines;
  }
  // A slow load shows a short "ready" summary first; a cache hit goes straight to the page.
  const holdMs = showLoadingReady();
  const holdDone = new Promise<void>(resolve => window.setTimeout(resolve, holdMs));
  // Badge counts and the sidebar don't wait for the summary to leave: the data is ready now.
  // The sidebar animates its width, so it must settle before a page draws its charts.
  refreshNavBadges(currentFilter);
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

  void Promise.allSettled([refreshGitHubAppSnapshot(), loadCapabilities(), holdDone]).then(async () => {
    if (holdMs > 0) await leaveLoadingScreen();
    disposeLoadingScreen();
    navigateTo(currentPage);
    if (holdMs > 0) document.getElementById('content')?.classList.add('content-enter');
    maybeShowSkippedBanner();
  });
}

/** After load, if any session files failed to parse, show a compact, dismissible notice above the
 *  page so the partial result is discoverable. A "View details" link reveals the "AI Engineer
 *  Coach" output channel with the full per-file breakdown. The notice lives in #content-col above
 *  #content, so it spans the content column and survives page navigation. */
function maybeShowSkippedBanner(): void {
  if (lastSkippedFiles <= 0) return;
  if (document.getElementById('skipped-banner')) return;
  const content = document.getElementById('content');
  const col = document.getElementById('content-col');
  if (!content || !col) return;

  const banner = buildSkippedBanner(lastSkippedFiles, lastSkippedLines, {
    onViewDetails: () => { void rpc('showOutput'); },
  });
  col.insertBefore(banner, content);
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
  if (!llmAvailable() && (page === 'skills' || page === 'level-up')) page = 'dashboard';
  currentPage = page;
  // A Timeline link names the Timeline's view; on another page it would open the Timeline again on reload.
  if (page !== 'timeline' && TIMELINE_LINK.test(window.location.hash)) {
    try {
      history.replaceState(history.state, '', window.location.pathname + window.location.search);
    } catch {
      // A host that doesn't allow it keeps the address as it is.
    }
  }
  document.body.classList.toggle('github-app-view', isGitHubAppPage(page));
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
  // Remember the page and keep the loading screen (also its short ready summary): onDataReady
  // renders `currentPage` once, when the screen leaves.
  if (!_dataIsReady || isLoadingScreenMounted()) {
    ensureLoadingUI();
    return;
  }
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
    case 'curiosity': withErrorBoundary('Curiosity', content, () => renderCuriosity(content, currentFilter)); break;
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
    case 'github-app': withErrorBoundary('GitHub App', content, () => renderGitHubApp(content, githubAppSnapshot)); break;
    case 'github-app-issue-credits':
      withErrorBoundary('Issue credits', content, () => {
        renderGitHubAppIssueCredits(content, githubAppIssueCreditsSnapshot);
      });
      break;
    default: render(html`<p>Unknown page</p>`, content);
  }
}

/* ---- Init ---- */
ensureLoadingUI();
