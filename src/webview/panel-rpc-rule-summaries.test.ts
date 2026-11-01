/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import { Analyzer } from '../core/analyzer';
import type { ParseResult } from '../core/cache';
import { invalidateDetectorRegistry } from '../core/detector-registry';
import { createRequest, createSession } from '../core/parser-shared';
import { clearLayerRules, getRule, registerPersonalRuleSource, removeUserRule, setUserRule } from '../core/rule-engine';
import { getRpcHandler } from './panel-rpc';

const RULES_DIR = path.join(__dirname, '..', 'core', 'rules');

/** The text under a rule file's `# Description` heading, read without the rule parser. */
function descriptionOf(markdown: string): string {
  const lines = markdown.replaceAll('\r\n', '\n').split('\n');
  const bodyStart = lines.indexOf('---', 1) + 1;
  const start = lines.findIndex((line, index) => index >= bodyStart && /^#+\s+Description\s*$/.test(line));
  if (start < 0) return '';
  const next = lines.findIndex((line, index) => index > start && /^#+\s/.test(line));
  return lines.slice(start + 1, next < 0 ? undefined : next).join('\n').trim();
}

const builtinDescriptions = new Map(fs.readdirSync(RULES_DIR).filter(file => file.endsWith('.md')).map(file =>
  [file.replace(/\.md$/, ''), descriptionOf(fs.readFileSync(path.join(RULES_DIR, file), 'utf-8'))] as const));

/** Rules whose list summary read "... of ..." or ".../..." (#353), plus context-engineering-gaps ("... of 5"). */
const BLANKED_RULES = [
  'high-cancellation', 'no-slash-commands', 'no-spec-driven-development', 'no-spec-structure', 'reasoning-effort-overuse',
  'yolo-mode', 'broken-flow-state', 'low-constraint-usage', 'no-custom-instructions', 'tunnel-vision', 'context-engineering-gaps',
];

// One VS Code session of 20 requests, 6 of them cancelled: high-cancellation fires (30% > 15%).
const requests = Array.from({ length: 20 }, (_, index) => createRequest({
  requestId: `r${index}`, timestamp: Date.parse('2026-09-30T12:00:00Z') + index * 60_000,
  messageText: 'Refactor the parser into smaller modules', responseText: 'Done.', isCanceled: index < 6,
}));
const sessions = [createSession({ sessionId: 's', workspaceId: 'ws', workspaceName: 'Project', harness: 'Local Agent', requests })];
const analyzer = new Analyzer(sessions, new Map());
const parsed: ParseResult = { sessions, workspaces: new Map(), editLocIndex: new Map(), sessionSourceIndex: new Map() };

interface RuleEditorData {
  rules: Array<{ id: string; source: string; description: string; descriptionTemplate: string }>;
  previews: Array<{ ruleId: string; triggered: boolean; previewDescription: string }>;
}
const call = (method: string): unknown => getRpcHandler(method)!(analyzer, parsed, {});
const ruleEditor = () => call('getRuleEditor') as RuleEditorData;
const summaryOf = (id: string) => ruleEditor().rules.find(rule => rule.id === id)?.description;
/** A summary as the oracle reads it: rule files have CRLF line endings in Windows checkouts. */
const lf = (text: string | undefined) => text?.replaceAll('\r\n', '\n');
const dots = (text: string) => text.split('...').length - 1;

// detector-registry loads ~/.ai-engineer-coach/rules when it's imported, and the fallback tests add rules of their own:
// every test starts with the built-in rules only.
beforeEach(() => {
  clearLayerRules('personal');
  removeUserRule('empty-description');
  invalidateDetectorRegistry();
});

describe('Rules list summaries', () => {
  it('summarizes the rules whose numbers were blanked with their Description', () => {
    const rules = ruleEditor().rules;
    for (const id of BLANKED_RULES) {
      const rule = rules.find(candidate => candidate.id === id);
      expect(rule?.descriptionTemplate, id).toMatch(/\{\{\w+(?:\.\w+)*\}\}/);
      expect(lf(rule?.description), id).toBe(builtinDescriptions.get(id));
      expect(rule?.description, id).not.toContain('...');
    }
  });

  it('summarizes every built-in rule with its whole Description, ending at a sentence', () => {
    const builtins = ruleEditor().rules.filter(rule => rule.source === 'built-in');
    expect(builtins.map(rule => rule.id).sort()).toEqual([...builtinDescriptions.keys()].sort());
    const problems = builtins.flatMap(({ id, description }) => {
      const source = builtinDescriptions.get(id) ?? '';
      return [
        lf(description) !== source && `${id}: not its whole Description`,
        /\{\{|\}\}/.test(description) && `${id}: template braces`,
        /\.\.\. of \.\.\.|\.\.\.\/\.\.\./.test(description) && `${id}: blanked numbers`,
        dots(description) > dots(source) && `${id}: "..." that its Description doesn't have`,
        !/[.!?]["')`]?$/.test(description) && `${id}: doesn't end at a sentence end`,
      ].filter(Boolean);
    });
    expect(problems).toEqual([]);
  });

  it('keeps the real numbers in a fired finding and in its Rules preview', () => {
    const finding = '6 of 20 requests cancelled (30%). This wastes premium quota.';
    const { patterns } = call('getAntiPatterns') as { patterns: Array<{ id: string; description: string }> };
    expect(patterns.find(pattern => pattern.id === 'high-cancellation')?.description).toBe(finding);
    expect(ruleEditor().previews.find(preview => preview.ruleId === 'high-cancellation'))
      .toMatchObject({ triggered: true, previewDescription: finding });
  });
});

describe('Rules list summary fallback', () => {
  const personalRule = (id: string, description?: string) => [
    '---', `id: ${id}`, 'name: Long Sessions', 'group: session-hygiene', 'severity: medium', 'scope: sessions', '---', '',
    ...(description === undefined ? [] : ['# Description', description, '']),
    '# When Triggered', '{{count}} of {{total}} sessions are long.', '',
    '# Detection Logic', '```detect', 'scan: sessions', 'match: requestCount > 50', 'check: count >= 1', '```',
  ].join('\n');

  it('shows the default text for a personal rule without a Description', () => {
    registerPersonalRuleSource('no-description', personalRule('no-description'), '/home/rules/no-description.md');
    expect(summaryOf('no-description')).toBe('Detects long sessions patterns.');
  });

  it('never shows a placeholder written into a Description', () => {
    const description = 'Flags the {{count}} sessions over {{thresholds.maxRequests}} requests.';
    registerPersonalRuleSource('templated', personalRule('templated', description), '/home/rules/templated.md');
    expect(summaryOf('templated')).toBe('Detects long sessions patterns.');
  });

  it('shows the default text for a rule whose Description is empty', () => {
    setUserRule({ ...getRule('high-cancellation')!, id: 'empty-description', name: 'Empty Description', description: '' });
    expect(summaryOf('empty-description')).toBe('Detects empty description patterns.');
  });
});
