/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Load phases and their share of the overall progress percentage. Browser-safe (no Node
 * imports): the parser maps in-phase progress to a percentage with `phasePct`, and the loading
 * screen maps it back to an in-phase fraction with `phaseFraction` to fill its stepper. */

export const LOAD_PHASES = [
  'Discovering log directories',
  'Checking cache',
  'Parsing session logs',
  'Scanning external harnesses',
  'Preparing analytics',
  'Ready',
] as const;

const PHASE_STARTS = [0, 2, 10, 75, 85, 95];
const PHASE_WIDTHS = [2, 8, 65, 10, 10, 5];

/** Overall percentage for `intraPhase` (0–1) of the way through `phase`. */
export function phasePct(phase: number, intraPhase: number): number {
  const base = PHASE_STARTS[phase] ?? 95;
  const width = PHASE_WIDTHS[phase] ?? 5;
  return Math.min(100, Math.round(base + width * Math.max(0, Math.min(1, intraPhase))));
}

/** How far (0–1) an overall percentage is through `phase`. */
export function phaseFraction(phase: number, pct: number): number {
  const base = PHASE_STARTS[phase];
  const width = PHASE_WIDTHS[phase];
  if (base === undefined || width === undefined || width <= 0) return 0;
  return Math.max(0, Math.min(1, (pct - base) / width));
}

/** What a progress item is: a workspace folder during a parse, or a Copilot CLI/App session
 *  read again on a cached load (those sessions are never cached). */
export type LoadItemKind = 'workspace' | 'cli-session';

/** `reading` while the item is open; the others once it is done. `slow` means it took over 2 s. */
export type LoadItemStatus = 'reading' | 'parsed' | 'slow' | 'skipped';

/** One unit of countable progress. `path` is a display path (home shortened to `~`), never the
 *  raw path, so it can appear on screen and in copied diagnostics. */
export interface LoadItem {
  kind: LoadItemKind;
  /** 1-based position of the item in the step. */
  index: number;
  total: number;
  /** Last path segment, the part people recognize. */
  folder: string;
  path: string;
  /** Wall-clock time the item took, once done. */
  ms?: number;
  /** Sessions this item added, once done. */
  sessions?: number;
  status: LoadItemStatus;
}

/** Items slower than this are marked `slow`. */
export const SLOW_ITEM_MS = 2000;
