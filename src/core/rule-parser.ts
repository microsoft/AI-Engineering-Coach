/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Rule parser: reads markdown-based rule definitions and produces DetectionRule objects.
 *
 * Rule file format:
 * ```markdown
 * ---
 * id: lazy-prompting
 * name: Lazy Prompting
 * group: prompt-quality
 * severity: medium
 * scope: requests
 * requiresIdeContext: false
 * version: 1
 * tags: [prompt, quality, short]
 * thresholds:
 *   minChars: 30
 *   maxRatio: 0.3
 *   minSample: 10
 * ---
 *
 * # Description
 * Detects requests with very short prompts that lack sufficient context.
 *
 * # When Triggered
 * {{count}} requests ({{pct}}) are under {{extra.minChars}} characters. Very short prompts often produce poor results.
 *
 * # How to Improve
 * Provide more context in your prompts: describe the intent, constraints, and expected output format.
 *
 * # Examples
 * "{{message}}" ({{extra.charCount}} chars)
 *
 * # Detection Logic
 * ```detect
 * filter: messageLength < thresholds.minChars AND messageLength > 0
 * check: ratio > thresholds.maxRatio AND count > thresholds.minSample
 * ```
 * ```
 */

import { defaultRuleDescription } from './rule-summary';
import { DetectionRule, RuleCondition, RuleSeverity, RuleScope, PracticeGroup, PRACTICE_GROUPS  } from './types';
import { formatInlineList, quoteScalar, readQuotedScalar, splitInlineList } from './frontmatter-values';

interface ParsedFrontmatter {
  id: string;
  name: string;
  group: string;
  severity: string;
  scope?: string;
  requiresIdeContext?: boolean;
  version?: number;
  tags?: string[];
  thresholds?: Record<string, number>;
  patterns?: Record<string, string[]>;
  fileTypes?: Record<string, string[]>;
  extends?: string;
  /** Referenced metric ID (from .metric.md files) */
  metric?: string;
  /** Rule dependency IDs */
  requires?: string[];
}

/**
 * A front matter value with its quotes and escapes processed (see frontmatter-values.ts). A value that
 * isn't one closed quoted scalar is read as before: one quote is stripped from each end.
 */
