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
import { timelineLocationNote } from './context-window-view';

const WORKSPACE_SESSION_CHART_ID = 'ctxCompWsSessionChart';
/** Sessions listed at first, and added by each "Show more". */
const DRILLDOWN_PAGE = 10;

function hasSessionComposition(s: SessionContextDetail): boolean {
  const detail = s.composition;
  return detail != null && (detail.breakdown != null || detail.systemSegments.length > 0 || detail.compactions.length > 0);
}

/** The sessions of one workspace's list. */
interface SessionList {
  sessions: SessionContextDetail[];
  /** The workspace table below lists these sessions with their context timeline. */
  timelineInTable: boolean;
}

/** How many sessions the list shows, which one is open, and which one gets focus after rendering. */
interface SessionListState {
  shown: number;
  selected: string | null;
  focusId?: string;
}

/** Lists the `shown` most recent sessions. "Show more" adds the next page and moves focus to its first session. */
function renderWorkspaceSessions(panel: HTMLElement, list: SessionList, state: SessionListState): void {
  const { sessions } = list;
  const { shown, selected, focusId } = state;
  destroyChartById(WORKSPACE_SESSION_CHART_ID);
  const visible = sessions.slice(0, shown);
  const remaining = sessions.length - visible.length;
  const select = (id: string) => renderWorkspaceSessions(panel, list, { shown, selected: id === selected ? null : id });
  const showMore = () => renderWorkspaceSessions(panel, list, { shown: shown + DRILLDOWN_PAGE, selected, focusId: sessions[shown]?.sessionId });
  render(sessions.length === 0
    ? html`<div class="ctx-comp-note">No session in this workspace has composition data in this range.</div>`
    : html`<ul class="ctx-comp-ws-session-list" aria-label="Sessions with composition data">
      ${visible.map(s => html`<li>
        <button type="button" class="ctx-comp-ws-session" data-session-id=${s.sessionId} aria-expanded=${String(s.sessionId === selected)} onClick=${() => select(s.sessionId)}>
          <span>${s.date}</span>
          <span class="ctx-comp-ws-session-harness">${s.harness}</span>
          <span>${countText(s.requestCount, 'request')}</span>
          ${compositionMiniBar(s.composition, false)}
        </button>
        ${s.sessionId === selected ? renderSessionCompositionPanel(s, WORKSPACE_SESSION_CHART_ID) : null}
        ${s.sessionId === selected && s.hasCallTimeline && list.timelineInTable ? timelineLocationNote() : null}
      </li>`)}
      ${remaining > 0 ? html`<li class="ctx-comp-ws-more-row">
        <span class="ctx-comp-note">Showing the ${visible.length} most recent of ${sessions.length} sessions.</span>
        <button type="button" class="ctx-comp-ws-more" onClick=${showMore}>Show ${Math.min(DRILLDOWN_PAGE, remaining)} more</button>
      </li>` : null}
    </ul>`, panel);
  const current = visible.find(s => s.sessionId === selected);
  if (current) renderSessionCompositionChart(current, WORKSPACE_SESSION_CHART_ID);
  if (focusId) [...panel.querySelectorAll<HTMLButtonElement>('.ctx-comp-ws-session')].find(button => button.dataset.sessionId === focusId)?.focus();
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

/** Wire the workspace "Sessions" buttons to an inline per-session drill-down. This also reaches sessions of
 *  older Copilot CLI builds, which the utilization table omits because they log no per-turn prompt size.
 *  Sessions are matched like the card's requests: any session with a request in range counts.
 *  `timelineInTable`: the workspace table is shown, so a session with a context timeline points to it. */
export function attachCompositionDrilldown(root: HTMLElement, filter: DateFilter, timelineInTable = false): void {
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
          renderWorkspaceSessions(panel, { sessions, timelineInTable }, { shown: DRILLDOWN_PAGE, selected: null });
        })
        .catch(() => {
          if (isCurrent()) render(html`<div class="ctx-comp-note">Could not load sessions.</div>`, panel);
        });
    });
  }
}
