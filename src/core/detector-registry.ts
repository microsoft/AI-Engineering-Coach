/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AntiPattern, OccurrenceDetail, PracticeGroup, Session, SessionRequest } from './types';
import type { DetectionRule, DetectorEmission, RuleFailure, RuleTemplateVars } from './types';
import { getAllRules } from './rule-engine';
import { registerAllBuiltinRules, loadPersonalRules, registerAllBuiltinMetrics } from './rule-loader';
import { fillTemplate } from './rule-parser';
import { parsePipeline, executePipeline, checkPipelineTrigger, resolveInheritance, type Pipeline } from './rule-pipeline';
import { isoWeek } from './helpers';
import { runtimeDebug } from './runtime-debug';
import { toRuleRequestRows } from './rule-rows';

registerAllBuiltinRules();
registerAllBuiltinMetrics();
loadPersonalRules();

interface DetectorContext {
  reqs: SessionRequest[];
  sessions: Session[];
  skipIdeDetectors: boolean;
}

export interface DetectorDefinition {
  name: string;
  group: PracticeGroup;
  requiresIdeContext?: boolean;
  rule?: DetectionRule;
  /** The rule's anti-pattern when it triggers, null when it doesn't, or why it couldn't be evaluated. */
  run: (ctx: DetectorContext) => AntiPattern | RuleFailure | null;
}

/* ------------------------------------------------------------------ */
/*  Map emission + rule → AntiPattern (the output format callers need) */
/* ------------------------------------------------------------------ */

const MAX_DETAILS = 200;

type DetailRow = Record<string, unknown>;

function textValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return `${value}`;
  }
  return '';
}

function truncatedText(value: unknown): string {
  return textValue(value).substring(0, 120);
}

function numericValue(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0);
}

function recordValue(value: unknown): DetailRow | null {
  return typeof value === 'object' && value !== null ? value as DetailRow : null;
}

function addWeekCount(weekCounts: Map<string, number>, timestamp: number): void {
  if (timestamp <= 0) return;
  const wk = isoWeek(new Date(timestamp));
  weekCounts.set(wk, (weekCounts.get(wk) || 0) + 1);
}

function collectWorkspaceStats(row: DetailRow): Record<string, number> {
  const stats: Record<string, number> = {};
  for (const [key, value] of Object.entries(row)) {
    if (key !== 'name' && key !== 'workspace' && key !== 'isLow' && typeof value === 'number') {
      stats[key] = value;
    }
  }
  return stats;
}

function addWorkspaceDetails(extraWorkspaces: unknown, details: OccurrenceDetail[]): boolean {
  if (!Array.isArray(extraWorkspaces) || extraWorkspaces.length === 0) return false;
  for (const item of extraWorkspaces) {
    if (details.length >= MAX_DETAILS) break;
    const row = recordValue(item);
    if (!row) continue;
    details.push({
      timestamp: 0,
      workspace: textValue(row.name) || textValue(row.workspace),
      sessionId: '',
      message: '',
      model: '',
      kind: 'workspace',
      stats: collectWorkspaceStats(row),
    });
  }
  return true;
}

function firstRequestMessage(row: DetailRow): string {
  if (!Array.isArray(row.requests) || row.requests.length === 0) return '';
  const first = recordValue(row.requests[0]);
  return first ? truncatedText(first.messageText) : '';
}

function addSessionDetail(row: DetailRow, details: OccurrenceDetail[], weekCounts: Map<string, number>): void {
  const timestamp = numericValue(row.creationDate ?? row.lastMessageDate ?? row.startTime);
  addWeekCount(weekCounts, timestamp);
  if (details.length >= MAX_DETAILS) return;
  details.push({
    timestamp,
    workspace: textValue(row.workspaceName) || textValue(row.workspaceId),
    sessionId: textValue(row.sessionId),
    message: firstRequestMessage(row),
    model: '',
  });
}

function addRequestDetail(row: DetailRow, details: OccurrenceDetail[], weekCounts: Map<string, number>): void {
  const timestamp = numericValue(row.timestamp);
  addWeekCount(weekCounts, timestamp);
  if (details.length >= MAX_DETAILS) return;
  details.push({
    timestamp,
    workspace: textValue(row.workspaceName) || textValue(row.sessionId),
    sessionId: textValue(row.sessionId),
    message: truncatedText(row.messageText),
    model: textValue(row.modelId),
  });
}

function collectMatchedRowDetails(
  emission: DetectorEmission,
  rule: DetectionRule,
  details: OccurrenceDetail[],
  weekCounts: Map<string, number>,
): void {
  if (!emission.matchedRows) return;
  const addDetail = rule.scope === 'sessions' ? addSessionDetail : addRequestDetail;
  for (const row of emission.matchedRows) {
    addDetail(row, details, weekCounts);
  }
}

