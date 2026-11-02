/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Context layer of the lazy `getSessionTimeline` payload (Copilot CLI and Copilot App): each compaction
 * placed on the call timeline, and each turn's context at its end. The per-bucket context size and limit
 * are fields of the timeline itself (`CallTimelineBucket.peakPrompt`, `contextLimit`). */

import type { CompactionEvent, Session, SessionContextLayer, TimelineCompaction } from './types';
import { compactionKind } from './cli-compaction';
import { requestCompactions } from './context-window';

/** Most compactions placed on one session's timeline. */
export const MAX_TIMELINE_COMPACTIONS = 100;

/** One compaction on the timeline. */
function timelineCompaction(event: CompactionEvent, callIndex: number, requestIndex: number): TimelineCompaction {
  return {
    callIndex,
    requestIndex,
    tokensBefore: event.contextLengthBefore,
    tokensAfter: event.contextLengthAfter ?? null,
    tokenLimit: event.tokenLimit ?? null,
    trigger: compactionKind(event.trigger),
    failed: event.outcome === 'failed',
  };
}

/** `null` for sessions without a per-call timeline. */
export function buildContextLayer(session: Session): SessionContextLayer | null {
  if (!session.callTimeline) return null;
  const compactions: TimelineCompaction[] = [];
  let omitted = 0;
  for (const [requestIndex, request] of session.requests.entries()) {
    for (const event of requestCompactions(request)) {
      if (event.atCall == null) continue;
      if (compactions.length >= MAX_TIMELINE_COMPACTIONS) omitted++;
      else compactions.push(timelineCompaction(event, event.atCall, requestIndex));
    }
  }
  return {
    compactions,
    omittedCompactions: omitted,
    turnEnds: session.requests.map(request => request.contextUsage?.lastPromptTokens ?? null),
  };
}
