/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * AST interpreter for the metric expression DSL.
 *
 * Evaluates an AST node against a context object (a row of data, or an
 * emission object).  Returns a JS value (number, string, boolean, array).
 *
 * Built-in functions available inside expressions:
 *   - length(x)           array or string length
 *   - contains(s, sub)    string contains
 *   - startsWith(s, sub)  string starts with
 *   - endsWith(s, sub)    string ends with
 *   - matches(s, /re/)    regex match
 *   - lower(s)            to lower case
 *   - upper(s)            to upper case
 *   - trim(s)             strip whitespace
 *   - abs(n)              absolute value
 *   - floor(n)            floor
 *   - ceil(n)             ceiling
 *   - round(n)            round
 *   - min(a, b)           minimum
 *   - max(a, b)           maximum
 *   - hour(ts)            0-23 from epoch ms
 *   - dayOfWeek(ts)       0=Sun 6=Sat from epoch ms
 *   - includes(arr, val)  array includes value
 *   - some(arr, field)    true if any element has truthy field
 *   - count(arr)          array length
 *   - sum(arr, field)     sum a numeric field across array elements
 *   - avg(arr, field)     average a numeric field
 *   - unique(arr, field)  count distinct values of field
 *   - truncate(s, n)      truncate string to n chars
 *   - substr(s, start, len) substring
 *   - split(s, sep)       split string into array
 *   - join(arr, sep)      join array into string
 *   - keys(obj)           object keys
 *   - values(obj)         object values
 *   - has(obj, key)       check if object has key
 *   - coalesce(a, b, ...) first non-null value
 *
 * Aggregate functions (operate on arrays of objects):
 *   - first(arr)               first element
 *   - at(arr, idx)             element at index
 *   - substring(s, start, end) substring
 *   - lineCount(s)             non-empty line count
 *   - isStructured(s)          has bullets/numbers/headings
 *   - hasProfanity(s)          profanity detection
 *   - normalizeModel(id)       normalize model name
 *   - sumAiLoc(reqs)           sum aiCode.loc across requests
 *   - workTypeCount(reqs)      distinct work types in requests
 *   - hasReviewFollowup(reqs)  any follow-up mentions review keywords
 *   - groupTopKey(arr, field)  most frequent value key
 *   - groupTopCount(arr, field) most frequent value count
 *   - groupTopShare(arr, field) proportion of most frequent value
 *   - countWhere(arr, field, op, value) count matching rows
 *   - sumField(arr, field)     sum numeric field across rows
 *   - avgField(arr, field)     average numeric field across rows
 *   - flatCount(arr, field)    sum of sub-array lengths
 *   - flatSomeWhere(arr, field, subField, value) any sub-element matches
 *   - adjacentPairCount(sessions, minLoc, maxGapMs) speed-accept pairs
 *   - flowScoreStats(sessions, minTimedReqs, rapidMs) flow-state analysis
 *   - langExplorationWeeks(reqs) language exploration stats
 *   - mdRatioByWorkspace(sessions, minLoc, docLangs) markdown ratio per workspace
 *   - devcontainerStats(sessions, reqs) devcontainer usage stats
 *   - contextGapCount(reqs) context engineering gap analysis
 *   - yoloStats(reqs) yolo-mode tool confirmation stats
 *   - reasoningEffortStats(reqs, premiumLevel) ratio of high/max effort use
 *   - instructionBloatStats(sessions, maxBytes) custom-instructions size analysis
 *   - depRetryStats(sessions, reqs) repeated dep-install attempts in VS Code terminal
 *   - excessFileContextStats(reqs, minFiles) outliers attaching huge file contexts
 *   - hasSkillByPattern(reqs, pattern) any skillsUsed entry matches a regex
 */

import { containsProfanity as _containsProfanity, extractProfaneWords } from '../profanity';
import { compileSafe, testSafe } from './safe-regex';
import { ASTNode } from './types';

export class InterpreterError extends Error {
  constructor(message: string) {
    super(`DSL runtime error: ${message}`);
  }
}

/** Safely convert an unknown value to string (never returns '[object Object]'). */
function asStr(v: unknown, fallback = ''): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return fallback;
}

/** Return arg as number if non-null, else return def. */
function numOpt(arg: unknown, def: number): number {
  return arg != null ? toNum(arg) : def;
}

/** Hard ceiling on AST-node evaluations per top-level `evaluate()` call
 *  (including pipe iterations over data rows). Real expressions stay far
 *  below this; only a pathological rule file can hit it. The throw is caught
 *  by the compiled-expression wrappers in dsl/index.ts, so an offending rule
 *  degrades to no-match instead of stalling analysis. */
const MAX_EVAL_STEPS = 5_000_000;
/** Recursion guard: parse depth is capped at 64, but calls and pipes add frames. */
const MAX_EVAL_DEPTH = 500;
let evalSteps = 0;
let evalDepth = 0;

export function evaluate(node: ASTNode, ctx: Record<string, unknown>): unknown {
  if (evalDepth === 0) evalSteps = 0;
  if (++evalSteps > MAX_EVAL_STEPS) {
    throw new InterpreterError(`evaluation budget exceeded (${MAX_EVAL_STEPS} steps)`);
  }
  if (evalDepth >= MAX_EVAL_DEPTH) {
    throw new InterpreterError('expression nesting too deep');
  }
  evalDepth++;
  try {
    return evaluateNode(node, ctx);
  } finally {
    evalDepth--;
  }
}

function evaluateNode(node: ASTNode, ctx: Record<string, unknown>): unknown {
  switch (node.type) {
    case 'number':
    case 'string':
    case 'boolean':
      return node.value;

    case 'identifier':
      return resolveIdentifier(node.name, ctx);

    case 'field_access':
      return evaluateFieldAccess(node, ctx);

    case 'binary':
      return evaluateBinary(node.op, node.left, node.right, ctx);

    case 'unary':
      if (node.op === 'NOT') return !toBool(evaluate(node.operand, ctx));
      throw new InterpreterError(`Unknown unary operator: ${node.op}`);

    case 'call':
      return evaluateCall(node.name, node.args, ctx);

    case 'pipe':
      return evaluatePipe(node.value, node.filter, node.arg, ctx);

    case 'array':
      return node.elements.map(el => evaluate(el, ctx));
  }
}

function evaluateFieldAccess(node: ASTNode & { type: 'field_access' }, ctx: Record<string, unknown>): unknown {
  const obj = evaluate(node.object, ctx);
  if (obj == null) return undefined;
  if (typeof obj === 'object') {
    const field = node.field;
    if (field === '__proto__' || field === 'constructor' || field === 'prototype') return undefined;
    return Object.hasOwn(obj as Record<string, unknown>, field)
      ? (obj as Record<string, unknown>)[field]
      : undefined;
  }
  if (node.field === 'length' && (typeof obj === 'string' || Array.isArray(obj))) {
    return (obj as string | unknown[]).length;
  }
  return undefined;
}

function resolveIdentifier(name: string, ctx: Record<string, unknown>): unknown {
  return Object.hasOwn(ctx, name) ? ctx[name] : undefined;
}

function evaluateBinary(op: string, left: ASTNode, right: ASTNode, ctx: Record<string, unknown>): unknown {
  // Short-circuit logical operators
  if (op === 'AND') return toBool(evaluate(left, ctx)) && toBool(evaluate(right, ctx));
  if (op === 'OR')  return toBool(evaluate(left, ctx)) || toBool(evaluate(right, ctx));

  const lv = evaluate(left, ctx);
  const rv = evaluate(right, ctx);

  switch (op) {
    case '<':  return toNum(lv) <  toNum(rv);
    case '>':  return toNum(lv) >  toNum(rv);
    case '<=': return toNum(lv) <= toNum(rv);
    case '>=': return toNum(lv) >= toNum(rv);
    case '==': return looseEquals(lv, rv);
    case '!=': return !looseEquals(lv, rv);
    // Arithmetic operators
    case '+':  return toNum(lv) + toNum(rv);
    case '-':  return toNum(lv) - toNum(rv);
    case '*':  return toNum(lv) * toNum(rv);
    case '/':  { const d = toNum(rv); return d === 0 ? 0 : toNum(lv) / d; }
    default:   throw new InterpreterError(`Unknown operator: ${op}`);
  }
}

function evaluateCall(name: string, argNodes: ASTNode[], ctx: Record<string, unknown>): unknown {
  const handler = (CALL_DISPATCH as Record<string, (argNodes: ASTNode[], ctx: Record<string, unknown>) => unknown>)[name];
  if (!handler) throw new InterpreterError(`Unknown function: ${name}`);
  return handler(argNodes, ctx);
}


