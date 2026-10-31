/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Context size and context window of requests and sessions, shared by the context analyzers.
 *
 * A request's context size is the prompt of its last model call. Copilot CLI, Copilot App, Codex, Claude Code
 * and OpenCode record it per turn (`contextUsage`); VS Code in `promptTokens`. The window is the limit
 * the harness reported for the turn when it logs one (`reported`); otherwise it's estimated from the
 * largest prompt seen in the session's turns without a reported limit, peaks within a turn included and
 * rounded up (`estimated`), which overstates utilization near the top. */

import type { CompactionEvent, ContextWindowSource, Session, SessionRequest } from './types';
import { CONTEXT_WINDOW_DEFAULT } from './constants';

/** Prompt tokens of the request's last model call; 0 when not recorded. */
export function requestContextTokens(request: SessionRequest): number {
  const last = request.contextUsage?.lastPromptTokens;
  if (last != null && last > 0) return last;
  return request.promptTokens != null && request.promptTokens > 0 ? request.promptTokens : 0;
}

/** The largest prompt of the request: the peak of its model calls when recorded, else its context size. A
 *  compaction within the turn can leave the last prompt far below the peak. */
export function requestPeakTokens(request: SessionRequest): number {
  return Math.max(requestContextTokens(request), request.contextUsage?.peakPromptTokens ?? 0);
}

/** Context limit the harness reported for the request; `null` when it didn't report one. */
export function requestContextLimit(request: SessionRequest): number | null {
  const limit = request.contextUsage?.contextLimit;
  return limit != null && limit > 0 ? limit : null;
}

/** Every compaction of a request, in order: several for a Copilot CLI turn, at most one elsewhere. */
export function requestCompactions(request: SessionRequest): CompactionEvent[] {
  if (request.compactions) return request.compactions;
  return request.compaction ? [request.compaction] : [];
}

/** Window estimate from the largest prompt seen: rounded up to 32K tokens, never below the default. */
export function estimateContextWindow(maxPromptTokens: number): number {
  return maxPromptTokens > 0
    ? Math.max(CONTEXT_WINDOW_DEFAULT, Math.ceil(maxPromptTokens / 32_000) * 32_000)
    : CONTEXT_WINDOW_DEFAULT;
}

export interface SessionContextWindow {
  /** `reported` when every turn with context data reported its limit, `estimated` when none did, and `mixed`
   *  when some did. */
  source: ContextWindowSource | 'mixed';
  /** The largest reported limit when the source is `reported`; otherwise the estimate. */
  window: number;
  /** Window for each request: its reported limit, else `window`. Aligned with `session.requests`. */
  perRequest: number[];
}

export function sessionContextWindow(session: Session): SessionContextWindow {
  let maxReported = 0;
  let maxEstimatedPeak = 0;
  let reportedTurns = 0;
  let estimatedTurns = 0;
  for (const request of session.requests) {
    const limit = requestContextLimit(request);
    if (limit != null) maxReported = Math.max(maxReported, limit);
    // Turns with a reported limit don't feed the estimate: another model's prompts don't size this window.
    else maxEstimatedPeak = Math.max(maxEstimatedPeak, requestPeakTokens(request));
    if (requestContextTokens(request) > 0) {
      if (limit != null) reportedTurns++;
      else estimatedTurns++;
    }
  }
  const source: SessionContextWindow['source'] = estimatedTurns === 0
    ? (maxReported > 0 ? 'reported' : 'estimated')
    : reportedTurns > 0 ? 'mixed' : 'estimated';
  const window = source === 'reported' ? maxReported : estimateContextWindow(maxEstimatedPeak);
  return {
    source,
    window,
    perRequest: session.requests.map(request => requestContextLimit(request) ?? window),
  };
}

/** Utilization (percent of the window) of each request with context data, `null` for the others. */
export function sessionUtilization(session: Session, window = sessionContextWindow(session)): (number | null)[] {
  return session.requests.map((request, i) => {
    const tokens = requestContextTokens(request);
    return tokens > 0 ? (tokens / window.perRequest[i]) * 100 : null;
  });
}
