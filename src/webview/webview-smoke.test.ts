/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * @vitest-environment jsdom
 *
 * Smoke test: verify webview DOM helpers work against a real JSDOM document
 * and that the `html` tagged template produces renderable output.
 *
 * This test stubs `acquireVsCodeApi` before importing `./shared`, so the
 * module-load-time call does not blow up.
 */

import { describe, it, expect, beforeAll } from 'vitest';

beforeAll(() => {
  (globalThis as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
    postMessage: () => { /* noop */ },
    getState: () => null,
    setState: () => { /* noop */ },
  });
});

describe('webview DOM smoke (jsdom)', () => {
  it.each([
    { pct: 50, text: '+50% WoW', state: 'trend-improving' },
    { pct: -50, text: '-50% WoW', state: 'trend-worsening' },
    { pct: 0, text: 'WoW 0%', state: 'trend-stable' },
  ])('renders $state badges with titles directly on the badge', async ({ pct, text, state }) => {
    const { PctBadge, render } = await import('./render');
    const host = document.createElement('div');
    render(PctBadge({ pct, label: 'WoW', title: 'Recorded count comparison' }), host);
    const badge = host.firstElementChild!;
    expect(host.children).toHaveLength(1);
    expect(badge.className).toBe(`trend-badge ${state}`);
    expect(badge.textContent).toBe(text);
    expect(badge.getAttribute('title')).toBe('Recorded count comparison');
    expect(badge.children).toHaveLength(0);
    render(PctBadge({ pct, label: 'WoW' }), host);
    expect(host.firstElementChild!.getAttribute('title') ?? '').toBe('');
  });

  it('el() creates a DOM node with class and innerHTML', async () => {
    const { el } = await import('./shared');
    const node = el('div', 'my-class', '<span>hi</span>');
    expect(node.tagName).toBe('DIV');
    expect(node.className).toBe('my-class');
    expect(node.querySelector('span')?.textContent).toBe('hi');
  });

  it('$ and $$ select elements from document', async () => {
    const { $, $$ } = await import('./shared');
    document.body.innerHTML = '<p class="x">a</p><p class="x">b</p><p>c</p>';
    expect($('p.x')?.textContent).toBe('a');
    expect($$('p').length).toBe(3);
  });

  it('html tag output can be injected into a real DOM node without XSS', async () => {
    const { html } = await import('./shared');
    const hostile = '<script>window.__x = 1;</script>';
    const out = html`<div>${hostile}</div>`.toString();
    const host = document.createElement('div');
    // eslint-disable-next-line no-unsanitized/property
    host.innerHTML = out;
    // The script tag is escaped, so no real <script> child should exist
    expect(host.querySelector('script')).toBeNull();
    expect(host.textContent).toBe(hostile);
  });

  it('html tag with rawHtml opts out of escaping', async () => {
    const { html, rawHtml } = await import('./shared');
    const out = html`<div>${rawHtml('<em>safe</em>')}</div>`.toString();
    const host = document.createElement('div');
    // eslint-disable-next-line no-unsanitized/property
    host.innerHTML = out;
    expect(host.querySelector('em')?.textContent).toBe('safe');
  });

  it('escapeHtml converts newlines to <br>', async () => {
    const { escapeHtml } = await import('./shared');
    expect(escapeHtml('a\nb')).toBe('a<br>b');
  });

  it('formatNum abbreviates thousands and millions', async () => {
    const { formatNum } = await import('./shared');
    expect(formatNum(999)).toBe('999');
    expect(formatNum(1_500)).toBe('1.5K');
    expect(formatNum(2_300_000)).toBe('2.3M');
  });

  it('rpc() is callable and returns a Promise (no immediate throw)', async () => {
    const { rpc } = await import('./shared');
    const p = rpc('noop', {});
    expect(p).toBeInstanceOf(Promise);
    // Don't await — would hang waiting for a response.
  });
});