function evaluatePipe(valueNode: ASTNode, filter: string, argNode: ASTNode | undefined, ctx: Record<string, unknown>): unknown {
  const value = evaluate(valueNode, ctx);
  const arg = argNode ? evaluate(argNode, ctx) : undefined;

  switch (filter) {
    case 'truncate': {
      const s = asStr(value);
      const n = numOpt(arg, 80);
      return s.length > n ? s.substring(0, n) + '...' : s;
    }
    case 'lower': return asStr(value).toLowerCase();
    case 'upper': return asStr(value).toUpperCase();
    case 'trim':  return asStr(value).trim();
    case 'round': return Math.round(toNum(value));
    case 'floor': return Math.floor(toNum(value));
    case 'ceil':  return Math.ceil(toNum(value));
    case 'abs':   return Math.abs(toNum(value));
    case 'pct':   return `${(toNum(value) * 100).toFixed(numOpt(arg, 0))}%`;
    case 'fixed': return toNum(value).toFixed(numOpt(arg, 2));
    case 'locale': return toNum(value).toLocaleString();
    default:
      throw new InterpreterError(`Unknown pipe filter: ${filter}`);
  }
}

/* ---- Type coercion helpers ---- */

function toNum(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') {
    const n = Number.parseFloat(v);
    return Number.isNaN(n) ? 0 : n;
  }
  if (v == null) return 0;
  return 0;
}

function toBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v.length > 0;
  if (v == null) return false;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

function looseEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null && b == null) return true;
  if (typeof a === 'number' && typeof b === 'string') return a === Number.parseFloat(b);
  if (typeof a === 'string' && typeof b === 'number') return Number.parseFloat(a) === b;
  if (typeof a === 'boolean' && typeof b === 'number') return (a ? 1 : 0) === b;
  if (typeof a === 'number' && typeof b === 'boolean') return a === (b ? 1 : 0);
  return false;
}

/* ── Model tier lookup (mirrors helpers.ts MODEL_MULTIPLIERS) ── */

const MODEL_TIERS: Record<string, number> = {
  'claude-opus-4.7': 7.5,
  'claude-opus-4.6-fast': 30, 'claude-opus-4.6': 3, 'claude-opus-4.5': 3,
  'claude-haiku-4.5': 0.33,
  'claude-sonnet-4.6': 1, 'claude-sonnet-4.5': 1, 'claude-sonnet-4': 1,
  'claude-opus-41': 1, 'claude-opus-4': 1,
  'claude-3.5-sonnet': 1, 'claude-3.7-sonnet': 1, 'claude-4': 1, 'claude-3-opus': 3,
  'gpt-5.4-mini': 0.33, 'gpt-5.4-nano': 0.2, 'gpt-5.4': 1,
  'gpt-5.3-codex': 1, 'gpt-5.2-codex': 1, 'gpt-5.2': 1,
  'gpt-5.1-codex-max': 1, 'gpt-5.1-codex-mini': 0.33, 'gpt-5.1-codex': 1, 'gpt-5.1': 1,
  'gpt-5.5': 3, 'gpt-5-mini': 0.33,
  'o4-mini': 2, 'o3-mini': 1, 'o3': 3, 'o1-mini': 1, 'o1-preview': 2, 'o1': 2,
  'gpt-4.1-nano': 0.2, 'gpt-4.1-mini': 0.5, 'gpt-4.1': 1,
  'gpt-4-turbo': 1, 'gpt-4': 1,
  'gemini-3.5-flash': 0.33, 'gemini-3.1-flash': 0.33, 'gemini-3.1-pro': 1, 'gemini-3-pro': 1, 'gemini-3-flash': 0.33,
  'gemini-2.5-pro': 1, 'gemini-2.0-flash': 0.3,
  'gpt-oss-120b': 0.5,
  'grok-code-fast-1': 0.25,
};

function modelTierLookup(raw: string): number {
  const id = raw.replace(/^(openai\/|anthropic\/|google\/)/, '').replace(/-\d{4}-\d{2}-\d{2}$/, '').toLowerCase();
  for (const [k, v] of Object.entries(MODEL_TIERS)) {
    if (id.includes(k)) return v;
  }
  return 0;
}

/* ── Work type classification (mirrors helpers.ts classifyWorkType) ── */

/** Extract inline regex flags like (?i), (?im), (?ims) from the start of a pattern */
function parseRegexFlags(pattern: string): { pattern: string; flags: string } {
  const m = pattern.match(/^\(\?([gimsuy]+)\)/);
  if (m) return { pattern: pattern.substring(m[0].length), flags: m[1] };
  return { pattern, flags: '' };
}

const WORK_TYPE_PATTERNS: [RegExp, string][] = [
  [/\b(bug|fix|error|issue|crash|broken|wrong|fail|debug)\b/i, 'bug fix'],
  [/\b(refactor|clean ?up|rename|restructure|reorganize|simplify)\b/i, 'refactor'],
  [/\b(test|spec|coverage|assert|expect|mock|stub)\b/i, 'test'],
  [/\b(doc|readme|comment|jsdoc|typedoc|explain)\b/i, 'documentation'],
  [/\b(deploy|ci|cd|pipeline|docker|kubernetes|helm|terraform|infra)\b/i, 'devops'],
  [/\b(style|css|layout|design|ui|ux|theme|color|font)\b/i, 'styling'],
  [/\b(config|setup|install|init|bootstrap|scaffold)\b/i, 'configuration'],
  [/\b(perf|optim|speed|cache|memory|benchmark)\b/i, 'performance'],
  [/\b(security|auth|permission|encrypt|token|oauth|cors)\b/i, 'security'],
  [/\b(migration?|upgrade|update|version|deprecat)\b/i, 'migration'],
];

function classifyWorkText(text: string): string {
  const sample = text.length > 300 ? text.substring(0, 300) : text;
  for (const [re, type] of WORK_TYPE_PATTERNS) {
    if (re.test(sample)) return type;
  }
  return 'feature';
}

/* ── Resolve nested field path ── */

function resolveField(row: Record<string, unknown>, field: string): unknown {
  const parts = field.split('.');
  let current: unknown = row;
  for (const part of parts) {
    if (current == null) return undefined;
    if (typeof current === 'object' && !Array.isArray(current)) {
      current = (current as Record<string, unknown>)[part];
    } else if (Array.isArray(current) && part === 'length') {
      return current.length;
    } else {
      return undefined;
    }
  }
  return current;
}

/* ── GroupBy helper ── */

function groupTop(arr: unknown[], fieldName: string): { key: string; count: number; share: number } {
  const counts = new Map<string, number>();
  for (const item of arr) {
    const val = typeof item === 'object' && item
      ? asStr(resolveField(item as Record<string, unknown>, fieldName))
      : '';
    counts.set(val, (counts.get(val) || 0) + 1);
  }
  let topKey = '', topCount = 0;
  for (const [k, c] of counts) {
    if (c > topCount) { topKey = k; topCount = c; }
  }
  return { key: topKey, count: topCount, share: arr.length > 0 ? topCount / arr.length : 0 };
}

/* ── Normalize model ID ── */

function normalizeModelId(raw: string): string {
  return raw.replace(/^(openai\/|anthropic\/|google\/)/, '').replace(/-\d{4}-\d{2}-\d{2}$/, '').toLowerCase().trim() || 'untracked';
}

/* ── Profanity detection ── */
// Shared implementation lives in ../profanity.ts

function detectProfanity(text: string): boolean {
  return _containsProfanity(text);
}

/* ── Speed-accept pairs (adjacent request analysis) ── */

function computeSpeedAcceptPairs(sessions: Record<string, unknown>[], minLoc: number, maxGap: number): { count: number; avgLoc: number; avgGap: number } {
  let count = 0;
  let totalLoc = 0;
  let totalGap = 0;
  for (const session of sessions) {
    const reqs = session.requests;
    if (!Array.isArray(reqs) || reqs.length < 2) continue;
    for (let i = 0; i < reqs.length - 1; i++) {
      const prev = reqs[i] as Record<string, unknown>;
      const next = reqs[i + 1] as Record<string, unknown>;
      // Sum AI LOC from prev
      const aiCode = prev.aiCode;
      if (!Array.isArray(aiCode)) continue;
      const aiLoc = aiCode.reduce((s: number, b: unknown) => s + toNum((b as Record<string, unknown>)?.loc), 0);
      if (aiLoc < minLoc) continue;
      // Compute gap
      const prevEnd = toNum(prev.timestamp) + toNum(prev.totalElapsed);
      const nextStart = toNum(next.timestamp);
      if (prevEnd <= 0 || nextStart <= 0) continue;
      const gap = nextStart - prevEnd;
      if (gap >= 0 && gap <= maxGap) {
        count++;
        totalLoc += aiLoc;
        totalGap += gap;
      }
    }
  }
  return {
    count,
    avgLoc: count > 0 ? Math.round(totalLoc / count) : 0,
    avgGap: count > 0 ? Math.round(totalGap / count / 1000) : 0,
  };
}

/* ── Flow-state scoring ── */

