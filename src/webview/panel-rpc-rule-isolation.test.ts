/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* The rule list and previews keep loading when a personal rule's detection logic doesn't parse; Test Rule shows why. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Analyzer } from '../core/analyzer';
import type { ParseResult } from '../core/cache';
import { invalidateDetectorRegistry } from '../core/detector-registry';
import { createRequest, createSession } from '../core/parser-shared';
import { clearLayerRules, registerPersonalRuleSource } from '../core/rule-engine';
import { getRpcHandler } from './panel-rpc';

// Keeps the skipped rule out of the developer's runtime.log.
vi.mock('../core/runtime-debug', async importOriginal => ({ ...await importOriginal<typeof import('../core/runtime-debug')>(), runtimeDebug: vi.fn() }));

interface Preview { ruleId: string; triggered: boolean; occurrences: number; total: number }

/** A personal rule that flags each request matching `match`. */
function requestRule(id: string, match: string): string {
  return [
    '---', `id: ${id}`, `name: ${id}`, 'group: prompt-quality', 'severity: low', 'scope: requests', '---', '',
    '# Description', 'A test rule.', '', '# Detection Logic', '```detect', 'scan: requests', `match: ${match}`, 'check: count > 0', '```', '',
  ].join('\n');
}

const BROKEN = requestRule('broken-rule', '(');

const requests = Array.from({ length: 6 }, (_, i) => createRequest({
  requestId: `r${i}`, messageText: i % 2 ? 'fix it' : 'Explain why the parser drops the last token.', responseText: 'Done.',
  timestamp: Date.UTC(2026, 9, 1 + i, 12),
}));
const sessions = [createSession({ sessionId: 's1', workspaceId: 'ws', workspaceName: 'Project', harness: 'Local Agent', requests })];
const parsed: ParseResult = { sessions, workspaces: new Map(), editLocIndex: new Map(), sessionSourceIndex: new Map() };
const analyzer = new Analyzer(sessions, parsed.editLocIndex);
const call = <T>(method: string, params: Record<string, unknown>): T => getRpcHandler(method)!(analyzer, parsed, params) as T;

describe('rule RPCs with a personal rule whose detection logic does not parse', () => {
  afterEach(() => {
    clearLayerRules('personal');
    invalidateDetectorRegistry();
  });

  function addRules(): void {
    registerPersonalRuleSource('every-request', requestRule('every-request', 'messageLength > 0'), '/home/rules/every-request.md');
    registerPersonalRuleSource('broken-rule', BROKEN, '/home/rules/broken-rule.md');
  }

  it('getRuleEditor lists every rule and shows the broken one as not triggered', () => {
    addRules();
    const { rules, previews } = call<{ rules: Array<{ id: string }>; previews: Preview[] }>('getRuleEditor', {});
    expect(rules.map(rule => rule.id)).toEqual(expect.arrayContaining(['every-request', 'broken-rule', 'lazy-prompting']));
    expect(previews.find(p => p.ruleId === 'every-request')).toMatchObject({ triggered: true, occurrences: 6, total: 6 });
    expect(previews.find(p => p.ruleId === 'broken-rule')).toMatchObject({ triggered: false, occurrences: 0 });
  });

  it('getRulePreview answers for the other rules and for the broken one', () => {
    addRules();
    expect(call<Preview>('getRulePreview', { ruleId: 'every-request' })).toMatchObject({ triggered: true, occurrences: 6 });
    expect(call<Preview>('getRulePreview', { ruleId: 'broken-rule' })).toMatchObject({ triggered: false, occurrences: 0 });
  });

  it('Test Rule still reports the parse error', () => {
    const result = call<{ ok: boolean; error?: string }>('testRuleLive', { markdown: BROKEN });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/^Parse error at position \d+/);
  });
});
