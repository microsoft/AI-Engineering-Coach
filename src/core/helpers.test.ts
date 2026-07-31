/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect } from 'vitest';
import {
  fileUriToPath, toDateStr, startOfDay, endOfDay, isoWeek, normalizeModel, modelMultiplier,
  classifyWorkType, resolveTokens, resolveContextTier, tokenCostInCredits,
} from './helpers';

describe('fileUriToPath', () => {
  it('converts a Windows file URI', () => {
    expect(fileUriToPath('file:///C:/Users/me/code')).toBe('C:/Users/me/code');
  });
  it('converts a Unix file URI', () => {
    expect(fileUriToPath('file:///home/user/code')).toBe('/home/user/code');
  });
  it('decodes percent-encoded characters', () => {
    expect(fileUriToPath('file:///C:/My%20Folder/file.txt')).toBe('C:/My Folder/file.txt');
  });
  it('returns a plain path unchanged', () => {
    expect(fileUriToPath('/home/user/code')).toBe('/home/user/code');
  });
  it('does not throw on a path with a literal % character', () => {
    expect(fileUriToPath('/home/user/100%done')).toBe('/home/user/100%done');
  });
});

describe('toDateStr', () => {
  it('formats a timestamp as YYYY-MM-DD', () => {
    const ts = new Date(2024, 5, 15).getTime(); // June 15, 2024
    expect(toDateStr(ts)).toBe('2024-06-15');
  });

  it('pads single-digit month and day', () => {
    const ts = new Date(2024, 0, 3).getTime(); // Jan 3
    expect(toDateStr(ts)).toBe('2024-01-03');
  });
});

describe('startOfDay / endOfDay', () => {
  it('startOfDay sets time to 00:00:00.000', () => {
    const ts = new Date(2024, 5, 15, 14, 30, 45).getTime();
    const sod = new Date(startOfDay(ts));
    expect(sod.getHours()).toBe(0);
    expect(sod.getMinutes()).toBe(0);
    expect(sod.getSeconds()).toBe(0);
    expect(sod.getMilliseconds()).toBe(0);
  });

  it('endOfDay sets time to 23:59:59.999', () => {
    const ts = new Date(2024, 5, 15, 8, 0, 0).getTime();
    const eod = new Date(endOfDay(ts));
    expect(eod.getHours()).toBe(23);
    expect(eod.getMinutes()).toBe(59);
    expect(eod.getSeconds()).toBe(59);
    expect(eod.getMilliseconds()).toBe(999);
  });
});

describe('isoWeek', () => {
  it('returns correct ISO week string', () => {
    // Jan 1, 2024 is a Monday → week 1
    expect(isoWeek(new Date(2024, 0, 1))).toBe('2024-W01');
  });

  it('returns correct week for mid-year date', () => {
    // June 15, 2024 is a Saturday → week 24
    const w = isoWeek(new Date(2024, 5, 15));
    expect(w).toMatch(/^2024-W\d{2}$/);
  });
});

describe('normalizeModel', () => {
  it('strips copilot/ prefix', () => {
    expect(normalizeModel('copilot/gpt-4.1')).toBe('gpt-4.1');
  });

  it('strips github.copilot-chat/ prefix', () => {
    expect(normalizeModel('github.copilot-chat/claude-3.5-sonnet')).toBe('claude-3.5-sonnet');
  });

  it('strips -thought suffix', () => {
    expect(normalizeModel('o3-mini-thought')).toBe('o3-mini');
  });

  it('strips -preview suffix', () => {
    expect(normalizeModel('o1-preview')).toBe('o1');
  });

  it('strips -latest suffix', () => {
    expect(normalizeModel('gpt-4.1-latest')).toBe('gpt-4.1');
  });

  it('trims whitespace', () => {
    expect(normalizeModel('  gpt-4.1  ')).toBe('gpt-4.1');
  });

  it('strips effort suffix from reasoning-capable models', () => {
    expect(normalizeModel('copilot/claude-opus-4.7-high')).toBe('claude-opus-4.7');
    expect(normalizeModel('copilot/claude-opus-4.7-xhigh')).toBe('claude-opus-4.7');
    expect(normalizeModel('gpt-5-low')).toBe('gpt-5');
  });

  it('does NOT strip -mini/-fast (non-effort suffixes)', () => {
    expect(normalizeModel('copilot/gpt-5.4-mini')).toBe('gpt-5.4-mini');
    expect(normalizeModel('copilot/claude-opus-4.6-fast')).toBe('claude-opus-4.6-fast');
  });

  it('normalizes Claude API hyphenated versions to dots', () => {
    expect(normalizeModel('claude-opus-4-6')).toBe('claude-opus-4.6');
    expect(normalizeModel('claude-opus-4-7')).toBe('claude-opus-4.7');
    expect(normalizeModel('claude-sonnet-4-6')).toBe('claude-sonnet-4.6');
    expect(normalizeModel('claude-haiku-4-5')).toBe('claude-haiku-4.5');
  });

  it('strips Claude API date suffixes before normalizing', () => {
    expect(normalizeModel('claude-haiku-4-5-20251001')).toBe('claude-haiku-4.5');
    expect(normalizeModel('claude-3-5-sonnet-20241022')).toBe('claude-3.5-sonnet');
  });

  it('handles Claude API model IDs with effort suffixes', () => {
    expect(normalizeModel('claude-opus-4-6-high')).toBe('claude-opus-4.6');
    expect(normalizeModel('claude-opus-4-7-xhigh')).toBe('claude-opus-4.7');
  });

  it('preserves Claude models with non-effort suffixes after normalization', () => {
    expect(normalizeModel('claude-opus-4-6-fast')).toBe('claude-opus-4.6-fast');
    expect(normalizeModel('claude-opus-4-6-1m')).toBe('claude-opus-4.6-1m');
  });

  it('leaves already-dotted Claude model IDs unchanged', () => {
    expect(normalizeModel('claude-opus-4.6')).toBe('claude-opus-4.6');
    expect(normalizeModel('claude-sonnet-4.5')).toBe('claude-sonnet-4.5');
    expect(normalizeModel('claude-3.5-sonnet')).toBe('claude-3.5-sonnet');
  });
});

