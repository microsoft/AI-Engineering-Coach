/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Types for the data-driven rule engine that powers anti-pattern detection. */

import { PracticeGroup } from './analytics-types';

/**
 * Where a rule was loaded from, in order of precedence (lowest to highest):
 * - 'built-in': shipped with the extension (dist/rules/)
 * - 'personal': user-level rules (~/.ai-engineer-coach/rules/)
 * - 'project':  workspace-level rules (.ai-engineer-coach/rules/ in the workspace root)
 */
export type RuleSource = 'built-in' | 'personal' | 'project';

/**
 * Raw data emitted by a detector function.
 * Detector functions ONLY compute metrics -- they never decide whether to flag.
 * The rule engine evaluates thresholds from the .md rule file against this data.
 */
export interface DetectorEmission {
  /** Number of flagged / matching items */
  count: number;
  /** Total items in scope (requests or sessions) */
  total: number;
  /** count / total (0-1), pre-computed for convenience */
  ratio: number;
  /** Sample items for the examples template */
  examples: string[];
  /** Arbitrary extra data for template interpolation (e.g. {{extra.avgGap}}) */
  extra: Record<string, unknown>;
  /** When the detector computes dynamic severity, pass the actual severity here.
   *  If omitted the rule's static `severity:` field is used. */
  dynamicSeverity?: RuleSeverity;
  /** Raw matched rows for building rich occurrence details */
  matchedRows?: Record<string, unknown>[];
}

/**
 * Severity level for a rule: determines scoring penalty weight.
 * - high: 12-point penalty (critical issues)
 * - medium: 7-point penalty (important issues)
 * - low: 3-point penalty (minor issues)
 */
export type RuleSeverity = 'high' | 'medium' | 'low';

/**
 * What data the rule operates on: requests (flat list) or sessions (grouped).
 * Rules can also need both.
 */
export type RuleScope = 'requests' | 'sessions' | 'both';

/**
 * A single condition in a rule's detection logic.
 * Conditions are composed to build the full detection pipeline.
 */
export interface RuleCondition {
  /** What to filter/check */
  type:
    | 'filter-requests'        // filter requests matching criteria
    | 'filter-sessions'        // filter sessions matching criteria
    | 'ratio-check'            // check a ratio (filtered / total) against a threshold
    | 'count-check'            // check a count against a minimum
    | 'aggregate'              // aggregate a value across requests/sessions
    | 'group-by'               // group by a field and check distribution
    | 'regex-match'            // match a regex pattern against request text
    | 'field-check'            // check a field value
    | 'custom';                // custom logic (for complex detectors that can't be expressed declaratively)

  /** The field to operate on */
  field?: string;

  /** Comparison operator */
  op?: 'lt' | 'gt' | 'lte' | 'gte' | 'eq' | 'ne' | 'includes' | 'not-includes' | 'matches' | 'not-matches';

  /** Value to compare against */
  value?: string | number | boolean;

  /** For regex-match conditions */
  pattern?: string;
  flags?: string;

  /** For ratio-check: what constitutes the numerator */
  numerator?: string;
  /** For ratio-check: the threshold to compare against */
  threshold?: number;

  /** For aggregate: the aggregation function */
  aggregation?: 'count' | 'sum' | 'avg' | 'max' | 'min' | 'ratio' | 'unique-count';

  /** Minimum sample size before this condition applies */
  minSample?: number;

  /** Sub-conditions for complex logic */
  conditions?: RuleCondition[];

  /** How to combine sub-conditions */
  logic?: 'and' | 'or';
}

/**
 * Template variables available in rule description/suggestion strings.
 * These are populated at runtime from the detection results.
 */
export interface RuleTemplateVars {
  count: number;           // number of occurrences (flagged items)
  total: number;           // total items checked
  ratio: number;           // count / total (0-1)
  pct: string;             // ratio formatted as percentage string
  extra: Record<string, unknown>;  // additional rule-specific vars
}

/**
 * A fully parsed detection rule. This is the in-memory representation
 * of a rule markdown file.
 */
export interface DetectionRule {
  /** Unique rule identifier, e.g. 'lazy-prompting' */
  id: string;

  /** Human-readable name, e.g. 'Lazy Prompting' */
  name: string;

  /** Practice group this rule belongs to */
  group: PracticeGroup;

  /** Severity when triggered */
  severity: RuleSeverity;

  /** Whether this rule requires IDE-specific context (e.g. VS Code data) */
  requiresIdeContext: boolean;

  /** What data scope the rule needs */
  scope: RuleScope;

  /** Short description of what this rule detects */
  description: string;

  /** Template for the problem description shown when triggered.
   *  Supports {{count}}, {{total}}, {{pct}}, {{extra.xxx}} placeholders. */
  descriptionTemplate: string;

  /** Template for the suggestion shown when triggered */
  suggestionTemplate: string;

  /** Template for generating example strings */
  exampleTemplate: string;

  /** Maximum number of examples to show */
  maxExamples: number;

  /** The detection logic expressed as conditions */
  conditions: RuleCondition[];

  /** Threshold constants used by this rule's conditions */
  thresholds: Record<string, number>;

  /** Named regex pattern lists (e.g. patterns.frustration: ["!{3,}", "\\?{3,}"]) */
  patterns: Record<string, string[]>;

  /** Named file extension groups (e.g. fileTypes.documentation: ["md", "txt", "rst"]) */
  fileTypes: Record<string, string[]>;

  /** Parent rule ID for inheritance (extends: in frontmatter) */
  extendsRule?: string;

  /** Inline test fixtures */
  tests: Array<{ input: Record<string, unknown>; expect: 'triggered' | 'clean' }>;

  /** Where this rule was loaded from (built-in, personal, or project) */
  source: RuleSource;

  /** Absolute path to the .md file this rule was loaded from (empty for in-memory rules) */
  sourceFilePath: string;

  /** Version of this rule definition */
  version: number;

  /** Tags for filtering/categorization */
  tags: string[];

  /** The raw markdown source */
  rawSource: string;
}

/**
 * Result of evaluating a rule against data.
 */
export interface RuleEvalResult {
  ruleId: string;
  triggered: boolean;
  occurrences: number;
  total: number;
  ratio: number;
  severity: RuleSeverity;
  description: string;
  suggestion: string;
  examples: string[];
  templateVars: RuleTemplateVars;
}

/**
 * Summary stats for a rule shown in the rule editor.
 */
export interface RulePreviewStats {
  ruleId: string;
  ruleName: string;
  triggered: boolean;
  occurrences: number;
  total: number;
  pct: number;
  severity: RuleSeverity;
  group: PracticeGroup;
  previewDescription: string;
  previewExamples: string[];
  /** Set when the rule couldn't be evaluated (see RuleFailure): why. The rule is then neither triggered nor clean. */
  error?: string;
}

/**
 * A rule that couldn't be evaluated: running its detection logic threw, for example because a `match:` expression
 * doesn't parse. It is neither triggered nor clean, and the other rules still run.
 */
export interface RuleFailure {
  ruleId: string;
  ruleName: string;
  group: PracticeGroup;
  /** Why, such as `Parse error at position 0: ...`. */
  error: string;
}
