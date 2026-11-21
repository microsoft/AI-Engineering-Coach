/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Request rows as detection rules, the Rule Editor and the Rule Playground evaluate them. */

import type { Session, SessionRequest } from './types';
import { AnalyzerBase } from './analyzer-base';
import { isHumanTurn } from './human-turns';

/**
 * A request plus its session's `harness`, so a rule can count only the harnesses that log a field, and
 * `humanTurn`, so a rule can count only the turns the user typed.
 */
export type RuleRequestRow = SessionRequest & { harness: string; humanTurn: boolean };

/**
 * Copies `reqs` with each request's session `harness` and `humanTurn` attached. Request objects are
 * cached and sent over RPC, so they are copied, never mutated.
 *
 * Requests resolve to sessions by identity. Pass the sessions the requests came from, or
 * a request-to-session index when `reqs` can hold requests whose session was filtered
 * out: date filters keep requests by timestamp but sessions by last activity.
 * A request that doesn't resolve keeps a harness it already carries, otherwise gets ''.
 */
export function toRuleRequestRows(
  reqs: readonly SessionRequest[],
  sessions: Session[] | ReadonlyMap<SessionRequest, Session>,
): RuleRequestRow[] {
  const sessionOf = 'get' in sessions ? sessions : AnalyzerBase.buildRequestSessionMap(sessions);
  return reqs.map(req => ({ ...req, harness: sessionOf.get(req)?.harness ?? carriedHarness(req), humanTurn: humanTurn(req) }));
}

function carriedHarness(req: SessionRequest): string {
  const harness = (req as Partial<RuleRequestRow>).harness;
  return typeof harness === 'string' ? harness : '';
}

/** False when the parser recorded that something else sent the turn; otherwise a value the row carries, or true. */
function humanTurn(req: SessionRequest): boolean {
  if (!isHumanTurn(req)) return false;
  const carried = (req as Partial<RuleRequestRow>).humanTurn;
  return typeof carried === 'boolean' ? carried : true;
}
