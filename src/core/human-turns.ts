/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Which logged "user" turns the user typed, for the measures that count only those turns. */

import type { NonHumanKind, SessionRequest, TurnBasis } from './types';

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

/** The turns the user typed, and how many other turns were left out, by kind. */
export function splitHumanTurns<T extends { nonHumanKind?: NonHumanKind }>(requests: readonly T[]): { human: T[]; basis: TurnBasis } {
  const human: T[] = [];
  const automatedByKind: TurnBasis['automatedByKind'] = {};
  for (const request of requests) {
    if (isHumanTurn(request)) human.push(request);
    else if (request.nonHumanKind) automatedByKind[request.nonHumanKind] = (automatedByKind[request.nonHumanKind] ?? 0) + 1;
  }
  return { human, basis: { humanTurns: human.length, automatedTurns: requests.length - human.length, automatedByKind } };
}

/**
 * Follow-up gaps (ms) before the turns the user typed, for `turns` in time order. A gap runs from the end of the
 * assistant's work to the typed turn: the end of the previous typed turn, or of automated work that ends later, such
 * as a sub-agent still running across typed turns. Automated turns extend that work but never start a gap. A typed
 * turn has no gap when nothing came before it. When every turn is typed, these are the gaps between consecutive
 * turns. A gap is negative when the turn started before that work ended; callers decide how to treat it.
 */
export function humanFollowUpGaps<T>(
  turns: readonly T[],
  startOf: (turn: T) => number,
  endOf: (turn: T) => number,
  isHuman: (turn: T) => boolean,
): number[] {
  const gaps: number[] = [];
  let typedEnd: number | null = null;
  let automatedEnd: number | null = null;
  for (const turn of turns) {
    const end = endOf(turn);
    if (!isHuman(turn)) {
      automatedEnd = latest(automatedEnd, end);
      continue;
    }
    const workEnd = latest(typedEnd, automatedEnd);
    if (workEnd !== null) gaps.push(startOf(turn) - workEnd);
    typedEnd = end;
  }
  return gaps;
}

function latest(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  return b === null ? a : Math.max(a, b);
}
