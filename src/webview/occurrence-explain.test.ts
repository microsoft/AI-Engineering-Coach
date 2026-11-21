/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { explainOccurrence } from './occurrence-explain';
import { html, render } from './render';

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('./shared', () => ({ rpc: mocks.rpc }));

type ExplainResponse = { ok: boolean; explanation: string; error?: string };

/** Render an occurrence row the way the Anti-Patterns page does, so the result
 *  container starts out as a Preact-managed element. */
function renderRow(): { button: HTMLButtonElement; result: HTMLElement } {
  const host = document.createElement('div');
  document.body.replaceChildren(host);
  render(html`
    <div class="occ-session-row">
      <button class="occ-explain-btn" data-rule-id="long-session" data-session-id="session-1">Why?</button>
      <div class="occ-explain-result" data-session-id="session-1" style="display:none;"></div>
    </div>`, host);
  return {
    button: host.querySelector<HTMLButtonElement>('.occ-explain-btn')!,
    result: host.querySelector<HTMLElement>('.occ-explain-result')!,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

beforeEach(() => {
  mocks.rpc.mockReset();
});

describe('explainOccurrence rendering', () => {
  it('shows a loading state, then replaces it with the explanation', async () => {
    const { button, result } = renderRow();
    const pending = deferred<ExplainResponse>();
    mocks.rpc.mockReturnValue(pending.promise);

    const done = explainOccurrence(button);
    expect(result.style.display).toBe('');
    expect(result.className).toBe('occ-explain-result occ-explain-loading');
    expect(result.textContent).toBe('Asking AI for an explanation...');
    expect(button.disabled).toBe(true);

    pending.resolve({ ok: true, explanation: 'The session ran long.\nStart a new chat per task.' });
    await done;

    expect(result.className).toBe('occ-explain-result occ-explain-ok');
    expect(result.textContent).not.toContain('Asking AI');
    expect(result.textContent).toContain('The session ran long.');
    expect(result.textContent).toContain('Start a new chat per task.');
    expect(result.querySelectorAll('br')).toHaveLength(1);
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe('Why?');
    expect(mocks.rpc).toHaveBeenCalledWith('explainOccurrence', { ruleId: 'long-session', sessionId: 'session-1' });
  });

  it('hides on the next click and renders a fresh explanation when asked again', async () => {
    const { button, result } = renderRow();
    mocks.rpc.mockResolvedValueOnce({ ok: true, explanation: 'First answer.' });
    await explainOccurrence(button);

    await explainOccurrence(button);
    expect(result.style.display).toBe('none');
    expect(mocks.rpc).toHaveBeenCalledTimes(1);

    mocks.rpc.mockResolvedValueOnce({ ok: true, explanation: 'Second answer.' });
    await explainOccurrence(button);

    expect(result.style.display).toBe('');
    expect(result.textContent).toBe('Second answer.');
    expect(result.className).toBe('occ-explain-result occ-explain-ok');
  });
});

describe('explainOccurrence failures and request shape', () => {
  it('shows the host error and asks again on the next click', async () => {
    const { button, result } = renderRow();
    mocks.rpc.mockRejectedValueOnce(new Error("GitHub Copilot isn't available. Sign in to GitHub Copilot in VS Code to use AI features."));

    await explainOccurrence(button);

    expect(result.className).toBe('occ-explain-result occ-explain-error');
    expect(result.textContent).toBe("GitHub Copilot isn't available. Sign in to GitHub Copilot in VS Code to use AI features.");

    mocks.rpc.mockResolvedValueOnce({ ok: true, explanation: 'Now it works.' });
    await explainOccurrence(button);

    expect(mocks.rpc).toHaveBeenCalledTimes(2);
    expect(result.textContent).toBe('Now it works.');
  });

  it('treats an empty explanation as an error instead of leaving the loading text', async () => {
    const { button, result } = renderRow();
    mocks.rpc.mockResolvedValueOnce({ ok: true, explanation: '   ' });

    await explainOccurrence(button);

    expect(result.className).toBe('occ-explain-result occ-explain-error');
    expect(result.textContent).toBe('The AI returned an empty explanation. Try again.');
  });

  it('shows an unsuccessful response without an error message', async () => {
    const { button, result } = renderRow();
    mocks.rpc.mockResolvedValueOnce({ ok: false, explanation: '' });

    await explainOccurrence(button);

    expect(result.textContent).toBe('Failed to get explanation.');
  });

  it('passes the active date filter to the host', async () => {
    const { button } = renderRow();
    mocks.rpc.mockResolvedValueOnce({ ok: true, explanation: 'Filtered.' });

    await explainOccurrence(button, { fromDate: '2026-10-01', harness: 'GitHub Copilot CLI' });

    expect(mocks.rpc).toHaveBeenCalledWith('explainOccurrence', {
      ruleId: 'long-session',
      sessionId: 'session-1',
      filter: { fromDate: '2026-10-01', harness: 'GitHub Copilot CLI' },
    });
  });
});
