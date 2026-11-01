/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Threshold edits written in place: only the edited number changes, under LF and CRLF line endings. */

import { describe, expect, it } from 'vitest';
import { parseRule } from './rule-parser';
import { patchThresholds, type ThresholdPatch } from './rule-thresholds';

const HEADER = ['---', 'id: sample-rule', 'name: Sample Rule', 'group: prompt-quality', 'severity: low', 'scope: requests'];
const BODY = [
  '---', '', '# Description', 'Prose that mentions minChars: 30.', '',
  '# Detection Logic', '```detect', 'scan: requests', 'match: messageLength < thresholds.minChars', 'minChars: 30',
  'check: count > thresholds.minSample', '```', '',
  '# Tests', '```test', '{messageText: "fix", messageLength: 3} -> triggered', '```', '',
];

/** A rule whose front matter ends with `frontMatter`, joined with `eol`. */
function ruleSource(frontMatter: string[], eol: string): string {
  return [...HEADER, ...frontMatter, ...BODY].join(eol);
}

/** The source of a successful patch. */
function patched(result: ThresholdPatch): string {
  if (!result.ok) throw new Error(`patch failed: ${result.key} (${result.reason})`);
  return result.source;
}

/** Index and text of each line that differs, splitting on `\n` so a CRLF line keeps its `\r`. */
function changedLines(before: string, after: string): Array<[number, string]> {
  const old = before.split('\n');
  const now = after.split('\n');
  expect(now).toHaveLength(old.length);
  return now.flatMap((line, i): Array<[number, string]> => (line === old[i] ? [] : [[i, line]]));
}

/** Line number (0-based) of `line` in a source built by ruleSource. */
function lineOf(frontMatter: string[], line: string): number {
  return HEADER.length + frontMatter.indexOf(line);
}

/** The patched rule parses like the original, except for its thresholds and source. */
function expectParsedWith(before: string, after: string, thresholds: Record<string, number>): void {
  const original = parseRule(before);
  expect(original).not.toBeNull();
  expect(parseRule(after)).toEqual({ ...original, thresholds: { ...original!.thresholds, ...thresholds }, rawSource: after });
}

const ENDINGS = [['LF', '\n'], ['CRLF', '\r\n']];

describe.each(ENDINGS)('patchThresholds sets values in place, with %s line endings', (_label, eol) => {
  const cr = eol === '\r\n' ? '\r' : '';

  it('changes only the edited number and keeps # Tests and the detection logic', () => {
    const fm = ['thresholds:', '  minChars: 30', '  maxRatio: 0.3', '  minSample: 10'];
    const source = ruleSource(fm, eol);
    const after = patched(patchThresholds(source, { minChars: 40 }));
    expect(changedLines(source, after)).toEqual([[lineOf(fm, '  minChars: 30'), `  minChars: 40${cr}`]]);
    expectParsedWith(source, after, { minChars: 40 });
  });

  it('returns the source unchanged for numbers equal to their new values, however they are written', () => {
    const fm = ['thresholds:', '  minChars: 30', '  maxRatio: 0.40', '  minSample: 5.0', '  big: 1e3', '  plus: +5', '  half: .5'];
    const source = ruleSource(fm, eol);
    const values = { minChars: 30, maxRatio: 0.4, minSample: 5, big: 1000, plus: 5, half: 0.5 };
    expect(patchThresholds(source, values)).toEqual({ ok: true, source });
  });

  it('keeps the indentation, the spacing after the colon and trailing spaces', () => {
    const fm = ['thresholds:', '    minChars:   30   ', '\t\tmaxRatio:\t0.3', '  minSample: 10'];
    const source = ruleSource(fm, eol);
    const after = patched(patchThresholds(source, { minChars: 40, maxRatio: 0.5, minSample: 20 }));
    expect(changedLines(source, after)).toEqual([
      [lineOf(fm, '    minChars:   30   '), `    minChars:   40   ${cr}`],
      [lineOf(fm, '\t\tmaxRatio:\t0.3'), `\t\tmaxRatio:\t0.5${cr}`],
      [lineOf(fm, '  minSample: 10'), `  minSample: 20${cr}`],
    ]);
    expectParsedWith(source, after, { minChars: 40, maxRatio: 0.5, minSample: 20 });
  });

  it('skips comments and blank lines in the block, even a comment naming the key', () => {
    const fm = ['thresholds:', '  # minChars: 1 was too low', '  minChars: 30', '', '  # a note', '  maxRatio: 0.3'];
    const source = ruleSource(fm, eol);
    const after = patched(patchThresholds(source, { minChars: 40, maxRatio: 0.5 }));
    expect(changedLines(source, after)).toEqual([
      [lineOf(fm, '  minChars: 30'), `  minChars: 40${cr}`],
      [lineOf(fm, '  maxRatio: 0.3'), `  maxRatio: 0.5${cr}`],
    ]);
    expectParsedWith(source, after, { minChars: 40, maxRatio: 0.5 });
  });

  it('never changes the key outside the thresholds block', () => {
    const fm = ['patterns:', '  minChars: [abc, def]', 'thresholds:', '  minChars: 30', 'fileTypes:', '  minChars: [md]'];
    const source = ruleSource(fm, eol);
    const after = patched(patchThresholds(source, { minChars: 40 }));
    expect(changedLines(source, after)).toEqual([[lineOf(fm, '  minChars: 30'), `  minChars: 40${cr}`]]);
    expectParsedWith(source, after, { minChars: 40 });
  });
});

