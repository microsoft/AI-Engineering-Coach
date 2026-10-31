/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Token Types tab of Context Health: token types beyond input and output (reasoning, compaction,
 * sub-agents, truncated calls and latency), one source at a time, because harnesses log them
 * differently. Data comes from `getTokenTypes`; the range bar and tab routing live in page-config.ts. */

import type { DateFilter, TokenTypesData, TokenTypesSource } from '../core/types';
import { rpc } from './shared';
import { html, render, type ComponentChildren } from './render';
import { infoTip, renderAvailability, renderSourcePanel } from './token-types-view';

const GUIDE_URL = 'https://docs.github.com/en/copilot/tutorials/optimize-ai-usage';

function openGuide(event: Event): void {
  event.preventDefault();
  void rpc('openExternal', { url: GUIDE_URL }).catch(() => undefined);
}

function renderTips(tips: string[]): ComponentChildren {
  if (tips.length === 0) return null;
  return html`<div class="ctx-tt-tips" role="note" aria-label="Insights">
    <div class="ctx-tt-tips-title">Insights</div>
    ${tips.map(tip => html`<div class="ctx-tt-tip">\u2022 ${tip}</div>`)}
  </div>`;
}

function renderEmpty(data: TokenTypesData): ComponentChildren {
  return html`<div class="ctx-tt" id="ctxTokenTypes">
    <div class="ctx-comp-note" id="ctxTokenTypesEmpty" role="note">
      ${data.harnesses.length === 0
        ? 'No requests in this range.'
        : 'No request in this range logged token types beyond input and output. Copilot CLI and Copilot App log all five, Codex logs reasoning, and Claude Code and OpenCode log truncated calls; VS Code does not log them. Try a longer range.'}
    </div>
    ${renderAvailability(data.harnesses)}
  </div>`;
}

function renderPicker(data: TokenTypesData, selected: TokenTypesSource, select: (source: TokenTypesSource) => void): ComponentChildren {
  if (data.sources.length < 2) return html`<div class="ctx-tt-source-label">${data.sources[0]?.label}</div>`;
  return html`<div class="ctx-tt-picker" role="group" aria-label="Harness">
    ${data.sources.map(source => html`<button type="button" class="ctx-tt-pick" data-source=${source.source}
      aria-pressed=${String(source.source === selected)} onClick=${() => select(source.source)}>${source.label}</button>`)}
  </div>`;
}

export async function renderTokenTypes(container: HTMLElement, filter: DateFilter, isCurrent: () => boolean = () => true): Promise<void> {
  let data: TokenTypesData;
  try {
    data = await rpc<TokenTypesData>('getTokenTypes', { filter });
  } catch {
    if (isCurrent()) render(html`<div class="ctx-comp-note" id="ctxTokenTypesError" role="alert">Could not load token types. Try another range or reload the dashboard.</div>`, container);
    return;
  }
  // A newer range or tab selection started its own render; drop this response.
  if (!isCurrent()) return;
  if (data.sources.length === 0) {
    render(renderEmpty(data), container);
    return;
  }
  let selected = data.sources[0].source;
  const draw = (): void => {
    const source = data.sources.find(s => s.source === selected) ?? data.sources[0];
    render(html`<div class="ctx-tt" id="ctxTokenTypes">
      ${renderTips(data.tips)}
      <h3 id="ctxTokenTypesTitle">Token types beyond input and output
        ${infoTip('Reasoning, compaction, sub-agent, truncation and latency figures from the per-call usage harnesses log. Each harness is shown on its own, because they log these differently. Only token counts, model names and event types are read, never prompt text.', 'About token types')}</h3>
      <p class="ctx-comp-intro">Where tokens and time go besides your prompts and the answers: thinking, summarizing a full context, delegating to sub-agents, and answers cut off at the output limit.</p>
      ${renderPicker(data, source.source, next => { selected = next; draw(); })}
      ${renderSourcePanel(source)}
      ${renderAvailability(data.harnesses)}
      <a class="ctx-comp-guide" href=${GUIDE_URL} onClick=${openGuide}>Optimizing your AI usage: GitHub\u2019s guide \u2192</a>
      <p class="ctx-tt-muted">These figures are for your own coaching, not for evaluating anyone\u2019s performance.</p>
    </div>`, container);
  };
  draw();
}
