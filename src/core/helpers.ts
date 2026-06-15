/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Shared date and model helpers used across analyzer modules */

import { WorkType } from './types';
import { MODEL_MULTIPLIERS, MODEL_TOKEN_RATES } from './constants';

/* ---- File-URI helper ---- */

/** decodeURIComponent that returns the input unchanged on malformed sequences (e.g. a literal `%` in a path). */
function safeDecode(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

/**
 * Convert a `file://` URI to a local filesystem path, handling Windows drive-letter
 * URIs (e.g. `file:///C:/Users/...`) correctly.  Falls back to decoding
 * for non-URI strings so callers don't need to branch.
 */
export function fileUriToPath(raw: string): string {
  if (!raw.startsWith('file://')) return safeDecode(raw);
  // Strip scheme: file:///C:/foo → /C:/foo   file:///home/u → /home/u
  let p = safeDecode(raw.replace(/^file:\/\//, ''));
  // On Windows the URI has an extra leading slash before the drive letter: /C:/...
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
  return p;
}

/* ---- Date helpers ---- */
export function toDateStr(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function endOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

export function isoWeek(d: Date): string {
  const thu = new Date(d);
  thu.setDate(d.getDate() - ((d.getDay() + 6) % 7) + 3);
  const yr = thu.getFullYear();
  const wk = Math.ceil((((thu.getTime() - new Date(yr, 0, 4).getTime()) / 86400000) + new Date(yr, 0, 4).getDay() + 1) / 7);
  return `${yr}-W${String(wk).padStart(2, '0')}`;
}

/** Return every YYYY-MM-DD between the first and last entry in `days` (inclusive). */
export function fillDayRange(days: string[]): string[] {
  if (days.length <= 1) return days;
  const sorted = [...days].sort();
  const start = new Date(sorted[0] + 'T00:00:00');
  const end = new Date(sorted[sorted.length - 1] + 'T00:00:00');
  const result: string[] = [];
  for (const d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    result.push(toDateStr(d.getTime()));
  }
  return result;
}

/** Return every ISO week label between the first and last entry in `weeks` (inclusive). */
export function fillWeekRange(weeks: string[]): string[] {
  if (weeks.length <= 1) return weeks;
  const sorted = [...weeks].sort();
  const toMonday = (label: string): Date => {
    const [y, w] = label.split('-W').map(Number);
    const jan4 = new Date(y, 0, 4);
    const dow = (jan4.getDay() + 6) % 7;
    const mon = new Date(jan4);
    mon.setDate(jan4.getDate() - dow + (w - 1) * 7);
    return mon;
  };
  const start = toMonday(sorted[0]);
  const end = toMonday(sorted[sorted.length - 1]);
  const result: string[] = [];
  for (const d = new Date(start); d <= end; d.setDate(d.getDate() + 7)) {
    result.push(isoWeek(d));
  }
  return result;
}

/** Return every YYYY-MM between the first and last entry in `months` (inclusive). */
export function fillMonthRange(months: string[]): string[] {
  if (months.length <= 1) return months;
  const sorted = [...months].sort();
  const [sy, sm] = sorted[0].split('-').map(Number);
  const [ey, em] = sorted[sorted.length - 1].split('-').map(Number);
  const result: string[] = [];
  for (let y = sy, m = sm; y < ey || (y === ey && m <= em); m++) {
    if (m > 12) { m = 1; y++; }
    result.push(`${y}-${String(m).padStart(2, '0')}`);
  }
  return result;
}

/* ---- Model helpers ---- */

/** Effort suffixes that get baked into model IDs by the GitHub model router
 *  (e.g. `claude-opus-4.7-high`, `claude-opus-4.7-xhigh`). We strip these
 *  from the normalized model name so cost/context analyses group by family,
 *  while the effort value is captured separately via extractReasoningEffortFromModelId. */
const EFFORT_SUFFIX_RE = /-(xhigh|extra-high|max|high|medium|med|low|minimal)$/;

export function normalizeModel(modelId: string): string {
  let m = modelId.trim();
  for (const prefix of ['copilot/', 'github.copilot-chat/', 'github/']) {
    if (m.startsWith(prefix)) { m = m.slice(prefix.length); break; }
  }
  m = m.replace(/-thought$/, '').replace(/-preview$/, '').replace(/-latest$/, '');
  // Claude's API returns hyphenated version numbers (claude-opus-4-6) where
  // our rate tables use dots (claude-opus-4.6). Also strip -YYYYMMDD date
  // suffixes that older API responses append (claude-haiku-4-5-20251001).
  // Non-global replace: only the first digit-hyphen-digit is converted,
  // preserving suffixes like -1m.
  if (m.startsWith('claude-')) {
    m = m.replace(/-\d{8}$/, '');
    m = m.replace(/(\d)-(\d)/, '$1.$2');
  }
  // Strip effort suffixes ONLY for known reasoning-capable families (avoid
  // false positives on models like gpt-5.4-mini or gemini-3-flash).
  if (EFFORT_BEARING_RE.test(m) && !NON_EFFORT_SUFFIXES_RE.test(m)) {
    m = m.replace(EFFORT_SUFFIX_RE, '');
  }
  return m.trim();
}

export function modelMultiplier(modelId: string): number {
  const key = normalizeModel(modelId);
  if (MODEL_MULTIPLIERS[key] !== undefined) return MODEL_MULTIPLIERS[key];
  for (const [k, v] of Object.entries(MODEL_MULTIPLIERS)) {
    if (key.startsWith(k)) return v;
  }
  return 1;
}

/* ---- Reasoning effort inference ---- */

/** Regex matching reasoning-capable model families. Uses prefix patterns so
 *  future point-releases (e.g. `claude-opus-4.8`, `gpt-5.7`) are covered
 *  automatically. Allowlist-based to avoid false-positives on suffixes that
 *  don't denote effort (e.g. `-fast`, `-1m`, `-mini`). */
const EFFORT_BEARING_RE = /^(?:claude-opus-4|claude-sonnet-4|gpt-5|o[1-9]|o\d{2,}|gemini-[2-9]|gemini-\d{2,})/;

/** Suffixes that look like effort markers but are NOT reasoning-effort levels.
 *  These are excluded before matching effort suffixes to prevent false positives. */
const NON_EFFORT_SUFFIXES_RE = /-(fast|1m|mini|nano|micro|preview|latest|thought|turbo|flash|pro|ultra|internal)$/;

/** Map a `-suffix` on a known reasoning-capable model id to a canonical
 *  effort level. Returns `null` for unknown families or unknown suffixes
 *  (do NOT guess — `null` propagates to "unknown" in the data). */
export function extractReasoningEffortFromModelId(
  modelId: string,
): 'max' | 'high' | 'medium' | 'low' | null {
  if (!modelId) return null;
  // Strip vendor prefix and legacy suffixes (-thought/-preview/-latest) but
  // NOT effort suffixes — those are what we want to detect here.
  let key = modelId.trim();
  for (const prefix of ['copilot/', 'github.copilot-chat/', 'github/']) {
    if (key.startsWith(prefix)) { key = key.slice(prefix.length); break; }
  }
  key = key.replace(/-thought$/, '').replace(/-preview$/, '').replace(/-latest$/, '').toLowerCase();
  // Same Claude API normalization as normalizeModel (date suffix + version dots).
  if (key.startsWith('claude-')) {
    key = key.replace(/-\d{8}$/, '');
    key = key.replace(/(\d)-(\d)/, '$1.$2');
  }
  if (!EFFORT_BEARING_RE.test(key)) return null;
  if (NON_EFFORT_SUFFIXES_RE.test(key)) return null;
  if (key.endsWith('-xhigh') || key.endsWith('-extra-high') || key.endsWith('-max')) return 'max';
  if (key.endsWith('-high')) return 'high';
  if (key.endsWith('-medium') || key.endsWith('-med')) return 'medium';
  if (key.endsWith('-low') || key.endsWith('-minimal')) return 'low';
  return null;
}

/** Normalize free-form effort strings reported by harnesses into the canonical set. */
export function canonicalizeReasoningEffort(
  raw: string | null | undefined,
): 'max' | 'high' | 'medium' | 'low' | null {
  if (!raw) return null;
  const s = String(raw).toLowerCase().trim();
  if (s === 'max' || s === 'maximum' || s === 'xhigh' || s === 'extra-high' || s === 'extreme') return 'max';
  if (s === 'high') return 'high';
  if (s === 'medium' || s === 'med' || s === 'default') return 'medium';
  if (s === 'low' || s === 'minimal') return 'low';
  return null;
}

/* ---- Native token resolution ---- */

/**
 * Resolve token counts for a request.
 *
 * Returns *only* native counts reported by the harness. No char-based
 * approximation is performed: when a side is missing the corresponding
 * value is `0` and the side-specific flag (`hasInput` / `hasOutput`) is
 * false. `missing` is `true` whenever **either** input OR output is absent
 * — credit math requires both sides to be considered complete.
 *
 * `promptTokens` is the *total* input context size (includes the cached
 * portion when known). `cacheReadTokens` and `cacheWriteTokens` are
 * subsets used only for billing math; they default to 0 (treated as
 * fully uncached) when not provided.
 */
export function resolveTokens(
  promptTokens: number | null,
  completionTokens: number | null,
  cacheReadTokens: number | null = null,
  cacheWriteTokens: number | null = null,
): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  uncachedInput: number;
  hasInput: boolean;
  hasOutput: boolean;
  missing: boolean;
} {
  const hasInput = promptTokens != null;
  const hasOutput = completionTokens != null;
  const input = hasInput ? promptTokens : 0;
  const output = hasOutput ? completionTokens : 0;
  const cacheRead = cacheReadTokens ?? 0;
  const cacheWrite = cacheWriteTokens ?? 0;
  // Uncached input cannot be negative even if cache totals exceed prompt
  // (which can happen with rounding from session-level totals).
  const uncachedInput = Math.max(0, input - cacheRead - cacheWrite);
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    uncachedInput,
    hasInput,
    hasOutput,
    missing: !hasInput || !hasOutput,
  };
}

/**
 * Calculate AI Credit cost for a single request or aggregated bucket.
 * 1 AI Credit = $0.01 USD. Rates are in $/1M tokens.
 *
 * `inputTokens` is the *uncached* input portion (billed at the input rate).
 * `cacheReadTokens` and `cacheWriteTokens` (defaulting to 0) are billed at
 * their lower respective rates. Returns credits, not dollars.
 */
export function tokenCostInCredits(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number = 0,
  cacheWriteTokens: number = 0,
): number {
  const rates = MODEL_TOKEN_RATES[normalizeModel(model)];
  if (!rates) {
    // Fallback: use model multiplier as rough proxy (1 PRU ≈ 1 credit)
    return modelMultiplier(model);
  }
  const inputCost = (inputTokens / 1_000_000) * rates.input;
  const outputCost = (outputTokens / 1_000_000) * rates.output;
  const cacheReadCost = (cacheReadTokens / 1_000_000) * rates.cached;
  const cacheWriteCost = (cacheWriteTokens / 1_000_000) * (rates.cacheWrite ?? rates.input);
  // Convert USD to credits (1 credit = $0.01)
  return (inputCost + outputCost + cacheReadCost + cacheWriteCost) * 100;
}

/* ---- Work-type classification ---- */
const WORK_PATTERNS: [RegExp, WorkType][] = [
  [/\b(fix|bug|error|issue|crash|exception|debug|problem|broken|fail|wrong)\b/i, 'bug fix'],
  [/\b(refactor|rename|extract|move|cleanup|simplify|restructure|reorganize)\b/i, 'refactor'],
  [/\b(review|pr|pull request|code review|comment on|feedback|approve)\b/i, 'code review'],
  [/\b(test|spec|expect|assert|mock|stub|coverage|vitest|jest|pytest|unittest)\b/i, 'test'],
  [/\b(doc|readme|comment|explain|jsdoc|typedoc|docstring|swagger|openapi)\b/i, 'docs'],
  [/\b(style|css|scss|sass|theme|layout|padding|margin|font|color|design|ui)\b/i, 'style'],
  [/\b(config|setup|install|dependency|package|ci|cd|pipeline|deploy|docker|k8s|terraform|bicep|env|yaml|yml)\b/i, 'config'],
  [/\b(add|create|implement|build|feature|new|scaffold|generate|develop)\b/i, 'feature'],
];

export function classifyWorkType(msg: string): WorkType {
  for (const [re, wt] of WORK_PATTERNS) {
    if (re.test(msg)) return wt;
  }
  return 'other';
}

/**
 * Harness-injected session-start payloads that are recorded as `user` messages
 * but are not real user prompts (e.g. Codex injects the repo `AGENTS.md` and
 * environment/instruction context at session start). These should be treated as
 * noise so they don't get clustered into workflow/skill recommendations.
 *
 * Matches a small set of known leading markers only — deliberately NOT a generic
 * `#` markdown header or `<tag>` rule, both of which would suppress legitimate
 * user prompts.
 */
const HARNESS_INJECTED_MARKERS: RegExp[] = [
  /^# AGENTS\.md instructions\b/,
  /^<environment_context\b/,
  /^<INSTRUCTIONS\b/,
  /^<user_instructions\b/,
];

export function isHarnessInjectedContext(text: string): boolean {
  const t = text.trimStart();
  return HARNESS_INJECTED_MARKERS.some(re => re.test(t));
}
