/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* One owner per conversation turn. A Claude Code fork (`--fork-session`) starts its transcript with its source's
 * messages, copied with their message IDs and their original, older times. Counting them in both sessions would count
 * the same work twice on every tab, so they are removed from the fork before analysis: the session where a message
 * isn't a copy owns it. Browser-safe: no Node imports. */

import type { Session, SessionRequest } from './types/session-types';

/** A prompt this much older than its transcript's first line is a copy even when no other session holds it (the source
 *  isn't loaded). Below it, only a matching message in another session makes it one: logs sometimes write a line a few
 *  milliseconds out of order. */
const COPY_LEAD_MS = 1000;

function isCandidate(r: SessionRequest): boolean {
  return (r.historyLeadMs ?? 0) > 0;
}

/** Sessions with the turns they copied from a fork source removed, `inheritedTurns` set and `forkedFromId` set to the
 *  session holding the latest copied message (the direct source, for a fork of a fork). Other sessions are returned as
 *  they are. */
export function withInheritedTurnsRemoved(sessions: readonly Session[]): Session[] {
  if (!sessions.some(s => s.requests.some(isCandidate))) return [...sessions];
  // Where each message is not a copy: its owner.
  const owner = new Map<string, Session>();
  const holders = new Map<string, number>();
  for (const s of sessions) {
    for (const r of s.requests) {
      if (!r.userEventId) continue;
      holders.set(r.userEventId, (holders.get(r.userEventId) ?? 0) + 1);
      if (!isCandidate(r) && !owner.has(r.userEventId)) owner.set(r.userEventId, s);
    }
  }
  return sessions.map(s => {
    const inherited = s.requests.filter(r => isCandidate(r) && (
      (r.userEventId !== undefined && (holders.get(r.userEventId) ?? 0) > 1) || (r.historyLeadMs ?? 0) > COPY_LEAD_MS));
    if (inherited.length === 0) return s;
    const removed = new Set(inherited);
    const requests = s.requests.filter(r => !removed.has(r));
    const source = [...inherited].reverse().map(r => (r.userEventId ? owner.get(r.userEventId) : undefined)).find(x => x && x !== s);
    const starts = requests.map(r => r.timestamp ?? 0).filter(t => t > 0);
    return {
      ...s,
      requests,
      requestCount: requests.length,
      inheritedTurns: inherited.length,
      ...(starts.length ? { creationDate: Math.min(...starts) } : {}),
      ...(s.forkedFromId || !source ? {} : { forkedFromId: source.sessionId }),
    };
  });
}

/** A session re-read in full (for its detail view) with the same turns the analysis kept: a fork's copied turns stay
 *  counted once, in their source. `analyzed` is the session as the analyzer holds it. */
export function withAnalyzedTurns(full: Session, analyzed: Session | null): Session {
  if (!analyzed?.inheritedTurns) return full;
  const kept = new Set(analyzed.requests.map(r => r.requestId));
  const requests = full.requests.filter(r => kept.has(r.requestId));
  return {
    ...full, requests, requestCount: requests.length, inheritedTurns: analyzed.inheritedTurns,
    ...(analyzed.forkedFromId ? { forkedFromId: analyzed.forkedFromId } : {}),
    ...(analyzed.creationDate != null ? { creationDate: analyzed.creationDate } : {}),
  };
}