function computeFlowScoreStats(
  sessions: Record<string, unknown>[],
  minTimedReqs: number,
  rapidMs: number,
): { fragmentedDays: number; totalDays: number; avgScore: number; lowScoreRate: number } {
  const dayScores = new Map<string, number[]>();

  for (const session of sessions) {
    const reqs = session.requests;
    if (!Array.isArray(reqs)) continue;
    const timed = (reqs as Record<string, unknown>[]).filter(
      r => toNum(r.timestamp) > 0 && toNum(r.totalElapsed) > 0
    );
    if (timed.length < minTimedReqs) continue;

    // Sort by timestamp
    timed.sort((a, b) => toNum(a.timestamp) - toNum(b.timestamp));

    // Compute inter-request gaps
    const gaps: number[] = [];
    for (let i = 1; i < timed.length; i++) {
      const prevEnd = toNum(timed[i - 1].timestamp) + toNum(timed[i - 1].totalElapsed);
      const nextStart = toNum(timed[i].timestamp);
      gaps.push(Math.max(0, nextStart - prevEnd));
    }
    if (gaps.length === 0) continue;

    // Median gap
    const sorted = [...gaps].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];

    // Flow score: rapid-followup rate + latency bonus
    const rapidCount = gaps.filter(g => g <= rapidMs).length;
    const rapidRate = rapidCount / gaps.length;
    const latencyScore = Math.max(0, 100 - (median / 1000)); // penalty per second
    const score = Math.round(rapidRate * 60 + Math.min(latencyScore, 40));

    // Group by day
    const day = new Date(toNum(timed[0].timestamp)).toISOString().substring(0, 10);
    if (!dayScores.has(day)) dayScores.set(day, []);
    dayScores.get(day)!.push(score);
  }

  const totalDays = dayScores.size;
  if (totalDays === 0) return { fragmentedDays: 0, totalDays: 0, avgScore: 100, lowScoreRate: 0 };

  let fragmentedDays = 0;
  let totalScore = 0;
  let scoreCount = 0;
  for (const scores of dayScores.values()) {
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    totalScore += avg;
    scoreCount++;
    if (avg < 50) fragmentedDays++;
  }

  return {
    fragmentedDays,
    totalDays,
    avgScore: scoreCount > 0 ? Math.round(totalScore / scoreCount) : 100,
    lowScoreRate: totalDays > 0 ? fragmentedDays / totalDays : 0,
  };
}

/* ── Language exploration tracking ── */

function computeLangExploration(reqs: Record<string, unknown>[]): { weeksSinceNew: number; totalLangs: number; recentNew: number; totalWeeks: number } {
  const IGNORE = new Set(['text', 'plaintext', 'unknown', 'json', 'yaml', 'toml', 'xml', 'csv', 'ini', 'env', 'markdown', 'md']);
  const weekLangs = new Map<string, Set<string>>();

  for (const r of reqs) {
    const ts = toNum(r.timestamp);
    if (ts <= 0) continue;
    const d = new Date(ts);
    const week = `${d.getFullYear()}-W${String(Math.ceil((d.getDate() + new Date(d.getFullYear(), d.getMonth(), 1).getDay()) / 7)).padStart(2, '0')}`;
    if (!weekLangs.has(week)) weekLangs.set(week, new Set());
    const set = weekLangs.get(week)!;
    for (const field of ['aiCode', 'userCode'] as const) {
      const blocks = r[field];
      if (!Array.isArray(blocks)) continue;
      for (const b of blocks) {
        const lang = asStr((b as Record<string, unknown>)?.language).toLowerCase();
        if (lang && !IGNORE.has(lang)) set.add(lang);
      }
    }
  }

  const weeks = [...weekLangs.keys()].sort();
  if (weeks.length === 0) return { weeksSinceNew: 0, totalLangs: 0, recentNew: 0, totalWeeks: 0 };

  const seen = new Set<string>();
  let lastNewWeek = 0;
  for (let i = 0; i < weeks.length; i++) {
    const langs = weekLangs.get(weeks[i])!;
    let isNew = false;
    for (const l of langs) {
      if (!seen.has(l)) { seen.add(l); isNew = true; }
    }
    if (isNew) lastNewWeek = i;
  }

  const weeksSinceNew = weeks.length - 1 - lastNewWeek;
  const recentNew = weeksSinceNew === 0 ? 1 : 0;
  return { weeksSinceNew, totalLangs: seen.size, recentNew, totalWeeks: weeks.length };
}

/* ── Markdown ratio by workspace ── */

function computeMdRatio(
  sessions: Record<string, unknown>[],
  minLoc: number,
  docLangs: string[],
): {
  lowCount: number;
  totalWorkspaces: number;
  overallRatio: number;
  totalCodeLoc: number;
  totalMdLoc: number;
  workspaces: { name: string; codeLoc: number; mdLoc: number; ratio: number; isLow: boolean }[];
} {
  const docSet = new Set(docLangs.map(l => l.toLowerCase()));
  const workspace = new Map<string, { md: number; code: number }>();

  for (const session of sessions) {
    const ws = asStr(session.workspaceName) || asStr(session.workspaceId) || 'unknown';
    if (!workspace.has(ws)) workspace.set(ws, { md: 0, code: 0 });
    const stats = workspace.get(ws)!;
    const reqs = session.requests;
    if (!Array.isArray(reqs)) continue;
    for (const r of reqs as Record<string, unknown>[]) {
      const aiCode = r.aiCode;
      if (!Array.isArray(aiCode)) continue;
      for (const b of aiCode as Record<string, unknown>[]) {
        const lang = asStr(b.language).toLowerCase();
        const loc = toNum(b.loc);
        if (docSet.has(lang)) stats.md += loc;
        else stats.code += loc;
      }
    }
  }

  let lowCount = 0;
  let totalMd = 0;
  let totalCode = 0;
  const workspaces: { name: string; codeLoc: number; mdLoc: number; ratio: number; isLow: boolean }[] = [];
  for (const [name, stats] of workspace.entries()) {
    const total = stats.md + stats.code;
    totalMd += stats.md;
    totalCode += stats.code;
    const ratio = total > 0 ? stats.md / total : 0;
    const isLow = total >= minLoc && ratio < 0.05;
    if (isLow) lowCount++;
    workspaces.push({ name, codeLoc: stats.code, mdLoc: stats.md, ratio, isLow });
  }
  // Sort: low-ratio workspaces first, then by code volume descending
  workspaces.sort((a, b) => (a.isLow === b.isLow ? b.codeLoc - a.codeLoc : a.isLow ? -1 : 1));

  return {
    lowCount,
    totalWorkspaces: workspace.size,
    overallRatio: (totalMd + totalCode) > 0 ? totalMd / (totalMd + totalCode) : 0,
    totalCodeLoc: totalCode,
    totalMdLoc: totalMd,
    workspaces,
  };
}

/* ── Devcontainer stats ── */

const VSCODE_HARNESSES = new Set(['VS Code', 'VS Code Insiders', 'Local Agent', 'Local Agent (Insiders)']);

function computeDevcontainerStats(
  sessions: Record<string, unknown>[],
  reqs: Record<string, unknown>[],
): { terminalReqs: number; vscodeReqs: number; sandboxedTerminalReqs: number; totalTerminalReqs: number; terminalRate: number; vscodeSessionCount: number } {
  const vscodeSessions = sessions.filter(s => VSCODE_HARNESSES.has(asStr(s.harness)));
  const sessionIsContained = new Map<string, boolean>();
  for (const s of vscodeSessions) {
    sessionIsContained.set(String(s.sessionId), s.hasDevcontainer === true);
  }
  const vscodeReqs = reqs.filter(r => sessionIsContained.has(asStr(r.sessionId)));

  let hostedTerminalReqs = 0;
  let sandboxedTerminalReqs = 0;
  for (const r of vscodeReqs) {
    const confs = r.toolConfirmations;
    if (!Array.isArray(confs) || !confs.some((tc: unknown) => (tc as Record<string, unknown>).isTerminal)) continue;
    if (sessionIsContained.get(asStr(r.sessionId)) === true) sandboxedTerminalReqs++;
    else hostedTerminalReqs++;
  }
  const totalTerminalReqs = hostedTerminalReqs + sandboxedTerminalReqs;

  return {
    terminalReqs: hostedTerminalReqs,
    vscodeReqs: vscodeReqs.length,
    sandboxedTerminalReqs,
    totalTerminalReqs,
    terminalRate: vscodeReqs.length > 0 ? hostedTerminalReqs / vscodeReqs.length : 0,
    vscodeSessionCount: vscodeSessions.length,
  };
}

/* ── Context engineering gaps ── */

function computeContextGaps(reqs: Record<string, unknown>[]): { gapCount: number; gaps: string[]; reqCount: number } {
  const gaps: string[] = [];
  const total = reqs.length;

  // 1. Sub-agent / multi-agent usage
  const hasSubAgents = reqs.some(r => {
    const name = asStr(r.agentName);
    return name && name !== 'copilot' && asStr(r.agentMode) === 'agent';
  });
  if (!hasSubAgents) gaps.push('No sub-agent usage detected');

  // 2. Skills usage
  const hasSkills = reqs.some(r => {
    const skills = r.skillsUsed;
    return Array.isArray(skills) && skills.length > 0;
  });
  if (!hasSkills) gaps.push('No skills used in any request');

  // 3. MCP tools
  const hasMcp = reqs.some(r => {
    const tools = r.toolsUsed;
    return Array.isArray(tools) && tools.some((t: unknown) => String(t).startsWith('mcp_'));
  });
  if (!hasMcp) gaps.push('No MCP tool integration');

  // 4. File reference rate
  const fileRefCount = reqs.filter(r => {
    const refs = r.referencedFiles;
    return Array.isArray(refs) && refs.length > 0;
  }).length;
  if (total > 0 && fileRefCount / total < 0.1) gaps.push('Low file reference rate (< 10%)');

  // 5. Custom instructions rate
  const instrCount = reqs.filter(r => {
    const instr = r.customInstructions;
    return Array.isArray(instr) && instr.length > 0;
  }).length;
  if (total > 0 && instrCount / total < 0.05) gaps.push('Low custom instructions usage (< 5%)');

  return { gapCount: gaps.length, gaps, reqCount: total };
}