describe('modelMultiplier', () => {
  it('returns 0 for gpt-4.1', () => {
    expect(modelMultiplier('gpt-4.1')).toBe(0);
  });

  it('returns 1 for claude-sonnet-4', () => {
    expect(modelMultiplier('claude-sonnet-4')).toBe(1);
  });

  it('strips prefix before looking up', () => {
    expect(modelMultiplier('copilot/gpt-4.1')).toBe(0);
  });

  it('returns 1 for unknown models', () => {
    expect(modelMultiplier('totally-unknown-model')).toBe(1);
  });
});

describe('classifyWorkType', () => {
  it('returns "bug fix" for fix-related text', () => {
    expect(classifyWorkType('fix this bug in login')).toBe('bug fix');
  });

  it('returns "refactor" for refactor-related text', () => {
    expect(classifyWorkType('refactor the auth module')).toBe('refactor');
  });

  it('returns "test" for test-related text', () => {
    expect(classifyWorkType('write a unit test for parser')).toBe('test');
  });

  it('returns "docs" for doc-related text', () => {
    expect(classifyWorkType('update the README')).toBe('docs');
  });

  it('returns "config" for config-related text', () => {
    expect(classifyWorkType('add docker compose')).toBe('config');
  });

  it('returns "feature" for feature-related text', () => {
    expect(classifyWorkType('implement search feature')).toBe('feature');
  });

  it('returns "other" for unmatched text', () => {
    expect(classifyWorkType('what is the meaning of life')).toBe('other');
  });

  it('matches higher-priority pattern first (bug fix before feature)', () => {
    expect(classifyWorkType('fix and add new feature')).toBe('bug fix');
  });
});

describe('resolveContextTier', () => {
  it('returns default for models without a longContext tier', () => {
    expect(resolveContextTier('gpt-4.1', 200_000)).toBe('default');
  });

  it('returns default when promptTokens is null', () => {
    expect(resolveContextTier('gpt-5.6-terra', null)).toBe('default');
  });

  it('returns default when input is at or below the 128k threshold', () => {
    expect(resolveContextTier('gpt-5.6-terra', 128_000)).toBe('default');
    expect(resolveContextTier('copilot/gpt-5.6-terra', 100_000)).toBe('default');
  });

  it('returns longContext when input exceeds the 128k threshold', () => {
    expect(resolveContextTier('gpt-5.6-terra', 128_001)).toBe('longContext');
    expect(resolveContextTier('copilot/gpt-5.6-terra', 200_000)).toBe('longContext');
  });
});

describe('resolveTokens', () => {
  it('reports default context tier for normal inputs', () => {
    const t = resolveTokens(10_000, 5_000, 0, 0, 'gpt-5.6-terra');
    expect(t.contextTier).toBe('default');
  });

  it('reports longContext tier for inputs above the threshold', () => {
    const t = resolveTokens(200_000, 5_000, 0, 0, 'gpt-5.6-terra');
    expect(t.contextTier).toBe('longContext');
  });

  it('defaults to default tier when modelId is omitted', () => {
    const t = resolveTokens(200_000, 5_000);
    expect(t.contextTier).toBe('default');
  });
});

describe('tokenCostInCredits', () => {
  it('uses default GPT-5.6 Terra rates below the long-context threshold', () => {
    // 1M input + 500k output, no cache
    const credits = tokenCostInCredits('gpt-5.6-terra', 1_000_000, 500_000, 0, 0, 'default');
    // (1 * $2.00 + 0.5 * $12.00) / $0.01 = 200 + 600 = 800 credits
    expect(credits).toBe(800);
  });

  it('uses long-context GPT-5.6 Terra rates above the threshold', () => {
    const credits = tokenCostInCredits('gpt-5.6-terra', 1_000_000, 500_000, 0, 0, 'longContext');
    // (1 * $4.00 + 0.5 * $18.00) / $0.01 = 400 + 900 = 1300 credits
    expect(credits).toBe(1300);
  });

  it('falls back to default rates when longContext is requested but not defined', () => {
    const credits = tokenCostInCredits('gpt-4.1', 1_000_000, 500_000, 0, 0, 'longContext');
    // (1 * $2.00 + 0.5 * $8.00) / $0.01 = 200 + 400 = 600 credits
    expect(credits).toBe(600);
  });

  it('bills cache reads and writes at the cached rates', () => {
    // 1M total input: 800k cache read + 200k cache write + 0 uncached; 0 output
    const credits = tokenCostInCredits('gpt-5.6-terra', 0, 0, 800_000, 200_000, 'default');
    // (0.8 * $0.20 + 0.2 * $2.50) / $0.01 = 16 + 50 = 66 credits
    expect(credits).toBe(66);
  });

  it('falls back to model multiplier for unknown models', () => {
    expect(tokenCostInCredits('unknown-premium-model', 1_000_000, 500_000)).toBe(1);
  });
});
