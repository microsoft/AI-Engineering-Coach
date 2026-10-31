/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Context Composition drill-down: a workspace row's "Sessions" button lists that workspace's
 * sessions for the row's source, with each session's composition inline. */

import type { DateFilter, SessionContextDetail, WorkspaceContextSessionsData } from '../core/types';
import { destroyChartById, rpc } from './shared';
import { html, render, unmount } from './render';
import { compositionMiniBar, countText, renderSessionCompositionChart, renderSessionCompositionPanel } from './context-composition-view';

const WORKSPACE_SESSION_CHART_ID = 'ctxCompWsSessionChart';
const MAX_DRILLDOWN_SESSIONS = 10;

function hasSessionComposition(s: SessionContextDetail): boolean {
  const detail = s.composition;
  return detail != null && (detail.breakdown != null || detail.systemSegments.length > 0 || detail.compactions.length > 0);
}

function renderWorkspaceSessions(panel: HTMLElement, sessions: SessionContextDetail[], total: number, selected: string | null): void {
  destroyChartById(WORKSPACE_SESSION_CHART_ID);
  const select = (id: string) => renderWorkspaceSessions(panel, sessions, total, id === selected ? null : id);
  render(sessions.length === 0
    ? html`<div class="ctx-comp-note">No session in this workspace has composition data in this range.</div>`
    : html`<ul class="ctx-comp-ws-session-list" aria-label="Sessions with composition data">
      ${sessions.map(s => html`<li>
        <button type="button" class="ctx-comp-ws-session" data-session-id=${s.sessionId} aria-expanded=${String(s.sessionId === selected)} onClick=${() => select(s.sessionId)}>
          <span>${s.date}</span>
          <span class="ctx-comp-ws-session-harness">${s.harness}</span>
          <span>${countText(s.requestCount, 'request')}</span>
          ${compositionMiniBar(s.composition, false)}
        </button>
        ${s.sessionId === selected ? renderSessionCompositionPanel(s, WORKSPACE_SESSION_CHART_ID) : null}
      </li>`)}
      ${total > sessions.length ? html`<li class="ctx-comp-note">Showing the ${sessions.length} most recent of ${total} sessions.</li>` : null}
    </ul>`, panel);
  const current = sessions.find(s => s.sessionId === selected);
  if (current) renderSessionCompositionChart(current, WORKSPACE_SESSION_CHART_ID);
}

function closeWorkspacePanels(toggles: HTMLButtonElement[]): void {
  destroyChartById(WORKSPACE_SESSION_CHART_ID);
  for (const toggle of toggles) {
    toggle.setAttribute('aria-expanded', 'false');
    const panel = toggle.closest('.ctx-comp-ws')?.querySelector<HTMLElement>('.ctx-comp-ws-sessions');
    if (!panel) continue;
    unmount(panel);
    panel.hidden = true;
  }
}

/** Wire the workspace "Sessions" buttons to an inline per-session drill-down. This also reaches
 *  Copilot CLI workspaces, which the utilization table omits because they lack per-request tokens.
 *  Sessions are matched like the card's requests: any session with a request in range counts. */
export function attachCompositionDrilldown(root: HTMLElement, filter: DateFilter): void {
  const toggles = [...root.querySelectorAll<HTMLButtonElement>('.ctx-comp-ws-toggle')];
  for (const toggle of toggles) {
    let generation = 0;
    toggle.addEventListener('click', () => {
      const workspace = toggle.closest<HTMLElement>('.ctx-comp-ws');
      const panel = workspace?.querySelector<HTMLElement>('.ctx-comp-ws-sessions');
      if (!workspace || !panel) return;
      // Every click supersedes a load still in flight, so a late response can't overwrite a newer panel.
      const load = ++generation;
      const wasOpen = toggle.getAttribute('aria-expanded') === 'true';
      closeWorkspacePanels(toggles);
      if (wasOpen) return;
      toggle.setAttribute('aria-expanded', 'true');
      panel.hidden = false;
      render(html`<div class="ctx-comp-note">Loading sessions\u2026</div>`, panel);
      const source = workspace.dataset.source;
      const isCurrent = () => load === generation && toggle.getAttribute('aria-expanded') === 'true' && root.isConnected && panel.isConnected;
      void rpc<WorkspaceContextSessionsData>('getWorkspaceContextSessions', { workspaceId: workspace.dataset.workspace, filter, rangeMatch: 'requests' })
        .then(data => {
          if (!isCurrent()) return;
          const sessions = data.sessions.filter(s => hasSessionComposition(s) && (source == null || s.composition?.source === source));
          renderWorkspaceSessions(panel, sessions.slice(0, MAX_DRILLDOWN_SESSIONS), sessions.length, null);
        })
        .catch(() => {
          if (isCurrent()) render(html`<div class="ctx-comp-note">Could not load sessions.</div>`, panel);
        });
    });
  }
}
