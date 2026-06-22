/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Universal rule pipeline engine.
 *
 * Compiles a Detection Logic block from a rule .md file into an emitter+trigger
 * pair using declarative DSL directives (`scan:`, `match:`, `aggregate:`,
 * `check:`, `examples:`, `severity:`).
 *
 * Also handles:
 *   - **Inheritance** (`extends:` in frontmatter)
 *   - **Test fixture validation** (`# Tests` section)
 *   - **Pattern/fileType resolution** into the DSL evaluation context
 */

import type { DetectionRule, DetectorEmission, RuleSeverity, Session, SessionRequest } from './types';
import { compileFilter, compileTrigger, evaluateTemplate, evaluateExpression } from './dsl/index';
import { getAllRules } from './rule-engine';
import { warnCore } from './log';

/* ================================================================== */
/*  Pipeline Definition                                               */
/* ================================================================== */

export interface Pipeline {
  scan: 'requests' | 'sessions';
  matchExpr?: string;
  aggregate: 'count' | 'ratio';
  checkExpr?: string;
  examplesTemplate?: string;
  severityExpr?: string;
  reduceExprs?: Record<string, string>;
}

export interface DetectorContext {
  reqs: SessionRequest[];
  sessions: Session[];
  skipIdeDetectors: boolean;
}

/* ================================================================== */
/*  Pipeline Parser                                                   */
/* ================================================================== */

/**
 * Parse the Detection Logic block from a rule's raw markdown source.
 * Returns a Pipeline definition.
 */
function mergeLineContinuations(rawLines: string[]): string[] {
  const lines: string[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    let line = rawLines[i];
    while (line.endsWith('\\') && i + 1 < rawLines.length) {
      line = line.slice(0, -1).trimEnd() + ' ' + rawLines[++i];
    }
    lines.push(line);
  }
  return lines;
}

export function parsePipeline(rule: DetectionRule): Pipeline {
  const block = rule.rawSource.match(/```detect\s*\n([\s\S]*?)```/);
  if (!block) {
    // No detection logic → default pipeline that never triggers
    return { scan: rule.scope === 'sessions' ? 'sessions' : 'requests', aggregate: 'count' };
  }

  const rawLines = block[1].split('\n').map(l => l.trim()).filter(Boolean);
  const lines = mergeLineContinuations(rawLines);
  const pipeline: Pipeline = {
    scan: rule.scope === 'sessions' ? 'sessions' : 'requests',
    aggregate: 'count',
  };

  for (const line of lines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx < 0) continue;
    const rawKey = line.substring(0, colonIdx).trim();
    const key = rawKey.toLowerCase();
    const value = line.substring(colonIdx + 1).trim();

    switch (key) {
      case 'scan':
        pipeline.scan = value === 'sessions' ? 'sessions' : 'requests';
        break;
      case 'match':
        pipeline.matchExpr = value;
        break;
      case 'aggregate':
        pipeline.aggregate = value === 'ratio' ? 'ratio' : 'count';
        break;
      case 'check':
        pipeline.checkExpr = value;
        break;
      case 'examples':
        pipeline.examplesTemplate = value;
        break;
      case 'severity':
        pipeline.severityExpr = value;
        break;
      default:
        // Any other key:value is treated as a reduce expression (preserve original case)
        if (rawKey && value && key !== 'reduce') {
          if (!pipeline.reduceExprs) pipeline.reduceExprs = {};
          pipeline.reduceExprs[rawKey] = value;
        }
        break;
    }
  }

  return pipeline;
}

/* ================================================================== */
/*  Rule Context Builder                                              */
/* ================================================================== */

/**
 * Build the evaluation context that gets merged into each row when
 * the DSL filter runs. This injects thresholds, patterns, and fileTypes
 * from the rule's frontmatter so expressions can reference them.
 */
function buildRuleContext(rule: DetectionRule): Record<string, unknown> {
  const ctx: Record<string, unknown> = {};

  // thresholds.xxx → thresholds object
  if (rule.thresholds) ctx.thresholds = rule.thresholds;
  // patterns.xxx → patterns object
  if (rule.patterns && Object.keys(rule.patterns).length > 0) ctx.patterns = rule.patterns;
  // fileTypes.xxx → fileTypes object
  if (rule.fileTypes && Object.keys(rule.fileTypes).length > 0) ctx.fileTypes = rule.fileTypes;

  return ctx;
}

/* ================================================================== */
/*  Pipeline Executor                                                 */
/* ================================================================== */

