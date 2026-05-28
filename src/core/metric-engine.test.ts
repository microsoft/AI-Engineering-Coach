/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect, beforeEach } from 'vitest';
import {
  parseMetric,
  parseRuleExtensions,
  evaluateMetric,
  evaluateTrigger,
  calibrate,
  serializeCalibration,
  stripCalibration,
  runTestCases,
  resolveDependencies,
  registerMetric,
  getAllMetrics,
  clearMetrics,
} from './metric-engine';

/* ---- parseMetric ---- */
describe('Metric Parser', () => {
  it('parses a valid .metric.md file', () => {
    const md = `---
id: short-messages
name: Short Messages
scope: requests
version: 1
tags: [prompt, quality]
---

# Filter
messageLength < 30 AND messageLength > 0

# Metric
ratio

# Examples
"{{messageText | truncate:80}}" ({{messageLength}} chars)
`;
    const metric = parseMetric(md);
    expect(metric).not.toBeNull();
    expect(metric!.id).toBe('short-messages');
    expect(metric!.name).toBe('Short Messages');
    expect(metric!.scope).toBe('requests');
    expect(metric!.filterExpr).toBe('messageLength < 30 AND messageLength > 0');
    expect(metric!.aggregationExpr).toBe('ratio');
    expect(metric!.exampleTemplate).toContain('messageText');
  });

  it('returns null for invalid markdown', () => {
    expect(parseMetric('no frontmatter')).toBeNull();
    expect(parseMetric('---\nfoo: bar\n---\nbody')).toBeNull();
  });
});

/* ---- parseRuleExtensions ---- */
describe('Rule Extensions Parser', () => {
  it('extracts filter and trigger from rule markdown', () => {
    const md = `---
id: test-rule
name: Test
group: prompt-quality
severity: medium
metric: short-messages
requires: [frustration-signals]
---

# Filter
messageLength < 30

# Trigger
ratio > 0.3 AND count > 5

# When Triggered
{{count}} messages are short.

# Test Cases
- input: { "messageLength": 5 }
  expect: flagged
- input: { "messageLength": 100 }
  expect: clean
`;
    const ext = parseRuleExtensions(md);
    expect(ext.filterExpr).toBe('messageLength < 30');
    expect(ext.triggerExpr).toBe('ratio > 0.3 AND count > 5');
    expect(ext.metricRef).toBe('short-messages');
    expect(ext.requires).toEqual(['frustration-signals']);
    expect(ext.testCases).toHaveLength(2);
    expect(ext.testCases[0].expect).toBe('flagged');
    expect(ext.testCases[1].expect).toBe('clean');
  });

  it('returns empty for rule without DSL sections', () => {
    const md = `---
id: old-rule
name: Old
group: prompt-quality
severity: low
---

# Description
Just a basic rule.
`;
    const ext = parseRuleExtensions(md);
    expect(ext.filterExpr).toBe('');
    expect(ext.triggerExpr).toBe('');
    expect(ext.metricRef).toBe('');
    expect(ext.requires).toEqual([]);
    expect(ext.testCases).toEqual([]);
  });
});

/* ---- evaluateMetric ---- */
describe('Metric Evaluation', () => {
  const rows = [
    { messageLength: 5,   messageText: 'hi',         isCanceled: false },
    { messageLength: 50,  messageText: 'longer msg',  isCanceled: true },
    { messageLength: 10,  messageText: 'short',       isCanceled: false },
    { messageLength: 200, messageText: 'big message',  isCanceled: false },
    { messageLength: 3,   messageText: 'yo',          isCanceled: false },
  ] as Record<string, unknown>[];

  it('evaluates filter + ratio', () => {
    const emission = evaluateMetric(
      'messageLength < 30 AND messageLength > 0',
      'ratio',
      '',
      rows,
    );
    expect(emission.count).toBe(3);
    expect(emission.total).toBe(5);
    expect(emission.ratio).toBeCloseTo(0.6);
  });

  it('evaluates filter + count', () => {
    const emission = evaluateMetric('isCanceled == true', 'count', '', rows);
    expect(emission.count).toBe(1);
  });

  it('evaluates with thresholds', () => {
    const emission = evaluateMetric(
      'messageLength < {{thresholds.minChars}}',
      'ratio',
      '',
      rows,
      { minChars: 20 },
    );
    expect(emission.count).toBe(3);
  });

  it('generates examples', () => {
    const emission = evaluateMetric(
      'messageLength < 30',
      'ratio',
      '"{{messageText}}"',
      rows,
    );
    expect(emission.examples.length).toBeGreaterThan(0);
    expect(emission.examples[0]).toContain('hi');
  });
});

