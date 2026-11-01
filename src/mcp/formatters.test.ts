/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* The MCP summaries name the rules that couldn't be evaluated, so a chat doesn't read their groups as complete. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Analyzer } from '../core/analyzer';
import { invalidateDetectorRegistry } from '../core/detector-registry';
import { createRequest, createSession } from '../core/parser-shared';
import { clearLayerRules, registerPersonalRuleSource } from '../core/rule-engine';
import { formatPatterns, formatSummary } from './formatters';

// Keeps the broken rule out of the developer's runtime.log.
vi.mock('../core/runtime-debug', async importOriginal => ({ ...await importOriginal<typeof import('../core/runtime-debug')>(), runtimeDebug: vi.fn() }));

const BROKEN = [
  '---', 'id: broken-rule', 'name: Broken Rule', 'group: prompt-quality', 'severity: high', 'scope: requests', '---', '',
  '# Description', 'A test rule.', '', '# Detection Logic', '```detect', 'scan: requests', 'match: (', 'check: count > 0', '```', '',
].join('\n');

const requests = [createRequest({ requestId: 'r0', messageText: 'Explain why the parser drops the last token.', responseText: 'Done.', timestamp: Date.UTC(2026, 9, 1, 12) })];
const analyzer = new Analyzer([createSession({ sessionId: 's1', workspaceId: 'ws', workspaceName: 'Project', harness: 'Local Agent', requests })], new Map());
const filter = { harness: 'Local Agent' };

describe('MCP anti-pattern summaries', () => {
  afterEach(() => {
    clearLayerRules('personal');
    invalidateDetectorRegistry();
  });

  it('list a rule that could not be evaluated, with its group and error', () => {
    registerPersonalRuleSource('broken-rule', BROKEN, '/home/rules/broken-rule.md');
    for (const notEvaluated of [formatPatterns(analyzer, filter).antiPatterns.notEvaluated, formatSummary(analyzer, filter).antiPatterns.notEvaluated]) {
      expect(notEvaluated.map(({ rule, group }) => ({ rule, group }))).toEqual([{ rule: 'Broken Rule', group: 'prompt-quality' }]);
      expect(notEvaluated[0].error).toMatch(/^Parse error at position \d+/);
    }
  });

  it('list none when every rule ran', () => {
    expect(formatPatterns(analyzer, filter).antiPatterns.notEvaluated).toEqual([]);
    expect(formatSummary(analyzer, filter).antiPatterns.notEvaluated).toEqual([]);
  });
});
