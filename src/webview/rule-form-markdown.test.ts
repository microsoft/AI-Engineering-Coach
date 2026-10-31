/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseRuleExtensions } from '../core/metric-engine';
import { parseRule } from '../core/rule-parser';
import { mergeRuleMarkdown, normalizeLineEndings, readRuleFields, type RuleFormField, type RuleFormFields } from './rule-form-markdown';

const RULES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'core', 'rules');
const toLf = (md: string) => md.replaceAll('\r\n', '\n');
const toCrlf = (md: string) => toLf(md).replaceAll('\n', '\r\n');

/** Every built-in rule with LF line endings, whatever the checkout uses. */
const BUILT_IN_RULES = readdirSync(RULES_DIR).filter(file => file.endsWith('.md')).sort()
  .map(file => ({ id: file.slice(0, -'.md'.length), lf: toLf(readFileSync(path.join(RULES_DIR, file), 'utf-8')) }));
const BOTH_SCOPE_RULES = ['context-engineering-gaps', 'no-devcontainer'];
const LINE_ENDINGS = [['LF', toLf], ['CRLF', toCrlf]] as const;

function fullFields(md: string): RuleFormFields {
  const fields = readRuleFields(md);
  expect(Object.keys(fields)).toHaveLength(13);
  return fields as RuleFormFields;
}

const allFields = (md: string) => new Set(Object.keys(fullFields(md)) as RuleFormField[]);

/** What the rule parser reads from markdown, without the raw source and with LF line endings. */
function parsedRule(md: string): unknown {
  const rule = parseRule(md);
  expect(rule).not.toBeNull();
  const { rawSource: _rawSource, ...rest } = rule!;
  return JSON.parse(JSON.stringify(rest).replaceAll(String.raw`\r\n`, String.raw`\n`));
}

/** The `# Tests` section, from its heading to the next heading or the end. */
function testsSection(md: string): string {
  return /^# Tests\n[\s\S]*?(?=^#+\s|(?![\s\S]))/m.exec(toLf(md))?.[0] ?? '';
}

const CUSTOM_RULE = [
  '---',
  'id: custom-rule',
  'name: Custom rule',
  '# A comment the form has no field for',
  'group: session-hygiene',
  'severity: low',
  'scope: both',
  'metric: long-sessions',
  'requires: [mega-sessions]',
  'requiresIdeContext: true',
  'version: 3',
  'tags: [a,b]',
  'thresholds:',
  '    maxMessages: 40',
  'patterns:',
  '  words: ["please", "thanks"]',
  '  other: ["x"]',
  'custom:',
  '  nested: value',
  '---',
  '',
  'Text before the first section.',
  '',
  '# Description',
  'Sessions that run long.',
  '',
  '## Background',
  'Kept as its own section.',
  '',
  '# Notes',
  'A section the form has no field for.',
  '',
  '# When Triggered',
  '{{count}} long sessions.',
  '',
  '# How to Improve',
  'Start a new chat.',
  '',
  '# Examples',
  '{{workspaceName}}',
  '',
  '# Detection Logic',
  'The block below is the logic.',
  '```detect',
  'scan: sessions',
  'match: requestCount > thresholds.maxMessages',
  'check: count >= 1',
  '```',
  'Text after the block.',
  '',
  '# Filter',
  'requestCount > 40',
  '',
  '# Test Cases',
  '- input: {"requestCount": 50}',
  '  expect: flagged',
  '',
  '# Tests',
  '```test',
  '{requestCount: 50} -> triggered',
  '```',
  '',
].join('\n');

describe('normalizeLineEndings', () => {
  it('converts CRLF and lone CR line endings to LF', () => {
    expect(normalizeLineEndings('a\r\nb\rc\nd')).toBe('a\nb\nc\nd');
  });
});

describe('readRuleFields', () => {
  it.each(BUILT_IN_RULES)('reads $id with CRLF line endings exactly as with LF', ({ id, lf }) => {
    const fields = fullFields(lf);
    expect(fields.id).toBe(id);
    expect(fields.version).toMatch(/^\d+$/);
    for (const field of ['name', 'group', 'severity', 'scope', 'description', 'whenTriggered', 'howToImprove', 'examples', 'detect'] as const) {
      expect(fields[field], field).not.toBe('');
    }
    expect(readRuleFields(toCrlf(lf))).toEqual(fields);
  });

  it('reads scope: both', () => {
    for (const id of BOTH_SCOPE_RULES) {
      const { lf } = BUILT_IN_RULES.find(rule => rule.id === id)!;
      expect(readRuleFields(toCrlf(lf)).scope).toBe('both');
    }
  });

  it('reads multi-line sections and the detect logic, and only the sections the form shows', () => {
    expect(readRuleFields(toCrlf(CUSTOM_RULE))).toEqual({
      id: 'custom-rule', name: 'Custom rule', group: 'session-hygiene', severity: 'low', scope: 'both', version: '3',
      tags: 'a, b', thresholds: 'maxMessages: 40',
      description: 'Sessions that run long.', whenTriggered: '{{count}} long sessions.', howToImprove: 'Start a new chat.',
      examples: '{{workspaceName}}',
      detect: 'scan: sessions\nmatch: requestCount > thresholds.maxMessages\ncheck: count >= 1',
    });
  });

  it('keeps a detect block out of the text sections', () => {
    const md = '---\nid: x\n---\n# Examples\n"{{message}}"\n```detect\nscan: requests\n```\nmore\n';
    expect(readRuleFields(md)).toMatchObject({ examples: '"{{message}}"\n\nmore', detect: 'scan: requests' });
  });

  it('leaves the front-matter fields out when the markdown has no front matter', () => {
    expect(readRuleFields('# Description\nText')).toEqual({
      description: 'Text', whenTriggered: '', howToImprove: '', examples: '', detect: '',
    });
  });
});

