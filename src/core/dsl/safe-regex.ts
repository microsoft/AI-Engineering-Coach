/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { warnCore } from '../log';

/** Max pattern length. Anything longer is almost certainly a mistake. */
const MAX_PATTERN_LEN = 1000;

/** Max input length for `.test()`. Long enough for any realistic message body. */
export const MAX_TEST_INPUT_LEN = 100_000;

/** LRU-ish cache of compiled regexes (FIFO eviction). */
const CACHE_MAX = 256;
const regexCache = new Map<string, RegExp>();

/** Patterns already seen and rejected, to avoid re-warning on every row. */
const rejectedPatterns = new Set<string>();

export function compileSafe(pattern: string, flags = ''): RegExp | null {
  const key = `${pattern}::${flags}`;
  const cached = regexCache.get(key);
  if (cached) return cached;
  if (rejectedPatterns.has(key)) return null;

  if (typeof pattern !== 'string' || pattern.length > MAX_PATTERN_LEN) {
    rejectedPatterns.add(key);
    warnCore('SafeRegex', `Pattern rejected (length > ${MAX_PATTERN_LEN}): ${pattern.slice(0, 40)}...`);
    return null;
  }

  if (!isLikelySafe(pattern)) {
    rejectedPatterns.add(key);
    warnCore('SafeRegex', `Pattern rejected (potential catastrophic backtracking): ${pattern}`);
    return null;
  }

  let re: RegExp;
  try {
    re = new RegExp(pattern, flags);
  } catch (err) {
    rejectedPatterns.add(key);
    warnCore('SafeRegex', `Invalid regex '${pattern}' flags='${flags}': ${(err as Error).message}`);
    return null;
  }

  if (regexCache.size >= CACHE_MAX) {
    // Evict oldest entry (insertion order).
    const firstKey = regexCache.keys().next().value;
    if (firstKey !== undefined) regexCache.delete(firstKey);
  }
  regexCache.set(key, re);
  return re;
}

export function testSafe(re: RegExp | null, input: string): boolean {
  if (!re) return false;
  const s = input.length > MAX_TEST_INPUT_LEN ? input.slice(0, MAX_TEST_INPUT_LEN) : input;
  try {
    // Reset lastIndex in case the pattern has the `g` flag.
    re.lastIndex = 0;
    return re.test(s);
  } catch {
    return false;
  }
}

/** Clear the compiled-regex cache (for tests / diagnostics). */
export function clearRegexCache(): void {
  regexCache.clear();
  rejectedPatterns.clear();
}

interface RegexGroupState {
  start: number;
  hasInnerUnbounded: boolean;
}

function skipEscapedChar(pattern: string, index: number): number {
  return pattern[index] === '\\' ? index + 1 : index;
}

function skipCharacterClass(pattern: string, index: number): number {
  let nextIndex = index + 1;
  while (nextIndex < pattern.length && pattern[nextIndex] !== ']') {
    if (pattern[nextIndex] === '\\') nextIndex++;
    nextIndex++;
  }
  return nextIndex;
}

function hasUnboundedQuantifierAt(pattern: string, index: number): boolean {
  const char = pattern[index];
  return char === '+' || char === '*' || (char === '{' && /^\{\d+,\d*\}/.test(pattern.slice(index)));
}

function closeGroup(
  pattern: string,
  index: number,
  groupStack: RegexGroupState[],
  starHeight: number,
  maxStarHeight: number,
): { safe: boolean; starHeight: number; maxStarHeight: number } {
  const group = groupStack.pop();
  if (!hasUnboundedQuantifierAt(pattern, index + 1)) {
    return { safe: true, starHeight, maxStarHeight };
  }

  const nextStarHeight = starHeight + 1;
  const nextMaxStarHeight = Math.max(maxStarHeight, nextStarHeight);
  if (group?.hasInnerUnbounded) return { safe: false, starHeight: nextStarHeight, maxStarHeight: nextMaxStarHeight };

  const body = pattern.slice(group ? group.start + 1 : 0, index);
  if (hasOverlappingAlternation(body)) {
    return { safe: false, starHeight: nextStarHeight, maxStarHeight: nextMaxStarHeight };
  }

  return { safe: true, starHeight: nextStarHeight, maxStarHeight: nextMaxStarHeight };
}

