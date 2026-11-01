/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Rule engine: loads detection rules from markdown files and bridges them with
 * the existing detector functions. Each rule's metadata (thresholds, description
 * templates, severity) is configurable, while the detection logic delegates to
 * the battle-tested detector implementations.
 *
 * This module also supports evaluating rules against live data for the preview
 * feature in the Rule Editor page.
 */

import { DetectionRule, DetectorEmission, RulePreviewStats, RuleEvalResult, RuleTemplateVars, AntiPattern, PracticeGroup, Session, SessionRequest  } from './types';
import type { RuleFailure } from './types';
import { parseRule, fillTemplate, serializeRule } from './rule-parser';
import { patchThresholds } from './rule-thresholds';
import { warnCore } from './log';

/* ---- Multi-layer rule storage ---- */

// Rule markdown sources keyed by rule ID, per layer.
const BUILTIN_RULE_SOURCES: Record<string, string> = {};
const PERSONAL_RULE_SOURCES: Record<string, { source: string; filePath: string }> = {};
const PROJECT_RULE_SOURCES: Record<string, { source: string; filePath: string }> = {};

// Parsed rule caches per layer (null = not yet parsed).
let builtinRules: DetectionRule[] | null = null;
let personalRules: DetectionRule[] | null = null;
let projectRules: DetectionRule[] | null = null;

// In-memory overrides (e.g. threshold tweaks from the UI).
const inMemoryOverrides: DetectionRule[] = [];

/**
 * Register a built-in rule source. Called during module initialization.
 */
export function registerBuiltinRuleSource(id: string, source: string): void {
  BUILTIN_RULE_SOURCES[id] = source;
}

/**
 * Register a personal rule source (from ~/.ai-engineer-coach/rules/).
 */
export function registerPersonalRuleSource(id: string, source: string, filePath: string): void {
  PERSONAL_RULE_SOURCES[id] = { source, filePath };
  personalRules = null; // invalidate cache
}

/**
 * Register a project rule source (from <workspace>/.ai-engineer-coach/rules/).
 */
export function registerProjectRuleSource(id: string, source: string, filePath: string): void {
  PROJECT_RULE_SOURCES[id] = { source, filePath };
  projectRules = null; // invalidate cache
}

/**
 * Clear all personal/project rules (for reload).
 */
export function clearLayerRules(layer: 'personal' | 'project'): void {
  if (layer === 'personal') {
    for (const k of Object.keys(PERSONAL_RULE_SOURCES)) delete PERSONAL_RULE_SOURCES[k];
    personalRules = null;
  } else {
    for (const k of Object.keys(PROJECT_RULE_SOURCES)) delete PROJECT_RULE_SOURCES[k];
    projectRules = null;
  }
}

/**
 * Load and parse all built-in rule sources. Cached after first call.
 */
export function loadBuiltinRules(): DetectionRule[] {
  if (builtinRules) return builtinRules;
  builtinRules = [];
  for (const [id, source] of Object.entries(BUILTIN_RULE_SOURCES)) {
    const rule = parseRule(source);
    if (rule) {
      rule.source = 'built-in';
      rule.sourceFilePath = '';
      builtinRules.push(rule);
    } else {
      warnCore('RuleEngine', `Failed to parse built-in rule: ${id}`);
    }
  }
  return builtinRules;
}

function loadPersonalRules(): DetectionRule[] {
  if (personalRules) return personalRules;
  personalRules = [];
  for (const [id, { source, filePath }] of Object.entries(PERSONAL_RULE_SOURCES)) {
    const rule = parseRule(source);
    if (rule) {
      rule.source = 'personal';
      rule.sourceFilePath = filePath;
      personalRules.push(rule);
    } else {
      warnCore('RuleEngine', `Failed to parse personal rule: ${id}`);
    }
  }
  return personalRules;
}

function loadProjectRules(): DetectionRule[] {
  if (projectRules) return projectRules;
  projectRules = [];
  for (const [id, { source, filePath }] of Object.entries(PROJECT_RULE_SOURCES)) {
    const rule = parseRule(source);
    if (rule) {
      rule.source = 'project';
      rule.sourceFilePath = filePath;
      projectRules.push(rule);
    } else {
      warnCore('RuleEngine', `Failed to parse project rule: ${id}`);
    }
  }
  return projectRules;
}