describe('mergeRuleMarkdown with the built-in rules', () => {
  describe.each(LINE_ENDINGS)('every built-in rule with %s line endings', (_name, convert) => {
    it.each(BUILT_IN_RULES)('keeps $id exactly when no field changed', ({ lf }) => {
      const source = convert(lf);
      expect(mergeRuleMarkdown(source, fullFields(source), new Set())).toBe(lf);
    });

    it.each(BUILT_IN_RULES)('rewrites every field of $id without changing what the rule parser reads', ({ lf }) => {
      const source = convert(lf);
      const merged = mergeRuleMarkdown(source, fullFields(source), allFields(source));
      expect(merged).not.toContain('\r');
      expect(parsedRule(merged)).toEqual(parsedRule(source));
      expect(parseRuleExtensions(merged)).toEqual(parseRuleExtensions(lf));
      expect(testsSection(merged)).toBe(testsSection(lf));
    });
  });

  it('keeps the # Tests sections of the built-in rules that have them', () => {
    const withTests = BUILT_IN_RULES.filter(rule => testsSection(rule.lf));
    expect(withTests.length).toBeGreaterThan(0);
    for (const { lf } of withTests) {
      const merged = mergeRuleMarkdown(toCrlf(lf), fullFields(lf), allFields(lf));
      expect(testsSection(merged)).toBe(testsSection(lf));
      expect(parseRule(merged)!.tests).toEqual(parseRule(lf)!.tests);
    }
  });

  it.each(BOTH_SCOPE_RULES)('keeps scope: both in %s when the form writes it', id => {
    const { lf } = BUILT_IN_RULES.find(rule => rule.id === id)!;
    const merged = mergeRuleMarkdown(toCrlf(lf), fullFields(lf), new Set<RuleFormField>(['scope', 'name']));
    expect(merged).toMatch(/^scope: both$/m);
    expect(parseRule(merged)?.scope).toBe('both');
  });
});

describe('mergeRuleMarkdown edits', () => {
  it('writes changed fields in place and keeps everything else, in order', () => {
    const fields = { ...fullFields(CUSTOM_RULE), name: 'Renamed rule', detect: 'scan: sessions\ncheck: count >= 2' };
    const merged = mergeRuleMarkdown(toCrlf(CUSTOM_RULE), fields, new Set<RuleFormField>(['name', 'detect']));
    expect(merged).toBe(CUSTOM_RULE
      .replace('name: Custom rule', 'name: Renamed rule')
      .replace('match: requestCount > thresholds.maxMessages\ncheck: count >= 1', 'check: count >= 2'));
  });

  it('rewrites a whole section and keeps the sections around it', () => {
    const fields = { ...fullFields(CUSTOM_RULE), description: 'Line one.\nLine two.' };
    const merged = mergeRuleMarkdown(CUSTOM_RULE, fields, new Set<RuleFormField>(['description']));
    expect(merged).toBe(CUSTOM_RULE.replace('# Description\nSessions that run long.\n', '# Description\nLine one.\nLine two.\n'));
  });

  it('rewrites the thresholds and tags it shows, and keeps the keys after them', () => {
    const fields = { ...fullFields(CUSTOM_RULE), tags: 'a, c', thresholds: 'maxMessages: 60\nminSessions: 2' };
    const merged = mergeRuleMarkdown(CUSTOM_RULE, fields, new Set<RuleFormField>(['tags', 'thresholds']));
    expect(merged).toBe(CUSTOM_RULE
      .replace('tags: [a,b]', 'tags: [a, c]')
      .replace('thresholds:\n    maxMessages: 40', 'thresholds:\n  maxMessages: 60\n  minSessions: 2'));
  });

  it('never writes an empty scalar, which the rule parser would read as a nested block', () => {
    const merged = mergeRuleMarkdown(CUSTOM_RULE, { ...fullFields(CUSTOM_RULE), scope: '' }, new Set<RuleFormField>(['scope']));
    expect(merged).toBe(CUSTOM_RULE.replace('scope: both\n', ''));
    expect(parseRule(merged)?.scope).toBe('requests');
  });
});