describe.each(ENDINGS)('patchThresholds reads values and blocks as the parser does, with %s line endings', (_label, eol) => {
  const cr = eol === '\r\n' ? '\r' : '';

  it('writes negative and decimal values exactly', () => {
    const fm = ['thresholds:', '  offset: -5', '  ratio: 0.25', '  count: 3'];
    const source = ruleSource(fm, eol);
    const sum = 0.1 + 0.2;
    const after = patched(patchThresholds(source, { offset: -3, ratio: sum, count: -1.5 }));
    expect(changedLines(source, after)).toEqual([
      [lineOf(fm, '  offset: -5'), `  offset: -3${cr}`],
      [lineOf(fm, '  ratio: 0.25'), `  ratio: ${String(sum)}${cr}`],
      [lineOf(fm, '  count: 3'), `  count: -1.5${cr}`],
    ]);
    expectParsedWith(source, after, { offset: -3, ratio: sum, count: -1.5 });
  });

  it('reads a block line as the parser does: a 1-space indent ends the block', () => {
    const source = ruleSource(['thresholds:', ' minChars: 30'], eol);
    expect(parseRule(source)?.thresholds).toEqual({});
    expect(patchThresholds(source, { minChars: 40 })).toEqual({ ok: false, key: 'minChars', reason: 'unknown-key' });
  });

  it('sets a value written as Infinity, which the parser reads as a number', () => {
    const fm = ['thresholds:', '  maxCount: Infinity', '  minCount: -Infinity'];
    const source = ruleSource(fm, eol);
    expect(parseRule(source)?.thresholds).toEqual({ maxCount: Infinity, minCount: -Infinity });
    const after = patched(patchThresholds(source, { maxCount: 5, minCount: -5 }));
    expect(changedLines(source, after)).toEqual([
      [lineOf(fm, '  maxCount: Infinity'), `  maxCount: 5${cr}`],
      [lineOf(fm, '  minCount: -Infinity'), `  minCount: -5${cr}`],
    ]);
    expectParsedWith(source, after, { maxCount: 5, minCount: -5 });
  });

  it('follows the last thresholds block and the last line of a repeated key', () => {
    const fm = ['thresholds:', '  minChars: 10', 'version: 1', 'thresholds:', '  minChars: 20', '  minChars: 30'];
    const source = ruleSource(fm, eol);
    const after = patched(patchThresholds(source, { minChars: 40 }));
    expect(changedLines(source, after)).toEqual([[lineOf(fm, '  minChars: 30'), `  minChars: 40${cr}`]]);
    expectParsedWith(source, after, { minChars: 40 });
  });
});

describe.each(ENDINGS)('patchThresholds rejects, with %s line endings', (_label, eol) => {
  it.each([
    ['thresholds: {}', ['thresholds: {}']],
    ['a later inline thresholds value', ['thresholds:', '  minChars: 30', 'thresholds: {}']],
    ['no thresholds block', ['version: 1']],
  ])('rejects %s', (_case, fm) => {
    expect(patchThresholds(ruleSource(fm, eol), { minChars: 40 })).toEqual({ ok: false, key: 'minChars', reason: 'no-thresholds' });
  });

  it('rejects a source without front matter', () => {
    expect(patchThresholds(`# Description${eol}minChars: 30${eol}`, { minChars: 40 }))
      .toEqual({ ok: false, key: 'minChars', reason: 'no-thresholds' });
  });

  it('rejects a key the block does not have', () => {
    expect(patchThresholds(ruleSource(['thresholds:', '  minChars: 30'], eol), { maxRatio: 0.5 }))
      .toEqual({ ok: false, key: 'maxRatio', reason: 'unknown-key' });
  });

  it.each([
    ['text', 'thirty'], ['a list', '[1, 2]'], ['a number and a comment', '30 # chars'], ['nothing', ''],
    ['infinity in lower case', 'infinity'],
  ])(
    'rejects a value written as %s',
    (_case, written) => {
      const source = ruleSource(['thresholds:', `  minChars: ${written}`.trimEnd()], eol);
      expect(patchThresholds(source, { minChars: 40 })).toEqual({ ok: false, key: 'minChars', reason: 'not-a-number' });
    },
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])('rejects the value %s', value => {
    expect(patchThresholds(ruleSource(['thresholds:', '  minChars: 30'], eol), { minChars: value }))
      .toEqual({ ok: false, key: 'minChars', reason: 'invalid-value' });
  });

  it('sets nothing unless every key can be set', () => {
    const source = ruleSource(['thresholds:', '  minChars: 30', '  maxRatio: 0.3'], eol);
    expect(patchThresholds(source, { minChars: 40, nope: 1, maxRatio: 0.5 })).toEqual({ ok: false, key: 'nope', reason: 'unknown-key' });
  });
});
