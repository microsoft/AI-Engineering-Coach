/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* One owner per conversation turn. A Claude Code fork (`--fork-session`) starts its transcript with its source's
 * messages, copied with their message IDs and their original, older times. Counting them in both sessions would count
 * the same work twice on every tab, so they are removed from the fork before analysis: the session where a message
 * isn't a copy owns it. A copy shows as a prompt older than the fork's first line or, when those lines are missing, as\n * the ordered history the fork shares with its source. Browser-safe: no Node imports. */

import type { Session, SessionRequest } from './types/session-types';

/** A prompt this much older than its transcript's first line is a copy even when no other session holds it (the source
 *  isn't loaded). Below it, only a matching message in another session makes it one: logs sometimes write a line a few
 *  milliseconds out of order. */
const COPY_LEAD_MS = 1000;

function isCandidate(r: SessionRequest): boolean {
  return (r.historyLeadMs ?? 0) > 0;
}

const byTime = (s: Session) => [...s.requests].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));

/** The coordinator's own turns, in order: sub-agent turns merged into a transcript are left out of prefix matching. */
const mainTurns = (s: Session) => byTime(s).filter(r => r.nonHumanKind !== 'subagent');

/** How many of their first prompts two transcripts share, in the same order (same message IDs and times). */
function sharedPrefix(a: readonly SessionRequest[], b: readonly SessionRequest[]): number {
  let k = 0;
  while (k < a.length && k < b.length && a[k].userEventId && a[k].userEventId === b[k].userEventId && a[k].timestamp === b[k].timestamp) k++;
  return k;
}

/** `source` is absent when two sessions hold the copied history equally: nothing says which one it came from. */
type PrefixFork = { copies: Set<SessionRequest>; source?: Session };

/** Whether `mine` copied the first `k` prompts it shares with `theirs`. A copy carries only the conversation lines:
 *  when one side logged those turns live and the other didn't, the other copied them. Without that witness nothing
 *  says which side copied: which one went on, or is longer, is no proof (a source can go on after a fork that stopped).
 *  Then neither is taken for a fork, and both keep the shared turns. */
function copiedFrom(mine: readonly SessionRequest[], theirs: readonly SessionRequest[], k: number): boolean {
  const liveMine = mine.slice(0, k).some(r => r.loggedLive);
  const liveTheirs = theirs.slice(0, k).some(r => r.loggedLive);
  return !liveMine && liveTheirs;
}

/** The session `s` copied its opening prompts from: the one it shares most with, among those it copied from. When two
 *  share as much, either could be the source, whatever order the logs were read in: `tie` is set. */
function prefixSource(s: Session, group: readonly Session[]): { source: Session; k: number; tie: boolean } | undefined {
  const mine = mainTurns(s);
  let best: { source: Session; k: number; tie: boolean } | undefined;
  for (const other of group) {
    if (other === s) continue;
    const theirs = mainTurns(other);
    const k = sharedPrefix(mine, theirs);
    if (k === 0 || !copiedFrom(mine, theirs, k)) continue;
    if (!best || k > best.k) best = { source: other, k, tie: false };
    else if (k === best.k) best.tie = true;
  }
  return best;
}
/** The copied coordinator prompts, plus the sub-agent turns the source holds too (same message and time) from before the
 *  fork's first prompt of its own: a sub-agent a shared prompt launched can run after it. Without such a prompt, every
 *  one the source holds. */
function prefixCopySet(s: Session, source: Session, k: number): Set<SessionRequest> {
  const mine = mainTurns(s);
  const copies = new Set(mine.slice(0, k));
  const key = (r: SessionRequest) => `${r.userEventId}@${r.timestamp}`;
  const theirSubs = new Set(source.requests.filter(r => r.nonHumanKind === 'subagent').map(key));
  const firstOwn = mine[k]?.timestamp ?? Infinity;
  for (const r of s.requests) {
    if (r.nonHumanKind === 'subagent' && r.userEventId && (r.timestamp ?? 0) < firstOwn && theirSubs.has(key(r))) copies.add(r);
  }
  return copies;
}

/** Claude Code forks whose copies show no clock lead (the fork's opening lines are missing): a transcript that begins
 *  with the same prompts, in the same order, as another one copied them when the other logged them live (see
 *  `copiedFrom`). The source is the one it shares most with (the direct source of a fork of a fork). Only coordinator
 *  turns are compared; a sub-agent turn is a copy only when the source holds the same message. */
