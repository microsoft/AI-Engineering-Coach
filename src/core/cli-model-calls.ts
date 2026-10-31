/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Generic reader for Copilot CLI and Copilot App `session.usage_record` events: one record per model call.
 * The parser reads each record once and hands the call to every consumer (prompt composition, the call
 * timeline, the prompt-cache tracker). Add new per-call fields here rather than walking the records again.
 * Only numbers, enum values and the model id are kept; ids, hashes and content are ignored. */

import type { RelativeRates } from './prompt-cache-usage';
import { cacheModelName } from './prompt-cache-usage';

/** One model call. Token counts are normalized so that `inputTokens` includes cached tokens. */
export interface CliModelCall {
  /** When the record was logged, which is when the call finished (epoch ms). */
  timestamp: number | null;
  /** How long the call took (`usage.duration`, ms); `null` when not logged. */
  durationMs: number | null;
  /** When the call started: `timestamp − durationMs`, or `timestamp` without a duration. The cache is
   *  refreshed at the start of a call, so `cacheExpiresAt` = `startTs` + the cache lifetime. */
  startTs: number | null;
  /** `main` builds the session's main context; sub-agents have their own. */
  stream: 'main' | 'subagent';
  model: string;
  /** `user` = the call answered a prompt you sent; `agent` = the agent (or a sub-agent) continued on its own. */
  initiator: 'user' | 'agent' | null;
  /** Automatic model selection picked the model. */
  autoModel: boolean;
  reasoningEffort: string | null;
  /** Prompt tokens, including tokens read from and written to the cache. */
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** False when the call didn't report cache tokens (older builds, or `cacheDetailsReported: false`). */
  cacheReported: boolean;
  cacheExpiresAt: number | null;
  cacheTtlSeconds: number | null;
  availableTools: number | null;
  toolTokens: number | null;
  /** Cache prices relative to the input price, from the call's logged token details. */
  rates: RelativeRates | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nonNegative(value: unknown): number | null {
  const n = finite(value);
  return n != null && n >= 0 ? n : null;
}

/** Epoch ms from an ISO string or a number in seconds or milliseconds. */
export function epochMs(value: unknown): number | null {
  if (typeof value === 'string' && value) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  const n = finite(value);
  if (n == null || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
}

/** Main-agent calls build the main context; sub-agent calls have their own. */
export function isMainAgentCall(usage: Record<string, unknown>): boolean {
  if (typeof usage.interactionType === 'string') return usage.interactionType === 'conversation-agent';
  return usage.initiator === 'user' || usage.initiator === 'agent';
}

/** Per-token rate of each token type from `copilotUsage.tokenDetails` (cost per batch ÷ batch size). */
function tokenTypeRates(copilotUsage: unknown): Map<string, number> {
  const rates = new Map<string, number>();
  const details = isRecord(copilotUsage) ? copilotUsage.tokenDetails : undefined;
  if (!Array.isArray(details)) return rates;
  for (const detail of details) {
    if (!isRecord(detail) || typeof detail.tokenType !== 'string') continue;
    const batch = finite(detail.batchSize);
    const cost = nonNegative(detail.costPerBatch);
    if (batch != null && batch > 0 && cost != null) rates.set(detail.tokenType, cost / batch);
  }
  return rates;
}

/** Cache read and write prices relative to the input price. `null` when the input price isn't logged, or a
 *  price is missing for a token type the call used. */
export function relativeRates(copilotUsage: unknown, cacheRead: number, cacheWrite: number): RelativeRates | null {
  const rates = tokenTypeRates(copilotUsage);
  const input = rates.get('input');
  if (input == null || input <= 0) return null;
  const read = rates.get('cache_read');
  const write = rates.get('cache_write');
  if ((read == null && cacheRead > 0) || (write == null && cacheWrite > 0)) return null;
  return { cacheRead: (read ?? 0) / input, cacheWrite: (write ?? 0) / input };
}

function initiatorOf(value: unknown): CliModelCall['initiator'] {
  if (value === 'user') return 'user';
  return value === 'agent' || value === 'sub-agent' ? 'agent' : null;
}

/** Read one `session.usage_record`. Returns `null` when the record has no positive prompt-token count. */
export function readCliModelCall(data: Record<string, unknown>, timestamp: number | null, fallbackModel: string): CliModelCall | null {
  const usage = isRecord(data.usage) ? data.usage : undefined;
  if (!usage) return null;
  const rawInput = nonNegative(usage.inputTokens);
  if (rawInput == null || rawInput <= 0) return null;
  const cacheRead = nonNegative(usage.cacheReadTokens);
  const cacheWrite = nonNegative(usage.cacheWriteTokens);
  const read = cacheRead ?? 0;
  const write = cacheWrite ?? 0;
  // Current builds count cached tokens inside inputTokens. Should a build ever report them separately,
  // the cached tokens would exceed the input, so add them back.
  const inputTokens = rawInput >= read + write ? rawInput : rawInput + read + write;
  const cacheReported = usage.cacheDetailsReported !== false && (cacheRead != null || cacheWrite != null);
  const durationMs = nonNegative(usage.duration);
  return {
    timestamp,
    durationMs,
    startTs: timestamp == null ? null : timestamp - (durationMs ?? 0),
    stream: isMainAgentCall(usage) ? 'main' : 'subagent',
    model: cacheModelName(typeof usage.model === 'string' && usage.model ? usage.model : fallbackModel),
    initiator: initiatorOf(usage.initiator),
    autoModel: usage.isAuto === true,
    reasoningEffort: typeof usage.reasoningEffort === 'string' && usage.reasoningEffort ? usage.reasoningEffort : null,
    inputTokens,
    cacheReadTokens: read,
    cacheWriteTokens: write,
    cacheReported,
    cacheExpiresAt: epochMs(usage.cacheExpiresAt),
    cacheTtlSeconds: nonNegative(usage.cacheTtlSeconds),
    availableTools: nonNegative(usage.availableToolCount),
    toolTokens: finite(usage.toolTokenCount),
    rates: cacheReported ? relativeRates(usage.copilotUsage, read, write) : null,
  };
}
