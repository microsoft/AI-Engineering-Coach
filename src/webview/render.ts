/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Secure rendering layer using Preact + htm.
 *
 *
 * Usage:
 *   import { html, render } from './render';
 *   render(html`<div class="card">${untrustedData}</div>`, container);
 */

import { h, render as preactRender, type VNode, type ComponentChildren } from 'preact';
import htm from 'htm';

/* Trusted Types: Preact's dangerouslySetInnerHTML (used only for the static SVG
 * icons in svg-icons.ts) writes innerHTML internally, which the browser routes
 * through the 'default' policy. Rather than a pass-through that would trust every
 * sink in the webview, this policy rejects anything resembling
 * script/event-handler/javascript: — the legitimate static SVG markup never
 * matches, so the Trusted Types backstop stays meaningful if untrusted data ever
 * reaches an innerHTML sink. */
// Note `[\s/]` before the event-handler check so `<svg/onload=...>` (no space
// before `on`) can't slip past — only static SVG icon markup legitimately
// reaches this policy, so a strict blocklist here has no false positives.
const UNSAFE_HTML = /<script|<\/script|javascript:|[\s/]on\w+\s*=/i;
if (typeof window !== 'undefined' && window.trustedTypes) {
  window.trustedTypes.createPolicy('default', {
    createHTML: (s: string) => {
      if (UNSAFE_HTML.test(s)) {
        throw new TypeError('Blocked potentially unsafe HTML in default Trusted Types policy');
      }
      return s;
    },
  });
}

export const html = htm.bind(h);

export function render(vnode: ComponentChildren, container: Element): void {
  preactRender(vnode as VNode, container);
}

export function unmount(container: Element): void {
  preactRender(null, container);
}

export { h, type VNode, type ComponentChildren };
export type { JSX } from 'preact';

export function StatCard({ label, value, accent }: { label: string; value: string; accent: string }) {
  return html`
    <div class="stat-card">
      <div class="stat-card-accent" style=${'background:' + accent}></div>
      <div class="stat-value">${value}</div>
      <div class="stat-label">${label}</div>
    </div>`;
}

export function CanvasEl({ id, height, title }: { id: string; height?: number; title?: string }) {
  return html`
    <div class="chart-wrap">
      ${title && html`<div class="chart-title">${title}</div>`}
      <canvas id=${id} height=${height || 300}></canvas>
    </div>`;
}

export function LoadingScreen({ message }: { message: string }) {
  return html`<div class="loading-screen"><div class="loading-spinner"></div><div class="loading-text">${message}</div></div>`;
}

export function ScoreRing({ score, color, size }: { score: number; color: string; size: number }) {
  const r = (size - 6) / 2;
  const c = Math.PI * 2 * r;
  const offset = c - (score / 100) * c;
  const fontSize = size > 80 ? 22 : size > 60 ? 20 : 14;
  return html`
    <svg class="score-ring" width=${size} height=${size} viewBox=${'0 0 ' + size + ' ' + size}>
      <circle cx=${size / 2} cy=${size / 2} r=${r} fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="5"/>
      <circle cx=${size / 2} cy=${size / 2} r=${r} fill="none" stroke=${color} stroke-width="5"
        stroke-dasharray=${c} stroke-dashoffset=${offset} stroke-linecap="round"
        transform=${'rotate(-90 ' + size / 2 + ' ' + size / 2 + ')'}/>
      <text x=${size / 2} y=${size / 2} text-anchor="middle" dominant-baseline="central"
        fill=${color} font-size=${fontSize} font-weight="700">${score}</text>
    </svg>`;
}

export function PctBadge({ pct, label, title }: { pct: number; label: string; title?: string }) {
  if (pct === 0) return html`<span class="trend-badge trend-stable" title=${title}>${label} 0%</span>`;
  const cls = pct > 0 ? 'trend-improving' : 'trend-worsening';
  const sign = pct > 0 ? '+' : '';
  return html`<span class="trend-badge ${cls}" title=${title}>${sign}${pct}% ${label}</span>`;
}

export function ErrorMsg({ message }: { message: string }) {
  return html`<div class="error-boundary">
    <p class="error-message">${message}</p>
    <p class="error-hint">Try reloading the dashboard (Ctrl+Shift+P → "AI Engineer Coach: Reload Data")</p>
  </div>`;
}

/**
 * Wraps a page renderer with an error boundary that shows a fallback UI.
 * Uses Preact render — no innerHTML.
 */
export function withErrorBoundary(
  pageName: string,
  container: HTMLElement,
  renderFn: () => void | Promise<void>,
): void {
  try {
    const result = renderFn();
    if (result instanceof Promise) {
      result.catch((err: unknown) => {
        showErrorFallback(pageName, container, err);
      });
    }
  } catch (err: unknown) {
    showErrorFallback(pageName, container, err);
  }
}

function showErrorFallback(pageName: string, container: HTMLElement, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  render(html`
    <div class="error-boundary">
      <h3>\u26a0\ufe0f Failed to render ${pageName}</h3>
      <p class="error-message">${message}</p>
      <p class="error-hint">Try reloading the dashboard (Ctrl+Shift+P \u2192 "AI Engineer Coach: Reload Data")</p>
    </div>`, container);
}