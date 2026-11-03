/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Threshold edits written into a rule's markdown in place.
 *
 * Only the number on each edited threshold's line changes. The line's indentation, the spaces around the number, the
 * `\r` of a CRLF line and every other line stay as written, so a rule keeps its `# Tests`, its detection logic and its
 * line endings. The lines are the ones the rule parser reads: readFrontmatter (rule-parser.ts) gives the front matter's
 * keys and where each value starts, and only the last `thresholds:` block is changed, never `patterns:`, the body or
 * the detection logic.
 */

import { readFrontmatter, type FrontmatterField, type FrontmatterLine } from './rule-parser';

/** A number as written, such as `5`, `-0.25`, `0.40`, `1e3` or `Infinity` (which the parser reads as a number too). */
const NUMBER = /^[-+]?(?:(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?|Infinity)$/;

/**
 * Why a threshold wasn't set:
 * - `no-thresholds`: the front matter has no `thresholds:` block (none, an inline value such as `{}`, or no front matter);
 * - `unknown-key`: the block has no line for the key;
 * - `not-a-number`: the key's value isn't written as a number (text, a list, or a number followed by a comment);
 * - `invalid-value`: the new value isn't a finite number.
 */
export type ThresholdPatchFailure = 'no-thresholds' | 'unknown-key' | 'not-a-number' | 'invalid-value';

export type ThresholdPatch =
  | { ok: true; source: string }
  | { ok: false; key: string; reason: ThresholdPatchFailure };

/**
 * `source` with each threshold in `values` set in place. A number that already equals its new value is left as
 * written (`0.40` for 0.4), so setting thresholds to their current values returns `source` unchanged. Nothing changes
 * unless every key can be set.
 */
export function patchThresholds(source: string, values: Record<string, number>): ThresholdPatch {
  const lines = thresholdLines(source);
  const edits: Array<{ line: FrontmatterLine; value: number }> = [];
  for (const [key, value] of Object.entries(values)) {
    if (!Number.isFinite(value)) return { ok: false, key, reason: 'invalid-value' };
    if (!lines) return { ok: false, key, reason: 'no-thresholds' };
    const line = lines.get(key);
    if (!line) return { ok: false, key, reason: 'unknown-key' };
    if (!NUMBER.test(line.value)) return { ok: false, key, reason: 'not-a-number' };
    if (Number(line.value) !== value) edits.push({ line, value });
  }
  // Last value first, so each edit leaves the offsets of the ones before it as they were.
  let patched = source;
  for (const { line, value } of edits.sort((a, b) => b.line.valueStart - a.line.valueStart)) {
    patched = patched.slice(0, line.valueStart) + String(value) + patched.slice(line.valueStart + line.value.length);
  }
  return { ok: true, source: patched };
}

/** The lines of the last `thresholds:` block by key (the last line of a repeated key), or undefined without one. */
function thresholdLines(source: string): Map<string, FrontmatterLine> | undefined {
  let thresholds: FrontmatterField | undefined;
  for (const field of readFrontmatter(source)?.fields ?? []) if (field.key === 'thresholds') thresholds = field;
  return thresholds?.block && new Map(thresholds.block.map(line => [line.key, line]));
}
