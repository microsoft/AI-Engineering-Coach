/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* A rule whose detection logic doesn't parse is reported as not evaluated without stopping the others; a built-in rule
 * never is. */

import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Analyzer } from './analyzer';
import { detectAntiPatterns, invalidateDetectorRegistry, runDetectors, runEmitters } from './detector-registry';
import { createRequest, createSession } from './parser-shared';
import { clearLayerRules, createRuleFromMarkdown, getRule, registerPersonalRuleSource, removeUserRule } from './rule-engine';
import { executePipeline, parsePipeline, resolveInheritance } from './rule-pipeline';
import { runtimeDebug } from './runtime-debug';
import type { RuleFailure, RuleSeverity } from './types';

// Keeps the skipped rules out of the developer's runtime.log; the log-once test reads the calls instead.
vi.mock('./runtime-debug', async importOriginal => ({ ...await importOriginal<typeof import('./runtime-debug')>(), runtimeDebug: vi.fn() }));

const BUILT_IN_IDS = fs.readdirSync(path.join(__dirname, 'rules')).filter(file => file.endsWith('.md')).map(file => file.slice(0, -3));

/** A personal rule that flags each request matching `match`. */
function requestRule(id: string, match: string, severity: RuleSeverity = 'low'): string {
  return [
    '---', `id: ${id}`, `name: ${id}`, 'group: prompt-quality', `severity: ${severity}`, 'scope: requests', '---', '',
    '# Description', 'A test rule.', '', '# Detection Logic', '```detect', 'scan: requests', `match: ${match}`, 'check: count > 0', '```', '',
  ].join('\n');
}

const WORKING = requestRule('every-request', 'messageLength > 0');
const BROKEN = requestRule('broken-rule', '(');
const ALL_PASSING = 'All checks passing -- no anti-patterns detected.';

/** The only failure is the broken rule's, by id, name and group, with its parse error. */
function expectOnlyBrokenRule(failures: RuleFailure[] | undefined): void {
  expect(failures?.map(({ error: _error, ...rule }) => rule)).toEqual([{ ruleId: 'broken-rule', ruleName: 'broken-rule', group: 'prompt-quality' }]);
  expect(failures?.[0].error).toMatch(/^Parse error at position \d+/);
}

const reqs = Array.from({ length: 6 }, (_, i) => createRequest({
  requestId: `r${i}`, messageText: i % 2 ? 'fix it' : 'Explain why the parser drops the last token.', responseText: 'Done.',
  timestamp: Date.UTC(2026, 9, 1 + i, 12),
}));
const sessions = [createSession({ sessionId: 's1', workspaceId: 'ws', workspaceName: 'Project', harness: 'Local Agent', requests: reqs })];

describe('built-in rules', () => {
  it.each(BUILT_IN_IDS)('%s runs on sample data without throwing', id => {
    const rule = resolveInheritance(getRule(id)!);
    expect(() => executePipeline(parsePipeline(rule), rule, { reqs, sessions, skipIdeDetectors: false })).not.toThrow();
  });

  it('all emit, so none of them is skipped', () => {
    expect([...runEmitters(reqs, sessions, false).keys()]).toEqual(expect.arrayContaining(BUILT_IN_IDS));
  });

  it('are all evaluated, so none of them is reported as failed', () => {
    expect(detectAntiPatterns(reqs, sessions, false).failures).toEqual([]);
  });
});

function removeTestRules(): void {
  clearLayerRules('personal');
  removeUserRule('broken-rule');
  invalidateDetectorRegistry();
  vi.mocked(runtimeDebug).mockClear();
}

function addRules(): void {
  registerPersonalRuleSource('every-request', WORKING, '/home/rules/every-request.md');
  registerPersonalRuleSource('broken-rule', BROKEN, '/home/rules/broken-rule.md');
}

