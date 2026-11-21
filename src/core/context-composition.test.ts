/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect } from 'vitest';
import {
  compositionFromCliUsage,
  compositionFromPromptTokenDetails,
  normalizeShares,
  readSystemSegments,
} from './context-composition';
import { PromptCompositionSchema } from './schemas';

const VSCODE_DETAILS = [
  { category: 'System', label: 'System Instructions', percentageOfPrompt: 26 },
  { category: 'System', label: 'Tool Definitions', percentageOfPrompt: 61 },
  { category: 'User Context', label: 'Messages', percentageOfPrompt: 5 },
  { category: 'User Context', label: 'Tool Results', percentageOfPrompt: 8 },
];

describe('compositionFromPromptTokenDetails', () => {
  it('maps VS Code labels to categories and treats missing known labels as 0%', () => {
    const composition = compositionFromPromptTokenDetails(VSCODE_DETAILS, 48_000);
    expect(composition).toEqual({
      source: 'vscode',
      promptTokens: 48_000,
      shares: { systemInstructions: 26, toolDefinitions: 61, messages: 5, toolResults: 8, files: 0 },
    });
  });

  it('puts unknown future labels into other instead of dropping them', () => {
    const composition = compositionFromPromptTokenDetails([
      ...VSCODE_DETAILS.slice(0, 2),
      { category: 'User Context', label: 'Memory', percentageOfPrompt: 7 },
      { category: 'User Context', label: 'Images', percentageOfPrompt: 6 },
    ], null);
    expect(composition?.shares.other).toBe(13);
    expect(composition?.promptTokens).toBeNull();
  });

  it('treats labels that name Object.prototype members as unknown', () => {
    const composition = compositionFromPromptTokenDetails([
      { label: 'Tool Definitions', percentageOfPrompt: 40 },
      { label: 'constructor', percentageOfPrompt: 30 },
      { label: '__proto__', percentageOfPrompt: 20 },
      { label: 'toString', percentageOfPrompt: 10 },
    ], 1000);
    expect(composition?.shares).toEqual({ toolDefinitions: 40, other: 60, systemInstructions: 0, messages: 0, toolResults: 0, files: 0 });
    expect(PromptCompositionSchema.safeParse(composition).success).toBe(true);
  });

  it('ignores malformed entries and returns undefined when nothing usable remains', () => {
    expect(compositionFromPromptTokenDetails(undefined, 1000)).toBeUndefined();
    expect(compositionFromPromptTokenDetails([], 1000)).toBeUndefined();
    expect(compositionFromPromptTokenDetails({ label: 'Messages' }, 1000)).toBeUndefined();
    expect(compositionFromPromptTokenDetails([
      { label: 'Messages', percentageOfPrompt: 'ten' },
      { label: 'Files', percentageOfPrompt: -4 },
      null,
    ], 1000)).toBeUndefined();
  });

  it('matches labels case-insensitively, clamps values and rejects a non-positive basis', () => {
    const composition = compositionFromPromptTokenDetails([
      { label: 'tool definitions', percentageOfPrompt: 140 },
      { label: ' MESSAGES ', percentageOfPrompt: 20 },
    ], 0);
    expect(composition?.shares.toolDefinitions).toBe(100);
    expect(composition?.shares.messages).toBe(20);
    expect(composition?.promptTokens).toBeNull();
  });
});

describe('normalizeShares', () => {
  it('rescales rounding noise to exactly 100', () => {
    const over = normalizeShares({ systemInstructions: 11, toolDefinitions: 36, messages: 21, toolResults: 32, files: 1 });
    const total = Object.values(over ?? {}).reduce((sum, value) => sum + (value ?? 0), 0);
    expect(total).toBeCloseTo(100, 6);
    expect(over?.other).toBeUndefined();

    const under = normalizeShares({ systemInstructions: 26, toolDefinitions: 60, messages: 5, toolResults: 8 });
    expect(Object.values(under ?? {}).reduce((sum, value) => sum + (value ?? 0), 0)).toBeCloseTo(100, 6);
    expect(under?.other).toBeUndefined();
  });

  it('reports a larger shortfall as other instead of inflating the reported categories', () => {
    const shares = normalizeShares({ systemInstructions: 20, toolDefinitions: 50, messages: 10 });
    expect(shares).toEqual({ systemInstructions: 20, toolDefinitions: 50, messages: 10, other: 20 });
  });

  it('returns null when nothing was reported', () => {
    expect(normalizeShares({})).toBeNull();
    expect(normalizeShares({ messages: 0, files: 0 })).toBeNull();
  });
});

