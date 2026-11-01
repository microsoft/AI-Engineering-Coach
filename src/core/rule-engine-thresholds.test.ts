/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* updateRuleThresholds: which rules it changes, how the override is built, and what it rejects. */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseRule, serializeRule } from './rule-parser';

let engine: typeof import('./rule-engine');

beforeEach(async () => {
  vi.resetModules();
  engine = await import('./rule-engine');
});

/** A rule with `frontMatter` after its header, a detection block with examples, and a # Tests block. */
function ruleSource(frontMatter: string[], id = 'tuned-rule'): string {
  return [
    '---', `id: ${id}`, 'name: Tuned Rule', 'group: prompt-quality', 'severity: low', 'scope: requests', ...frontMatter, '---',
    '', '# Description', 'Short prompts.', '',
    '# Detection Logic', '```detect', 'scan: requests', 'match: messageLength < thresholds.minChars', 'aggregate: ratio',
    'check: ratio > thresholds.maxRatio', 'examples: "{{messageText | truncate:40}}"', '```', '',
    '# Tests', '```test', '{messageText: "fix", messageLength: 3} -> triggered', '```', '',
  ].join('\n');
}

const TUNABLE = ruleSource(['thresholds:', '  minChars: 30', '  maxRatio: 0.3']);

describe('updateRuleThresholds rejects', () => {
  it.each([
    ['a key the rule does not have', TUNABLE, { minSample: 5 }],
    ['thresholds: {}', ruleSource(['thresholds: {}']), { minChars: 40 }],
    ['a rule without thresholds', ruleSource([]), { minChars: 40 }],
    ['a value written as text', ruleSource(['thresholds:', '  minChars: thirty']), { minChars: 40 }],
    ['a value that is not finite', TUNABLE, { minChars: Number.NaN }],
  ])('%s and leaves the rule as it was', (_case, source, values) => {
    engine.registerBuiltinRuleSource('tuned-rule', source);
    const before = engine.getRule('tuned-rule');

    expect(engine.updateRuleThresholds('tuned-rule', values)).toBeNull();
    expect(engine.getRule('tuned-rule')).toBe(before);
    expect(engine.getRuleSource('tuned-rule')).toBe(source);
  });

  it('a value the parser reads as text even when it equals the new value, but sets a new one', () => {
    const source = ruleSource(['thresholds:', '  minChars: 30', '  maxRatio: 0.40']);
    engine.registerBuiltinRuleSource('tuned-rule', source);

    expect(engine.updateRuleThresholds('tuned-rule', { maxRatio: 0.4 })).toBeNull();
    expect(engine.getRuleSource('tuned-rule')).toBe(source);

    expect(engine.updateRuleThresholds('tuned-rule', { maxRatio: 0.5 })?.thresholds).toEqual({ minChars: 30, maxRatio: 0.5 });
    expect(engine.getRuleSource('tuned-rule')).toBe(source.replace('maxRatio: 0.40', 'maxRatio: 0.5'));
  });
});

describe('updateRuleThresholds sets', () => {
  it('nothing for values already set: a built-in rule is returned itself and stays built-in', () => {
    engine.registerBuiltinRuleSource('tuned-rule', TUNABLE);
    const before = engine.getRule('tuned-rule');

    expect(engine.updateRuleThresholds('tuned-rule', { minChars: 30, maxRatio: 0.3 })).toBe(before);
    expect(engine.getRule('tuned-rule')).toMatchObject({ source: 'built-in' });
  });

  it('the override from its new markdown, keeping its # Tests and detection logic', () => {
    engine.registerBuiltinRuleSource('tuned-rule', TUNABLE);

    const updated = engine.updateRuleThresholds('tuned-rule', { minChars: 40 });

    const expected = TUNABLE.replace('  minChars: 30', '  minChars: 40');
    expect(engine.getRuleSource('tuned-rule')).toBe(expected);
    expect(updated).toEqual({ ...parseRule(expected), source: 'personal' });
    expect(updated?.tests).toHaveLength(1);
    expect(engine.getRule('tuned-rule')).toBe(updated);
  });

  it('a second edit on top of the first', () => {
    engine.registerBuiltinRuleSource('tuned-rule', TUNABLE);

    engine.updateRuleThresholds('tuned-rule', { minChars: 40 });
    const updated = engine.updateRuleThresholds('tuned-rule', { maxRatio: 0.5 });

    expect(updated?.thresholds).toEqual({ minChars: 40, maxRatio: 0.5 });
    expect(engine.getRuleSource('tuned-rule')).toBe(TUNABLE.replace('minChars: 30', 'minChars: 40').replace('maxRatio: 0.3', 'maxRatio: 0.5'));
  });

  it.each([
    ['personal', (source: string) => engine.registerPersonalRuleSource('tuned-rule', source, '/home/rules/tuned-rule.md'), '/home/rules/tuned-rule.md'],
    ['project', (source: string) => engine.registerProjectRuleSource('tuned-rule', source, '/repo/rules/tuned-rule.md'), '/repo/rules/tuned-rule.md'],
  ])('the layer and file of a %s rule are kept', (layer, register, filePath) => {
    register(TUNABLE);

    expect(engine.updateRuleThresholds('tuned-rule', { minChars: 40 })).toMatchObject({ source: layer, sourceFilePath: filePath });
  });

  it('fields that are not in the markdown are kept', () => {
    engine.setUserRule({ ...parseRule(TUNABLE)!, source: 'personal', sourceFilePath: '/home/rules/tuned-rule.md', maxExamples: 7 });

    expect(engine.updateRuleThresholds('tuned-rule', { minChars: 40 }))
      .toMatchObject({ source: 'personal', sourceFilePath: '/home/rules/tuned-rule.md', maxExamples: 7 });
  });

  it('a rule built in code without markdown is still serialized', () => {
    const rule = { ...parseRule(TUNABLE)!, rawSource: '' };
    engine.setUserRule(rule);

    const updated = engine.updateRuleThresholds('tuned-rule', { minChars: 40 });

    expect(updated?.thresholds).toEqual({ minChars: 40, maxRatio: 0.3 });
    expect(updated?.rawSource).toBe(serializeRule({ ...rule, thresholds: { minChars: 40, maxRatio: 0.3 }, rawSource: '' }));
  });
});