describe('mergeRuleMarkdown additions', () => {
  it('adds a field the rule lacks once it has a value', () => {
    const base = CUSTOM_RULE.replace('scope: both\n', '').replace('# Examples\n{{workspaceName}}\n\n', '');
    const fields = { ...fullFields(base), scope: 'sessions', examples: '{{workspaceName}}' };
    expect(mergeRuleMarkdown(base, fields, new Set<RuleFormField>(['scope', 'examples']))).toBe(base
      .replace('custom:\n  nested: value\n', 'custom:\n  nested: value\nscope: sessions\n')
      .replace('# Detection Logic', '# Examples\n{{workspaceName}}\n\n# Detection Logic'));
  });

  it('keeps a detect block that sits in a rewritten text section, and edits it there', () => {
    const base = '---\nid: x\nname: X\ngroup: prompt-quality\nseverity: low\n---\n\n# Examples\n"{{message}}"\n```detect\nscan: requests\ncheck: count >= 1\n```\n';
    const fields = { ...fullFields(base), examples: 'New example', detect: 'scan: requests\ncheck: count >= 2' };
    const merged = mergeRuleMarkdown(base, fields, new Set<RuleFormField>(['examples', 'detect']));
    expect(merged).toBe('---\nid: x\nname: X\ngroup: prompt-quality\nseverity: low\n---\n\n# Examples\nNew example\n\n```detect\nscan: requests\ncheck: count >= 2\n```\n');
    expect(readRuleFields(merged)).toMatchObject({ examples: 'New example', detect: 'scan: requests\ncheck: count >= 2' });
  });

  it('adds a detect block to the Detection Logic section, or a new section', () => {
    const fields = (md: string) => ({ ...fullFields(md), detect: 'scan: requests' });
    const withHeading = '---\nid: x\n---\n\n# Detection Logic\nLogic below.\n\n# Tests\n';
    expect(mergeRuleMarkdown(withHeading, fields(withHeading), new Set<RuleFormField>(['detect'])))
      .toBe('---\nid: x\n---\n\n# Detection Logic\nLogic below.\n```detect\nscan: requests\n```\n\n# Tests\n');
    const withoutHeading = '---\nid: x\n---\n\n# Description\nText';
    expect(mergeRuleMarkdown(withoutHeading, fields(withoutHeading), new Set<RuleFormField>(['detect'])))
      .toBe('---\nid: x\n---\n\n# Description\nText\n\n# Detection Logic\n```detect\nscan: requests\n```\n');
  });
});

describe('mergeRuleMarkdown new rules', () => {
  it('writes every front-matter field from the form into markdown without front matter', () => {
    const body = '# Description\nShort prompts.\n\n# Detection Logic\n```detect\nscan: requests\nmatch: messageLength < 30\ncheck: count >= 5\n```\n';
    const fields: RuleFormFields = {
      ...(readRuleFields(body) as RuleFormFields),
      id: 'short-prompts', name: '', group: 'prompt-quality', severity: 'medium', scope: 'requests', version: '1', tags: '', thresholds: '',
    };
    const merged = mergeRuleMarkdown(body, fields, new Set<RuleFormField>(['id']));
    expect(merged).toBe([
      '---', 'id: short-prompts', 'name: My Custom Rule', 'group: prompt-quality', 'severity: medium', 'scope: requests',
      'version: 1', 'tags: []', 'thresholds: {}', '---', '',
    ].join('\n') + body);
    expect(parseRule(merged)).toMatchObject({ id: 'short-prompts', group: 'prompt-quality', severity: 'medium', scope: 'requests' });
  });

  it('builds a new rule from the template, with defaults for empty fields', () => {
    const fields: RuleFormFields = {
      id: '', name: 'Short prompts', group: 'prompt-quality', severity: 'medium', scope: 'both', version: '1',
      tags: 'custom', thresholds: 'minChars: 30', description: '', whenTriggered: '', howToImprove: '', examples: '', detect: '',
    };
    const merged = mergeRuleMarkdown('', fields, new Set(Object.keys(fields) as RuleFormField[]));
    expect(merged).toBe([
      '---', 'id: my-custom-rule', 'name: Short prompts', 'group: prompt-quality', 'severity: medium', 'scope: both',
      'version: 1', 'tags: [custom]', 'thresholds:', '  minChars: 30', '---', '',
      '# Description', 'Describe what this rule detects.', '',
      '# When Triggered', '{{count}} occurrences detected ({{pct}} of requests).', '',
      '# How to Improve', 'Explain how to fix this anti-pattern.', '',
      '# Examples', '"{{message}}..."', '',
      '# Detection Logic', '```detect', 'scan: requests', 'match: messageLength > 0', 'aggregate: count', 'check: count >= 1', '```', '',
    ].join('\n'));
    expect(parseRule(merged)).toMatchObject({ id: 'my-custom-rule', scope: 'both', thresholds: { minChars: 30 } });
  });
});
