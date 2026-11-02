/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Payload of the lazy `getSessionTimeline` RPC: one session's call timeline plus the data of each layer
 * drawn on it. Drill-downs fetch it when they open, so list payloads stay small. Other views can add
 * their own layer field next to `cache`. */

import type { CallTimeline } from './call-timeline-types';
import type { SessionCacheLayer } from './prompt-cache-types';

/** A compaction placed on the call timeline (Copilot CLI and Copilot App). */
export interface TimelineCompaction {
  /** Index of the first main-agent call after the compaction (`CompactionEvent.atCall`). */
  callIndex: number;
  requestIndex: number;
  tokensBefore: number;
  /** `null` when the build didn't log the size after. */
  tokensAfter: number | null;
  tokenLimit: number | null;
  trigger: 'automatic' | 'manual' | 'other' | null;
  failed: boolean;
}

/** Context layer: compactions on the call timeline and each turn's context at its end. */
export interface SessionContextLayer {
  /** In order; at most `MAX_TIMELINE_COMPACTIONS`. */
  compactions: TimelineCompaction[];
  omittedCompactions: number;
  /** Prompt tokens of each turn's last main-agent call, by request index; `null` for a turn without one. */
  turnEnds: (number | null)[];
}

export interface SessionTimelineData {
  sessionId: string;
  harness: string;
  /** `calls`: one point per main-agent model call (Copilot CLI and Copilot App); `requests`: one per request. */
  unit: 'calls' | 'requests';
  /** `null` when the session has nothing to plot. */
  timeline: CallTimeline | null;
  /** Prompt-cache layer; `null` when the session reports no cache usage. */
  cache: SessionCacheLayer | null;
  /** Context layer; `null` without a per-call timeline. */
  context: SessionContextLayer | null;
}
