/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Prompt-composition helpers shared by the parsers and the context analyzer.
 * Only category names and numbers pass through here — never prompt content. */

import type { ContextCategory, PromptComposition, SystemPromptSegment } from './types';
import { COMPOSITION_ROUNDING_TOLERANCE } from './constants';

type Shares = Partial<Record<ContextCategory, number>>;

/** Canonical display order. */
export const CONTEXT_CATEGORIES: readonly ContextCategory[] = [
  'systemInstructions',
  'toolDefinitions',
  'messages',
  'toolResults',
  'files',
  'conversation',
  'other',
];

/* Labels VS Code Copilot Chat writes into `promptTokenDetails` (constant English strings).
 * A Map, because labels come from log files and must not resolve through Object.prototype. */
const VSCODE_LABELS = new Map<string, ContextCategory>([
  ['system instructions', 'systemInstructions'],
  ['tool definitions', 'toolDefinitions'],
  ['messages', 'messages'],
  ['tool results', 'toolResults'],
  ['files', 'files'],
]);

/* VS Code omits labels that round to 0%, so a missing known label means 0%, not "not reported". */
const VSCODE_CATEGORIES: readonly ContextCategory[] = ['systemInstructions', 'toolDefinitions', 'messages', 'toolResults', 'files'];

const MAX_SYSTEM_SEGMENTS = 40;
const SEGMENT_NAME_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clampShare(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function roundShare(value: number): number {
  return Math.round(value * 100) / 100;
}

function positiveOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Map VS Code's `promptTokenDetails` (`[{ category, label, percentageOfPrompt }]`) to a
 * composition. Unknown labels go to `other`. `promptTokens` is the prompt size the
 * percentages describe. Returns `undefined` when the request carries no usable details.
 */
export function compositionFromPromptTokenDetails(details: unknown, promptTokens: unknown): PromptComposition | undefined {
  if (!Array.isArray(details)) return undefined;
  const shares: Shares = {};
  let found = false;
  for (const item of details) {
    if (!isRecord(item)) continue;
    const pct = item.percentageOfPrompt;
    if (typeof pct !== 'number' || !Number.isFinite(pct) || pct < 0) continue;
    const label = typeof item.label === 'string' ? item.label.trim().toLowerCase() : '';
    const category = VSCODE_LABELS.get(label) ?? 'other';
    shares[category] = clampShare((shares[category] ?? 0) + pct);
    found = true;
  }
  if (!found) return undefined;
  for (const category of VSCODE_CATEGORIES) shares[category] ??= 0;
  return { source: 'vscode', shares, promptTokens: positiveOrNull(promptTokens) };
}

/** Main-agent model calls of one Copilot CLI turn, summed from `session.usage_record`. */
export interface CliTurnUsage {
  calls: number;
  /** Total prompt tokens, including cached tokens. */
  inputTokens: number;
  toolTokens: number;
  availableTools: number;
}

/**
 * Build a Copilot CLI turn composition. Tool definitions come from the per-call
 * `toolTokenCount`; the system prompt uses the size from the latest checkpoint per call;
 * the remainder of the prompt is the conversation. Without a system size, the
 * non-tool remainder stays unattributed (`other`).
 */
export function compositionFromCliUsage(usage: CliTurnUsage, systemTokensPerCall: number | null): PromptComposition | undefined {
  if (usage.calls <= 0 || usage.inputTokens <= 0) return undefined;
  const input = usage.inputTokens;
  const tools = Math.min(Math.max(0, usage.toolTokens), input);
  const shares: Shares = { toolDefinitions: roundShare((tools / input) * 100) };
  if (systemTokensPerCall != null && systemTokensPerCall > 0) {
    const system = Math.min(systemTokensPerCall * usage.calls, input - tools);
    shares.systemInstructions = roundShare((system / input) * 100);
    shares.conversation = roundShare(((input - tools - system) / input) * 100);
  } else {
    shares.other = roundShare(((input - tools) / input) * 100);
  }
  return {
    source: 'copilot-cli',
    shares,
    promptTokens: Math.round(input / usage.calls),
    calls: usage.calls,
    toolDefinitionTokens: Math.round(tools / usage.calls),
    ...(usage.availableTools > 0 ? { availableTools: usage.availableTools } : {}),
  };
}

/**
 * Rescale shares so they sum to 100. VS Code rounds every label, so sums within
 * the rounding tolerance are noise; a larger shortfall is reported as `other`.
 * Returns `null` when nothing was reported.
 */
export function normalizeShares(shares: Shares): Shares | null {
  const out: Shares = {};
  let sum = 0;
  for (const category of CONTEXT_CATEGORIES) {
    const value = shares[category];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) continue;
    out[category] = value;
    sum += value;
  }
  if (sum <= 0) return null;
  if (sum < 100 - COMPOSITION_ROUNDING_TOLERANCE) {
    out.other = (out.other ?? 0) + (100 - sum);
    sum = 100;
  }
  const scale = 100 / sum;
  for (const category of CONTEXT_CATEGORIES) {
    const value = out[category];
    if (value != null) out[category] = value * scale;
  }
  return out;
}

/**
 * Read `system_segments` from a Copilot CLI usage checkpoint, keeping only the segment
 * name and token count (hashes are dropped). Unexpected names are folded into `other`.
 */
export function readSystemSegments(value: unknown): SystemPromptSegment[] {
  if (!Array.isArray(value)) return [];
  const byName = new Map<string, number>();
  for (const segment of value) {
    if (!isRecord(segment)) continue;
    const tokens = positiveOrNull(segment.tokens);
    if (tokens == null) continue;
    const name = typeof segment.segment === 'string' && SEGMENT_NAME_RE.test(segment.segment) ? segment.segment : 'other';
    byName.set(name, (byName.get(name) ?? 0) + tokens);
  }
  const sorted = [...byName].map(([name, tokens]) => ({ name, tokens })).sort((a, b) => b.tokens - a.tokens);
  if (sorted.length <= MAX_SYSTEM_SEGMENTS) return sorted;
  const kept = sorted.slice(0, MAX_SYSTEM_SEGMENTS - 1).filter(segment => segment.name !== 'other');
  const rest = sorted.filter(segment => !kept.includes(segment)).reduce((sum, segment) => sum + segment.tokens, 0);
  return [...kept, { name: 'other', tokens: rest }];
}