function prefixCopies(sessions: readonly Session[]): Map<Session, PrefixFork> {
  const out = new Map<Session, PrefixFork>();
  // A fork with a clock lead is found by that lead, so it is never inferred here; it can still be the source of a fork
  // that lost its own opening lines (a fork of a fork).
  const claude = sessions.filter(s => s.harness === 'Claude' && mainTurns(s).length > 0);
  const holdersOf = new Map<string, Session[]>();
  for (const s of claude) {
    const first = mainTurns(s)[0].userEventId;
    if (first) holdersOf.set(first, [...(holdersOf.get(first) ?? []), s]);
  }
  for (const group of holdersOf.values()) {
    if (group.length < 2) continue;
    for (const s of group) {
      if (s.requests.some(isCandidate)) continue;
      const best = prefixSource(s, group);
      // On a tie the copied prompts are the same whichever holder they came from, but a sub-agent turn's owner isn't
      // known: it stays with the transcript that holds it, whatever order the logs were read in.
      if (best) out.set(s, best.tie ? { copies: new Set(mainTurns(s).slice(0, best.k)) } : { copies: prefixCopySet(s, best.source, best.k), source: best.source });
    }
  }
  return out;
}

/** Sessions with the turns they copied from a fork source removed, `inheritedTurns` set and `forkedFromId` set to the
 *  session holding the latest copied message (the direct source, for a fork of a fork). Other sessions are returned as
 *  they are. */
export function withInheritedTurnsRemoved(sessions: readonly Session[]): Session[] {
  const byPrefix = prefixCopies(sessions);
  if (byPrefix.size === 0 && !sessions.some(s => s.requests.some(isCandidate))) return [...sessions];
  // Where each message is not a copy: its owner.
  const owner = new Map<string, Session>();
  const holders = new Map<string, number>();
  for (const s of sessions) {
    const copies = byPrefix.get(s)?.copies;
    for (const r of s.requests) {
      if (!r.userEventId) continue;
      holders.set(r.userEventId, (holders.get(r.userEventId) ?? 0) + 1);
      if (!isCandidate(r) && !copies?.has(r) && !owner.has(r.userEventId)) owner.set(r.userEventId, s);
    }
  }
  return sessions.map(s => {
    const prefix = byPrefix.get(s);
    const inherited = s.requests.filter(r => prefix?.copies.has(r) || (isCandidate(r) && (
      (r.userEventId !== undefined && (holders.get(r.userEventId) ?? 0) > 1) || (r.historyLeadMs ?? 0) > COPY_LEAD_MS)));
    if (inherited.length === 0) return s;
    const removed = new Set(inherited);
    const requests = s.requests.filter(r => !removed.has(r));
    const source = prefix ? prefix.source
      : [...inherited].reverse().map(r => (r.userEventId ? owner.get(r.userEventId) : undefined)).find(x => x && x !== s);
    const ambiguous = prefix !== undefined && prefix.source === undefined;
    const starts = requests.map(r => r.timestamp ?? 0).filter(t => t > 0);
    return {
      ...s,
      requests,
      requestCount: requests.length,
      inheritedTurns: inherited.length,
      ...(starts.length ? { creationDate: Math.min(...starts) } : {}),
      ...(s.forkedFromId || !source ? {} : { forkedFromId: source.sessionId }),
      ...(ambiguous && !s.forkedFromId ? { forkSourceAmbiguous: true } : {}),
    };
  });
}
/** A turn's identity that stays the same while its session is still being written: its prompt's event, else its
 *  request (a Copilot request ID is its latest reply's, so it changes as the turn gains messages). */
export const turnIdentity = (r: Pick<SessionRequest, 'userEventId' | 'requestId'>): string => r.userEventId || r.requestId;

/** A session re-read in full (for its detail view) with the same turns the analysis kept: a fork's copied turns stay
 *  counted once, in their source. `analyzed` is the session as the analyzer holds it. */
export function withAnalyzedTurns(full: Session, analyzed: Session | null): Session {
  if (!analyzed?.inheritedTurns) return full;
  const kept = new Set(analyzed.requests.map(turnIdentity));
  const requests = full.requests.filter(r => kept.has(turnIdentity(r)));
  return {
    ...full, requests, requestCount: requests.length, inheritedTurns: analyzed.inheritedTurns,
    ...(analyzed.forkedFromId ? { forkedFromId: analyzed.forkedFromId } : {}),
    ...(analyzed.forkSourceAmbiguous ? { forkSourceAmbiguous: true } : {}),
    ...(analyzed.creationDate != null ? { creationDate: analyzed.creationDate } : {}),
  };
}
