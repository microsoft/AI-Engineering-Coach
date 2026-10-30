/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* "Why?" explanations for anti-pattern occurrences.
 *
 * The result container is owned by Preact: every state (loading, explanation,
 * error) goes through render(). Writing textContent into a container Preact has
 * rendered into leaves Preact patching detached nodes, which kept "Asking AI
 * for an explanation..." on screen forever (#278). */

import type { DateFilter } from '../core/types';
import { html, render } from './render';
import { rpc } from './shared';

type ExplainResponse = { ok: boolean; explanation: string; error?: string };

export type ExplainState =
  | { kind: 'loading' }
  | { kind: 'ok'; text: string }
  | { kind: 'error'; message: string };

const STATE_CLASS: Readonly<Record<ExplainState['kind'], string>> = {
  loading: 'occ-explain-loading',
  ok: 'occ-explain-ok',
  error: 'occ-explain-error',
};

export function renderExplainState(container: HTMLElement, state: ExplainState): void {
  container.className = `occ-explain-result ${STATE_CLASS[state.kind]}`;
  if (state.kind === 'loading') {
    render(html`<span>Asking AI for an explanation...</span>`, container);
  } else if (state.kind === 'error') {
    render(html`<span>${state.message}</span>`, container);
  } else {
    const lines = state.text.split('\n');
    render(html`<span>${lines.map((line, i) => html`<span>${line}${i < lines.length - 1 ? html`<br/>` : null}</span>`)}</span>`, container);
  }
}

function datasetValue(element: HTMLElement, key: string): string | null {
  const value = element.dataset[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Ask the host to explain why a session triggered a rule. Clicking again while
 * an explanation is shown hides it; the next click asks again.
 */
export async function explainOccurrence(button: HTMLButtonElement, filter?: DateFilter): Promise<void> {
  const ruleId = datasetValue(button, 'ruleId');
  const sessionId = datasetValue(button, 'sessionId');
  if (!ruleId || !sessionId) return;

  const row = button.closest<HTMLElement>('.occ-session-row');
  const resultDiv = row?.querySelector<HTMLElement>('.occ-explain-result');
  if (!resultDiv) return;

  if (resultDiv.style.display === '' && resultDiv.dataset.loaded === 'true') {
    resultDiv.style.display = 'none';
    return;
  }

  button.disabled = true;
  button.textContent = 'Thinking...';
  resultDiv.style.display = '';
  delete resultDiv.dataset.loaded;
  renderExplainState(resultDiv, { kind: 'loading' });

  try {
    const request: { ruleId: string; sessionId: string; filter?: Record<string, unknown> } = { ruleId, sessionId };
    if (filter) request.filter = filter as Record<string, unknown>;
    const res = await rpc<ExplainResponse>('explainOccurrence', request);
    const text = res.ok ? res.explanation.trim() : '';
    if (text) {
      renderExplainState(resultDiv, { kind: 'ok', text });
      resultDiv.dataset.loaded = 'true';
    } else {
      const message = res.ok ? 'The AI returned an empty explanation. Try again.' : res.error || 'Failed to get explanation.';
      renderExplainState(resultDiv, { kind: 'error', message });
    }
  } catch (err: unknown) {
    renderExplainState(resultDiv, { kind: 'error', message: err instanceof Error ? err.message : String(err) });
  } finally {
    button.disabled = false;
    button.textContent = 'Why?';
  }
}
