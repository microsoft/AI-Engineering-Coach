/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest';
import { createRuleFromMarkdown, removeUserRule } from './rule-engine';
import { checkPipelineTrigger, executePipeline, parsePipeline, resolveInheritance } from './rule-pipeline';
import type { DetectionRule, SessionRequest } from './types';

function makeRule(rawSource: string): DetectionRule {
  return {
    id: 'pipeline-test',
    name: 'Pipeline Test',
    group: 'prompt-quality',
    severity: 'medium',
    requiresIdeContext: false,
    scope: 'requests',
    description: 'Rule for pipeline tests',
    descriptionTemplate: '{{count}} of {{total}} requests matched',
    suggestionTemplate: 'Improve',
    exampleTemplate: '{{messageText}}',
    maxExamples: 3,
    conditions: [],
    thresholds: {},
    patterns: {},
    fileTypes: {},
    tests: [],
    source: 'built-in',
    sourceFilePath: '',
    version: 1,
    tags: [],
    rawSource,
  };
}

const reqs = [{ messageText: 'a' }, { messageText: 'b' }] as unknown as SessionRequest[];

function ruleTriggers(rule: DetectionRule): boolean {
  const emission = executePipeline(parsePipeline(rule), rule, { reqs, sessions: [], skipIdeDetectors: false });
  return checkPipelineTrigger(parsePipeline(rule), emission, rule);
}

function triggers(rawSource: string): boolean {
  return ruleTriggers(makeRule(rawSource));
}

describe('rule pipeline without detection logic', () => {
  it('never triggers when the rule has no detect block', () => {
    expect(triggers('# Filter\nmessageLength < 0')).toBe(false);
  });

  it('never triggers when the detect block has neither match: nor check:', () => {
    expect(triggers('```detect\nscan: requests\n```')).toBe(false);
    expect(triggers('```detect\n```')).toBe(false);
  });

  it('still triggers with match: only', () => {
    expect(triggers('```detect\nmatch: messageText == "a"\n```')).toBe(true);
  });

  it('still evaluates check:-only rules over every row', () => {
    expect(triggers('```detect\ncheck: count >= 2\n```')).toBe(true);
  });
});

const created: string[] = [];

function personalRule(id: string, frontMatter: string[], body: string[] = []): DetectionRule {
  created.push(id);
  return createRuleFromMarkdown([
    '---', `id: ${id}`, `name: ${id}`, 'group: prompt-quality', 'severity: low', 'scope: requests', ...frontMatter, '---', '',
    '# Description', 'A test rule.', '', ...body, '',
  ].join('\n'))!;
}

function detect(match: string, check = 'count > 0'): string[] {
  return ['# Detection Logic', '```detect', 'scan: requests', `match: ${match}`, `check: ${check}`, '```'];
}

describe('extends: inheritance of detection logic', () => {
  afterEach(() => created.splice(0).forEach(removeUserRule));

  it('runs the parent\'s detect block for a child without one', () => {
    personalRule('parent', [], detect('messageText == "a"'));
    const child = personalRule('child', ['extends: parent']);
    expect(ruleTriggers(resolveInheritance(child))).toBe(true);
  });

  it('inherits through several levels', () => {
    personalRule('grandparent', [], detect('messageText == "a"'));
    personalRule('parent', ['extends: grandparent']);
    const child = personalRule('child', ['extends: parent']);
    expect(ruleTriggers(resolveInheritance(child))).toBe(true);
  });

  it('evaluates the inherited block with the child\'s thresholds', () => {
    personalRule('parent', ['thresholds:', '  min: 5'], detect('messageText == "a"', 'count > thresholds.min'));
    const child = personalRule('child', ['extends: parent', 'thresholds:', '  min: 0']);
    expect(ruleTriggers(resolveInheritance(child))).toBe(true);
  });

  it('keeps the child\'s own detect block', () => {
    personalRule('parent', [], detect('messageText == "a"'));
    const child = personalRule('child', ['extends: parent'], detect('messageText == "z"'));
    expect(ruleTriggers(resolveInheritance(child))).toBe(false);
  });

  it('keeps the child\'s own inline tests', () => {
    personalRule('parent', [], [...detect('messageText == "a"'), '', '# Tests', '```test', '{messageText: "a"} -> triggered', '```']);
    const child = personalRule('child', ['extends: parent'], ['# Tests', '```test', '{messageText: "b"} -> clean', '```']);
    expect(resolveInheritance(child).tests).toEqual([{ input: { messageText: 'b' }, expect: 'clean' }]);
  });

  it('never triggers when the parent is missing', () => {
    const child = personalRule('child', ['extends: missing-parent']);
    expect(ruleTriggers(resolveInheritance(child))).toBe(false);
  });
});
