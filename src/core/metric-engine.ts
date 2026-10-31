/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Metric engine: parses .metric.md files, evaluates metrics via the DSL,
 * runs auto-calibration, validates test fixtures, and resolves rule dependencies.
 *
 * A .metric.md file defines a reusable data query:
 *
 *   ---
 *   id: short-messages
 *   name: Short Messages
 *   scope: requests
 *   version: 1
 *   ---
 *
 *   # Filter
 *   messageLength < 30 AND messageLength > 0
 *
 *   # Metric
 *   ratio
 *
 *   # Examples
 *   "{{messageText | truncate:80}}" ({{messageLength}} chars)
 */

import type { DetectorEmission } from './types/rule-types';
import {
  compileFilter,
  compileTrigger,
  parseAggregation,
  computeAggregation,
  evaluateTemplate,
} from './dsl/index';
import { fillTemplate } from './rule-parser';

/* ================================================================== */
/*  Metric Definition (parsed from .metric.md)                        */
/* ================================================================== */

export interface MetricDefinition {
  id: string;
  name: string;
  scope: 'requests' | 'sessions';
  version: number;
  tags: string[];
  /** Raw filter expression (DSL) */
  filterExpr: string;
  /** Aggregation expression: ratio, count, avg(field), etc. */
  aggregationExpr: string;
  /** Example template for matched items */
  exampleTemplate: string;
  /** The full raw markdown source */
  rawSource: string;
  /** Where this metric was loaded from */
  source: 'built-in' | 'personal' | 'project';
  sourceFilePath: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return `${value}`;
  }
  return '';
}

