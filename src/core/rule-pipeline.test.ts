/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { checkPipelineTrigger, executePipeline, parsePipeline } from './rule-pipeline';
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

function triggers(rawSource: string): boolean {
  const rule = makeRule(rawSource);
  const emission = executePipeline(parsePipeline(rule), rule, { reqs, sessions: [], skipIdeDetectors: false });
  return checkPipelineTrigger(parsePipeline(rule), emission, rule);
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