/* ── Yolo-mode stats ── */

function computeYoloStats(reqs: Record<string, unknown>[]): { autoApproved: number; totalConfirmations: number; ratio: number; withConfirmationsCount: number } {
  let totalConf = 0;
  let autoApproved = 0;
  let withConf = 0;
  for (const r of reqs) {
    const confs = r.toolConfirmations;
    if (!Array.isArray(confs) || confs.length === 0) continue;
    withConf++;
    for (const tc of confs as Record<string, unknown>[]) {
      totalConf++;
      const scope = asStr(tc.autoApproveScope);
      if (scope === 'session' || scope === 'always') autoApproved++;
    }
  }
  return {
    autoApproved,
    totalConfirmations: totalConf,
    ratio: totalConf > 0 ? autoApproved / totalConf : 0,
    withConfirmationsCount: withConf,
  };
}

/* ── Reasoning effort overuse ── */

function computeReasoningEffortStats(
  reqs: Record<string, unknown>[],
  premiumLevel: string,
): { premiumCount: number; totalKnown: number; total: number; ratio: number; topTier: string } {
  const premiumSet = premiumLevel === 'max'
    ? new Set(['max'])
    : new Set(['high', 'max']);
  let premiumCount = 0;
  let totalKnown = 0;
  const tierCounts = new Map<string, number>();
  for (const r of reqs) {
    const eff = r.reasoningEffort;
    if (eff === undefined || eff === null) continue;
    const tier = asStr(eff).toLowerCase();
    if (!['max', 'high', 'medium', 'low'].includes(tier)) continue;
    totalKnown++;
    tierCounts.set(tier, (tierCounts.get(tier) ?? 0) + 1);
    if (premiumSet.has(tier)) premiumCount++;
  }
  let topTier = '';
  let topCount = -1;
  for (const [t, c] of tierCounts.entries()) {
    if (c > topCount) { topTier = t; topCount = c; }
  }
  return {
    premiumCount,
    totalKnown,
    total: reqs.length,
    ratio: totalKnown > 0 ? premiumCount / totalKnown : 0,
    topTier,
  };
}

/* ── Instruction-bloat (oversized .github/copilot-instructions.md) ── */

function computeInstructionBloatStats(
  sessions: Record<string, unknown>[],
  maxBytes: number,
): { bloatedSessions: number; withInstructionsCount: number; totalSessions: number; maxBytes: number; p95Bytes: number } {
  const perWorkspace = new Map<string, number>();
  for (const s of sessions) {
    const ws = asStr(s.workspaceName) || asStr(s.workspaceId);
    const bytes = s.customInstructionsBytes;
    if (typeof bytes !== 'number' || !Number.isFinite(bytes)) continue;
    const prior = perWorkspace.get(ws);
    if (prior === undefined || bytes > prior) perWorkspace.set(ws, bytes);
  }
  let bloated = 0;
  let withInstructions = 0;
  const sizes: number[] = [];
  let topSize = 0;
  for (const bytes of perWorkspace.values()) {
    sizes.push(bytes);
    if (bytes > 0) withInstructions++;
    if (bytes > maxBytes) bloated++;
    if (bytes > topSize) topSize = bytes;
  }
  sizes.sort((a, b) => a - b);
  const p95 = sizes.length > 0 ? sizes[Math.min(sizes.length - 1, Math.floor(sizes.length * 0.95))] : 0;
  return {
    bloatedSessions: bloated,
    withInstructionsCount: withInstructions,
    totalSessions: perWorkspace.size,
    maxBytes: topSize,
    p95Bytes: p95,
  };
}

/* ── Excessive file context (huge file attachments per request) ── */

function computeExcessFileContextStats(
  reqs: Record<string, unknown>[],
  minFiles: number,
): { outlierCount: number; totalReqs: number; ratio: number; p95Files: number; maxFiles: number } {
  let outliers = 0;
  let topFiles = 0;
  const counts: number[] = [];
  for (const r of reqs) {
    const refs = r.referencedFiles;
    const n = Array.isArray(refs) ? refs.length : 0;
    counts.push(n);
    if (n > topFiles) topFiles = n;
    if (n >= minFiles) outliers++;
  }
  counts.sort((a, b) => a - b);
  const p95 = counts.length > 0 ? counts[Math.min(counts.length - 1, Math.floor(counts.length * 0.95))] : 0;
  return {
    outlierCount: outliers,
    totalReqs: reqs.length,
    ratio: reqs.length > 0 ? outliers / reqs.length : 0,
    p95Files: p95,
    maxFiles: topFiles,
  };
}

/* ── Duplicate groups (repeated prompts) ── */

function computeDuplicateGroups(reqs: Record<string, unknown>[], minKeyLen: number, minCount: number): { totalDupes: number; distinctCount: number; topKey: string; topCount: number } {
  const map = new Map<string, number>();
  for (const r of reqs) {
    const msg = asStr(r.messageText);
    const key = msg.substring(0, 100).toLowerCase().trim();
    if (key.length >= minKeyLen) map.set(key, (map.get(key) || 0) + 1);
  }
  const dupes = [...map.entries()].filter(([, c]) => c >= minCount);
  const totalDupes = dupes.reduce((s, [, c]) => s + c, 0);
  dupes.sort((a, b) => b[1] - a[1]);
  return {
    totalDupes,
    distinctCount: dupes.length,
    topKey: dupes.length > 0 ? dupes[0][0] : '',
    topCount: dupes.length > 0 ? dupes[0][1] : 0,
  };
}

/* ── Profanity matches across requests ── */

function computeProfanityMatches(reqs: Record<string, unknown>[]): { count: number; total: number; flaggedWords: string[] } {
  let count = 0;
  const flagged: string[] = [];
  for (const r of reqs) {
    const msg = asStr(r.messageText);
    const found = extractProfaneWords(msg);
    if (found.length > 0) {
      count++;
      if (flagged.length < 10) flagged.push(...found.slice(0, 3));
    }
  }
  return { count, total: reqs.length, flaggedWords: [...new Set(flagged)] };
}

/* ── Auto-approve stats ── */

function computeAutoApproveStats(reqs: Record<string, unknown>[]): {
  terminalAutoApproved: number; autoApprovedTotal: number; withConfirmations: number;
} {
  let withConf = 0, autoTotal = 0, termAuto = 0;
  for (const r of reqs) {
    const confs = r.toolConfirmations;
    if (!Array.isArray(confs) || confs.length === 0) continue;
    withConf++;
    let hasAutoApprove = false, hasTerminalAutoApprove = false;
    for (const tc of confs as Record<string, unknown>[]) {
      const scope = asStr(tc.autoApproveScope);
      if (scope === 'session' || scope === 'always') {
        hasAutoApprove = true;
        if (tc.isTerminal) hasTerminalAutoApprove = true;
      }
    }
    if (hasAutoApprove) autoTotal++;
    if (hasTerminalAutoApprove) termAuto++;
  }
  return { terminalAutoApproved: termAuto, autoApprovedTotal: autoTotal, withConfirmations: withConf };
}

/* ── Group by field and sum another, return top group ── */

function groupTopBySum(arr: unknown[], groupField: string, sumField: string): { key: string; sum: number; share: number; count: number } {
  const counts = new Map<string, number>();
  let totalSum = 0;
  for (const item of arr) {
    if (typeof item !== 'object' || !item) continue;
    const row = item as Record<string, unknown>;
    const key = asStr(resolveField(row, groupField));
    const value = toNum(resolveField(row, sumField));
    counts.set(key, (counts.get(key) || 0) + value);
    totalSum += value;
  }
  let topKey = '', topSum = 0;
  for (const [k, s] of counts) {
    if (s > topSum) { topKey = k; topSum = s; }
  }
  return { key: topKey, sum: topSum, share: totalSum > 0 ? topSum / totalSum : 0, count: counts.size };
}

/* ── Model overreliance stats ── */

function computeModelStats(reqs: Record<string, unknown>[]): { topModel: string; topCount: number; topShare: number; modelCount: number; total: number } {
  const counts = new Map<string, number>();
  for (const r of reqs) {
    const m = normalizeModelId(asStr(r.modelId, 'untracked'));
    counts.set(m, (counts.get(m) || 0) + 1);
  }
  let topModel = '', topCount = 0;
  for (const [k, c] of counts) {
    if (c > topCount) { topModel = k; topCount = c; }
  }
  return {
    topModel,
    topCount,
    topShare: reqs.length > 0 ? topCount / reqs.length : 0,
    modelCount: counts.size,
    total: reqs.length,
  };
}