/**
 * Execute a pipeline against data to produce a DetectorEmission.
 */
function buildDuplicateGroupExamples(extra: Record<string, unknown>): string[] | undefined {
  const dupes = extra.dupes;
  if (!dupes || typeof dupes !== 'object') return undefined;

  const groups = (dupes as { groups?: unknown }).groups;
  if (!Array.isArray(groups)) return undefined;

  const examples = groups.slice(0, 3)
    .map(group => {
      if (!group || typeof group !== 'object') return '';

      const record = group as Record<string, unknown>;
      const sample = typeof record.sample === 'string'
        ? record.sample
        : typeof record.key === 'string'
          ? record.key
          : '';

      if (!sample) return '';

      const count = typeof record.count === 'number' ? record.count : 0;
      const clipped = sample.length > 80 ? `${sample.substring(0, 77)}...` : sample;

      return count > 0 ? `"${clipped}" (repeated ${count}x)` : `"${clipped}"`;
    })
    .filter(Boolean);

  return examples.length > 0 ? examples : undefined;
}
function buildExamples(
  matched: Record<string, unknown>[],
  pipeline: Pipeline,
  ruleCtx: Record<string, unknown>,
  count: number,
  total: number,
  ratio: number,
  extra: Record<string, unknown>,
): string[] {
  const duplicateGroupExamples = buildDuplicateGroupExamples(extra);
  if (duplicateGroupExamples) return duplicateGroupExamples;

  const examples: string[] = [];
  for (const row of matched.slice(0, 3)) {
    if (pipeline.examplesTemplate) {
      const mergedRow = { ...row, ...ruleCtx, count, total, ratio, ...extra };
      examples.push(evaluateTemplate(pipeline.examplesTemplate, mergedRow));
    } else {
      const msgText = row.messageText;
      const wsName = row.workspaceName;
      const msg = typeof msgText === 'string' ? msgText : (typeof wsName === 'string' ? wsName : '');
      if (msg) examples.push(msg.substring(0, 80));
    }
  }
  return examples;
}

export function executePipeline(
  pipeline: Pipeline,
  rule: DetectionRule,
  ctx: DetectorContext,
): DetectorEmission {
  // ── Declarative pipeline path ──
  const rows: Record<string, unknown>[] = pipeline.scan === 'sessions'
    ? ctx.sessions as unknown as Record<string, unknown>[]
    : ctx.reqs as unknown as Record<string, unknown>[];

  if (rows.length === 0) return EMPTY_EMISSION;

  const ruleCtx = buildRuleContext(rule);

  // Compile match filter
  const matchFn = pipeline.matchExpr
    ? compileFilterWithContext(pipeline.matchExpr, ruleCtx)
    : () => true;

  // Filter rows
  const matched = rows.filter(matchFn);

  // Aggregate
  let count = matched.length;
  let total = rows.length;
  let ratio = total > 0 ? count / total : 0;

  // Evaluate reduce expressions to compute extra fields
  const extra: Record<string, unknown> = {};
  if (pipeline.reduceExprs) {
    const reduceCtx: Record<string, unknown> = {
      ...ruleCtx,
      matched,
      all: rows,
      allReqs: ctx.reqs,
      allSessions: ctx.sessions,
      count,
      total,
      ratio,
      extra,
    };
    for (const [key, expr] of Object.entries(pipeline.reduceExprs)) {
      const val = evaluateExpression(expr, reduceCtx);
      extra[key] = val;
      // Make each computed value available to subsequent expressions
      reduceCtx[key] = val;
      reduceCtx.extra = { ...extra };
    }
  }

  // Override count/total/ratio from reduce expressions (emitCount, emitTotal, emitRatio)
  if (typeof extra.emitCount === 'number') count = extra.emitCount;
  if (typeof extra.emitTotal === 'number') total = extra.emitTotal;
  if (extra.emitCount !== undefined || extra.emitTotal !== undefined) {
    ratio = total > 0 ? count / total : 0;
  }
  if (typeof extra.emitRatio === 'number') ratio = extra.emitRatio;

  // Generate examples
  const examples = buildExamples(matched, pipeline, ruleCtx, count, total, ratio, extra);

  // Dynamic severity
  let dynamicSeverity: RuleSeverity | undefined;
  if (pipeline.severityExpr) {
    try {
      const severityFn = compileTrigger(pipeline.severityExpr);
      if (severityFn({ count, total, ratio, extra })) {
        dynamicSeverity = 'high';
      }
    } catch { /* ignore severity expression errors */ }
  }

  return { count, total, ratio, examples, extra, dynamicSeverity, matchedRows: matched };
}