function numericValue(value: unknown): number | null {
  if (typeof value === 'number' && !Number.isNaN(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function stringListValue(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(item => stringValue(item)).filter(Boolean);
  const single = stringValue(value);
  return single ? single.split(/[,\s]+/).filter(Boolean) : [];
}

function firstRowText(row: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const text = stringValue(row[key]);
    if (text) return text;
  }
  return '';
}

/* ================================================================== */
/*  Metric Parser                                                     */
/* ================================================================== */

export function parseMetric(markdown: string): MetricDefinition | null {
  const fmMatch = markdown.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  if (!fmMatch) return null;

  const fm = parseYamlLike(fmMatch[1]);
  const id = stringValue(fm.id);
  const name = stringValue(fm.name);
  if (!id || !name) return null;

  const body = markdown.substring(fmMatch[0].length);
  const filterExpr = extractSection(body, 'Filter') || '';
  const aggregationExpr = extractSection(body, 'Metric') || 'ratio';
  const exampleTemplate = extractSection(body, 'Examples') || '';

  return {
    id,
    name,
    scope: fm.scope === 'sessions' ? 'sessions' : 'requests',
    version: numericValue(fm.version) || 1,
    tags: stringListValue(fm.tags),
    filterExpr,
    aggregationExpr,
    exampleTemplate,
    rawSource: markdown,
    source: 'built-in',
    sourceFilePath: '',
  };
}

/* ================================================================== */
/*  Enhanced Rule Extensions (parsed from rule .md # sections)        */
/* ================================================================== */

export interface RuleExtensions {
  /** Inline filter expression (from # Filter section) */
  filterExpr: string;
  /** Trigger expression (from # Trigger section) */
  triggerExpr: string;
  /** Referenced metric ID (from frontmatter metric: field) */
  metricRef: string;
  /** Rule dependency IDs (from frontmatter requires: field) */
  requires: string[];
  /** Test fixtures */
  testCases: TestCase[];
}

export interface TestCase {
  input: Record<string, unknown>;
  expect: 'flagged' | 'clean';
}

/**
 * Extract extended sections from a rule markdown body + frontmatter.
 * Called after the standard parseRule() to augment with DSL-powered sections.
 */
export function parseRuleExtensions(markdown: string): RuleExtensions {
  const fmMatch = markdown.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  const fm = fmMatch ? parseYamlLike(fmMatch[1]) : {};
  const body = fmMatch ? markdown.substring(fmMatch[0].length) : markdown;

  const filterExpr = extractSection(body, 'Filter') || '';
  const triggerExpr = extractSection(body, 'Trigger') || '';
  const metricRef = stringValue(fm.metric);
  const requires = stringListValue(fm.requires);
  const testCases = parseTestCases(body);

  return { filterExpr, triggerExpr, metricRef, requires, testCases };
}

/* ================================================================== */
/*  Metric Evaluation                                                 */
/* ================================================================== */

/**
 * Evaluate a metric (from .metric.md or inline rule # Filter) against data.
 * Returns a DetectorEmission.
 */
export function evaluateMetric(
  filterExpr: string,
  aggregationExpr: string,
  exampleTemplate: string,
  rows: Record<string, unknown>[],
  thresholds?: Record<string, number>,
): DetectorEmission {
  // Resolve threshold placeholders in the filter expression
  let resolvedFilter = filterExpr;
  if (thresholds) {
    resolvedFilter = fillTemplate(filterExpr, { thresholds } as unknown as Record<string, unknown>);
  }

  const filterFn = compileFilter(resolvedFilter);
  const matched = rows.filter(filterFn);
  const agg = parseAggregation(aggregationExpr);
  const value = computeAggregation(agg, matched, rows);

  const count = agg.type === 'count' || agg.type === 'ratio' ? matched.length : value;
  const total = rows.length;
  const ratio = total > 0 ? matched.length / total : 0;

  // Generate examples
  const examples: string[] = [];
  const sampleRows = matched.slice(0, 3);
  for (const row of sampleRows) {
    if (exampleTemplate) {
      examples.push(evaluateTemplate(exampleTemplate, row));
    } else {
      // Default example: first 80 chars of messageText
      const msg = firstRowText(row, 'messageText', 'workspaceName', 'sessionId');
      examples.push(msg.substring(0, 80));
    }
  }

  return {
    count,
    total,
    ratio,
    examples,
    extra: {
      matchedCount: matched.length,
      aggregationType: agg.type,
      ...(agg.field ? { aggregationField: agg.field } : {}),
      ...(agg.type !== 'count' && agg.type !== 'ratio' ? { aggregationValue: value } : {}),
    },
  };
}

/**
 * Evaluate a trigger expression against an emission.
 * Returns true if the rule should fire.
 */
export function evaluateTrigger(
  triggerExpr: string,
  emission: DetectorEmission,
  thresholds?: Record<string, number>,
): boolean {
  if (!triggerExpr.trim()) {
    // Default trigger: any matches = triggered
    return emission.count > 0;
  }

  let resolved = triggerExpr;
  if (thresholds) {
    resolved = fillTemplate(triggerExpr, { thresholds } as unknown as Record<string, unknown>);
  }

  const triggerFn = compileTrigger(resolved);
  return triggerFn({
    count: emission.count,
    total: emission.total,
    ratio: emission.ratio,
    extra: emission.extra,
  });
}

/* ================================================================== */
/*  Auto-Calibration                                                  */
/* ================================================================== */

export interface CalibrationResult {
  datasetSize: number;
  scope: string;
  flaggedCount: number;
  flaggedPct: number;
  /** Field distribution stats (for the metric's filter field) */
  distribution: {
    p25: number;
    p50: number;
    p75: number;
    min: number;
    max: number;
  } | null;
  triggered: boolean;
  lastRun: string;
}

/**
 * Run auto-calibration: evaluate the metric against real data and produce
 * distribution stats. This is injected back into the .md file as a comment.
 */
export function calibrate(
  filterExpr: string,
  aggregationExpr: string,
  triggerExpr: string,
  rows: Record<string, unknown>[],
  thresholds?: Record<string, number>,
): CalibrationResult {
  const emission = evaluateMetric(filterExpr, aggregationExpr, '', rows, thresholds);
  const triggered = evaluateTrigger(triggerExpr, emission, thresholds);

  // Try to extract the primary field from the filter to compute distribution
  let distribution: CalibrationResult['distribution'] = null;
  const fieldMatch = filterExpr.match(/^(\w[\w.]*)\s*[<>=!]/);
  if (fieldMatch) {
    const field = fieldMatch[1];
    const values = rows.map(r => {
      const parts = field.split('.');
      let v: unknown = r;
      for (const p of parts) {
        if (v == null) return Number.NaN;
        if (typeof v === 'object' && !Array.isArray(v)) v = (v as Record<string, unknown>)[p];
        else if (Array.isArray(v) && p === 'length') return v.length;
        else return Number.NaN;
      }
      return typeof v === 'number' ? v : Number.NaN;
    }).filter(n => !Number.isNaN(n)).sort((a, b) => a - b);

    if (values.length > 0) {
      distribution = {
        min: values[0],
        max: values[values.length - 1],
        p25: values[Math.floor(values.length * 0.25)],
        p50: values[Math.floor(values.length * 0.50)],
        p75: values[Math.floor(values.length * 0.75)],
      };
    }
  }

  return {
    datasetSize: rows.length,
    scope: aggregationExpr.includes('session') ? 'sessions' : 'requests',
    flaggedCount: emission.count,
    flaggedPct: rows.length > 0 ? Math.round((emission.count / rows.length) * 1000) / 10 : 0,
    distribution,
    triggered,
    lastRun: new Date().toISOString().split('T')[0],
  };
}

/**
 * Serialize a CalibrationResult as a markdown comment block.
 */
export function serializeCalibration(cal: CalibrationResult): string {
  const lines = ['<!-- calibration:'];
  lines.push(`  dataset: ${cal.datasetSize.toLocaleString('en-US')} ${cal.scope}`);
  lines.push(`  flagged: ${cal.flaggedCount.toLocaleString('en-US')} (${cal.flaggedPct}%)`);
  if (cal.distribution) {
    lines.push(`  p25: ${cal.distribution.p25}, p50: ${cal.distribution.p50}, p75: ${cal.distribution.p75}`);
    lines.push(`  min: ${cal.distribution.min}, max: ${cal.distribution.max}`);
  }
  lines.push(`  triggered: ${cal.triggered}`);
  lines.push(`  last_run: ${cal.lastRun}`);
  lines.push('-->');
  return lines.join('\n');
}

/**
 * Strip any existing calibration comment from markdown source.
 */
export function stripCalibration(markdown: string): string {
  return markdown.replace(/\n?<!-- calibration:[\s\S]*?-->\s*$/, '').trimEnd();
}

/* ================================================================== */
/*  Test Fixture Runner                                               */
/* ================================================================== */

export interface TestResult {
  index: number;
  expected: 'flagged' | 'clean';
  actual: 'flagged' | 'clean';
  passed: boolean;
  emission?: DetectorEmission;
}

/**
 * Run test cases for a rule/metric.
 * Each test case provides a partial input object and the expected outcome.
 * The engine evaluates the filter + trigger against a synthetic dataset
 * containing just the test input.
 */
export function runTestCases(
  filterExpr: string,
  aggregationExpr: string,
  triggerExpr: string,
  testCases: TestCase[],
  thresholds?: Record<string, number>,
): TestResult[] {
  return testCases.map((tc, index) => {
    // Create a minimal dataset with just this one row
    const row = { ...defaultRow(), ...tc.input };
    const rows = [row];

    const emission = evaluateMetric(filterExpr, aggregationExpr, '', rows, thresholds);
    const triggered = evaluateTrigger(triggerExpr, emission, thresholds);
    const actual = triggered ? 'flagged' : 'clean';

    return {
      index,
      expected: tc.expect,
      actual,
      passed: tc.expect === actual,
      emission,
    };
  });
}

/** Default row values for test fixtures (zero/empty for all fields). */
function defaultRow(): Record<string, unknown> {
  return {
    requestId: 'test-req',
    timestamp: Date.now(),
    messageText: '',
    responseText: '',
    isCanceled: false,
    agentName: '',
    agentMode: 'chat',
    modelId: 'gpt-4.1',
    toolsUsed: [],
    editedFiles: [],
    referencedFiles: [],
    slashCommand: '',
    variableKinds: {},
    customInstructions: [],
    skillsUsed: [],
    firstProgress: null,
    totalElapsed: null,
    messageLength: 0,
    responseLength: 0,
    userCode: [],
    aiCode: [],
    toolConfirmations: [],
    promptTokens: null,
    completionTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    workType: '',
    humanTurn: true,
    // Session fields
    sessionId: 'test-session',
    workspaceId: 'test-ws',
    workspaceName: 'Test Workspace',
    location: '/tmp/test',
    harness: 'VS Code',
    creationDate: Date.now(),
    lastMessageDate: Date.now(),
    requestCount: 1,
    requests: [],
  };
}

/* ================================================================== */
/*  Dependency Resolution                                             */
/* ================================================================== */

export interface DependencyGraph {
  /** Topological order of rule IDs (dependencies before dependents) */
  order: string[];
  /** Rules with unresolvable dependencies */
  errors: { ruleId: string; missing: string[] }[];
}

/**
 * Resolve a dependency graph for rules that have `requires:` fields.
 * Returns a topological ordering so dependent rules run after their prerequisites.
 */
export function resolveDependencies(
  ruleRequires: Map<string, string[]>,
): DependencyGraph {
  const allIds = new Set(ruleRequires.keys());
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const order: string[] = [];
  const errors: DependencyGraph['errors'] = [];

  function visit(id: string): void {
    if (visited.has(id)) return;
    if (visiting.has(id)) return; // cycle - skip

    visiting.add(id);
    const deps = ruleRequires.get(id) || [];
    const missing = deps.filter(d => !allIds.has(d));
    if (missing.length > 0) {
      errors.push({ ruleId: id, missing });
    }
    for (const dep of deps) {
      if (allIds.has(dep)) visit(dep);
    }
    visiting.delete(id);
    visited.add(id);
    order.push(id);
  }

  for (const id of allIds) {
    visit(id);
  }

  return { order, errors };
}

/* ================================================================== */
/*  Metric Registry (in-memory store)                                 */
/* ================================================================== */

const METRIC_STORE = new Map<string, MetricDefinition>();

export function registerMetric(metric: MetricDefinition): void {
  METRIC_STORE.set(metric.id, metric);
}

export function getAllMetrics(): MetricDefinition[] {
  return [...METRIC_STORE.values()];
}

export function clearMetrics(): void {
  METRIC_STORE.clear();
}

/* ================================================================== */
/*  Internal helpers                                                  */
/* ================================================================== */

function extractSection(body: string, heading: string): string | null {
  const re = new RegExp(`^#\\s+${heading}\\s*$`, 'mi');
  const match = re.exec(body);
  if (!match) return null;
  const start = match.index + match[0].length;
  const nextHeading = body.indexOf('\n#', start);
  const section = nextHeading >= 0 ? body.substring(start, nextHeading) : body.substring(start);
  return section.trim() || null;
}

function parseYamlLike(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = text.split('\n');
  let currentKey = '';
  let indent = 0;
  const arrayBuffer: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Array item under a key
    if (trimmed.startsWith('- ') && currentKey && indent > 0) {
      arrayBuffer.push(trimmed.substring(2).trim());
      continue;
    }

    // Flush array buffer
    if (arrayBuffer.length > 0 && currentKey) {
      result[currentKey] = arrayBuffer.slice();
      arrayBuffer.length = 0;
    }

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx < 0) continue;

    const key = trimmed.substring(0, colonIdx).trim();
    const val = trimmed.substring(colonIdx + 1).trim();
    currentKey = key;
    indent = line.length - line.trimStart().length;

    if (!val) continue; // Sub-object or array follows

    // Inline array: [a, b, c]
    if (val.startsWith('[') && val.endsWith(']')) {
      result[key] = val.slice(1, -1).split(',').map(s => {
        const t = s.trim();
        const n = Number.parseFloat(t);
        return !Number.isNaN(n) && /^[\d.-]+$/.test(t) ? n : t;
      });
    } else if (val === 'true' || val === 'false') {
      result[key] = val === 'true';
    } else {
      const num = Number.parseFloat(val);
      result[key] = !Number.isNaN(num) && /^[\d.-]+$/.test(val) ? num : val;
    }
  }

  // Flush remaining array
  if (arrayBuffer.length > 0 && currentKey) {
    result[currentKey] = arrayBuffer.slice();
  }

  return result;
}

function parseTestCases(body: string): TestCase[] {
  const section = extractSection(body, 'Test Cases');
  if (!section) return [];

  const cases: TestCase[] = [];

  // Support YAML-like list format:
  // - input: { field: value }
  //   expect: flagged
  const blocks = ('\n' + section).split(/\n\s*-\s+input:/);
  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i];
    try {
      // Extract input JSON
      const inputMatch = block.match(/^\s*(\{[\s\S]*?\})/m);
      const expectMatch = block.match(/expect:\s*(flagged|clean)/i);
      if (inputMatch && expectMatch) {
        const input = JSON.parse(inputMatch[1]) as unknown;
        if (!isRecord(input)) continue;
        const expect = expectMatch[1].toLowerCase() as 'flagged' | 'clean';
        cases.push({ input, expect });
      }
    } catch {
      // Skip unparseable test cases
    }
  }

  return cases;
}