function parseScalar(raw: string): string {
  const text = raw.trim();
  return readQuotedScalar(text) ?? text.replaceAll(/^['"]|['"]$/g, '');
}

function parseNestedValue(line: string, nestedObj: Record<string, number | string | string[]>): void {
  const colonIdx = line.indexOf(':');
  const k = line.substring(0, colonIdx).trim();
  const v = line.substring(colonIdx + 1).trim();
  if (v.startsWith('[') && v.endsWith(']')) {
    nestedObj[k] = splitInlineList(v.slice(1, -1)).map(item => parseScalar(item));
    return;
  }
  const num = Number.parseFloat(v);
  if (!Number.isNaN(num) && String(num) === v) {
    nestedObj[k] = num;
    return;
  }
  nestedObj[k] = parseScalar(v);
}

function parseTopLevelValue(value: string): unknown {
  if (value.startsWith('[') && value.endsWith(']')) {
    return splitInlineList(value.slice(1, -1)).map(item => parseScalar(item));
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  const num = Number.parseFloat(value);
  if (!Number.isNaN(num) && String(num) === value) return num;
  return parseScalar(value);
}

function parseFrontmatter(raw: string): { frontmatter: ParsedFrontmatter; body: string } | null {
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) return null;

  const yamlBlock = match[1];
  const body = match[2];

  const fm: Record<string, unknown> = {};
  let currentKey = '';
  let inNestedBlock = false;
  const nestedObj: Record<string, number | string | string[]> = {};

  for (const line of yamlBlock.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    if (inNestedBlock) {
      if (/^\s{2,}/.test(line) && line.includes(':')) {
        parseNestedValue(line, nestedObj);
        continue;
      }
      fm[currentKey] = { ...nestedObj };
      inNestedBlock = false;
    }

    const kvMatch = trimmed.match(/^(\w[\w-]*):\s*(.*)$/);
    if (!kvMatch) continue;

    const [, key, rawValue] = kvMatch;
    const value = rawValue.trim();

    if (value === '' || value === '|') {
      currentKey = key;
      inNestedBlock = true;
      for (const k of Object.keys(nestedObj)) delete nestedObj[k];
      continue;
    }

    fm[key] = parseTopLevelValue(value);
  }

  if (inNestedBlock) {
    fm[currentKey] = { ...nestedObj };
  }

  return { frontmatter: fm as unknown as ParsedFrontmatter, body };
}

function parseSection(body: string, heading: string): string {
  // Find the heading, then capture everything until the next heading or true end-of-string.
  // We avoid the 'm' flag on `$` which would stop at end-of-line; instead we use
  // a negative lookahead `(?![\s\S])` as a true end-of-string anchor.
  const regex = new RegExp(`^#+\\s+${heading}\\s*\\n([\\s\\S]*?)(?=^#+\\s|(?![\\s\\S]))`, 'mi');
  const match = body.match(regex);
  return match ? match[1].trim() : '';
}

function parseDetectionLogic(body: string): RuleCondition[] {
  const logicBlock = body.match(/```detect\s*\n([\s\S]*?)```/);
  if (!logicBlock) return [];

  const lines = logicBlock[1].split('\n').filter(l => l.trim());
  const conditions: RuleCondition[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith('filter:')) {
      conditions.push(parseFilterLine(trimmed.slice(7).trim()));
    } else if (trimmed.startsWith('check:')) {
      conditions.push(parseCheckLine(trimmed.slice(6).trim()));
    } else if (trimmed.startsWith('aggregate:')) {
      conditions.push(parseAggregateLine(trimmed.slice(10).trim()));
    } else if (trimmed.startsWith('group-by:')) {
      conditions.push({ type: 'group-by', field: trimmed.slice(9).trim() });
    } else if (trimmed.startsWith('match:')) {
      const pattern = trimmed.slice(6).trim();
      conditions.push({ type: 'regex-match', pattern, flags: 'i' });
    } else if (trimmed.startsWith('custom:')) {
      conditions.push({ type: 'custom', field: trimmed.slice(7).trim() });
    }
  }

  return conditions;
}

function parseFilterLine(expr: string): RuleCondition {
  // Parse expressions like: messageLength < thresholds.minChars AND messageLength > 0
  const parts = expr.split(/\s+AND\s+/i);
  if (parts.length > 1) {
    return {
      type: 'filter-requests',
      logic: 'and',
      conditions: parts.map(p => parseSingleCondition(p.trim())),
    };
  }
  const orParts = expr.split(/\s+OR\s+/i);
  if (orParts.length > 1) {
    return {
      type: 'filter-requests',
      logic: 'or',
      conditions: orParts.map(p => parseSingleCondition(p.trim())),
    };
  }
  return parseSingleCondition(expr);
}

function parseCheckLine(expr: string): RuleCondition {
  const parts = expr.split(/\s+AND\s+/i);
  const conditions = parts.map(p => {
    const trimmed = p.trim();
    if (trimmed.startsWith('ratio')) {
      const match = trimmed.match(/ratio\s*(>|<|>=|<=)\s*(.+)/);
      if (match) {
        return {
          type: 'ratio-check' as const,
          op: parseOp(match[1]),
          threshold: parseValue(match[2]) as number,
        };
      }
    }
    if (trimmed.startsWith('count')) {
      const match = trimmed.match(/count\s*(>|<|>=|<=)\s*(.+)/);
      if (match) {
        return {
          type: 'count-check' as const,
          op: parseOp(match[1]),
          value: parseValue(match[2]),
        };
      }
    }
    return parseSingleCondition(trimmed);
  });

  if (conditions.length === 1) return conditions[0];
  return { type: 'filter-requests', logic: 'and', conditions: conditions };
}

function parseSingleCondition(expr: string): RuleCondition {
  const match = expr.match(/^(\S+)\s*(<=|>=|!=|<|>|==|=|includes|not-includes|matches|not-matches)\s*(.+)$/);
  if (!match) return { type: 'field-check', field: expr };

  const [, field, rawOp, rawVal] = match;
  return {
    type: 'field-check',
    field,
    op: parseOp(rawOp),
    value: parseValue(rawVal),
  };
}

function parseOp(op: string): RuleCondition['op'] {
  switch (op) {
    case '<': return 'lt';
    case '>': return 'gt';
    case '<=': return 'lte';
    case '>=': return 'gte';
    case '==': case '=': return 'eq';
    case '!=': return 'ne';
    default: return op as RuleCondition['op'];
  }
}

function parseValue(val: string): string | number | boolean {
  const trimmed = val.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  const num = Number.parseFloat(trimmed);
  if (!Number.isNaN(num) && /^[\d.]+$/.test(trimmed)) return num;
  // References like thresholds.xxx stay as strings
  return trimmed;
}

function parseAggregateLine(expr: string): RuleCondition {
  const match = expr.match(/^(\w+)\((\S+)\)\s*(>|<|>=|<=)\s*(.+)$/);
  if (match) {
    return {
      type: 'aggregate',
      aggregation: match[1] as RuleCondition['aggregation'],
      field: match[2],
      op: parseOp(match[3]),
      value: parseValue(match[4]),
    };
  }
  return { type: 'aggregate', field: expr };
}

function extractRuleMaps(fm: ParsedFrontmatter): {
  thresholds: Record<string, number>;
  patterns: Record<string, string[]>;
  fileTypes: Record<string, string[]>;
} {
  const rawThresholds = fm.thresholds as Record<string, number | string | string[]> | undefined;
  const thresholds: Record<string, number> = {};
  if (rawThresholds) {
    for (const [k, v] of Object.entries(rawThresholds)) {
      if (typeof v === 'number') thresholds[k] = v;
    }
  }

  const patterns: Record<string, string[]> = {};
  const rawPatterns = fm.patterns as Record<string, string | string[]> | undefined;
  if (rawPatterns) {
    for (const [k, v] of Object.entries(rawPatterns)) {
      if (Array.isArray(v)) patterns[k] = v;
      else if (typeof v === 'string') patterns[k] = [v];
    }
  }

  const fileTypes: Record<string, string[]> = {};
  const rawFileTypes = fm.fileTypes as Record<string, string | string[]> | undefined;
  if (rawFileTypes) {
    for (const [k, v] of Object.entries(rawFileTypes)) {
      if (Array.isArray(v)) fileTypes[k] = v;
      else if (typeof v === 'string') fileTypes[k] = [v];
    }
  }

  return { thresholds, patterns, fileTypes };
}

const VALID_GROUPS = new Set(Object.keys(PRACTICE_GROUPS));
const VALID_SEVERITIES = new Set<RuleSeverity>(['high', 'medium', 'low']);
const VALID_SCOPES = new Set<RuleScope>(['requests', 'sessions', 'both']);

export function parseRule(markdown: string): DetectionRule | null {
  const parsed = parseFrontmatter(markdown);
  if (!parsed) return null;

  const { frontmatter: fm, body } = parsed;

  if (!fm.id || !fm.name || !fm.group || !fm.severity) return null;
  if (!VALID_GROUPS.has(fm.group)) return null;
  if (!VALID_SEVERITIES.has(fm.severity as RuleSeverity)) return null;

  const scope = (fm.scope || 'requests') as RuleScope;
  if (!VALID_SCOPES.has(scope)) return null;

  const description = parseSection(body, 'Description');
  const descriptionTemplate = parseSection(body, 'When Triggered');
  const suggestionTemplate = parseSection(body, 'How to Improve');
  const exampleTemplate = parseSection(body, 'Examples');
  const conditions = parseDetectionLogic(body);
  const tests = parseTestFixtures(body);

  const { thresholds, patterns, fileTypes } = extractRuleMaps(fm);

  return {
    id: fm.id,
    name: fm.name,
    group: fm.group as PracticeGroup,
    severity: fm.severity as RuleSeverity,
    requiresIdeContext: fm.requiresIdeContext ?? false,
    scope,
    description: description || defaultRuleDescription(fm.name),
    descriptionTemplate: descriptionTemplate || '{{count}} occurrences detected.',
    suggestionTemplate: suggestionTemplate || 'Review your practices.',
    exampleTemplate: exampleTemplate || '',
    maxExamples: 3,
    conditions,
    thresholds,
    patterns,
    fileTypes,
    extendsRule: fm.extends ? String(fm.extends) : undefined,
    tests,
    source: 'built-in',
    sourceFilePath: '',
    version: fm.version || 1,
    tags: fm.tags || [],
    rawSource: markdown,
  };
}

/**
 * Parse # Tests section from rule body.
 * Format: ```test blocks with JSON-like lines: {key: val, ...} -> triggered|clean
 */
function parseTestFixtures(body: string): Array<{ input: Record<string, unknown>; expect: 'triggered' | 'clean' }> {
  const block = body.match(/```test\s*\n([\s\S]*?)```/);
  if (!block) return [];
  const tests: Array<{ input: Record<string, unknown>; expect: 'triggered' | 'clean' }> = [];
  for (const line of block[1].split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const arrowIdx = trimmed.lastIndexOf('->');
    if (arrowIdx < 0) continue;
    const jsonPart = trimmed.substring(0, arrowIdx).trim();
    const expectPart = trimmed.substring(arrowIdx + 2).trim().toLowerCase();
    if (expectPart !== 'triggered' && expectPart !== 'clean') continue;
    try {
      // Convert relaxed JSON to strict: add quotes to keys
      const strict = jsonPart.replaceAll(/(\w+)\s*:/g, '"$1":').replaceAll('\'', '"');
      const input = JSON.parse(strict) as Record<string, unknown>;
      tests.push({ input, expect: expectPart });
    } catch { /* skip unparseable lines */ }
  }
  return tests;
}

/**
 * Serialize a DetectionRule back to markdown format.
 */
export function serializeRule(rule: DetectionRule): string {
  const lines: string[] = ['---'];
  lines.push(`id: ${rule.id}`);
  lines.push(`name: ${rule.name}`);
  lines.push(`group: ${rule.group}`);
  lines.push(`severity: ${rule.severity}`);
  lines.push(`scope: ${rule.scope}`);
  if (rule.requiresIdeContext) lines.push(`requiresIdeContext: true`);
  lines.push(`version: ${rule.version}`);
  if (rule.tags.length > 0) lines.push(`tags: ${formatInlineList(rule.tags)}`);
  if (rule.extendsRule) lines.push(`extends: ${rule.extendsRule}`);
  if (Object.keys(rule.thresholds).length > 0) {
    lines.push('thresholds:');
    for (const [k, v] of Object.entries(rule.thresholds)) {
      lines.push(`  ${k}: ${v}`);
    }
  }
  if (Object.keys(rule.patterns).length > 0) {
    lines.push('patterns:');
    for (const [k, v] of Object.entries(rule.patterns)) {
      lines.push(`  ${k}: [${v.map(s => quoteScalar(s)).join(', ')}]`);
    }
  }
  if (Object.keys(rule.fileTypes).length > 0) {
    lines.push('fileTypes:');
    for (const [k, v] of Object.entries(rule.fileTypes)) {
      lines.push(`  ${k}: ${formatInlineList(v)}`);
    }
  }
  lines.push('---');
  lines.push('');
  lines.push(`# Description`);
  lines.push(rule.description);
  lines.push('');
  lines.push(`# When Triggered`);
  lines.push(rule.descriptionTemplate);
  lines.push('');
  lines.push(`# How to Improve`);
  lines.push(rule.suggestionTemplate);
  lines.push('');
  if (rule.exampleTemplate) {
    lines.push(`# Examples`);
    lines.push(rule.exampleTemplate);
    lines.push('');
  }
  if (rule.conditions.length > 0) {
    lines.push(`# Detection Logic`);
    lines.push('```detect');
    for (const c of rule.conditions) {
      lines.push(serializeCondition(c));
    }
    lines.push('```');
    lines.push('');
  }
  return lines.join('\n');
}

function serializeCondition(c: RuleCondition): string {
  if (c.type === 'custom') return `custom: ${c.field || ''}`;
  if (c.type === 'filter-requests' || c.type === 'filter-sessions') {
    if (c.conditions && c.conditions.length > 0) {
      const joiner = c.logic === 'or' ? ' OR ' : ' AND ';
      return `filter: ${c.conditions.map(serializeSubCondition).join(joiner)}`;
    }
    return `filter: ${serializeSubCondition(c)}`;
  }
  if (c.type === 'ratio-check') return `check: ratio ${opToStr(c.op)} ${c.threshold}`;
  if (c.type === 'count-check') return `check: count ${opToStr(c.op)} ${c.value}`;
  if (c.type === 'aggregate') return `aggregate: ${c.aggregation || 'count'}(${c.field || ''}) ${opToStr(c.op)} ${c.value}`;
  if (c.type === 'regex-match') return `match: ${c.pattern}`;
  if (c.type === 'group-by') return `group-by: ${c.field}`;
  return `filter: ${serializeSubCondition(c)}`;
}

function serializeSubCondition(c: RuleCondition): string {
  if (!c.field) return '';
  return `${c.field} ${opToStr(c.op)} ${c.value ?? ''}`;
}

function opToStr(op: RuleCondition['op']): string {
  switch (op) {
    case 'lt': return '<';
    case 'gt': return '>';
    case 'lte': return '<=';
    case 'gte': return '>=';
    case 'eq': return '==';
    case 'ne': return '!=';
    default: return op || '==';
  }
}

/**
 * Fill a template string with variables.
 * Supports {{var}}, {{extra.var}}, and simple number formatting.
 */
export function fillTemplate(template: string, vars: Record<string, unknown>): string {
  return template.replaceAll(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_match, path: string) => {
    const parts = path.split('.');
    let val: unknown = vars;
    for (const p of parts) {
      if (val && typeof val === 'object') val = (val as Record<string, unknown>)[p];
      else return '';
    }
    if (typeof val === 'number') {
      if (Number.isInteger(val)) return String(val);
      return val.toFixed(1);
    }
    if (val == null) return '';
    if (typeof val === 'string') return val;
    if (typeof val === 'boolean') return String(val);
    if (Array.isArray(val)) return val.join(', ');
    return JSON.stringify(val);
  });
}
