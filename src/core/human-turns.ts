/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Which logged "user" turns the user typed, for the measures that count only those turns. */

import type { NonHumanKind, SessionRequest } from './types';

/** Every NonHumanKind, in the order the dashboard lists them. */
export const NON_HUMAN_KINDS = [
  'agent', 'relayed', 'subagent', 'skill', 'system', 'autopilot', 'meta', 'compaction', 'output',
] as const satisfies readonly NonHumanKind[];

/** True when the user typed the turn: its parser found no record that anything else sent it. */
export function isHumanTurn(request: { nonHumanKind?: unknown }): boolean {
  return request.nonHumanKind == null;
}

/** Marks a turn the user didn't type. Curiosity leaves such turns out, as it does for every non-human turn. */
export function markNonHuman(request: SessionRequest, kind: NonHumanKind): void {
  request.nonHumanKind = kind;
  request.curiosity = { kind: 'excluded', excerpts: [] };
}