/* ---- evaluateTrigger ---- */
describe('Trigger Evaluation', () => {
  it('evaluates a simple trigger', () => {
    expect(evaluateTrigger('ratio > 0.3', { count: 3, total: 5, ratio: 0.6, examples: [], extra: {} })).toBe(true);
    expect(evaluateTrigger('ratio > 0.3', { count: 1, total: 5, ratio: 0.2, examples: [], extra: {} })).toBe(false);
  });

  it('evaluates compound trigger', () => {
    expect(evaluateTrigger('ratio > 0.3 AND count > 2',
      { count: 3, total: 5, ratio: 0.6, examples: [], extra: {} })).toBe(true);
    expect(evaluateTrigger('ratio > 0.3 AND count > 10',
      { count: 3, total: 5, ratio: 0.6, examples: [], extra: {} })).toBe(false);
  });

  it('defaults to count > 0 for empty trigger', () => {
    expect(evaluateTrigger('', { count: 1, total: 5, ratio: 0.2, examples: [], extra: {} })).toBe(true);
    expect(evaluateTrigger('', { count: 0, total: 5, ratio: 0, examples: [], extra: {} })).toBe(false);
  });
});

/* ---- Auto-Calibration ---- */
describe('Calibration', () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({
    messageLength: i * 3,
  })) as Record<string, unknown>[];

  it('produces calibration stats', () => {
    const result = calibrate('messageLength < 30', 'ratio', 'ratio > 0.3', rows);
    expect(result.datasetSize).toBe(100);
    expect(result.flaggedCount).toBe(10);
    expect(result.flaggedPct).toBeCloseTo(10);
    expect(result.distribution).not.toBeNull();
    expect(result.distribution!.min).toBe(0);
    expect(result.distribution!.max).toBe(297);
  });
});

/* ---- Test Fixture Runner ---- */
describe('Test Fixture Runner', () => {
  it('runs passing tests', () => {
    const results = runTestCases(
      'messageLength < 30',
      'ratio',
      '', // empty trigger defaults to count > 0
      [
        { input: { messageLength: 5 }, expect: 'flagged' },
        { input: { messageLength: 100 }, expect: 'clean' },
      ],
    );
    expect(results).toHaveLength(2);
    expect(results[0].passed).toBe(true);
    expect(results[1].passed).toBe(true);
  });

  it('detects failing tests', () => {
    const results = runTestCases(
      'messageLength < 30',
      'ratio',
      '',
      [{ input: { messageLength: 5 }, expect: 'clean' }],
    );
    expect(results[0].passed).toBe(false);
  });
});

/* ---- Dependency Resolution ---- */
describe('Dependency Resolution', () => {
  it('resolves linear dependencies', () => {
    const deps = new Map([
      ['rule-a', []],
      ['rule-b', ['rule-a']],
      ['rule-c', ['rule-b']],
    ]);
    const result = resolveDependencies(deps);
    expect(result.errors).toHaveLength(0);
    const aIdx = result.order.indexOf('rule-a');
    const bIdx = result.order.indexOf('rule-b');
    const cIdx = result.order.indexOf('rule-c');
    expect(aIdx).toBeLessThan(bIdx);
    expect(bIdx).toBeLessThan(cIdx);
  });

  it('reports missing dependencies', () => {
    const deps = new Map([
      ['rule-a', ['nonexistent']],
    ]);
    const result = resolveDependencies(deps);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].missing).toContain('nonexistent');
  });

  it('handles cycles gracefully', () => {
    const deps = new Map([
      ['rule-a', ['rule-b']],
      ['rule-b', ['rule-a']],
    ]);
    const result = resolveDependencies(deps);
    // Should not throw, just resolve what it can
    expect(result.order).toHaveLength(2);
  });
});

/* ---- Metric Registry ---- */
describe('Metric Registry', () => {
  beforeEach(() => clearMetrics());

  it('registers and retrieves metrics', () => {
    registerMetric({
      id: 'test-metric',
      name: 'Test',
      scope: 'requests',
      version: 1,
      tags: [],
      filterExpr: 'x > 0',
      aggregationExpr: 'count',
      exampleTemplate: '',
      rawSource: '',
      source: 'built-in',
      sourceFilePath: '',
    });
    expect(getAllMetrics().find(m => m.id === 'test-metric')).toBeDefined();
    expect(getAllMetrics()).toHaveLength(1);
  });

  it('clears metrics', () => {
    registerMetric({
      id: 'x', name: 'X', scope: 'requests', version: 1, tags: [],
      filterExpr: '', aggregationExpr: 'count', exampleTemplate: '',
      rawSource: '', source: 'built-in', sourceFilePath: '',
    });
    clearMetrics();
    expect(getAllMetrics()).toHaveLength(0);
  });
});

