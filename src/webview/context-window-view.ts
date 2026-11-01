/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Context-window labels for Context Management: utilization is measured against the limit the harness
 * reported (Copilot CLI and Copilot App, Codex) or against an estimate from the largest prompt seen. */

import type { ContextWindowSource, SessionContextDetail, WorkspaceContextScore } from '../core/types';
import { formatNum } from './shared';
import { html, ComponentChildren } from './render';

const WINDOW_HELP: Record<ContextWindowSource | 'mixed', string> = {
  reported: 'Utilization uses the context limit the harness reported for each turn.',
  estimated: 'Utilization uses an estimated window: the largest prompt seen, rounded up. The harness does not report its limit, so utilization near the top is overstated.',
  mixed: 'Some turns use the context limit the harness reported; the others use an estimate from the largest prompt seen among them.',
};

/** Harnesses whose sessions open on a per-call context timeline. */
const TIMELINE_HARNESSES = new Set(['GitHub Copilot CLI', 'GitHub Copilot App']);
const TIMELINE_HINT = 'To see a Copilot CLI or Copilot App session\u2019s context timeline, with every model call, the context limit and each compaction, click its workspace, then the session. It also opens from the session in Context Composition\u2019s Sessions list.';

export function windowSourceHelp(source: ContextWindowSource | 'mixed' | undefined): string {
  return WINDOW_HELP[source ?? 'estimated'];
}

/** Short tag shown after a utilization value whose window wasn't estimated. */
export function windowTag(source: ContextWindowSource | 'mixed' | undefined): ComponentChildren {
  if (source !== 'reported' && source !== 'mixed') return null;
  return html`<span class="ctx-window-tag">${source === 'reported' ? 'reported limit' : 'mixed limits'}</span>`;
}

/** Utilization (%) per request: against the turn's reported limit, else the session's window (its limit or its own
 *  estimate, as in its table row), else the fallback window. */
export function utilizationSeries(s: SessionContextDetail, fallbackWindow: number): (number | null)[] {
  const sessionWindow = s.contextWindow > 0 ? s.contextWindow : fallbackWindow;
  return s.tokenCurve.map((tokens, i) => {
    const window = s.turnLimits?.[i] ?? sessionWindow;
    return tokens == null || window <= 0 ? null : Math.round((tokens / window) * 1000) / 10;
  });
}

/** Inline SVG sparkline of a session's utilization (%) per request, against the same windows as its row and chart
 *  (`utilizationSeries`), in the color `colorOf` gives its peak. Requests without token data are bridged, so the
 *  curve reads as continuous: a gap in the source data shouldn't look like a request made with zero tokens. */
export function utilizationSparkline(s: SessionContextDetail, fallbackWindow: number, colorOf: (utilization: number) => string): ComponentChildren {
  const series = utilizationSeries(s, fallbackWindow);
  const values = series.filter((v): v is number => v != null);
  if (values.length === 0) return html`<span style="color:var(--text-muted);">-</span>`;

  const width = 80;
  const height = 20;
  const top = Math.max(100, ...values);
  const step = series.length > 1 ? width / (series.length - 1) : 0;
  // Project every point with a value to (x, y); one polyline through them bridges the gaps (like Chart.js spanGaps).
  const points: { x: number; y: number }[] = [];
  for (const [i, v] of series.entries()) {
    if (v == null) continue;
    points.push({ x: series.length === 1 ? width / 2 : i * step, y: height - (v / top) * height });
  }
  const color = colorOf(Math.max(...values));

  const pointsStr = points.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const firstX = points[0].x;
  const lastX = points[points.length - 1].x;
  const fillPath = `M${firstX.toFixed(1)},${height} ${points.map(p => `L${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')} L${lastX.toFixed(1)},${height} Z`;

  return html`<svg width=${width} height=${height} style="vertical-align:middle;" title=${'Context utilization across ' + values.length + ' of ' + series.length + ' requests'}>
    <path d=${fillPath} fill=${color} fill-opacity="0.15"/>
    <polyline points=${pointsStr} fill="none" stroke=${color} stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
  </svg>`;
}

/** Header note for an expanded session whose turns reported their limit. */
export function windowNote(s: SessionContextDetail): string {
  if (s.contextWindow <= 0) return '';
  if (s.windowSource === 'reported') return ` \u00b7 context limit ${formatNum(s.contextWindow)} (reported)`;
  if (s.windowSource === 'mixed') return ` \u00b7 context limit reported for some turns; the others use an estimated ${formatNum(s.contextWindow)}`;
  return '';
}

/** Extra tooltip lines for one request of the session token chart. */
export function turnTooltipLines(s: SessionContextDetail, index: number): string[] {
  const lines: string[] = [];
  const peak = s.turnPeaks?.[index];
  const last = s.tokenCurve[index];
  if (peak != null && last != null && peak > last) lines.push(`Peak during the turn: ${formatNum(peak)} tokens`);
  const limit = s.turnLimits?.[index];
  if (limit != null) lines.push(`Context limit: ${formatNum(limit)} tokens (reported)`);
  return lines;
}

/** Footnotes under the workspace table: how reported limits differ from estimates, and where Copilot CLI and
 *  Copilot App sessions show their context timeline. */
export function windowFootnote(workspaces: WorkspaceContextScore[]): ComponentChildren {
  const reported = workspaces.some(w => w.windowSource === 'reported' || w.windowSource === 'mixed');
  const timeline = workspaces.some(w => TIMELINE_HARNESSES.has(w.harness));
  if (!reported && !timeline) return null;
  return html`
    ${reported ? html`<p class="ctx-window-note">Copilot CLI, Copilot App and Codex report their context limit, so their utilization is measured against it. Other harnesses don\u2019t; their window is estimated from the largest prompt seen, which overstates utilization near the top.</p>` : null}
    ${timeline ? html`<p class="ctx-timeline-hint">${TIMELINE_HINT}</p>` : null}`;
}

/** Note under a context timeline in Context Composition's session list: the workspace table shows it too, with more. */
export function timelineAlsoInTableNote(): ComponentChildren {
  return html`<div class="ctx-comp-note ctx-comp-timeline-note">Per-Workspace Context Session Health shows the same timeline with the session\u2019s utilization, verdict and token types: click this workspace there, then the session.</div>`;
}
