/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Activity Patterns counts only the prompts the user typed. This note says so, and which other turns it left out. */

import type { NonHumanKind, TurnBasis } from '../core/types';
import { NON_HUMAN_KINDS } from '../core/human-turns';
import { html, type VNode } from './render';
import { formatNum } from './shared';

const KIND_LABELS: Record<NonHumanKind, string> = {
  agent: 'Sent by another agent',
  relayed: 'Relayed from another session',
  subagent: 'Sub-agent prompts from a parent agent',
  skill: 'Skill instructions',
  system: 'Sent by the harness',
  autopilot: 'Autopilot continuations',
  meta: 'Context the harness added',
  compaction: 'Compaction summaries',
  output: 'Command output',
};

function counted(n: number, one: string, many: string): string {
  return `${formatNum(n)} ${n === 1 ? one : many}`;
}

/** "Counts the 12 prompts you typed; 3 automated turns left out." */
export function turnBasisSummary(basis: TurnBasis): string {
  const typed = `Counts the ${counted(basis.humanTurns, 'prompt', 'prompts')} you typed`;
  return basis.automatedTurns > 0 ? `${typed}; ${counted(basis.automatedTurns, 'automated turn', 'automated turns')} left out.` : `${typed}.`;
}

/** The turns left out, by kind, most first: "Sent by another agent: 899". */
export function automatedTurnLines(basis: TurnBasis): string[] {
  return NON_HUMAN_KINDS
    .map(kind => [kind, basis.automatedByKind[kind] ?? 0] as const)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([kind, count]) => `${KIND_LABELS[kind]}: ${formatNum(count)}`);
}

export function TurnBasisNote({ basis, detail }: { basis?: TurnBasis; detail?: string }): VNode | null {
  if (!basis) return null;
  const lines = automatedTurnLines(basis);
  return html`
    <p class="turn-basis-note">
      ${turnBasisSummary(basis)}${detail ? ` ${detail}` : ''}
      ${lines.length > 0 ? html`<span class="info-icon" tabindex="0" role="button" aria-label="Turns left out">${'\u24d8'}<span class="info-popup">
        Left out: turns the harness logged as sent by something other than you. They show when your agents ran, not when you worked.
        ${lines.map(line => html`<span class="turn-basis-kind">${line}</span>`)}
      </span></span>` : null}
    </p>
  ` as VNode;
}
