/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Runs every built-in rule's inline `# Tests` block through the detector pipeline. */

import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect } from 'vitest';
import { parseRule } from './rule-parser';
import { runInlineTests, RULE_TEST_ROWS, type InlineTestResult } from './rule-inline-tests';
import type { DetectionRule } from './types';

const RULES_DIR = path.join(__dirname, 'rules');

interface RuleFile {
  source: string;
  rule: DetectionRule;
}

function parseOrThrow(source: string, label: string): DetectionRule {
  const rule = parseRule(source);
  if (!rule) throw new Error(`${label} doesn't parse`);
  return rule;
}

const ruleFiles: RuleFile[] = fs.readdirSync(RULES_DIR)
  .filter(file => file.endsWith('.md'))
  .sort()
  .map(file => {
    const source = fs.readFileSync(path.join(RULES_DIR, file), 'utf-8');
    return { source, rule: parseOrThrow(source, file) };
  });
const withTests = ruleFiles.filter(({ source }) => /^#\s+Tests\s*$/m.test(source));

/** Non-blank lines of the ```test block, as authored. */
function testBlockLines(source: string): string[] {
  const block = source.match(/```test\s*\n([\s\S]*?)```/);
  return block ? block[1].split('\n').map(line => line.trim()).filter(Boolean) : [];
}

/** The rule with its `check:` line, and any continuation lines, replaced. */
function withCheck(source: string, check: string): DetectionRule {
  return parseOrThrow(source.replace(/^check:(?:.*\\\r?\n)*.*$/m, `check: ${check}`), 'mutated rule');
}

function failures(results: InlineTestResult[]): number[] {
  return results.filter(result => !result.passed).map(result => result.line);
}

describe('built-in rule # Tests blocks', () => {
  it('finds every rule that ships a block', () => {
    expect(withTests.map(({ rule }) => rule.id)).toEqual(expect.arrayContaining([
      'agent-mode-for-asks', 'context-engineering-gaps', 'frustration-signals', 'lazy-prompting',
      'no-custom-instructions', 'no-plan-mode', 'verbose-output',
    ]));
  });

  describe.each(withTests)('$rule.id', ({ source, rule }) => {
    let results: InlineTestResult[] | undefined;
    const resultAt = (index: number) => (results ??= runInlineTests(rule))[index];

    it('parses every line of its block', () => {
      expect(rule.tests.length).toBeGreaterThan(0);
      expect(rule.tests).toHaveLength(testBlockLines(source).length);
    });

    it.each(rule.tests.map((test, index) => ({ index, label: `${JSON.stringify(test.input)} -> ${test.expect}` })))(
      '$label',
      ({ index }) => {
        const result = resultAt(index);
        expect(result.actual).toBe(result.expected);
      },
    );

    it('fails when its check is broken', () => {
      const triggered = rule.tests.flatMap((test, index) => test.expect === 'triggered' ? [index + 1] : []);
      const clean = rule.tests.flatMap((test, index) => test.expect === 'clean' ? [index + 1] : []);
      expect(failures(runInlineTests(withCheck(source, 'false')))).toEqual(triggered);
      expect(failures(runInlineTests(withCheck(source, 'true')))).toEqual(clean);
    });
  });
});

describe('runInlineTests', () => {
  function rule(scan: 'requests' | 'sessions', match: string, check: string, tests: string[]): DetectionRule {
    return parseOrThrow([
      '---', 'id: inline-test-probe', 'name: Inline Test Probe', 'group: prompt-quality', 'severity: low', `scope: ${scan}`, '---',
      '', '# Detection Logic', '```detect', `scan: ${scan}`, `match: ${match}`, 'aggregate: count', `check: ${check}`, '```',
      '', '# Tests', '```test', ...tests, '```', '',
    ].join('\n'), 'probe rule');
  }

  it(`repeats each line ${RULE_TEST_ROWS} times, each copy in its own session`, () => {
    const probe = rule('sessions', 'requestCount == 1', `count == ${RULE_TEST_ROWS} AND total == ${RULE_TEST_ROWS}`, [
      '{messageText: "fix bug"} -> triggered',
    ]);
    expect(failures(runInlineTests(probe))).toEqual([]);
  });

  it('puts harness on the session and exposes it on request rows, defaulting to Local Agent', () => {
    const requests = rule('requests', 'harness == "Claude"', 'count > 0', [
      '{harness: "Claude"} -> triggered',
      '{} -> clean',
    ]);
    const sessions = rule('sessions', 'harness == "Local Agent"', 'count > 0', [
      '{} -> triggered',
      '{harness: "Codex"} -> clean',
    ]);
    expect(failures(runInlineTests(requests))).toEqual([]);
    expect(failures(runInlineTests(sessions))).toEqual([]);
  });

  it('lets a line override the fields createRequest derives', () => {
    const probe = rule('requests', 'messageLength == 25 AND workType == "feature"', 'count > 0', [
      '{messageText: "fix bug", messageLength: 25, workType: "feature"} -> triggered',
      '{messageText: "fix bug"} -> clean',
    ]);
    expect(failures(runInlineTests(probe))).toEqual([]);
  });
});
