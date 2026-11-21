/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Which session started which. Browser-safe: no Node imports.
 *
 * 1. `create`: a session whose ID is in the result of another session's `create_session`, `open_pr_session` or
 *    `open_issue_session` call is that session's child (Copilot CLI and Copilot App).
 * 2. `harness`: the harness logged the parent itself (Codex `parent_thread_id`, OpenCode `parentID`).
 * 3. `relay`: otherwise, a session whose FIRST message was relayed from another session was started by it. Relayed
 *    messages later in a session are reports from the sessions it started, so they never count.
 * Links that would make a cycle are dropped, relay links first. Forks are linked separately (`resolveForkLinks`). */

import type { Session, SessionRequest } from './types/session-types';
import type { TimelineLinkKind } from './types/timeline-types';

export type LinkableSession = Pick<Session, 'sessionId' | 'creationDate' | 'childSessionIds' | 'relaySenderId' | 'parentSessionId'>;

export interface ParentLink {
  parent: string;
  via: TimelineLinkKind;
}

const key = (id: string): string => id.toLowerCase();

/** Parent of each child session, keyed by the child's ID. Only sessions in `sessions` are linked. */
export function resolveParentLinks(sessions: readonly LinkableSession[]): Map<string, ParentLink> {
  const byKey = new Map<string, LinkableSession>();
  for (const s of sessions) if (!byKey.has(key(s.sessionId))) byKey.set(key(s.sessionId), s);
  const links = new Map<string, ParentLink>();
  const link = (child: string, parent: LinkableSession, via: TimelineLinkKind): void => {
    const c = byKey.get(key(child));
    if (!c || c === parent || links.has(c.sessionId)) return;
    links.set(c.sessionId, { parent: parent.sessionId, via });
  };
  // The earliest session that reports starting a child is its parent.
  const byAge = [...byKey.values()].sort((a, b) => (a.creationDate ?? Infinity) - (b.creationDate ?? Infinity)
    || a.sessionId.localeCompare(b.sessionId));
  for (const parent of byAge) for (const child of parent.childSessionIds ?? []) link(child, parent, 'create');
  for (const child of byAge) {
    const parent = child.parentSessionId ? byKey.get(key(child.parentSessionId)) : undefined;
    if (parent) link(child.sessionId, parent, 'harness');
  }
  for (const child of byAge) {
    const parent = child.relaySenderId ? byKey.get(key(child.relaySenderId)) : undefined;
    if (parent) link(child.sessionId, parent, 'relay');
  }
  dropCycles(links, byKey);
  return links;
}

/** Breaks every cycle: drops its relay links, or, with none, the link of its oldest session. */
function dropCycles(links: Map<string, ParentLink>, byKey: Map<string, LinkableSession>): void {
  for (const start of links.keys()) {
    const path: string[] = [];
    const seen = new Set<string>();
    let at: string | undefined = start;
    while (at !== undefined && links.has(at) && !seen.has(at)) {
      seen.add(at);
      path.push(at);
      at = links.get(at)?.parent;
    }
    if (at === undefined || !seen.has(at)) continue;
    const cycle = path.slice(path.indexOf(at));
    const relays = cycle.filter(id => links.get(id)?.via === 'relay');
    if (relays.length > 0) {
      for (const id of relays) links.delete(id);
    } else {
      // The oldest session of the loop can't have been started by a later one.
      const oldest = cycle.reduce((a, b) => ((byKey.get(key(b))?.creationDate ?? Infinity) < (byKey.get(key(a))?.creationDate ?? Infinity) ? b : a));
      links.delete(oldest);
    }
  }
}

/* ---- forks ---- */

export type ForkableSession = Pick<Session, 'sessionId' | 'forkedFromId' | 'copiesHistory'> & {
  requests: readonly Pick<SessionRequest, 'userEventId'>[];
};

export interface ForkLink {
  /** The session it was forked from. */
  source: string;
  /** Prompts it copied from its source (their message IDs): counted once, in the source. */
  copied: Set<string>;
}

/** The source of each forked session, keyed by the fork's ID. A fork is linked only where the log says so:
 *  - Codex writes `forked_from_id` in the fork's `session_meta` (`forkedFromId`).
 *  - A Claude Code fork starts with the source's messages, copied with their message IDs and older times
 *    (`copiesHistory`): its source is the session that holds its first prompt without having copied it.
 *  Copilot CLI and Copilot App log no fork source, so their forks aren't linked. Forks are not family links: a fork is
 *  your own branch of a conversation, not a session an agent started. */
export function resolveForkLinks(sessions: readonly ForkableSession[]): Map<string, ForkLink> {
  const byKey = new Map(sessions.map(s => [key(s.sessionId), s]));
  const owner = new Map<string, ForkableSession>();
  for (const s of sessions) {
    if (s.copiesHistory) continue;
    for (const r of s.requests) if (r.userEventId && !owner.has(r.userEventId)) owner.set(r.userEventId, s);
  }
  const links = new Map<string, ForkLink>();
  for (const s of sessions) {
    const first = s.requests.find(r => r.userEventId)?.userEventId;
    const source = s.forkedFromId ? byKey.get(key(s.forkedFromId)) : s.copiesHistory && first ? owner.get(first) : undefined;
    if (!source || source === s) continue;
    const ids = new Set(source.requests.map(r => r.userEventId).filter((id): id is string => !!id));
    links.set(s.sessionId, { source: source.sessionId, copied: new Set(s.requests.map(r => r.userEventId).filter((id): id is string => !!id && ids.has(id))) });
  }
  return links;
}