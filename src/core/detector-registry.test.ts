/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* A rule whose detection logic doesn't parse is skipped without stopping the others; a built-in rule never is. */

import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { Analyzer } from './analyzer';
import { invalidateDetectorRegistry, runDetectors, runEmitters } from './detector-registry';
import { createRequest, createSession } from './parser-shared';
import { clearLayerRules, createRuleFromMarkdown, getRule, registerPersonalRuleSource, removeUserRule } from './rule-engine';
import { executePipeline, parsePipeline, resolveInheritance } from './rule-pipeline';
import { setOutputHook } from './runtime-debug';

const BUILT_IN_IDS = fs.readdirSync(path.join(__dirname, 'rules')).filter(file => file.endsWith('.md')).map(file => file.slice(0, -3));

/** A personal rule that flags each request matching `match`. */
function requestRule(id: string, match: string): string {
  return [
    '---', `id: ${id}`, `name: ${id}`, 'group: prompt-quality', 'severity: low', 'scope: requests', '---', '',
    '# Description', 'A test rule.', '', '# Detection Logic', '```detect', 'scan: requests', `match: ${match}`, 'check: count > 0', '```', '',
  ].join('\n');
}

const WORKING = requestRule('every-request', 'messageLength > 0');
const BROKEN = requestRule('broken-rule', '(');

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
});

describe('a personal rule whose detection logic does not parse', () => {
  afterEach(() => {
    clearLayerRules('personal');
    removeUserRule('broken-rule');
    invalidateDetectorRegistry();
    setOutputHook(null);
  });

  function addRules(): void {
    registerPersonalRuleSource('every-request', WORKING, '/home/rules/every-request.md');
    registerPersonalRuleSource('broken-rule', BROKEN, '/home/rules/broken-rule.md');
  }

  it('does not stop runDetectors for the other rules', () => {
    addRules();
    const ids = runDetectors(reqs, sessions, false).map(pattern => pattern.id);
    expect(ids).toContain('every-request');
    expect(ids).not.toContain('broken-rule');
  });

  it('is left out of runEmitters, which still emits every other rule', () => {
    addRules();
    const emissions = runEmitters(reqs, sessions, false);
    expect(emissions.has('broken-rule')).toBe(false);
    expect(emissions.get('every-request')?.count).toBe(reqs.length);
    expect([...emissions.keys()]).toEqual(expect.arrayContaining(BUILT_IN_IDS));
  });

  it('does not stop the Anti-Patterns analysis for a filter', () => {
    addRules();
    const analyzer = new Analyzer(sessions, new Map());
    expect(analyzer.getAntiPatterns({ harness: 'Local Agent' }).patterns.map(pattern => pattern.id)).toContain('every-request');
  });

  it('saved from the Rule Editor (in memory) does not stop the other rules', () => {
    registerPersonalRuleSource('every-request', WORKING, '/home/rules/every-request.md');
    createRuleFromMarkdown(BROKEN);
    expect(runDetectors(reqs, sessions, false).map(pattern => pattern.id)).toContain('every-request');
  });

  it('goes to the Output log once per rule and message, and again after the registry is invalidated', () => {
    const output: string[] = [];
    setOutputHook(line => output.push(line));
    const skipped = () => output.filter(line => line.includes('[detectors] rule-skipped') && line.includes('broken-rule: Parse error'));
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