describe('a personal rule whose detection logic does not parse', () => {
  afterEach(removeTestRules);

  it('is reported as not evaluated, with its error, while the other rules still run', () => {
    addRules();
    const { patterns, failures } = detectAntiPatterns(reqs, sessions, false);
    expectOnlyBrokenRule(failures);
    expect(patterns.map(pattern => pattern.id)).toContain('every-request');
    expect(patterns.map(pattern => pattern.id)).not.toContain('broken-rule');
    expect(runDetectors(reqs, sessions, false)).toEqual(patterns);
  });

  it('is left out of runEmitters, which still emits every other rule', () => {
    addRules();
    const emissions = runEmitters(reqs, sessions, false);
    expect(emissions.has('broken-rule')).toBe(false);
    expect(emissions.get('every-request')?.count).toBe(reqs.length);
    expect([...emissions.keys()]).toEqual(expect.arrayContaining(BUILT_IN_IDS));
  });

  it('saved from the Rule Editor (in memory) does not stop the other rules', () => {
    registerPersonalRuleSource('every-request', WORKING, '/home/rules/every-request.md');
    createRuleFromMarkdown(BROKEN);
    const { patterns, failures } = detectAntiPatterns(reqs, sessions, false);
    expect(patterns.map(pattern => pattern.id)).toContain('every-request');
    expectOnlyBrokenRule(failures);
  });

  it('goes to the Output log once per rule and message, and again after the registry is invalidated', () => {
    const skipped = () => vi.mocked(runtimeDebug).mock.calls.filter(([scope, message, detail]) =>
      scope === 'detectors' && message === 'rule-skipped' && typeof detail === 'string' && detail.startsWith('broken-rule: Parse error'));
    addRules();

    runEmitters(reqs, sessions, false);
    runEmitters(reqs, sessions, false);
    runDetectors(reqs, sessions, false);
    expect(skipped()).toHaveLength(1);

    invalidateDetectorRegistry();
    runEmitters(reqs, sessions, false);
    expect(skipped()).toHaveLength(2);
  });
});

describe('the Anti-Patterns analysis with a personal rule whose detection logic does not parse', () => {
  afterEach(removeTestRules);

  it('reports the rule and its group as incomplete, while the other rules still run', () => {
    addRules();
    const analyzer = new Analyzer(sessions, new Map());
    const data = analyzer.getAntiPatterns({ harness: 'Local Agent' });
    expect(data.patterns.map(pattern => pattern.id)).toContain('every-request');
    expectOnlyBrokenRule(data.failedRules);
    expectOnlyBrokenRule(data.groupScores.find(score => score.group === 'prompt-quality')?.failedRules);
    expect(data.groupScores.filter(score => score.group !== 'prompt-quality').every(score => score.failedRules.length === 0)).toBe(true);
  });

  it('with one request and a high severity, leaves Prompt Quality incomplete instead of claiming all checks pass', () => {
    registerPersonalRuleSource('broken-rule', requestRule('broken-rule', '(', 'high'), '/home/rules/broken-rule.md');
    const one = reqs.slice(0, 1);
    const analyzer = new Analyzer([createSession({ sessionId: 's1', workspaceId: 'ws', workspaceName: 'Project', harness: 'Local Agent', requests: one })], new Map());
    const data = analyzer.getAntiPatterns({ harness: 'Local Agent' });
    const promptQuality = data.groupScores.find(score => score.group === 'prompt-quality')!;
    expect(promptQuality.patternCount).toBe(0);
    expectOnlyBrokenRule(promptQuality.failedRules);
    expect(promptQuality.improvements).not.toContain(ALL_PASSING);
    // The groups whose rules all ran still say so.
    const complete = data.groupScores.filter(score => score.group !== 'prompt-quality' && score.patternCount === 0);
    expect(complete.length).toBeGreaterThan(0);
    for (const score of complete) expect(score.improvements).toContain(ALL_PASSING);
  });

  it('scores a group over the rules that ran, so a rule that fails does not raise the score', () => {
    registerPersonalRuleSource('every-request', requestRule('every-request', 'messageLength > 0', 'high'), '/home/rules/every-request.md');
    const promptQuality = () => new Analyzer(sessions, new Map()).getAntiPatterns({ harness: 'Local Agent' }).groupScores
      .find(score => score.group === 'prompt-quality')!;
    const before = promptQuality();
    registerPersonalRuleSource('broken-rule', BROKEN, '/home/rules/broken-rule.md');
    const after = promptQuality();
    expect(after.failedRules).toHaveLength(1);
    expect(before.score).toBeLessThan(100);
    expect(after.score).toBe(before.score);
  });
});