/* ---- Edge Cases: Missing Data & Zero Values ---- */
describe('Metric Evaluation – edge cases', () => {
  it('returns zeros for an empty dataset', () => {
    const emission = evaluateMetric('messageLength < 30', 'ratio', '', []);
    expect(emission.count).toBe(0);
    expect(emission.total).toBe(0);
    expect(emission.ratio).toBe(0);
    expect(emission.examples).toEqual([]);
  });

  it('returns zero count when no row matches the filter', () => {
    const rows = [{ messageLength: 100 }, { messageLength: 200 }] as Record<string, unknown>[];
    const emission = evaluateMetric('messageLength < 30', 'ratio', '', rows);
    expect(emission.count).toBe(0);
    expect(emission.total).toBe(2);
    expect(emission.ratio).toBe(0);
    expect(emission.examples).toEqual([]);
  });

  it('treats missing fields as non-matching', () => {
    const rows = [
      { messageLength: 5 },
      { /* messageLength missing */ },
      { messageLength: null },
    ] as Record<string, unknown>[];
    const emission = evaluateMetric('messageLength < 30 AND messageLength > 0', 'ratio', '', rows);
    expect(emission.count).toBe(1);
    expect(emission.total).toBe(3);
  });

  it('falls back to default example text when no template is provided', () => {
    const rows = [{ messageText: 'hello world', messageLength: 11 }] as Record<string, unknown>[];
    const emission = evaluateMetric('messageLength > 0', 'ratio', '', rows);
    expect(emission.examples[0]).toContain('hello world');
  });

  it('supports avg aggregations and exposes the value via extra', () => {
    const rows = [
      { messageLength: 10 },
      { messageLength: 20 },
      { messageLength: 30 },
    ] as Record<string, unknown>[];
    const emission = evaluateMetric('messageLength > 0', 'avg(messageLength)', '', rows);
    expect(emission.total).toBe(3);
    expect(emission.extra.aggregationType).toBe('avg');
    expect(emission.extra.aggregationField).toBe('messageLength');
    expect(emission.extra.aggregationValue).toBeCloseTo(20);
  });

  it('caps generated examples at three rows', () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      messageLength: 5,
      messageText: `msg-${i}`,
    })) as Record<string, unknown>[];
    const emission = evaluateMetric('messageLength < 30', 'ratio', '"{{messageText}}"', rows);
    expect(emission.examples).toHaveLength(3);
  });
});

/* ---- Threshold Overrides on Trigger / Calibrate / Test Cases ---- */
describe('Threshold Overrides', () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ messageLength: i })) as Record<string, unknown>[];

  it('applies thresholds to trigger expressions', () => {
    const emission = evaluateMetric('messageLength < 5', 'ratio', '', rows);
    expect(evaluateTrigger('ratio > {{thresholds.maxRatio}}', emission, { maxRatio: 0.3 })).toBe(true);
    expect(evaluateTrigger('ratio > {{thresholds.maxRatio}}', emission, { maxRatio: 0.9 })).toBe(false);
  });

  it('applies thresholds when calibrating', () => {
    const result = calibrate(
      'messageLength < {{thresholds.minChars}}',
      'ratio',
      'ratio > {{thresholds.maxRatio}}',
      rows,
      { minChars: 3, maxRatio: 0.2 },
    );
    expect(result.flaggedCount).toBe(3);
    expect(result.triggered).toBe(true);
  });

  it('applies thresholds inside test fixtures', () => {
    const results = runTestCases(
      'messageLength < {{thresholds.minChars}}',
      'ratio',
      '',
      [
        { input: { messageLength: 2 }, expect: 'flagged' },
        { input: { messageLength: 50 }, expect: 'clean' },
      ],
      { minChars: 10 },
    );
    expect(results[0].passed).toBe(true);
    expect(results[1].passed).toBe(true);
  });
});