/**
 * Get all rules with 3-tier precedence: built-in < personal < project.
 * In-memory overrides (from threshold editing) take highest precedence.
 */
export function getAllRules(): DetectionRule[] {
  const builtin = loadBuiltinRules();
  const personal = loadPersonalRules();
  const project = loadProjectRules();

  // Merge: project > personal > built-in.  In-memory overrides win over everything.
  const merged = new Map<string, DetectionRule>();
  for (const r of builtin) merged.set(r.id, r);
  for (const r of personal) merged.set(r.id, r);
  for (const r of project) merged.set(r.id, r);
  for (const r of inMemoryOverrides) merged.set(r.id, r);

  return [...merged.values()];
}

/**
 * Get a single rule by ID.
 */
export function getRule(id: string): DetectionRule | undefined {
  return getAllRules().find(r => r.id === id);
}

/**
 * Add or update an in-memory rule override.
 */
export function setUserRule(rule: DetectionRule): void {
  if (rule.source === 'built-in') {
    rule.source = 'personal';
  }
  const idx = inMemoryOverrides.findIndex(r => r.id === rule.id);
  if (idx >= 0) inMemoryOverrides[idx] = rule;
  else inMemoryOverrides.push(rule);
}

/**
 * Remove an in-memory rule override. Layer rules (file-based) cannot be removed this way.
 */
export function removeUserRule(id: string): boolean {
  const idx = inMemoryOverrides.findIndex(r => r.id === id);
  if (idx < 0) return false;
  inMemoryOverrides.splice(idx, 1);
  return true;
}

/**
 * Set thresholds on a rule (a user override of a built-in). Only the edited numbers change in the rule's markdown, so
 * its `# Tests`, detection logic and line endings stay as written, and the override is parsed from that markdown.
 * Setting thresholds to their current values returns the rule unchanged, without an override. Returns null when the
 * rule doesn't exist or a threshold can't be set: its key isn't in the front matter's `thresholds:` block, its value
 * isn't written as a number, or the new value isn't finite.
 */
export function updateRuleThresholds(id: string, thresholds: Record<string, number>): DetectionRule | null {
  const existing = getRule(id);
  if (!existing) return null;
  // Rules loaded from files or saved from the editor keep their markdown; only a rule built in code has none.
  if (!existing.rawSource) return overrideSerializedThresholds(existing, thresholds);

  const patch = patchThresholds(existing.rawSource, thresholds);
  const rule = patch.ok ? parseRule(patch.source) : null;
  if (!patch.ok || !rule || Object.entries(thresholds).some(([key, value]) => rule.thresholds[key] !== value)) {
    const reason = patch.ok ? 'a value isn\'t read back as a number' : `${patch.key} (${patch.reason})`;
    warnCore('RuleEngine', `Threshold not set on ${id}: ${reason}`);
    return null;
  }
  if (patch.source === existing.rawSource) return existing;

  const updated: DetectionRule = {
    ...rule,
    source: existing.source,
    sourceFilePath: existing.sourceFilePath,
    maxExamples: existing.maxExamples,
  };
  setUserRule(updated);
  return updated;
}

/** For a rule without markdown: merge the thresholds and serialize the whole rule. */
function overrideSerializedThresholds(existing: DetectionRule, thresholds: Record<string, number>): DetectionRule {
  const updated: DetectionRule = {
    ...existing,
    thresholds: { ...existing.thresholds, ...thresholds },
    source: existing.source === 'built-in' ? 'personal' : existing.source,
    rawSource: '',
  };
  updated.rawSource = serializeRule(updated);
  setUserRule(updated);
  return updated;
}

/**
 * Create a new rule from markdown source.
 */
export function createRuleFromMarkdown(markdown: string): DetectionRule | null {
  const rule = parseRule(markdown);
  if (!rule) return null;
  rule.source = 'personal';
  rule.sourceFilePath = '';
  setUserRule(rule);
  return rule;
}

