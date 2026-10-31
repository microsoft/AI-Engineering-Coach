/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Prompt Cache tab of Context Health: how much of each prompt the model reused from its cache, what that
 * saved, and why the cache broke. Data comes from `getPromptCache`; drill-downs load on demand. */

import type { DateFilter, PromptCacheData } from '../core/types';
import { rpc } from './shared';
import { html, render, type ComponentChildren } from './render';
import { GUIDE_URL } from './prompt-cache-labels';
import {
  infoTip,
  renderAttribution,
  renderHarnessRows,
  renderKpis,
  renderModelTable,
  renderTrendChart,
  renderTrendPanel,
  tokenLegend,
} from './prompt-cache-view';
import { attachSessionToggles, attachWorkspaceToggles, renderSessionList, renderWorkspaceList } from './prompt-cache-session';

function openGuide(event: Event): void {
  event.preventDefault();
  void rpc('openExternal', { url: GUIDE_URL }).catch(() => undefined);
}

function renderTips(tips: string[]): ComponentChildren {
  if (tips.length === 0) return null;
  return html`<div class="ctx-cache-tips" role="note" aria-label="Insights">
    <div class="ctx-cache-tips-title">Insights</div>
    ${tips.map(tip => html`<div class="ctx-cache-tip">\u2022 ${tip}</div>`)}
  </div>`;
}

function renderEmpty(data: PromptCacheData): ComponentChildren {
  return html`<div class="ctx-cache" id="ctxPromptCache">
    <div class="ctx-comp-note" id="ctxCacheEmpty" role="note">
      ${data.harnesses.length === 0
        ? 'No requests in this range.'
        : 'No model call in this range logged prompt-cache tokens. Recent Copilot App and Copilot CLI builds, Claude Code, OpenCode and Codex log them; VS Code doesn\u2019t. Try a longer range.'}
    </div>
    ${data.harnesses.length > 0 ? renderHarnessRows(data) : null}
  </div>`;
}

export async function renderPromptCache(container: HTMLElement, filter: DateFilter, isCurrent: () => boolean = () => true): Promise<void> {
  let data: PromptCacheData;
  try {
    data = await rpc<PromptCacheData>('getPromptCache', { filter });
  } catch {
    if (isCurrent()) render(html`<div class="ctx-comp-note" id="ctxCacheError" role="alert">Couldn\u2019t load prompt-cache data. Try another range or reload the dashboard.</div>`, container);
    return;
  }
  // A newer range or tab selection started its own render; drop this response.
  if (!isCurrent()) return;
  if (!data.harnesses.some(h => h.all != null)) {
    render(renderEmpty(data), container);
    return;
  }
  const rebuilt = data.topSessions.some(s => (s.rebuiltTokens ?? 0) > 0);
  render(html`<div class="ctx-cache" id="ctxPromptCache">
    ${renderTips(data.tips)}
    <h3 id="ctxPromptCacheTitle">Prompt Cache
      ${infoTip('Agents resend the same context on every model call. The prompt cache lets the model reuse what it has seen, at a fraction of the input price, until it expires or the start of the prompt changes. Only token counts, model names and event types are read, never prompt text.', 'About the prompt cache')}</h3>
    <p class="ctx-comp-intro">How much of each prompt the model reused from its cache, what that saved, and why the cache broke. Each harness is shown separately because they log the cache differently.</p>
    ${renderKpis(data)}
    ${tokenLegend()}
    ${renderHarnessRows(data)}
    ${renderAttribution(data.attribution)}
    <div class="two-col">${renderTrendPanel(data)}${renderModelTable(data.models)}</div>
    <h4>${rebuilt ? 'Sessions that rebuilt the most' : 'Sessions with the most cache misses'}
      ${infoTip('Sessions with activity in this range. Their numbers cover the whole session. Open one to see its timeline.', 'About the session list')}</h4>
    <div id="ctxCacheTopSessions">${data.topSessions.length > 0 ? renderSessionList(data.topSessions, 'Sessions by rebuilt tokens') : html`<div class="ctx-comp-note">No session to show.</div>`}</div>
    <h4>By workspace</h4>
    <div id="ctxCacheWorkspaces">${renderWorkspaceList(data.workspaces)}</div>
    <a class="ctx-comp-guide" href=${GUIDE_URL} onClick=${openGuide}>Preserve the cache: GitHub\u2019s guide to optimizing AI usage \u2192</a>
    <p class="ctx-cache-muted">These figures are for your own coaching, not for evaluating anyone\u2019s performance.</p>
  </div>`, container);
  renderTrendChart(data);
  const top = document.getElementById('ctxCacheTopSessions');
  if (top) attachSessionToggles(top);
  const workspaces = document.getElementById('ctxCacheWorkspaces');
  if (workspaces) attachWorkspaceToggles(workspaces, filter);
}
