/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Threshold edits written into a rule's markdown in place.
 *
 * Only the number on each edited threshold's line changes. The line's indentation, the spaces around the number, the
 * `\r` of a CRLF line and every other line stay as written, so a rule keeps its `# Tests`, its detection logic and its
 * line endings. Lines are found the way parseFrontmatter (rule-parser.ts) reads the front matter: only its
 * `thresholds:` block is searched, never `patterns:`, the body or the detection logic.
 */

/** The front matter, matched as parseFrontmatter matches it. Group 1 is the YAML block; the `d` flag gives its offsets. */
const FRONT_MATTER = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/d;

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
  const block = FRONT_MATTER.exec(source)?.indices?.[1];
  const lines = block ? source.slice(block[0], block[1]).split('\n') : [];
  const keyLines = thresholdLines(lines);
  for (const [key, value] of Object.entries(values)) {
    if (!Number.isFinite(value)) return { ok: false, key, reason: 'invalid-value' };
    if (!keyLines) return { ok: false, key, reason: 'no-thresholds' };
    const index = keyLines.get(key);
    if (index === undefined) return { ok: false, key, reason: 'unknown-key' };
    const line = withNumber(lines[index], value);
    if (line === undefined) return { ok: false, key, reason: 'not-a-number' };
    lines[index] = line;
  }
  if (!block) return { ok: true, source };
  return { ok: true, source: source.slice(0, block[0]) + lines.join('\n') + source.slice(block[1]) };
}

/**
 * The line of each threshold in the YAML block, or undefined without a `thresholds:` block. As parseFrontmatter reads
 * the block: blank and `#` lines are skipped, a block line starts with two or more whitespace characters and has a
 * colon, the last `thresholds:` wins (an inline value such as `thresholds: {}` included), and so does the last line of
 * a repeated key.
 */
function thresholdLines(lines: string[]): Map<string, number> | undefined {
  let thresholds: Map<string, number> | undefined;
  let block: Map<string, number> | undefined;
  let inBlock = false;
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (inBlock && /^\s{2,}/.test(line) && line.includes(':')) {
      block?.set(line.slice(0, line.indexOf(':')).trim(), index);
      continue;
    }
    const entry = /^(\w[\w-]*):\s*(.*)$/.exec(trimmed);
    const value = entry?.[2].trim();
    inBlock = value === '' || value === '|';
    block = inBlock && entry?.[1] === 'thresholds' ? new Map<string, number>() : undefined;
    if (entry?.[1] === 'thresholds') thresholds = block;
  }
  return thresholds;
}

/** `line` with its number set to `value`, or undefined when the line's value isn't written as a number. */
function withNumber(line: string, value: number): string | undefined {
  const start = line.indexOf(':') + 1;
  const written = line.slice(start).trim();
  if (!NUMBER.test(written)) return undefined;
  if (Number(written) === value) return line;
  const at = line.indexOf(written, start);
  return line.slice(0, at) + String(value) + line.slice(at + written.length);
}