function emissionToAntiPattern(
  emission: DetectorEmission,
  rule: DetectionRule,
): AntiPattern {
  const pct = emission.total > 0
    ? `${(emission.count / emission.total * 100).toFixed(0)}%`
    : '0%';

  const vars: RuleTemplateVars = {
    count: emission.count,
    total: emission.total,
    ratio: emission.ratio,
    pct,
    extra: { ...rule.thresholds, ...emission.extra },
  };

  const severity = emission.dynamicSeverity ?? rule.severity;
  const description = rule.descriptionTemplate
    ? fillTemplate(rule.descriptionTemplate, vars as unknown as Record<string, unknown>)
    : `${rule.name}: ${emission.count} occurrences`;
  const suggestion = rule.suggestionTemplate
    ? fillTemplate(rule.suggestionTemplate, vars as unknown as Record<string, unknown>)
    : '';

  const details: OccurrenceDetail[] = [];
  const weekCounts = new Map<string, number>();
  const hasWorkspaceDetails = addWorkspaceDetails(emission.extra?.workspaces, details);
  if (!hasWorkspaceDetails) {
    collectMatchedRowDetails(emission, rule, details, weekCounts);
  }

  details.sort((a, b) => b.timestamp - a.timestamp);

  return {
    id: rule.id,
    name: rule.name,
    severity,
    group: rule.group,
    occurrences: emission.count,
    description,
    suggestion,
    examples: emission.examples,
    details,
    weeklyHist: buildWeeklyHist(weekCounts),
  };
}

/** Build a weekly histogram with continuous labels (fill gaps with 0). */
function buildWeeklyHist(weekCounts: Map<string, number>): { labels: string[]; counts: number[] } {
  if (weekCounts.size === 0) return { labels: [], counts: [] };
  const sorted = [...weekCounts.keys()].sort();
  const first = sorted[0];
  const last = sorted[sorted.length - 1];

  // Generate continuous week labels between first and last
  const labels: string[] = [];
  const counts: number[] = [];
  const d = parseIsoWeek(first);
  const end = parseIsoWeek(last);
  while (d <= end) {
    const wk = isoWeek(d);
    labels.push(wk);
    counts.push(weekCounts.get(wk) || 0);
    d.setDate(d.getDate() + 7);
  }
  // Limit to last 12 weeks
  const MAX_WEEKS = 12;
  if (labels.length > MAX_WEEKS) {
    const start = labels.length - MAX_WEEKS;
    return { labels: labels.slice(start), counts: counts.slice(start) };
  }
  return { labels, counts };
}

/** Parse an ISO week string like "2025-W14" to a Date (Monday of that week). */
function parseIsoWeek(wk: string): Date {
  const [yearStr, weekStr] = wk.split('-W');
  const year = Number.parseInt(yearStr, 10);
  const week = Number.parseInt(weekStr, 10);
  const jan1 = new Date(year, 0, 1);
  const dayOfWeek = jan1.getDay() || 7; // ISO: Monday = 1
  const firstMonday = new Date(year, 0, 1 + (8 - dayOfWeek) % 7);
  const d = new Date(firstMonday);
  d.setDate(d.getDate() + (week - 1) * 7);
  return d;
}

/* ------------------------------------------------------------------ */
/*  Pipeline-based registry build                                     */
/* ------------------------------------------------------------------ */

/** Rule id and message of each detection failure already logged, so a broken rule is logged once. */
const loggedFailures = new Set<string>();

/**
 * The rule's emission, or why it couldn't be evaluated when its detection logic throws, such as a `match:` expression
 * that doesn't parse. A broken personal or project rule then doesn't stop the other rules: it is reported as not
 * evaluated, neither triggered nor clean, and the reason also goes to the Output log (runtimeDebug) once per rule and
 * message.
 */
function emitOrFail(pipeline: Pipeline, rule: DetectionRule, ctx: DetectorContext): DetectorEmission | RuleFailure {
  try {
    return executePipeline(pipeline, rule, ctx);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const key = `${rule.id}\n${message}`;
    if (!loggedFailures.has(key)) {
      loggedFailures.add(key);
      runtimeDebug('detectors', 'rule-skipped', `${rule.id}: ${message}`);
    }
    return { ruleId: rule.id, ruleName: rule.name, group: rule.group, error: message };
  }
}

function buildDetector(rawRule: DetectionRule): DetectorDefinition {
  const rule = resolveInheritance(rawRule);
  const pipeline = parsePipeline(rule);

  return {
    name: rule.name,
    group: rule.group,
    requiresIdeContext: rule.requiresIdeContext,
    rule,
    run: (ctx) => {
      const emission = emitOrFail(pipeline, rule, ctx);
      if ('error' in emission) return emission;
      if (!checkPipelineTrigger(pipeline, emission, rule)) return null;
      return emissionToAntiPattern(emission, rule);
    },
  };
}

