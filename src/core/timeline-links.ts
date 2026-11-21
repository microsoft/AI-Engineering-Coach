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
 * Links that would make a cycle are dropped, relay links first. Forks are not family links (`fork-ownership.ts`). */

import type { Session } from './types/session-types';
import type { TimelineLinkKind } from './types/timeline-types';

export type LinkableSession = Pick<Session, 'sessionId' | 'creationDate' | 'childSessionIds' | 'childSessionCreatedAt' | 'childSessionOpenedAt' | 'relaySenderId' | 'parentSessionId'>;

/** A session an `open_pr_session` or `open_issue_session` call named that began more than this before the call was
 *  opened by it, not created by it (the allowance covers clock differences between the two logs). */
const OPENED_BEFORE_MS = 5_000;

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
  const byAge = [...byKey.values()].sort((a, b) => (a.creationDate ?? Infinity) - (b.creationDate ?? Infinity)
    || a.sessionId.localeCompare(b.sessionId));
  linkStartedSessions(byAge, byKey, link);
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

/** `create` links. A create_session result is proof of birth, so it wins over any other session's call, whatever their
 *  ages. Otherwise the earliest session that reports starting a child is its parent; an open_pr_session or
 *  open_issue_session call can open a session that already existed, and that's no birth. */
function linkStartedSessions(byAge: readonly LinkableSession[], byKey: Map<string, LinkableSession>,
  link: (child: string, parent: LinkableSession, via: TimelineLinkKind) => void): void {
  for (const parent of byAge) {
    for (const child of parent.childSessionIds ?? []) if (parent.childSessionCreatedAt?.[key(child)] !== undefined) link(child, parent, 'create');
  }
  for (const parent of byAge) {
    for (const child of parent.childSessionIds ?? []) {
      const opened = parent.childSessionOpenedAt?.[key(child)];
      const began = byKey.get(key(child))?.creationDate;
      if (opened != null && began != null && began < opened - OPENED_BEFORE_MS) continue;
      link(child, parent, 'create');
    }
  }
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