const CALL_DISPATCH: Record<string, (argNodes: ASTNode[], ctx: Record<string, unknown>) => unknown> = {
  'length': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    {
      const v = evaluate(argNodes[0], ctx);
      if (typeof v === 'string' || Array.isArray(v)) return v.length;
      return 0;
    }
  },
  'contains': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    const args = () => argNodes.map(a => evaluate(a, ctx));

    {
      const [s, sub] = args();
      return typeof s === 'string' && typeof sub === 'string' && s.includes(sub);
    }
  },
  'startsWith': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    const args = () => argNodes.map(a => evaluate(a, ctx));

    {
      const [s, sub] = args();
      return typeof s === 'string' && typeof sub === 'string' && s.startsWith(sub);
    }
  },
  'endsWith': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    const args = () => argNodes.map(a => evaluate(a, ctx));

    {
      const [s, sub] = args();
      return typeof s === 'string' && typeof sub === 'string' && s.endsWith(sub);
    }
  },
  'matches': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    const args = () => argNodes.map(a => evaluate(a, ctx));

    {
      const [s, pattern] = args();
      if (typeof s !== 'string' || typeof pattern !== 'string') return false;
      const m = pattern.match(/^\/(.+)\/([gimsuy]*)$/);
      if (m) return testSafe(compileSafe(m[1], m[2]), s);
      const pf = parseRegexFlags(pattern);
      return testSafe(compileSafe(pf.pattern, pf.flags), s);
    }
  },
  'lower': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
     { const v = evaluate(argNodes[0], ctx); return typeof v === 'string' ? v.toLowerCase() : ''; }
  },
  'upper': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
     { const v = evaluate(argNodes[0], ctx); return typeof v === 'string' ? v.toUpperCase() : ''; }
  },
  'trim': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
      { const v = evaluate(argNodes[0], ctx); return typeof v === 'string' ? v.trim() : ''; }
  },
  'substr': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    const args = () => argNodes.map(a => evaluate(a, ctx));

    {
      const [s, start, len] = args();
      return typeof s === 'string' ? s.substring(toNum(start), len != null ? toNum(start) + toNum(len) : undefined) : '';
    }
  },
  'split': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    const args = () => argNodes.map(a => evaluate(a, ctx));

    {
      const [s, sep] = args();
      return typeof s === 'string' ? s.split(asStr(sep)) : [];
    }
  },
  'join': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    const args = () => argNodes.map(a => evaluate(a, ctx));

    {
      const [arr, sep] = args();
      return Array.isArray(arr) ? arr.join(asStr(sep, ',')) : '';
    }
  },
  'truncate': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    const args = () => argNodes.map(a => evaluate(a, ctx));

    {
      const [s, n] = args();
      if (typeof s !== 'string') return '';
      const max = toNum(n);
      return s.length > max ? s.substring(0, max) + '...' : s;
    }

    // Math functions
  },
  'abs': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
      return Math.abs(toNum(evaluate(argNodes[0], ctx)));
  },
  'floor': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    return Math.floor(toNum(evaluate(argNodes[0], ctx)));
  },
  'ceil': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
     return Math.ceil(toNum(evaluate(argNodes[0], ctx)));
  },
  'round': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    return Math.round(toNum(evaluate(argNodes[0], ctx)));
  },
  'min': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    const args = () => argNodes.map(a => evaluate(a, ctx));

      return Math.min(...args().map(toNum));
  },
  'max': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    const args = () => argNodes.map(a => evaluate(a, ctx));

      return Math.max(...args().map(toNum));

    // Date functions
  },
  'hour': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    {
      const ts = toNum(evaluate(argNodes[0], ctx));
      return ts > 0 ? new Date(ts).getHours() : -1;
    }
  },
  'dayOfWeek': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    {
      const ts = toNum(evaluate(argNodes[0], ctx));
      return ts > 0 ? new Date(ts).getDay() : -1;
    }
  },
  'dayOfMonth': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    {
      const ts = toNum(evaluate(argNodes[0], ctx));
      return ts > 0 ? new Date(ts).getDate() : -1;
    }
  },
  'month': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    {
      const ts = toNum(evaluate(argNodes[0], ctx));
      return ts > 0 ? new Date(ts).getMonth() : -1;
    }
  },
  'year': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    {
      const ts = toNum(evaluate(argNodes[0], ctx));
      return ts > 0 ? new Date(ts).getFullYear() : -1;
    }

    // Array functions
  },
  'includes': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    const args = () => argNodes.map(a => evaluate(a, ctx));

    {
      const [arr, val] = args();
      return Array.isArray(arr) && arr.includes(val);
    }
  },
  'some': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    {
      const arr = evaluate(argNodes[0], ctx);
      if (!Array.isArray(arr)) return false;
      const fieldName = argNodes[1]?.type === 'identifier' ? (argNodes[1] as { name: string }).name : asStr(evaluate(argNodes[1], ctx));
      return arr.some(item => {
        if (typeof item === 'object' && item) return !!(item as Record<string, unknown>)[fieldName];
        return false;
      });
    }
  },
  'every': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    {
      const arr = evaluate(argNodes[0], ctx);
      if (!Array.isArray(arr)) return false;
      const fieldName = argNodes[1]?.type === 'identifier' ? (argNodes[1] as { name: string }).name : asStr(evaluate(argNodes[1], ctx));
      return arr.every(item => {
        if (typeof item === 'object' && item) return !!(item as Record<string, unknown>)[fieldName];
        return false;
      });
    }
  },
  'count': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    {
      const v = evaluate(argNodes[0], ctx);
      return Array.isArray(v) ? v.length : 0;
    }
  },
  'sum': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    {
      const arr = evaluate(argNodes[0], ctx);
      if (!Array.isArray(arr)) return 0;
      if (argNodes.length > 1) {
        const field = argNodes[1]?.type === 'identifier' ? (argNodes[1] as { name: string }).name : asStr(evaluate(argNodes[1], ctx));
        return arr.reduce<number>((s, item) => s + toNum((typeof item === 'object' && item ? (item as Record<string, unknown>)[field] : 0)), 0);
      }
      return arr.reduce<number>((s, item) => s + toNum(item), 0);
    }
  },
  'avg': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    {
      const arr = evaluate(argNodes[0], ctx);
      if (!Array.isArray(arr) || arr.length === 0) return 0;
      if (argNodes.length > 1) {
        const field = argNodes[1]?.type === 'identifier' ? (argNodes[1] as { name: string }).name : asStr(evaluate(argNodes[1], ctx));
        const total = arr.reduce<number>((s, item) => s + toNum((typeof item === 'object' && item ? (item as Record<string, unknown>)[field] : 0)), 0);
        return total / arr.length;
      }
      return arr.reduce<number>((s, item) => s + toNum(item), 0) / arr.length;
    }
  },
  'unique': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    {
      const arr = evaluate(argNodes[0], ctx);
      if (!Array.isArray(arr)) return 0;
      if (argNodes.length > 1) {
        const field = argNodes[1]?.type === 'identifier' ? (argNodes[1] as { name: string }).name : asStr(evaluate(argNodes[1], ctx));
        return new Set<unknown>((arr as unknown[]).map(item => typeof item === 'object' && item ? (item as Record<string, unknown>)[field] : item)).size;
      }
      return new Set<unknown>(arr as unknown[]).size;
    }

    // Object functions
  },
  'keys': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    {
      const v = evaluate(argNodes[0], ctx);
      return typeof v === 'object' && v && !Array.isArray(v) ? Object.keys(v) : [];
    }
  },
  'values': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    {
      const v = evaluate(argNodes[0], ctx);
      return typeof v === 'object' && v && !Array.isArray(v) ? Object.values(v as Record<string, unknown>) : [];
    }
  },
  'has': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    const args = () => argNodes.map(a => evaluate(a, ctx));

    {
      const [obj, key] = args();
      return typeof obj === 'object' && obj && !Array.isArray(obj) && asStr(key) in (obj as Record<string, unknown>);
    }

    // Utility
  },
  'coalesce': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    {
      for (const arg of argNodes) {
        const v = evaluate(arg, ctx);
        if (v != null) return v;
      }
      return null;
    }
  },
  'iif': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    {
      // iif(condition, trueVal, falseVal)
      const cond = toBool(evaluate(argNodes[0], ctx));
      return cond ? evaluate(argNodes[1], ctx) : (argNodes[2] ? evaluate(argNodes[2], ctx) : null);
    }
  },
  'str': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    {
      const v = evaluate(argNodes[0], ctx);
      return asStr(v);
    }
  },
  'num': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    {
      const v = evaluate(argNodes[0], ctx);
      return toNum(v);
    }

    // ── Extended functions for rule pipeline ──

    /** matchesAny(text, patternArray) – true if text matches ANY regex in the array */
  },
  'matchesAny': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    const args = () => argNodes.map(a => evaluate(a, ctx));

    {
      const [text, patterns] = args();
      if (typeof text !== 'string' || !Array.isArray(patterns)) return false;
      return patterns.some(p => {
        const pf = parseRegexFlags(asStr(p));
        return testSafe(compileSafe(pf.pattern, pf.flags), text);
      });
    }

    /** capsLetterRatio(text) – ratio of uppercase letters to total letters */
  },
  'capsLetterRatio': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    {
      const text = asStr(evaluate(argNodes[0], ctx));
      let letters = 0, upper = 0;
      for (let i = 0, len = Math.min(text.length, 2000); i < len; i++) {
        const c = text.charCodeAt(i);
        if (c >= 65 && c <= 90) { letters++; upper++; }
        else if (c >= 97 && c <= 122) { letters++; }
      }
      return letters > 0 ? upper / letters : 0;
    }

    /** capsWordRatio(text, minWordLen?) – ratio of ALL-CAPS words (default minWordLen=3) */
  },
  'capsWordRatio': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    {
      const text = asStr(evaluate(argNodes[0], ctx));
      const minLen = argNodes.length > 1 ? toNum(evaluate(argNodes[1], ctx)) : 3;
      let wordLen = 0, wordCount = 0, capsWordCount = 0;
      let allUpper = true, hasLetter = false;
      const scanLen = Math.min(text.length, 2000);
      for (let i = 0; i <= scanLen; i++) {
        const c = i < scanLen ? text.charCodeAt(i) : 32;
        if (c === 32 || c === 9 || c === 10 || c === 13) {
          if (wordLen >= minLen) {
            wordCount++;
            if (allUpper && hasLetter) capsWordCount++;
          }
          wordLen = 0; allUpper = true; hasLetter = false;
        } else {
          wordLen++;
          if (c >= 65 && c <= 90) hasLetter = true;
          else if (c >= 97 && c <= 122) allUpper = false;
        }
      }
      return wordCount > 0 ? capsWordCount / wordCount : 0;
    }

    /** sumLoc(codeBlocks) – sum .loc from an array of {language, loc} blocks */
  },
  'sumLoc': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    {
      const arr = evaluate(argNodes[0], ctx);
      if (!Array.isArray(arr)) return 0;
      return arr.reduce<number>((s, b) => s + toNum((b as Record<string, unknown>)?.loc), 0);
    }

    /** sumLocFor(codeBlocks, langArray) – sum .loc where .language is in the array */
  },
  'sumLocFor': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    const args = () => argNodes.map(a => evaluate(a, ctx));

    {
      const [arr, langs] = args();
      if (!Array.isArray(arr) || !Array.isArray(langs)) return 0;
      const langSet = new Set(langs.map((l: unknown) => asStr(l).toLowerCase()));
      return (arr as Record<string, unknown>[])
        .filter(b => langSet.has(asStr(b.language).toLowerCase()))
        .reduce<number>((s, b) => s + toNum(b.loc), 0);
    }

    /** modelTier(modelId) – returns model cost multiplier (0 = free/unknown, ≥1 = premium) */
  },
  'modelTier': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    {
      const id = asStr(evaluate(argNodes[0], ctx));
      return modelTierLookup(id);
    }

    /** classifyWork(text) – classify message into work type string */
  },
  'classifyWork': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    {
      const text = asStr(evaluate(argNodes[0], ctx));
      return classifyWorkText(text);
    }

    // ── Array access functions ──

    /** first(arr) – first element of array */
  },
  'first': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    {
      const arr = evaluate(argNodes[0], ctx);
      return Array.isArray(arr) && arr.length > 0 ? (arr as unknown[])[0] : null;
    }

    /** at(arr, idx) – element at index */
  },
  'at': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    const args = () => argNodes.map(a => evaluate(a, ctx));

    {
      const [arr, idx] = args();
      return Array.isArray(arr) ? (arr as unknown[])[toNum(idx)] ?? null : null;
    }

    // ── String analysis functions ──

    /** substring(str, start, end) – extract portion of string */
  },
  'substring': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    const args = () => argNodes.map(a => evaluate(a, ctx));

    {
      const [s, start, end] = args();
      return typeof s === 'string' ? s.substring(toNum(start), end != null ? toNum(end) : undefined) : '';
    }

    /** lineCount(str) – count non-empty lines */
  },
  'lineCount': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    {
      const s = asStr(evaluate(argNodes[0], ctx));
      return s.split('\n').filter(l => l.trim().length > 0).length;
    }

    /** isStructured(str_or_reqObj) – true if text has bullets, numbered lists, headings, or spec keywords */
  },
  'isStructured': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    {
      const raw = evaluate(argNodes[0], ctx);
      const s = (typeof raw === 'object' && raw && !Array.isArray(raw))
        ? asStr((raw as Record<string, unknown>).messageText)
        : asStr(raw);
      return /^[-*]\s/m.test(s) ||        // bullets
             /^\d+[.)]\s/m.test(s) ||     // numbered lists
             /^#+\s/m.test(s) ||           // markdown headings
             /\b(requirements?|spec|acceptance criteria|user stor(y|ies)|given|when|then|should|must)\b/i.test(s) ||
             s.split('\n').filter(l => l.trim().length > 0).length >= 4;
    }

    /** hasProfanity(str) – detect profanity in text (strips code blocks first) */
  },
  'hasProfanity': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    {
      const raw = asStr(evaluate(argNodes[0], ctx));
      return detectProfanity(raw);
    }

    /** normalizeModel(id) – normalize model ID string */
  },
  'normalizeModel': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    {
      const raw = asStr(evaluate(argNodes[0], ctx));
      return normalizeModelId(raw);
    }

    // ── Generic array/regex utility functions ──

    /** anyMatch(strArr, pattern) – 1 if any string in array matches regex */
  },
  'anyMatch': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    {
      const arr = evaluate(argNodes[0], ctx);
      const pattern = asStr(evaluate(argNodes[1], ctx));
      if (!Array.isArray(arr)) return 0;
      const pf = parseRegexFlags(pattern);
      const re = compileSafe(pf.pattern, pf.flags);
      if (!re) return 0;
      return arr.some(item => testSafe(re, asStr(item))) ? 1 : 0;
    }

    /** flatSumField(arr, arrayField, sumField) – sum field across nested arrays */
  },
  'flatSumField': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    {
      const arr = evaluate(argNodes[0], ctx);
      if (!Array.isArray(arr)) return 0;
      const arrayField = argNodes[1]?.type === 'identifier'
        ? (argNodes[1] as { name: string }).name : asStr(evaluate(argNodes[1], ctx));
      const sumFieldName = argNodes[2]?.type === 'identifier'
        ? (argNodes[2] as { name: string }).name : asStr(evaluate(argNodes[2], ctx));
      let total = 0;
      for (const item of arr) {
        const sub = resolveField(item as Record<string, unknown>, arrayField);
        if (Array.isArray(sub)) {
          for (const elem of sub) {
            total += toNum(resolveField(elem as Record<string, unknown>, sumFieldName));
          }
        }
      }
      return total;
    }

    /** slice(arr, start, end?) – returns arr.slice(start, end) */
  },
  'slice': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    {
      const arr = evaluate(argNodes[0], ctx);
      if (!Array.isArray(arr)) return [];
      const start = toNum(evaluate(argNodes[1], ctx));
      const end = argNodes.length > 2 ? toNum(evaluate(argNodes[2], ctx)) : undefined;
      return (arr as unknown[]).slice(start, end);
    }

    /** anyWhere(arr, field, op, value) – 1 if any element matches, supports "matches" op */
  },
  'anyWhere': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    {
      const arr = evaluate(argNodes[0], ctx);
      if (!Array.isArray(arr)) return 0;
      const fieldName = asStr(evaluate(argNodes[1], ctx));
      const op = argNodes.length >= 4 ? asStr(evaluate(argNodes[2], ctx)) : '==';
      const value = argNodes.length >= 4 ? evaluate(argNodes[3], ctx) : evaluate(argNodes[2], ctx);
      return (arr as unknown[]).some(item => {
        const row: Record<string, unknown> = typeof item === 'object' && item ? item as Record<string, unknown> : { '.': item };
        const fv: unknown = fieldName === '.' ? item : resolveField(row, fieldName);
        switch (op) {
          case '==': return looseEquals(fv, value);
          case '!=': return !looseEquals(fv, value);
          case '>':  return toNum(fv) > toNum(value);
          case '>=': return toNum(fv) >= toNum(value);
          case '<':  return toNum(fv) < toNum(value);
          case '<=': return toNum(fv) <= toNum(value);
          case 'matches': {
            const pf = parseRegexFlags(asStr(value));
            return testSafe(compileSafe(pf.pattern, pf.flags), asStr(fv));
          }
          default: return looseEquals(fv, value);
        }
      }) ? 1 : 0;
    }
  },
  'sumAiLoc': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    {
      const reqs = evaluate(argNodes[0], ctx);
      if (!Array.isArray(reqs)) return 0;
      let total = 0;
      for (const r of reqs) {
        const blocks = (r as Record<string, unknown>)?.aiCode;
        if (Array.isArray(blocks)) {
          for (const b of blocks) total += toNum((b as Record<string, unknown>)?.loc);
        }
      }
      return total;
    }
  },
  'workTypeCount': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    {
      const reqs = evaluate(argNodes[0], ctx);
      if (!Array.isArray(reqs)) return 0;
      const types = new Set<string>();
      for (const r of reqs) {
        const msg = asStr((r as Record<string, unknown>)?.messageText);
        const wt = (r as Record<string, unknown>)?.workType;
        types.add(typeof wt === 'string' && wt ? wt : classifyWorkText(msg));
      }
      return types.size;
    }
  },
  'hasReviewFollowup': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    {
      const reqs = evaluate(argNodes[0], ctx);
      if (!Array.isArray(reqs) || reqs.length < 2) return false;
      const REVIEW_RE = /\b(change|fix|modify|update|refactor|wrong|instead|actually|revert|redo|try again)\b/i;
      for (let i = 1; i < reqs.length; i++) {
        const r = reqs[i] as Record<string, unknown>;
        const msg = asStr(r?.messageText);
        const edits = r?.editedFiles;
        if (REVIEW_RE.test(msg) || (Array.isArray(edits) && edits.length > 0)) return true;
      }
      return false;
    }
  },
  'groupTopKey': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    {
      const arr = evaluate(argNodes[0], ctx);
      if (!Array.isArray(arr) || arr.length === 0) return '';
      const fieldName = argNodes[1]?.type === 'identifier' ? (argNodes[1] as { name: string }).name : asStr(evaluate(argNodes[1], ctx));
      return groupTop(arr as unknown[], fieldName).key;
    }
  },
  'groupTopCount': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    {
      const arr = evaluate(argNodes[0], ctx);
      if (!Array.isArray(arr) || arr.length === 0) return 0;
      const fieldName = argNodes[1]?.type === 'identifier' ? (argNodes[1] as { name: string }).name : asStr(evaluate(argNodes[1], ctx));
      return groupTop(arr as unknown[], fieldName).count;
    }
  },
  'groupTopShare': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    {
      const arr = evaluate(argNodes[0], ctx);
      if (!Array.isArray(arr) || arr.length === 0) return 0;
      const fieldName = argNodes[1]?.type === 'identifier' ? (argNodes[1] as { name: string }).name : asStr(evaluate(argNodes[1], ctx));
      return groupTop(arr as unknown[], fieldName).share;
    }
  },
  'countWhere': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    {
      const arr = evaluate(argNodes[0], ctx);
      if (!Array.isArray(arr)) return 0;
      const fieldName = asStr(evaluate(argNodes[1], ctx));
      const op = asStr(evaluate(argNodes[2], ctx));
      const value = evaluate(argNodes[3], ctx);
      return arr.filter(item => {
        const fv = resolveField(item as Record<string, unknown>, fieldName);
        switch (op) {
          case '>':  return toNum(fv) >  toNum(value);
          case '>=': return toNum(fv) >= toNum(value);
          case '<':  return toNum(fv) <  toNum(value);
          case '<=': return toNum(fv) <= toNum(value);
          case '==': return looseEquals(fv, value);
          case '!=': return !looseEquals(fv, value);
          case 'matches': {
            const pf = parseRegexFlags(asStr(value));
            return testSafe(compileSafe(pf.pattern, pf.flags), asStr(fv));
          }
          default:   return toBool(fv);
        }
      }).length;
    }
  },
  'sumField': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    {
      const arr = evaluate(argNodes[0], ctx);
      if (!Array.isArray(arr)) return 0;
      const fieldName = argNodes[1]?.type === 'identifier' ? (argNodes[1] as { name: string }).name : asStr(evaluate(argNodes[1], ctx));
      return arr.reduce<number>((s, item) => s + toNum(resolveField(item as Record<string, unknown>, fieldName)), 0);
    }
  },
  'avgField': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    {
      const arr = evaluate(argNodes[0], ctx);
      if (!Array.isArray(arr) || arr.length === 0) return 0;
      const fieldName = argNodes[1]?.type === 'identifier' ? (argNodes[1] as { name: string }).name : asStr(evaluate(argNodes[1], ctx));
      const total = arr.reduce<number>((s, item) => s + toNum(resolveField(item as Record<string, unknown>, fieldName)), 0);
      return total / arr.length;
    }
  },
  'flatCount': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    {
      const arr = evaluate(argNodes[0], ctx);
      if (!Array.isArray(arr)) return 0;
      const fieldName = argNodes[1]?.type === 'identifier' ? (argNodes[1] as { name: string }).name : asStr(evaluate(argNodes[1], ctx));
      return arr.reduce<number>((s, item) => {
        const sub = resolveField(item as Record<string, unknown>, fieldName);
        return s + (Array.isArray(sub) ? sub.length : 0);
      }, 0);
    }
  },
  'flatUnique': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    {
      const arr = evaluate(argNodes[0], ctx);
      if (!Array.isArray(arr)) return 0;
      const fieldName = argNodes[1]?.type === 'identifier' ? (argNodes[1] as { name: string }).name : asStr(evaluate(argNodes[1], ctx));
      const seen = new Set<string>();
      for (const item of arr) {
        const sub = resolveField(item as Record<string, unknown>, fieldName);
        if (Array.isArray(sub)) {
          for (const v of sub) {
            if (v !== null && v !== undefined) seen.add(asStr(v));
          }
        }
      }
      return seen.size;
    }
  },
  'flatSomeWhere': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    {
      const arr = evaluate(argNodes[0], ctx);
      if (!Array.isArray(arr)) return 0;
      const fieldName = argNodes[1]?.type === 'identifier' ? (argNodes[1] as { name: string }).name : asStr(evaluate(argNodes[1], ctx));
      const subField = asStr(evaluate(argNodes[2], ctx));
      const target = evaluate(argNodes[3], ctx);
      const op = argNodes.length >= 5 ? asStr(evaluate(argNodes[4], ctx)) : '==';
      const checkElem = (elem: unknown): boolean => {
        const fv = subField === '.' ? elem : resolveField(elem as Record<string, unknown>, subField);
        switch (op) {
          case '==': return looseEquals(fv, target);
          case '!=': return !looseEquals(fv, target);
          case 'startsWith': return asStr(fv).startsWith(asStr(target));
          case 'contains': return asStr(fv).includes(asStr(target));
          case 'matches': {
            const pf = parseRegexFlags(asStr(target));
            return testSafe(compileSafe(pf.pattern, pf.flags), asStr(fv));
          }
          default: return looseEquals(fv, target);
        }
      };
      return arr.some(item => {
        const sub = resolveField(item as Record<string, unknown>, fieldName);
        if (!Array.isArray(sub)) return false;
        return sub.some(checkElem);
      }) ? 1 : 0;
    }
  },
  'adjacentPairCount': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    {
      const sessions = evaluate(argNodes[0], ctx);
      const minLoc = toNum(evaluate(argNodes[1], ctx));
      const maxGap = toNum(evaluate(argNodes[2], ctx));
      if (!Array.isArray(sessions)) return { count: 0, avgLoc: 0, avgGap: 0 };
      return computeSpeedAcceptPairs(sessions as Record<string, unknown>[], minLoc, maxGap);
    }
  },
  'flowScoreStats': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    {
      const sessions = evaluate(argNodes[0], ctx);
      const minTimed = argNodes.length > 1 ? toNum(evaluate(argNodes[1], ctx)) : 3;
      const rapidMs = argNodes.length > 2 ? toNum(evaluate(argNodes[2], ctx)) : 30000;
      if (!Array.isArray(sessions)) return { fragmentedDays: 0, totalDays: 0, avgScore: 100 };
      return computeFlowScoreStats(sessions as Record<string, unknown>[], minTimed, rapidMs);
    }
  },
  'langExplorationWeeks': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    {
      const reqs = evaluate(argNodes[0], ctx);
      if (!Array.isArray(reqs)) return { weeksSinceNew: 0, totalLangs: 0, recentNew: 0 };
      return computeLangExploration(reqs as Record<string, unknown>[]);
    }
  },
  'mdRatioByWorkspace': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    {
      const sessions = evaluate(argNodes[0], ctx);
      const minLoc = argNodes.length > 1 ? toNum(evaluate(argNodes[1], ctx)) : 100;
      const docLangs = argNodes.length > 2 ? evaluate(argNodes[2], ctx) : ['markdown', 'md'];
      if (!Array.isArray(sessions)) return { lowCount: 0, totalWorkspaces: 0, overallRatio: 0 };
      return computeMdRatio(
        sessions as Record<string, unknown>[],
        minLoc,
        Array.isArray(docLangs) ? docLangs.map(String) : ['markdown', 'md'],
      );
    }
  },
  'devcontainerStats': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    {
      const sessions = evaluate(argNodes[0], ctx);
      const reqs = evaluate(argNodes[1], ctx);
      if (!Array.isArray(sessions) || !Array.isArray(reqs)) return { terminalReqs: 0, vscodeReqs: 0, sandboxedTerminalReqs: 0, totalTerminalReqs: 0, terminalRate: 0 };
      return computeDevcontainerStats(sessions as Record<string, unknown>[], reqs as Record<string, unknown>[]);
    }
  },
  'contextGapCount': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    {
      const reqs = evaluate(argNodes[0], ctx);
      if (!Array.isArray(reqs)) return { gapCount: 0, gaps: [], reqCount: 0 };
      return computeContextGaps(reqs as Record<string, unknown>[]);
    }
  },
  'yoloStats': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    {
      const reqs = evaluate(argNodes[0], ctx);
      if (!Array.isArray(reqs)) return { autoApproved: 0, totalConfirmations: 0, ratio: 0 };
      return computeYoloStats(reqs as Record<string, unknown>[]);
    }
  },
  'reasoningEffortStats': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    {
      const reqs = evaluate(argNodes[0], ctx);
      const premiumLevel = argNodes.length > 1 ? asStr(evaluate(argNodes[1], ctx), 'high').toLowerCase() : 'high';
      if (!Array.isArray(reqs)) return { premiumCount: 0, totalKnown: 0, total: 0, ratio: 0, topTier: '' };
      return computeReasoningEffortStats(reqs as Record<string, unknown>[], premiumLevel);
    }
  },
  'instructionBloatStats': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    {
      const sessions = evaluate(argNodes[0], ctx);
      const maxBytes = argNodes.length > 1 ? toNum(evaluate(argNodes[1], ctx)) : 4000;
      if (!Array.isArray(sessions)) return { bloatedSessions: 0, withInstructionsCount: 0, totalSessions: 0, maxBytes: 0, p95Bytes: 0 };
      return computeInstructionBloatStats(sessions as Record<string, unknown>[], maxBytes);
    }
  },
  'excessFileContextStats': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    {
      const reqs = evaluate(argNodes[0], ctx);
      const minFiles = argNodes.length > 1 ? toNum(evaluate(argNodes[1], ctx)) : 30;
      if (!Array.isArray(reqs)) return { outlierCount: 0, totalReqs: 0, ratio: 0, p95Files: 0, maxFiles: 0 };
      return computeExcessFileContextStats(reqs as Record<string, unknown>[], minFiles);
    }
  },
  'hasSkillByPattern': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    {
      const reqs = evaluate(argNodes[0], ctx);
      const pattern = asStr(evaluate(argNodes[1], ctx));
      if (!Array.isArray(reqs) || !pattern) return 0;
      const pf = parseRegexFlags(pattern);
      const re = compileSafe(pf.pattern, pf.flags);
      if (!re) return 0;
      for (const r of reqs) {
        const skills = (r as Record<string, unknown>).skillsUsed;
        if (Array.isArray(skills)) {
          for (const s of skills) {
            if (testSafe(re, asStr(s))) return 1;
          }
        }
      }
      return 0;
    }
  },
  'duplicateGroups': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    {
      const reqs = evaluate(argNodes[0], ctx);
      const minKeyLen = argNodes.length > 1 ? toNum(evaluate(argNodes[1], ctx)) : 10;
      const minCount = argNodes.length > 2 ? toNum(evaluate(argNodes[2], ctx)) : 3;
      if (!Array.isArray(reqs)) return { totalDupes: 0, distinctCount: 0, topKey: '', topCount: 0 };
      return computeDuplicateGroups(reqs as Record<string, unknown>[], minKeyLen, minCount);
    }
  },
  'profanityMatches': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    {
      const reqs = evaluate(argNodes[0], ctx);
      if (!Array.isArray(reqs)) return { count: 0, total: 0, flaggedWords: [] };
      return computeProfanityMatches(reqs as Record<string, unknown>[]);
    }
  },
  'hasConstraint': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    {
      const text = asStr(evaluate(argNodes[0], ctx));
      const sample = text.length > 500 ? text.substring(0, 500) : text;
      return /\b(do not|don't|dont|must not|mustn't|never|without|avoid|only|strictly|limit to|at most|at least|no more than|require|restrict|exclude|ensure|must|shall|should not|shouldn't)\b/i.test(sample);
    }
  },
  'someWhere': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    {
      const arr = evaluate(argNodes[0], ctx);
      if (!Array.isArray(arr)) return false;
      const fieldName = asStr(evaluate(argNodes[1], ctx));
      const op = argNodes.length >= 4 ? asStr(evaluate(argNodes[2], ctx)) : '==';
      const value = argNodes.length >= 4 ? evaluate(argNodes[3], ctx) : evaluate(argNodes[2], ctx);
      return arr.some(item => {
        if (typeof item !== 'object' || !item) return false;
        const fv = resolveField(item as Record<string, unknown>, fieldName);
        switch (op) {
          case '==': return looseEquals(fv, value);
          case '!=': return !looseEquals(fv, value);
          case '>':  return toNum(fv) > toNum(value);
          case '>=': return toNum(fv) >= toNum(value);
          case '<':  return toNum(fv) < toNum(value);
          case '<=': return toNum(fv) <= toNum(value);
          case 'matches': {
            const pf = parseRegexFlags(asStr(value));
            return testSafe(compileSafe(pf.pattern, pf.flags), asStr(fv));
          }
          default:   return looseEquals(fv, value);
        }
      }) ? 1 : 0;
    }
  },
  'isSpecDriven': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    {
      const arr = evaluate(argNodes[0], ctx);
      if (!Array.isArray(arr) || arr.length === 0) return 0;
      const first = arr[0] as Record<string, unknown>;

      const refs = first.referencedFiles;
      if (Array.isArray(refs) && refs.some(f => /\.(md|txt|spec|prd|design|plan|rfc|adoc)$/i.test(asStr(f)))) return 1;

      const msg = asStr(first.messageText);
      if (/\b(spec|requirements?|acceptance criteria|design doc|PRD|RFC|plan file|constraint|must|should|ensure)\b/i.test(msg)) return 1;
      if (/^[-*]\s/m.test(msg) && msg.split('\n').filter(l => l.trim()).length >= 3) return 1;
      if (/^\d+[.)]\s/m.test(msg) && msg.split('\n').filter(l => l.trim()).length >= 3) return 1;
      if (/^#+\s/m.test(msg)) return 1;

      const mode = asStr(first.agentMode);
      const slash = asStr(first.slashCommand);
      if (mode.includes('plan') || slash === 'plan') return 1;

      return 0;
    }
  },
  'hasPlanUsage': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    {
      const arr = evaluate(argNodes[0], ctx);
      if (!Array.isArray(arr)) return 0;
      return (arr as Record<string, unknown>[]).some(r => {
        const mode = asStr(r.agentMode);
        const slash = asStr(r.slashCommand);
        if (mode.includes('plan') || slash === 'plan') return true;
        const msg = asStr(r.messageText).toLowerCase();
        return msg.startsWith('plan') && toNum(r.messageLength) > 15;
      }) ? 1 : 0;
    }
  },
  'autoApproveStats': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    {
      const reqs = evaluate(argNodes[0], ctx);
      if (!Array.isArray(reqs)) return { terminalAutoApproved: 0, autoApprovedTotal: 0, withConfirmations: 0 };
      return computeAutoApproveStats(reqs as Record<string, unknown>[]);
    }
  },
  'groupTopBySum': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    {
      const arr = evaluate(argNodes[0], ctx);
      if (!Array.isArray(arr) || arr.length === 0) return { key: '', sum: 0, share: 0 };
      const groupField = asStr(evaluate(argNodes[1], ctx));
      const sumField = asStr(evaluate(argNodes[2], ctx));
      return groupTopBySum(arr as unknown[], groupField, sumField);
    }
  },
  'uniqueCount': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    {
      const arr = evaluate(argNodes[0], ctx);
      if (!Array.isArray(arr)) return 0;
      const fieldName = asStr(evaluate(argNodes[1], ctx));
      const vals = new Set(arr.map(item =>
        typeof item === 'object' && item ? asStr(resolveField(item as Record<string, unknown>, fieldName)) : ''
      ));
      return vals.size;
    }
  },
  'modelStats': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    {
      const reqs = evaluate(argNodes[0], ctx);
      if (!Array.isArray(reqs)) return { topModel: '', topCount: 0, topShare: 0, modelCount: 0, total: 0 };
      return computeModelStats(reqs as Record<string, unknown>[]);
    }
  },
  'hasPlanning': (argNodes: ASTNode[], ctx: Record<string, unknown>) => {
    {
      const arr = evaluate(argNodes[0], ctx);
      if (!Array.isArray(arr)) return 0;
      return (arr as Record<string, unknown>[]).some(r => {
        const mode = asStr(r.agentMode);
        const slash = asStr(r.slashCommand);
        if (mode.includes('plan') || slash === 'plan') return true;
        const msg = asStr(r.messageText).substring(0, 300);
        return /\b(plan|architect|design|outline|approach|strategy|scope|breakdown|roadmap|RFC|spec|proposal)\b/i.test(msg);
      }) ? 1 : 0;
    }
  },
};