function markInnerUnbounded(groupStack: RegexGroupState[]): void {
  const top = groupStack[groupStack.length - 1];
  if (top) top.hasInnerUnbounded = true;
}

export function isLikelySafe(pattern: string): boolean {
  let starHeight = 0;
  let maxStarHeight = 0;
  const groupStack: RegexGroupState[] = [];

  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];

    if (ch === '\\') {
      i = skipEscapedChar(pattern, i);
      continue;
    }
    if (ch === '[') {
      i = skipCharacterClass(pattern, i);
      continue;
    }
    if (ch === '(') {
      groupStack.push({ start: i, hasInnerUnbounded: false });
      continue;
    }
    if (ch === ')') {
      const result = closeGroup(pattern, i, groupStack, starHeight, maxStarHeight);
      if (!result.safe) return false;
      starHeight = result.starHeight;
      maxStarHeight = result.maxStarHeight;
      continue;
    }
    if (hasUnboundedQuantifierAt(pattern, i)) {
      markInnerUnbounded(groupStack);
    }
  }

  return maxStarHeight <= 2;
}

const CLASS_ESCAPES = new Set(['w', 'W', 'd', 'D', 's', 'S']);

function splitTopLevelBranches(body: string): string[] {
  const branches: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '\\') { i++; continue; }
    if (ch === '[') { i = skipCharacterClass(body, i); continue; }
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === '|' && depth === 0) {
      branches.push(body.slice(start, i));
      start = i + 1;
    }
  }
  branches.push(body.slice(start));
  return branches;
}

// Alternation branches that can match the same first character cause
// catastrophic backtracking under an unbounded quantifier (e.g. `(.|a)+`).
function hasOverlappingAlternation(body: string): boolean {
  const tokens = splitTopLevelBranches(body).map(firstToken);
  if (tokens.length < 2) return false;

  for (let i = 0; i < tokens.length; i++) {
    for (let j = i + 1; j < tokens.length; j++) {
      if (tokensOverlap(tokens[i], tokens[j])) return true;
    }
  }
  return false;
}

// A branch's leading token: either a literal run or a single-char matcher
// (`.`, a class escape, or a `[...]` class). `null` means indeterminate.
type FirstToken =
  | { set: false; literal: string }
  | { set: true; source: string }
  | null;

function firstToken(branch: string): FirstToken {
  const body = branch.startsWith('^') ? branch.slice(1) : branch;
  if (body.length === 0) return null;

  if (body[0] === '.') return { set: true, source: '.' };
  if (body[0] === '[') return { set: true, source: body.slice(0, skipCharacterClass(body, 0) + 1) };
  if (body[0] === '\\' && body.length > 1 && CLASS_ESCAPES.has(body[1])) {
    return { set: true, source: body.slice(0, 2) };
  }

  const prefix = literalPrefix(body);
  return prefix ? { set: false, literal: prefix } : null;
}

function tokensOverlap(a: FirstToken, b: FirstToken): boolean {
  if (!a || !b) return false;
  if (!a.set && !b.set) return a.literal.startsWith(b.literal) || b.literal.startsWith(a.literal);
  if (a.set && b.set) return true;
  const set = a.set ? a : (b as Extract<FirstToken, { set: true }>);
  const literal = a.set ? (b as Extract<FirstToken, { set: false }>) : a;
  return setMatchesChar(set.source, literal.literal[0]);
}

// Whether a single-char matcher source (e.g. `[a-z]`, `\w`, `.`) accepts `ch`.
// An unparseable source is treated as a match (fail closed toward rejection).
function setMatchesChar(source: string, ch: string): boolean {
  try {
    return new RegExp(`^(?:${source})$`).test(ch);
  } catch {
    return true;
  }
}

function literalPrefix(branch: string): string {
  let out = '';
  for (let i = 0; i < branch.length; i++) {
    const ch = branch[i];
    if (ch === '\\' && i + 1 < branch.length) {
      out += branch[i + 1];
      i++;
      continue;
    }
    if ('()[]{}|+*?.^$'.includes(ch)) break;
    out += ch;
  }
  return out;
}
