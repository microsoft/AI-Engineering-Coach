/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Payload of the lazy `getSessionTimeline` RPC: one session's call timeline plus the data of each layer
 * drawn on it. Drill-downs fetch it when they open, so list payloads stay small. Other views can add
 * their own layer field next to `cache`. */

import type { CallTimeline } from './call-timeline-types';
import type { SessionCacheLayer } from './prompt-cache-types';

export interface SessionTimelineData {
  sessionId: string;
  harness: string;
  /** `calls`: one point per main-agent model call (Copilot CLI and Copilot App); `requests`: one per request. */
  unit: 'calls' | 'requests';
  /** `null` when the session has nothing to plot. */
  timeline: CallTimeline | null;
  /** Prompt-cache layer; `null` when the session reports no cache usage. */
  cache: SessionCacheLayer | null;
}
