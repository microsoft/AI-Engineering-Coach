/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Canonical order of a parse result.
 *
 * The parser visits sources in an order that depends on directory modification times, readdir
 * order and, on a cache hit, on which sources it re-reads from disk (Copilot CLI/App, Xcode,
 * Claude, Codex, OpenCode) and appends after the cached sessions. Analyses that show the first N
 * matches or break sort ties by input order would then show different results for the same logs.
 * Every parser entry point therefore sorts its result into this order before returning it, so a
 * cold parse, an incremental update and a cache hit give identical results. */

import type { ParseResult } from './cache';
import type { Session, Workspace } from './types';

function compare(a: number | string, b: number | string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function finite(value: number | null | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** When the session started; sessions without a valid time sort after all others. */
function startTime(session: Session): number {
  return finite(session.creationDate) ?? finite(session.requests[0]?.timestamp) ?? Number.POSITIVE_INFINITY;
}

/** Oldest session first. The remaining keys order sessions that start in the same millisecond,
 *  so the result never depends on the order in which the sessions were collected. */
export function compareSessions(a: Session, b: Session): number {
  return compare(startTime(a), startTime(b))
    || compare(a.sessionId, b.sessionId)
    || compare(a.harness, b.harness)
    || compare(a.workspaceId, b.workspaceId)
    || compare(finite(a.lastMessageDate) ?? Number.POSITIVE_INFINITY, finite(b.lastMessageDate) ?? Number.POSITIVE_INFINITY)
    || compare(a.requests.length, b.requests.length);
}

/**
 * Sort `result` in place into the canonical order: sessions oldest first, then workspaces in the
 * order of their first session, followed by workspaces without sessions sorted by id.
 */
export function sortParseResult(result: Pick<ParseResult, 'sessions' | 'workspaces'>): void {
  result.sessions.sort(compareSessions);
  const ordered: Array<[string, Workspace]> = [];
  const placed = new Set<string>();
  for (const session of result.sessions) {
    const workspace = result.workspaces.get(session.workspaceId);
    if (!workspace || placed.has(session.workspaceId)) continue;
    placed.add(session.workspaceId);
    ordered.push([session.workspaceId, workspace]);
  }
  const withoutSessions = [...result.workspaces]
    .filter(([id]) => !placed.has(id))
    .sort(([a], [b]) => compare(a, b));
  result.workspaces.clear();
  for (const [id, workspace] of [...ordered, ...withoutSessions]) result.workspaces.set(id, workspace);
}
