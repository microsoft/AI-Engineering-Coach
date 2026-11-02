/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { parseRule, serializeRule } from './rule-parser';
import type { DetectionRule } from './types';

const RULES_DIR = path.join(__dirname, 'rules');

/** A minimal valid rule with extra front matter lines, joined with `eol`. */
function ruleSource(frontMatter: string[], eol = '\n'): string {
  return [
    '---', 'id: probe', 'name: Probe', 'group: prompt-quality', 'severity: low', 'scope: requests', ...frontMatter, '---',
    '', '# Description', 'Probe rule.', '', '# Detection Logic', '```detect', 'scan: requests', 'match: messageLength > 0',
    'aggregate: count', 'check: count > 0', '```', '',
  ].join(eol);
}

function parse(frontMatter: string[], eol?: string): DetectionRule {
  const rule = parseRule(ruleSource(frontMatter, eol));
  if (!rule) throw new Error("probe rule doesn't parse");
  return rule;
}

describe('parseRule front matter: quoted values', () => {
  it('keeps a comma inside a quoted list item', () => {
    const rule = parse(['patterns:', String.raw`  frustration: ["!{3,}", "\\?{3,}", "wtf|come on|why won't"]`]);
    expect(rule.patterns.frustration).toEqual(['!{3,}', String.raw`\?{3,}`, `wtf|come on|why won't`]);
  });

  it('reads \\\\ and \\" in double quotes and keeps every other backslash', () => {
    const rule = parse([
      'patterns:',
      String.raw`  doubled: "(?i)\\.(md|txt)$"`,
      String.raw`  single: "\d+\s\b"`,
      String.raw`  quotes: ["say \"hi\"", "a\\\\b"]`,
    ]);
    expect(rule.patterns).toEqual({
      doubled: [String.raw`(?i)\.(md|txt)$`],
      single: [String.raw`\d+\s\b`],
      quotes: ['say "hi"', String.raw`a\\b`],
    });
  });

  it("reads '' in single quotes as one single quote, with backslashes literal", () => {
    const rule = parse([`tags: ['it''s', plain]`, 'patterns:', String.raw`  apostrophes: ['won''t, can''t', '\d']`]);
    expect(rule.tags).toEqual([`it's`, 'plain']);
    expect(rule.patterns.apostrophes).toEqual([`won't, can't`, String.raw`\d`]);
  });

  it('reads top-level quoted values the same way', () => {
    const rule = parse([String.raw`extends: "base\\rule"`, String.raw`tags: ["a, b", "c\"d"]`]);
    expect(rule.extendsRule).toBe(String.raw`base\rule`);
    expect(rule.tags).toEqual(['a, b', 'c"d']);
  });
});

describe('parseRule front matter: unquoted, unclosed and CRLF values', () => {
  it('reads unquoted values as written', () => {
    const rule = parse([
      String.raw`tags: [prompt, don't, a\\b]`,
      'fileTypes:', '  documentation: [markdown, md, mdx]',
      'patterns:', String.raw`  plain: (?m)^#+\s`, String.raw`  doubled: \\d`,
    ]);
    expect(rule.tags).toEqual(['prompt', `don't`, String.raw`a\\b`]);
    expect(rule.fileTypes.documentation).toEqual(['markdown', 'md', 'mdx']);
    expect(rule.patterns).toEqual({ plain: [String.raw`(?m)^#+\s`], doubled: [String.raw`\\d`] });
  });

  it('reads a value whose quote is never closed as before', () => {
    const rule = parse(['tags: ["open, b]', 'patterns:', '  open: "abc', '  trailing: "a" b']);
    expect(rule.tags).toEqual(['open', 'b']);
    expect(rule.patterns).toEqual({ open: ['abc'], trailing: ['a" b'] });
  });

  it('parses CRLF front matter the same as LF', () => {
    const lines = [
      'tags: ["a, b", c]', 'thresholds:', '  minReqs: 2',
      'patterns:', String.raw`  frustration: ["!{3,}", "\\?{3,}"]`, String.raw`  numbered: "(?m)^\\d+[.)]\\s"`,
    ];
    const lf = parse(lines);
    const crlf = parse(lines, '\r\n');
    expect(crlf.tags).toEqual(['a, b', 'c']);
    expect(crlf.thresholds).toEqual({ minReqs: 2 });
    expect(crlf.patterns).toEqual({ frustration: ['!{3,}', String.raw`\?{3,}`], numbered: [String.raw`(?m)^\d+[.)]\s`] });
    expect(crlf.patterns).toEqual(lf.patterns);
  });
});

describe('serializeRule', () => {
  const FIELDS = [
    'id', 'name', 'group', 'severity', 'scope', 'requiresIdeContext', 'version', 'tags', 'thresholds', 'patterns',
    'fileTypes', 'extendsRule', 'description', 'descriptionTemplate', 'suggestionTemplate', 'exampleTemplate',
  ] as const;

  it('escapes patterns so that parseRule reads them back unchanged', () => {
    const patterns = {
      tricky: ['!{3,}', String.raw`\?{3,}`, String.raw`\\d`, 'say "hi"', `won't`, 'a, b', 'x\\', ' padded ', ''],
    };
    const again = parseRule(serializeRule({ ...parse([]), patterns }));
    expect(again?.patterns).toEqual(patterns);
  });

  it('quotes tags and fileTypes items only when they need it', () => {
    const tags = ['plain', 'a, b', '"q"', `it's`, ' padded'];
    const fileTypes = { docs: ['md', 'x, y'] };
    const source = serializeRule({ ...parse([]), tags, fileTypes });
    expect(source).toContain(String.raw`tags: [plain, "a, b", "\"q\"", it's, " padded"]`);
    expect(source).toContain('  docs: [md, "x, y"]');
    const again = parseRule(source);
    expect(again?.tags).toEqual(tags);
    expect(again?.fileTypes).toEqual(fileTypes);
  });

  it('writes a built-in pattern line as the rule file has it', () => {
    const source = fs.readFileSync(path.join(RULES_DIR, 'frustration-signals.md'), 'utf-8');
    const line = source.split(/\r?\n/).find(l => l.trimStart().startsWith('frustration:'));
    expect(line).toBeDefined();
    expect(serializeRule(parseRule(source)!).split('\n')).toContain(line);
  });

  it('round-trips the front matter and sections of every built-in rule', () => {
    const files = fs.readdirSync(RULES_DIR).filter(file => file.endsWith('.md'));
    expect(files.length).toBeGreaterThanOrEqual(45);
    for (const file of files) {
      const rule = parseRule(fs.readFileSync(path.join(RULES_DIR, file), 'utf-8'));
      expect(rule, file).not.toBeNull();
      const again = parseRule(serializeRule(rule!));
      for (const field of FIELDS) expect(again?.[field], `${file}: ${field}`).toEqual(rule![field]);
    }
  });
});