/* ---- Calibration edge cases ---- */
describe('Calibration – edge cases', () => {
  it('handles an empty dataset', () => {
    const result = calibrate('messageLength < 30', 'ratio', 'ratio > 0.3', []);
    expect(result.datasetSize).toBe(0);
    expect(result.flaggedCount).toBe(0);
    expect(result.flaggedPct).toBe(0);
    expect(result.distribution).toBeNull();
    expect(result.triggered).toBe(false);
  });

  it('omits distribution when the filter has no numeric field', () => {
    const rows = [{ isCanceled: true }, { isCanceled: false }] as Record<string, unknown>[];
    const result = calibrate('isCanceled == true', 'count', 'count > 0', rows);
    expect(result.flaggedCount).toBe(1);
    expect(result.distribution).toBeNull();
  });

  it('marks scope as sessions when the aggregation references session', () => {
    const rows = [{ messageLength: 5 }] as Record<string, unknown>[];
    const result = calibrate('messageLength < 30', 'count(session)', '', rows);
    expect(result.scope).toBe('sessions');
  });
});

/* ---- Calibration Serialization ---- */
describe('Calibration serialization', () => {
  it('serializes a calibration result as a markdown comment', () => {
    const rendered = serializeCalibration({
      datasetSize: 1234,
      scope: 'requests',
      flaggedCount: 12,
      flaggedPct: 1.0,
      distribution: { min: 0, max: 100, p25: 10, p50: 50, p75: 75 },
      triggered: true,
      lastRun: '2025-01-01',
    });
    expect(rendered).toContain('<!-- calibration:');
    expect(rendered).toContain('dataset: 1,234 requests');
    expect(rendered).toContain('flagged: 12 (1%)');
    expect(rendered).toContain('p25: 10, p50: 50, p75: 75');
    expect(rendered).toContain('min: 0, max: 100');
    expect(rendered).toContain('triggered: true');
    expect(rendered).toContain('last_run: 2025-01-01');
    expect(rendered.trimEnd().endsWith('-->')).toBe(true);
  });

  it('omits distribution lines when no distribution is available', () => {
    const rendered = serializeCalibration({
      datasetSize: 0,
      scope: 'sessions',
      flaggedCount: 0,
      flaggedPct: 0,
      distribution: null,
      triggered: false,
      lastRun: '2025-01-01',
    });
    expect(rendered).not.toContain('p25');
    expect(rendered).not.toContain('min:');
  });

  it('strips an existing calibration comment block from markdown', () => {
    const md = `# Rule\n\nBody text.\n\n<!-- calibration:\n  dataset: 1 requests\n-->`;
    const stripped = stripCalibration(md);
    expect(stripped).not.toContain('calibration');
    expect(stripped.endsWith('Body text.')).toBe(true);
  });

  it('leaves markdown without calibration intact', () => {
    const md = '# Rule\n\nBody text.';
    expect(stripCalibration(md)).toBe(md);
  });
});

/* ---- Rule Extension parsing – edge cases ---- */
describe('Rule Extensions – edge cases', () => {
  it('parses inline-array requires and skips malformed test cases', () => {
    const md = `---
id: ext-rule
name: Ext
group: prompt-quality
severity: medium
metric: short-messages
requires: [a, b, c]
---

# Filter
messageLength < 30

# Trigger
ratio > 0.1

# Test Cases
- input: { "messageLength": 5 }
  expect: flagged
- input: { not valid json
  expect: clean
- input: { "messageLength": 100 }
  expect: clean
`;
    const ext = parseRuleExtensions(md);
    expect(ext.requires).toEqual(['a', 'b', 'c']);
    expect(ext.metricRef).toBe('short-messages');
    expect(ext.testCases).toHaveLength(2);
    expect(ext.testCases[0].expect).toBe('flagged');
    expect(ext.testCases[1].expect).toBe('clean');
  });

  it('parses extensions from markdown without frontmatter', () => {
    const md = `# Filter
messageLength < 30

# Trigger
ratio > 0.3
`;
    const ext = parseRuleExtensions(md);
    expect(ext.filterExpr).toBe('messageLength < 30');
    expect(ext.triggerExpr).toBe('ratio > 0.3');
    expect(ext.metricRef).toBe('');
    expect(ext.requires).toEqual([]);
  });
});

/* ---- parseMetric – edge cases ---- */
describe('parseMetric – edge cases', () => {
  it('defaults missing scope to requests and missing aggregation to ratio', () => {
    const md = `---
id: simple
name: Simple
---

# Filter
messageLength > 0
`;
    const metric = parseMetric(md);
    expect(metric).not.toBeNull();
    expect(metric!.scope).toBe('requests');
    expect(metric!.aggregationExpr).toBe('ratio');
    expect(metric!.version).toBe(1);
  });

  it('returns null when id or name are missing', () => {
    const md = `---
name: NoId
---

# Filter
messageLength > 0
`;
    expect(parseMetric(md)).toBeNull();
  });
});