/**
 * Get rule markdown source for editing.
 */
export function getRuleSource(id: string): string | null {
  const rule = getRule(id);
  if (!rule) return null;
  return rule.rawSource || serializeRule(rule);
}

/**
 * Evaluate a single rule against emission data.
 */
export function evaluateRule(
  rule: DetectionRule,
  emission: DetectorEmission | null,
): RuleEvalResult {
  if (!emission || emission.count === 0) {
    return {
      ruleId: rule.id,
      triggered: false,
      occurrences: 0,
      total: 0,
      ratio: 0,
      severity: rule.severity,
      description: '',
      suggestion: '',
      examples: [],
      templateVars: { count: 0, total: 0, ratio: 0, pct: '0%', extra: {} },
    };
  }

  const pct = emission.total > 0
    ? `${(emission.count / emission.total * 100).toFixed(0)}%`
    : '0%';

  const vars: RuleTemplateVars = {
    count: emission.count,
    total: emission.total,
    ratio: emission.ratio,
    pct,
    extra: emission.extra,
  };

  const severity = emission.dynamicSeverity ?? rule.severity;
  const description = rule.descriptionTemplate
    ? fillTemplate(rule.descriptionTemplate, vars as unknown as Record<string, unknown>)
    : `${emission.count} occurrences`;
  const suggestion = rule.suggestionTemplate
    ? fillTemplate(rule.suggestionTemplate, vars as unknown as Record<string, unknown>)
    : '';

  return {
    ruleId: rule.id,
    triggered: true,
    occurrences: emission.count,
    total: emission.total,
    ratio: emission.ratio,
    severity,
    description,
    suggestion,
    examples: emission.examples,
    templateVars: vars,
  };
}

/**
 * Get preview stats for all rules against current data.
 * Used by the Rule Editor to show how many items each rule would flag. A rule in `failures` couldn't be evaluated: its
 * preview has the `error` and says it wasn't evaluated, instead of reading as clean.
 */
export function getRulePreviewStats(
  reqs: SessionRequest[],
  sessions: Session[],
  skipIdeDetectors: boolean,
  detectorResults: AntiPattern[],
  emissions?: Map<string, DetectorEmission>,
  failures: RuleFailure[] = [],
): RulePreviewStats[] {
  const allRules = getAllRules();
  const resultMap = new Map<string, AntiPattern>();
  for (const r of detectorResults) resultMap.set(r.id, r);
  const failureMap = new Map(failures.map(failure => [failure.ruleId, failure]));

  return allRules
    .filter(rule => !skipIdeDetectors || !rule.requiresIdeContext)
    .map(rule => {
      const emission = emissions?.get(rule.id);
      const result = resultMap.get(rule.id);
      const failure = failureMap.get(rule.id);
      const total = emission?.total ?? (rule.scope === 'sessions' ? sessions.length : reqs.length);
      const occurrences = emission?.count ?? result?.occurrences ?? 0;
      const pct = total > 0 ? (occurrences / total) * 100 : 0;

      return {
        ruleId: rule.id,
        ruleName: rule.name,
        triggered: !!result,
        occurrences,
        total,
        pct: Math.round(pct * 10) / 10,
        severity: rule.severity,
        group: rule.group,
        previewDescription: failure
          ? `Not evaluated: ${failure.error}`
          : result?.description ?? 'Not triggered with current data.',
        previewExamples: result?.examples ?? [],
        ...(failure && { error: failure.error }),
      };
    });
}

/**
 * Get all rules grouped by practice group for UI display.
 */
export function getRulesGrouped(): Record<PracticeGroup, DetectionRule[]> {
  const groups: Record<PracticeGroup, DetectionRule[]> = {
    'prompt-quality': [],
    'session-hygiene': [],
    'code-review': [],
    'tool-mastery': [],
    'context-management': [],
  };
  for (const rule of getAllRules()) {
    groups[rule.group].push(rule);
  }
  return groups;
}

// Re-export for convenience
export { serializeRule, parseRule, fillTemplate };
