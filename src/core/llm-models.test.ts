/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect } from 'vitest';
import { scoreFamily, orderModelsByPreference, dedupeModelsById } from './llm-models';

describe('scoreFamily', () => {
  it('ranks stronger capability tiers ahead of weaker ones', () => {
    expect(scoreFamily('claude-opus-4.8')).toBeLessThan(scoreFamily('claude-sonnet-4.5'));
    expect(scoreFamily('gpt-5.4')).toBeLessThan(scoreFamily('gpt-4o'));
    expect(scoreFamily('gpt-4o')).toBeLessThan(scoreFamily('claude-haiku-4'));
  });

  it('prefers the higher version within the same tier', () => {
    expect(scoreFamily('claude-opus-4.8')).toBeLessThan(scoreFamily('claude-opus-4.6'));
    expect(scoreFamily('gpt-5.4')).toBeLessThan(scoreFamily('gpt-5.1'));
  });

  it('is case-insensitive on the family prefix', () => {
    expect(scoreFamily('CLAUDE-OPUS-4.8')).toBe(scoreFamily('claude-opus-4.8'));
  });

  it('sinks non-chat helper families below every tier and unknown families', () => {
    const helper = scoreFamily('copilot-utility');
    expect(helper).toBeGreaterThan(scoreFamily('claude-haiku-4'));
    expect(helper).toBeGreaterThan(scoreFamily('some-unknown-model-9'));
  });

  it('places unknown families mid-pack (after known tiers, before helpers)', () => {
    const unknown = scoreFamily('mystery-model-2');
    expect(unknown).toBeGreaterThan(scoreFamily('claude-haiku-4'));
    expect(unknown).toBeLessThan(scoreFamily('copilot-utility'));
  });
});

describe('orderModelsByPreference', () => {
  const models = [
    { id: 'a', family: 'gpt-4o' },
    { id: 'b', family: 'claude-opus-4.8' },
    { id: 'c', family: 'copilot-utility' },
    { id: 'd', family: 'gpt-5.4' },
  ];

  it('orders by capability with helper models last (org-neutral)', () => {
    const ordered = orderModelsByPreference(models);
    expect(ordered.map(m => m.id)).toEqual(['b', 'd', 'a', 'c']);
  });

  it('floats the preferred model (matched by id) to the front', () => {
    const ordered = orderModelsByPreference(models, 'a');
    expect(ordered[0].id).toBe('a');
  });

  it('floats the preferred model (matched by family) to the front', () => {
    const ordered = orderModelsByPreference(models, 'copilot-utility');
    expect(ordered[0].id).toBe('c');
  });

  it('falls back to capability order when the preferred model is unavailable', () => {
    const ordered = orderModelsByPreference(models, 'not-installed');
    expect(ordered[0].id).toBe('b');
  });
});

describe('dedupeModelsById', () => {
  it('keeps the first occurrence of each id and drops exact duplicates', () => {
    const input = [
      { id: 'x', family: 'gpt-5.4' },
      { id: 'x', family: 'gpt-5.4' },
      { id: 'y', family: 'claude-opus-4.8' },
    ];
    expect(dedupeModelsById(input).map(m => m.id)).toEqual(['x', 'y']);
  });

  it('keeps distinct ids that happen to share a family', () => {
    const input = [
      { id: 'auto', family: 'auto' },
      { id: 'gpt-5.3-codex', family: 'auto' },
    ];
    expect(dedupeModelsById(input).map(m => m.id)).toEqual(['auto', 'gpt-5.3-codex']);
  });
});