function buildRegistry(): DetectorDefinition[] {
  return getAllRules().map(rule => buildDetector(rule));
}

/** Rules read each request with its session's `harness` (see toRuleRequestRows). */
function detectorContext(
  reqs: SessionRequest[],
  sessions: Session[],
  skipIdeDetectors: boolean,
  sessionOf?: ReadonlyMap<SessionRequest, Session>,
): DetectorContext {
  return { reqs: toRuleRequestRows(reqs, sessionOf ?? sessions), sessions, skipIdeDetectors };
}

let _registry: DetectorDefinition[] | null = null;

export const DETECTOR_REGISTRY: DetectorDefinition[] = new Proxy([] as DetectorDefinition[], {
  get(_target, prop) {
    if (!_registry) _registry = buildRegistry();
    return Reflect.get(_registry, prop) as unknown;
  },
});

export function invalidateDetectorRegistry(): void {
  _registry = null;
  loggedFailures.clear();
}

export function getActiveDetectors(skipIdeDetectors: boolean): DetectorDefinition[] {
  const registry = buildRegistry();
  return registry.filter(detector => !skipIdeDetectors || !detector.requiresIdeContext);
}

/** What the active rules found: the anti-patterns of the triggered rules, and the rules that couldn't be evaluated. */
export interface DetectionResult {
  patterns: AntiPattern[];
  failures: RuleFailure[];
}

/**
 * Run every active rule. A rule whose detection logic throws is in `failures`; the other rules still run. `sessionOf`
 * resolves each request's session for its `harness`; pass it when `reqs` can hold requests whose session isn't in
 * `sessions`.
 */
export function detectAntiPatterns(
  reqs: SessionRequest[],
  sessions: Session[],
  skipIdeDetectors: boolean,
  sessionOf?: ReadonlyMap<SessionRequest, Session>,
): DetectionResult {
  const ctx = detectorContext(reqs, sessions, skipIdeDetectors, sessionOf);
  const result: DetectionResult = { patterns: [], failures: [] };
  for (const detector of getActiveDetectors(skipIdeDetectors)) {
    const outcome = detector.run(ctx);
    if (!outcome) continue;
    if ('error' in outcome) result.failures.push(outcome);
    else result.patterns.push(outcome);
  }
  return result;
}

/**
 * The anti-patterns of the triggered rules. Use detectAntiPatterns to also know which rules couldn't be evaluated.
 * `sessionOf` works as in detectAntiPatterns.
 */
export function runDetectors(
  reqs: SessionRequest[],
  sessions: Session[],
  skipIdeDetectors: boolean,
  sessionOf?: ReadonlyMap<SessionRequest, Session>,
): AntiPattern[] {
  return detectAntiPatterns(reqs, sessions, skipIdeDetectors, sessionOf).patterns;
}

/** Run one rule the way runDetectors does, e.g. for the rule's inline `# Tests`. Throws when the rule can't be evaluated. */
export function runDetector(rule: DetectionRule, reqs: SessionRequest[], sessions: Session[]): AntiPattern | null {
  const outcome = buildDetector(rule).run(detectorContext(reqs, sessions, false));
  if (outcome && 'error' in outcome) throw new Error(outcome.error);
  return outcome;
}

/**
 * Run emitters only (no trigger evaluation). Used by rule-engine preview. A rule that couldn't be evaluated has no
 * emission; detectAntiPatterns reports why. `sessionOf` works as in runDetectors.
 */
export function runEmitters(
  reqs: SessionRequest[],
  sessions: Session[],
  skipIdeDetectors: boolean,
  sessionOf?: ReadonlyMap<SessionRequest, Session>,
): Map<string, DetectorEmission> {
  const rules = getAllRules();
  const ctx = detectorContext(reqs, sessions, skipIdeDetectors, sessionOf);
  const results = new Map<string, DetectorEmission>();
  for (const rawRule of rules) {
    if (skipIdeDetectors && rawRule.requiresIdeContext) continue;
    const rule = resolveInheritance(rawRule);
    const pipeline = parsePipeline(rule);
    const emission = emitOrFail(pipeline, rule, ctx);
    if (!('error' in emission)) results.set(rule.id, emission);
  }
  return results;
}

export function getDetectorGroupCounts(skipIdeDetectors: boolean): Record<PracticeGroup, number> {
  const counts: Record<PracticeGroup, number> = {
    'prompt-quality': 0,
    'session-hygiene': 0,
    'code-review': 0,
    'tool-mastery': 0,
    'context-management': 0,
  };
  for (const detector of getActiveDetectors(skipIdeDetectors)) {
    counts[detector.group] += 1;
  }
  return counts;
}