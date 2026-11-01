/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* The rule list, previews and analysis keep loading when a personal rule's detection logic doesn't parse: the broken
 * rule shows as not evaluated, its group's score as incomplete, and Test Rule shows why. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Analyzer } from '../core/analyzer';
import type { ParseResult } from '../core/cache';
import { invalidateDetectorRegistry } from '../core/detector-registry';
import { createRequest, createSession } from '../core/parser-shared';
import { clearLayerRules, registerPersonalRuleSource } from '../core/rule-engine';
import type { AntiPatternData } from '../core/types';
import { getRpcHandler } from './panel-rpc';

// Keeps the skipped rule out of the developer's runtime.log.
vi.mock('../core/runtime-debug', async importOriginal => ({ ...await importOriginal<typeof import('../core/runtime-debug')>(), runtimeDebug: vi.fn() }));

interface Preview { ruleId: string; triggered: boolean; occurrences: number; total: number; previewDescription: string; evaluationError?: string }

/** A personal rule that flags each request matching `match`. */
function requestRule(id: string, match: string, severity = 'low'): string {
  return [
    '---', `id: ${id}`, `name: ${id}`, 'group: prompt-quality', `severity: ${severity}`, 'scope: requests', '---', '',
    '# Description', 'A test rule.', '', '# Detection Logic', '```detect', 'scan: requests', `match: ${match}`, 'check: count > 0', '```', '',
  ].join('\n');
}

const BROKEN = requestRule('broken-rule', '(');
const PARSE_ERROR = /^Parse error at position \d+/;

/** The broken rule's preview: not evaluated, with its parse error, instead of a clean result. */
function expectNotEvaluated(preview: Preview | undefined): void {
  expect(preview?.triggered).toBe(false);
  expect(preview?.evaluationError).toMatch(PARSE_ERROR);
  expect(preview?.previewDescription).toBe(`Not evaluated: ${preview?.evaluationError}`);
  // An RPC result with an `error` is a failed call: the webview would reject the preview instead of showing it.
  expect(preview).not.toHaveProperty('error');
}

const requests = Array.from({ length: 6 }, (_, i) => createRequest({
  requestId: `r${i}`, messageText: i % 2 ? 'fix it' : 'Explain why the parser drops the last token.', responseText: 'Done.',
  timestamp: Date.UTC(2026, 9, 1 + i, 12),
}));
const sessions = [createSession({ sessionId: 's1', workspaceId: 'ws', workspaceName: 'Project', harness: 'Local Agent', requests })];
const parsed: ParseResult = { sessions, workspaces: new Map(), editLocIndex: new Map(), sessionSourceIndex: new Map() };
const analyzer = new Analyzer(sessions, parsed.editLocIndex);
const call = <T>(method: string, params: Record<string, unknown>, on = analyzer): T => getRpcHandler(method)!(on, parsed, params) as T;

describe('rule RPCs with a personal rule whose detection logic does not parse', () => {
  afterEach(() => {
    clearLayerRules('personal');
    invalidateDetectorRegistry();
  });

  function addRules(): void {
    registerPersonalRuleSource('every-request', requestRule('every-request', 'messageLength > 0'), '/home/rules/every-request.md');
    registerPersonalRuleSource('broken-rule', BROKEN, '/home/rules/broken-rule.md');
  }

  it('getRuleEditor lists every rule, runs the others and shows the broken one as not evaluated', () => {
    addRules();
    const { rules, previews } = call<{ rules: Array<{ id: string }>; previews: Preview[] }>('getRuleEditor', {});
    expect(rules.map(rule => rule.id)).toEqual(expect.arrayContaining(['every-request', 'broken-rule', 'lazy-prompting']));
    expect(previews.find(p => p.ruleId === 'every-request')).toMatchObject({ triggered: true, occurrences: 6, total: 6 });
    expectNotEvaluated(previews.find(p => p.ruleId === 'broken-rule'));
    expect(previews.filter(p => p.evaluationError !== undefined).map(p => p.ruleId)).toEqual(['broken-rule']);
  });

  it('getRulePreview answers for the other rules and shows the broken one as not evaluated', () => {
    addRules();
    expect(call<Preview>('getRulePreview', { ruleId: 'every-request' })).toMatchObject({ triggered: true, occurrences: 6 });
    expect(call<Preview>('getRulePreview', { ruleId: 'every-request' }).evaluationError).toBeUndefined();
    expectNotEvaluated(call<Preview>('getRulePreview', { ruleId: 'broken-rule' }));
  });

  it('with one request and a high severity, neither previews it as clean nor scores Prompt Quality as all passing', () => {
    registerPersonalRuleSource('broken-rule', requestRule('broken-rule', '(', 'high'), '/home/rules/broken-rule.md');
    const one = new Analyzer([createSession({ sessionId: 's1', workspaceId: 'ws', workspaceName: 'Project', harness: 'Local Agent', requests: requests.slice(0, 1) })], new Map());
    const preview = call<Preview>('getRulePreview', { ruleId: 'broken-rule' }, one);
    expectNotEvaluated(preview);
    expect(preview.total).toBe(1);
    const data = call<AntiPatternData>('getAntiPatterns', { harness: 'Local Agent' }, one);
    const promptQuality = data.groupScores.find(score => score.group === 'prompt-quality');
    expect(promptQuality?.patternCount).toBe(0);
    expect(promptQuality?.failedRules.map(rule => rule.ruleId)).toEqual(['broken-rule']);
    expect(promptQuality?.failedRules[0].error).toMatch(PARSE_ERROR);
    expect(promptQuality?.improvements).not.toContain('All checks passing -- no anti-patterns detected.');
    expect(data.failedRules.map(rule => rule.ruleId)).toEqual(['broken-rule']);
  });

  it('Test Rule still reports the parse error', () => {
    const result = call<{ ok: boolean; error?: string }>('testRuleLive', { markdown: BROKEN });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(PARSE_ERROR);
  });
});