describe('compositionFromCliUsage', () => {
  it('splits a turn into tool definitions, system prompt and conversation', () => {
    const composition = compositionFromCliUsage({ calls: 2, inputTokens: 200_000, toolTokens: 60_000, availableTools: 271 }, 20_000);
    expect(composition).toEqual({
      source: 'copilot-cli',
      shares: { toolDefinitions: 30, systemInstructions: 20, conversation: 50 },
      promptTokens: 100_000,
      calls: 2,
      toolDefinitionTokens: 30_000,
      availableTools: 271,
    });
  });

  it('keeps the non-tool remainder unattributed without a system-prompt size', () => {
    const composition = compositionFromCliUsage({ calls: 1, inputTokens: 80_000, toolTokens: 20_000, availableTools: 0 }, null);
    expect(composition?.shares).toEqual({ toolDefinitions: 25, other: 75 });
    expect(composition).not.toHaveProperty('availableTools');
  });

  it('never attributes more than the prompt', () => {
    const composition = compositionFromCliUsage({ calls: 1, inputTokens: 40_000, toolTokens: 30_000, availableTools: 10 }, 25_000);
    expect(composition?.shares).toEqual({ toolDefinitions: 75, systemInstructions: 25, conversation: 0 });
  });

  it('returns undefined without calls or prompt tokens', () => {
    expect(compositionFromCliUsage({ calls: 0, inputTokens: 0, toolTokens: 0, availableTools: 0 }, 10_000)).toBeUndefined();
    expect(compositionFromCliUsage({ calls: 2, inputTokens: 0, toolTokens: 0, availableTools: 0 }, 10_000)).toBeUndefined();
  });
});

describe('readSystemSegments', () => {
  it('keeps only segment names and tokens, largest first', () => {
    const segments = readSystemSegments([
      { segment: 'memory', hash: 'abc123', tokens: 1172 },
      { segment: 'tool_instructions', hash: 'def456', tokens: 9570 },
      { segment: 'canvases', hash: 'f00', tokens: 1049 },
      { segment: 'empty', hash: 'f01', tokens: 0 },
    ]);
    expect(segments).toEqual([
      { name: 'tool_instructions', tokens: 9570 },
      { name: 'memory', tokens: 1172 },
      { name: 'canvases', tokens: 1049 },
    ]);
    expect(JSON.stringify(segments)).not.toContain('hash');
  });

  it('folds names that are not plain identifiers into other and merges duplicates', () => {
    const segments = readSystemSegments([
      { segment: 'You are a helpful assistant', tokens: 50 },
      { segment: 'memory', tokens: 10 },
      { segment: 'memory', tokens: 15 },
      { segment: 42, tokens: 5 },
    ]);
    expect(segments).toEqual([{ name: 'other', tokens: 55 }, { name: 'memory', tokens: 25 }]);
  });

  it('caps the list and folds the tail into other', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ segment: `segment_${i}`, tokens: 1000 - i }));
    const segments = readSystemSegments(many);
    expect(segments).toHaveLength(40);
    expect(segments.at(-1)?.name).toBe('other');
    expect(segments.reduce((sum, segment) => sum + segment.tokens, 0)).toBe(many.reduce((sum, segment) => sum + segment.tokens, 0));
  });

  it('returns an empty list for missing data', () => {
    expect(readSystemSegments(undefined)).toEqual([]);
    expect(readSystemSegments({ segment: 'memory', tokens: 3 })).toEqual([]);
  });
});