/**
 * Check whether a pipeline's trigger condition is met.
 */
export function checkPipelineTrigger(
  pipeline: Pipeline,
  emission: DetectorEmission,
  rule: DetectionRule,
): boolean {
  if (!pipeline.checkExpr) {
    // Default: trigger if any matches
    return emission.count > 0;
  }

  // Resolve threshold references in the check expression
  let resolved = pipeline.checkExpr;
  if (rule.thresholds) {
    for (const [k, v] of Object.entries(rule.thresholds)) {
      resolved = resolved.replaceAll(`thresholds.${k}`, String(v));
    }
  }

  try {
    const triggerFn = compileTrigger(resolved);
    return triggerFn({
      count: emission.count,
      total: emission.total,
      ratio: emission.ratio,
      extra: emission.extra,
    });
  } catch {
    return emission.count > 0;
  }
}

/* ================================================================== */
/*  Inheritance Resolver                                              */
/* ================================================================== */

/**
 * Resolve rule inheritance. If a rule has `extends: parent-id`, merge
 * the parent's fields (thresholds, patterns, fileTypes, templates) with
 * the child's overrides.
 */
export function resolveInheritance(rule: DetectionRule, visited: Set<string> = new Set()): DetectionRule {
  if (!rule.extendsRule) return rule;

  if (visited.has(rule.id)) {
    warnCore('Pipeline', `Circular inheritance detected: ${[...visited].join(' -> ')} -> ${rule.id}`);
    return rule;
  }
  visited.add(rule.id);

  const allRules = getAllRules();
  const parent = allRules.find(r => r.id === rule.extendsRule);
  if (!parent) {
    warnCore('Pipeline', `Inheritance: parent rule '${rule.extendsRule}' not found for '${rule.id}'`);
    return rule;
  }

  // Resolve parent first (chains supported)
  const resolvedParent = resolveInheritance(parent, visited);

  return {
    ...resolvedParent,
    // Child overrides:
    id: rule.id,
    name: rule.name || resolvedParent.name,
    severity: rule.severity || resolvedParent.severity,
    group: rule.group || resolvedParent.group,
    scope: rule.scope || resolvedParent.scope,
    description: rule.description || resolvedParent.description,
    descriptionTemplate: rule.descriptionTemplate || resolvedParent.descriptionTemplate,
    suggestionTemplate: rule.suggestionTemplate || resolvedParent.suggestionTemplate,
    exampleTemplate: rule.exampleTemplate || resolvedParent.exampleTemplate,
    // Merge thresholds (child wins)
    thresholds: { ...resolvedParent.thresholds, ...rule.thresholds },
    // Merge patterns (child wins per key)
    patterns: { ...resolvedParent.patterns, ...rule.patterns },
    // Merge fileTypes (child wins per key)
    fileTypes: { ...resolvedParent.fileTypes, ...rule.fileTypes },
    // Keep child's detection logic if present
    rawSource: rule.rawSource,
    conditions: rule.conditions.length > 0 ? rule.conditions : resolvedParent.conditions,
    tags: rule.tags.length > 0 ? rule.tags : resolvedParent.tags,
    version: rule.version || resolvedParent.version,
    source: rule.source,
    sourceFilePath: rule.sourceFilePath,
    tests: rule.tests.length > 0 ? rule.tests : resolvedParent.tests,
  };
}

/* ================================================================== */
/*  Helpers                                                           */
/* ================================================================== */

const EMPTY_EMISSION: DetectorEmission = {
  count: 0, total: 0, ratio: 0, examples: [], extra: {},
};

/**
 * Compile a DSL filter expression with rule-level context merged into
 * each row's evaluation scope.
 */
function compileFilterWithContext(
  expr: string,
  ruleCtx: Record<string, unknown>,
): (row: Record<string, unknown>) => boolean {
  // Resolve thresholds.xxx references to literal values
  let resolved = expr;
  const thresholds = ruleCtx.thresholds as Record<string, number> | undefined;
  if (thresholds) {
    for (const [k, v] of Object.entries(thresholds)) {
      resolved = resolved.replaceAll(`thresholds.${k}`, String(v));
    }
  }

  const filterFn = compileFilter(resolved);
  return (row: Record<string, unknown>) => {
    const mergedRow = { ...row, ...ruleCtx };
    return filterFn(mergedRow);
  };
}
