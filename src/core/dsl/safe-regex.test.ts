/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_TEST_INPUT_LEN,
  clearRegexCache,
  compileSafe,
  isLikelySafe,
  testSafe,
} from './safe-regex';

describe('compileSafe', () => {
  beforeEach(() => {
    clearRegexCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns a RegExp for a simple pattern', () => {
    const re = compileSafe('hello');

    expect(re).toBeInstanceOf(RegExp);
    expect(re?.source).toBe('hello');
  });

  it('returns a matching regex for simple text', () => {
    const re = compileSafe('hello');

    expect(re?.test('say hello')).toBe(true);
  });

  it('caches compiled regex instances for the same pattern and flags', () => {
    const first = compileSafe('hello');
    const second = compileSafe('hello');

    expect(second).toBe(first);
  });

  it('treats flags as part of the cache key', () => {
    const plain = compileSafe('hello');
    const ignoreCase = compileSafe('hello', 'i');

    expect(ignoreCase).toBeInstanceOf(RegExp);
    expect(ignoreCase).not.toBe(plain);
  });

  it('handles valid regex flags', () => {
    const re = compileSafe('hello', 'i');

    expect(re).toBeInstanceOf(RegExp);
    expect(re?.flags).toContain('i');
    expect(re?.test('HELLO')).toBe(true);
  });

  it('accepts patterns exactly at the maximum allowed length', () => {
    const re = compileSafe('a'.repeat(1000));

    expect(re).toBeInstanceOf(RegExp);
  });

  it('returns null for patterns longer than 1000 characters', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const re = compileSafe('a'.repeat(1001));

    expect(re).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('returns null for patterns with nested quantifiers', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const re = compileSafe('(a+)+');

    expect(re).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('returns null for invalid regex syntax', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const re = compileSafe('[');

    expect(re).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('returns null for invalid regex flags', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const re = compileSafe('hello', 'z');

    expect(re).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('caches rejected unsafe patterns and does not warn twice', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(compileSafe('(a+)+')).toBeNull();
    expect(compileSafe('(a+)+')).toBeNull();

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('caches rejected invalid patterns and does not warn twice', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(compileSafe('[')).toBeNull();
    expect(compileSafe('[')).toBeNull();

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('evicts the oldest compiled regex when the FIFO cache exceeds 256 entries', () => {
    const first = compileSafe('pattern-0');
    for (let i = 1; i <= 256; i++) {
      compileSafe(`pattern-${i}`);
    }

    const recompiled = compileSafe('pattern-0');

    expect(recompiled).toBeInstanceOf(RegExp);
    expect(recompiled).not.toBe(first);
  });

  it('keeps newer compiled entries in the cache after FIFO eviction', () => {
    for (let i = 0; i <= 255; i++) {
      compileSafe(`pattern-${i}`);
    }
    const newest = compileSafe('pattern-255');
    compileSafe('pattern-256');

    const cachedNewest = compileSafe('pattern-255');

    expect(cachedNewest).toBe(newest);
  });
});

describe('testSafe', () => {
  beforeEach(() => {
    clearRegexCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns false for a null regex', () => {
    expect(testSafe(null, 'hello')).toBe(false);
  });

  it('returns true for matching input', () => {
    const re = compileSafe('hello');

    expect(testSafe(re, 'well hello there')).toBe(true);
  });

  it('returns false for non-matching input', () => {
    const re = compileSafe('hello');

    expect(testSafe(re, 'goodbye')).toBe(false);
  });

  it('truncates overly long input before testing', () => {
    const re = compileSafe('^a+$');
    const input = `${'a'.repeat(MAX_TEST_INPUT_LEN)}b`;

    expect(testSafe(re, input)).toBe(true);
  });

  it('still returns false when the mismatch is inside the truncated portion', () => {
    const re = compileSafe('^a+$');
    const input = `${'a'.repeat(MAX_TEST_INPUT_LEN - 1)}b${'a'.repeat(50)}`;

    expect(testSafe(re, input)).toBe(false);
  });

  it('handles extremely long matching input without throwing', () => {
    const re = compileSafe('a+$');
    const input = 'z'.repeat(10) + 'a'.repeat(MAX_TEST_INPUT_LEN + 10);

    expect(() => testSafe(re, input)).not.toThrow();
  });

  it('resets lastIndex before testing a global regex', () => {
    const re = compileSafe('a', 'g');
    expect(re).not.toBeNull();
    re!.lastIndex = 1;

    expect(testSafe(re, 'a')).toBe(true);
  });

  it('leaves a global regex at the post-test lastIndex after a successful match', () => {
    const re = compileSafe('a', 'g');
    expect(re).not.toBeNull();
    re!.lastIndex = 99;

    testSafe(re, 'a');

    expect(re!.lastIndex).toBe(1);
  });

  it('resets lastIndex to 0 when a global regex does not match', () => {
    const re = compileSafe('a', 'g');
    expect(re).not.toBeNull();
    re!.lastIndex = 99;

    expect(testSafe(re, 'bbb')).toBe(false);
    expect(re!.lastIndex).toBe(0);
  });

  it('returns false if regex.test throws', () => {
    const throwing = {
      lastIndex: 123,
      test: vi.fn(() => {
        throw new Error('boom');
      }),
    } as unknown as RegExp;

    expect(testSafe(throwing, 'hello')).toBe(false);
  });

  it('resets lastIndex even for regex-like objects whose test throws', () => {
    const throwing = {
      lastIndex: 123,
      test: vi.fn(() => {
        throw new Error('boom');
      }),
    } as unknown as RegExp;

    testSafe(throwing, 'hello');

    expect(throwing.lastIndex).toBe(0);
  });
});

describe('clearRegexCache', () => {
  beforeEach(() => {
    clearRegexCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('recompiles previously cached patterns after clearing the cache', () => {
    const first = compileSafe('hello');

    clearRegexCache();

    const second = compileSafe('hello');

    expect(second).toBeInstanceOf(RegExp);
    expect(second).not.toBe(first);
  });

  it('re-evaluates previously rejected long patterns after clearing the cache', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const pattern = 'a'.repeat(1001);

    expect(compileSafe(pattern)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);

    clearRegexCache();
    expect(compileSafe(pattern)).toBeNull();

    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('re-evaluates previously rejected unsafe patterns after clearing the cache', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(compileSafe('(a+)+')).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);

    clearRegexCache();
    expect(compileSafe('(a+)+')).toBeNull();

    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('re-evaluates previously rejected invalid patterns after clearing the cache', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(compileSafe('[')).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);

    clearRegexCache();
    expect(compileSafe('[')).toBeNull();

    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe('isLikelySafe', () => {
  it('returns true for a simple literal pattern', () => {
    expect(isLikelySafe('hello')).toBe(true);
  });

  it('returns true for a digit class with a quantifier', () => {
    expect(isLikelySafe('\\d+')).toBe(true);
  });

  it('returns true for a character class with a quantifier', () => {
    expect(isLikelySafe('[a-z]+')).toBe(true);
  });

  it('returns true for bounded repetition', () => {
    expect(isLikelySafe('(abc){1,5}')).toBe(true);
  });

  it('returns true for a complex email-like pattern', () => {
    expect(isLikelySafe('^[a-zA-Z0-9]+@[a-zA-Z0-9]+\\.[a-z]{2,4}$')).toBe(true);
  });

  it('returns true for non-overlapping alternation under a quantifier', () => {
    expect(isLikelySafe('(a|b)+')).toBe(true);
  });

  it('returns true for distinct literal branches under a quantifier', () => {
    expect(isLikelySafe('(cat|dog)+')).toBe(true);
  });

  it('returns true for escaped metacharacters', () => {
    expect(isLikelySafe('\\(a\\+\\)+')).toBe(true);
  });

  it('returns true for escaped closing brackets inside a character class', () => {
    expect(isLikelySafe('[a-z\\]]+')).toBe(true);
  });

  it('returns true for overlapping alternation when the group is not quantified', () => {
    expect(isLikelySafe('(aa|aa)')).toBe(true);
  });

  it('returns false for nested plus quantifiers', () => {
    expect(isLikelySafe('(a+)+')).toBe(false);
  });

  it('returns false for nested star quantifiers', () => {
    expect(isLikelySafe('(a*)*')).toBe(false);
  });

  it('returns false for an unbounded inner quantifier inside a counted outer quantifier', () => {
    expect(isLikelySafe('(a+){2,}')).toBe(false);
  });

  it('returns false for overlapping alternation under a quantifier', () => {
    expect(isLikelySafe('(aa|aa)+')).toBe(false);
  });

  it('returns false for prefix-overlapping alternation under a quantifier', () => {
    expect(isLikelySafe('(a|aa)+')).toBe(false);
  });

  it('returns false for a character-class branch overlapping a literal under a quantifier', () => {
    expect(isLikelySafe('^([a]|a)+$')).toBe(false);
  });

  it('returns false for a dot branch overlapping a literal under a quantifier', () => {
    expect(isLikelySafe('^(.|a)+$')).toBe(false);
  });

  it('returns false for a class-escape branch overlapping a literal under a quantifier', () => {
    expect(isLikelySafe('^(\\w|a)+$')).toBe(false);
  });

  it('returns true for a disjoint character-class alternation under a quantifier', () => {
    expect(isLikelySafe('^([a-z]|_)+$')).toBe(true);
  });

  it('rejects a class-overlapping alternation pattern through compileSafe', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    // Pattern assembled at runtime so static analysis does not treat this
    // rejected fixture as a live regex; compileSafe returns null before any
    // RegExp is constructed.
    const ch = String.fromCharCode(97);
    const overlapping = `^([${ch}]|${ch})+$`;
    expect(compileSafe(overlapping)).toBeNull();

    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
