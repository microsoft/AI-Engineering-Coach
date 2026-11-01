/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * Threshold edits on every built-in rule, under LF and CRLF line endings: setting a threshold to its own value leaves
 * the rule as written, and a new value changes only that threshold's line.
 */

import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseRule } from './rule-parser';
import { parsePipeline } from './rule-pipeline';
import type { DetectionRule } from './types';

type Engine = typeof import('./rule-engine');

const RULES_DIR = path.join(__dirname, 'rules');
const IDS = fs.readdirSync(RULES_DIR).filter(file => file.endsWith('.md')).map(file => file.slice(0, -3)).sort();
const ENDINGS = [['LF', '\n'], ['CRLF', '\r\n']];

/**
 * Every built-in rule's file with `eol` line endings, registered in a fresh rule engine before the suite's tests. The
 * engine's overrides are removed after each test.
 */
function builtInRules(eol: string): { sources: Map<string, string>; engine: () => Engine } {
  const sources = new Map(IDS.map(id => [id, fs.readFileSync(path.join(RULES_DIR, `${id}.md`), 'utf-8').replaceAll(/\r?\n/g, eol)]));
  let engine: Engine | undefined;
  beforeAll(async () => {
    vi.resetModules();
    engine = await import('./rule-engine');
    for (const [id, source] of sources) engine.registerBuiltinRuleSource(id, source);
  });
  afterEach(() => {
    for (const id of IDS) engine?.removeUserRule(id);
  });
  return { sources, engine: () => engine! };
}

/** The rule as its file parses, with its thresholds. */
function asWritten(source: string): { rule: DetectionRule; thresholds: Array<[string, number]> } {
  const rule = parseRule(source)!;
  return { rule, thresholds: Object.entries(rule.thresholds) };
}

/** The engine's rule matches its file: the same source bytes, the same parse and the same detection pipeline. */
function expectAsWritten(engine: Engine, id: string, source: string, layer: DetectionRule['source']): void {
  const { rule } = asWritten(source);
  expect(engine.getRuleSource(id)).toBe(source);
  expect(engine.getRule(id)).toEqual({ ...rule, source: layer });
  expect(parsePipeline(engine.getRule(id)!)).toEqual(parsePipeline(rule));
}

/** A different value for a threshold, written the way a user would type it. */
function newValue(value: number): number {
  return Number.isInteger(value) ? value + 1 : Math.round((value + 0.05) * 1000) / 1000;
}

/** Index and text of each line that differs, splitting on `\n` so a CRLF line keeps its `\r`. */
function changedLines(before: string, after: string): Array<[number, string]> {
  const old = before.split('\n');
  const now = after.split('\n');
  expect(now).toHaveLength(old.length);
  return now.flatMap((line, i): Array<[number, string]> => (line === old[i] ? [] : [[i, line]]));
}

/** Index of the threshold's line in the front matter. */
function thresholdLine(lines: string[], key: string): number {
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
  return lines.findIndex((line, i) => i < end && /^\s/.test(line) && line.trimStart().startsWith(`${key}:`));
}

describe.each(ENDINGS)('same-value threshold edits on built-in rules with %s line endings', (_label, eol) => {
  const { sources, engine } = builtInRules(eol);

  it('covers every built-in rule, each with thresholds', () => {
    expect(IDS.length).toBeGreaterThanOrEqual(45);
    for (const id of IDS) expect(asWritten(sources.get(id)!).thresholds.length, id).toBeGreaterThan(0);
  });

  it.each(IDS)('%s: setting each threshold to its value, one at a time, changes nothing', id => {
    const existing = engine().getRule(id);
    for (const [key, value] of asWritten(sources.get(id)!).thresholds) {
      expect(engine().updateRuleThresholds(id, { [key]: value }), key).toBe(existing);
    }
    expectAsWritten(engine(), id, sources.get(id)!, 'built-in');
  });

  it.each(IDS)('%s: setting every threshold to its value at once changes nothing', id => {
    const existing = engine().getRule(id);
    expect(engine().updateRuleThresholds(id, Object.fromEntries(asWritten(sources.get(id)!).thresholds))).toBe(existing);
    expectAsWritten(engine(), id, sources.get(id)!, 'built-in');
  });

  it.each(IDS)('%s: changing each threshold and back restores the source byte for byte', id => {
    for (const [key, value] of asWritten(sources.get(id)!).thresholds) {
      expect(engine().updateRuleThresholds(id, { [key]: newValue(value) }), key).not.toBeNull();
      expect(engine().updateRuleThresholds(id, { [key]: value }), key).not.toBeNull();
    }
    expectAsWritten(engine(), id, sources.get(id)!, 'personal');
  });
});

describe.each(ENDINGS)('new threshold values on built-in rules with %s line endings', (_label, eol) => {
  const { sources, engine } = builtInRules(eol);

  it.each(IDS)('%s: a new value changes only its own line and keeps the line ending', id => {
    const source = sources.get(id)!;
    const { rule, thresholds } = asWritten(source);
    const lines = source.split('\n');
    for (const [key, value] of thresholds) {
      engine().removeUserRule(id);
      const next = newValue(value);
      const updated = engine().updateRuleThresholds(id, { [key]: next });
      const after = engine().getRuleSource(id)!;
      const index = thresholdLine(lines, key);
      expect(changedLines(source, after), key).toEqual([[index, lines[index].replace(`: ${value}`, `: ${next}`)]]);
      expect(after.split('\n')[index].endsWith('\r'), key).toBe(eol === '\r\n');
      expect(updated, key).toEqual({ ...rule, thresholds: { ...rule.thresholds, [key]: next }, rawSource: after, source: 'personal' });
      expect(parsePipeline(updated!), key).toEqual(parsePipeline(rule));
    }
  });
});
