/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Context size and context window of requests and sessions, shared by the context analyzers.
 *
 * A request's context size is the prompt of its last model call. Copilot CLI, Copilot App and Codex
 * record it per turn (`contextUsage`); the other harnesses in `promptTokens`. The window is the limit
 * the harness reported for the turn when it logs one (`reported`); otherwise it's estimated from the
 * session's largest prompt, rounded up (`estimated`), which overstates utilization near the top. */

import type { CompactionEvent, ContextWindowSource, Session, SessionRequest } from './types';
import { CONTEXT_WINDOW_DEFAULT } from './constants';

/** Prompt tokens of the request's last model call; 0 when not recorded. */
export function requestContextTokens(request: SessionRequest): number {
  const last = request.contextUsage?.lastPromptTokens;
  if (last != null && last > 0) return last;
  return request.promptTokens != null && request.promptTokens > 0 ? request.promptTokens : 0;
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
  source: ContextWindowSource;
  /** The largest reported limit, or the estimate. */
  window: number;
  /** Window for each request: its reported limit, else `window`. Aligned with `session.requests`. */
  perRequest: number[];
}

export function sessionContextWindow(session: Session): SessionContextWindow {
  let maxTokens = 0;
  let maxReported = 0;
  for (const request of session.requests) {
    maxTokens = Math.max(maxTokens, requestContextTokens(request));
    maxReported = Math.max(maxReported, requestContextLimit(request) ?? 0);
  }
  const source: ContextWindowSource = maxReported > 0 ? 'reported' : 'estimated';
  const window = maxReported > 0 ? maxReported : estimateContextWindow(maxTokens);
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
