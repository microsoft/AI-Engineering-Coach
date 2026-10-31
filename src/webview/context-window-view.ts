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
  mixed: 'Some sessions use the context limit the harness reported; others use an estimate from the largest prompt seen.',
};

export function windowSourceHelp(source: ContextWindowSource | 'mixed'): string {
  return WINDOW_HELP[source];
}

/** Short tag shown after a utilization value whose window wasn't estimated. */
export function windowTag(source: ContextWindowSource | 'mixed'): ComponentChildren {
  if (source === 'estimated') return null;
  return html`<span class="ctx-window-tag">${source === 'reported' ? 'reported limit' : 'mixed limits'}</span>`;
}

/** Utilization (%) per request: against the turn's reported limit, else the session's or the fallback window. */
export function utilizationSeries(s: SessionContextDetail, fallbackWindow: number): (number | null)[] {
  const sessionWindow = s.windowSource === 'reported' && s.contextWindow > 0 ? s.contextWindow : fallbackWindow;
  return s.tokenCurve.map((tokens, i) => {
    const window = s.turnLimits?.[i] ?? sessionWindow;
    return tokens == null || window <= 0 ? null : Math.round((tokens / window) * 1000) / 10;
  });
}

/** Header note for an expanded session whose turns reported their limit. */
export function windowNote(s: SessionContextDetail): string {
  return s.windowSource === 'reported' && s.contextWindow > 0
    ? ` \u00b7 context limit ${formatNum(s.contextWindow)} (reported)`
    : '';
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

/** Footnote under the workspace table when any utilization uses a reported limit. */
export function windowFootnote(workspaces: WorkspaceContextScore[]): ComponentChildren {
  if (!workspaces.some(w => w.windowSource !== 'estimated')) return null;
  return html`<p class="ctx-window-note">Copilot CLI, Copilot App and Codex report their context limit, so their utilization is measured against it. Other harnesses don\u2019t; their window is estimated from the largest prompt seen, which overstates utilization near the top.</p>`;
}
