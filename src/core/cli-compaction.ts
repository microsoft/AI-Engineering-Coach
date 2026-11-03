/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Copilot CLI and Copilot App `session.compaction_complete` events. Current builds log the context
 * size before and after, the limit, the trigger and the tokens of the compaction call; the legacy
 * fields (`mode`, `numRounds`, `contextLengthBefore`) are still read when present. Only numbers and
 * enum values are kept: never `summaryContent`, `checkpointPath` or error text. */

import type { CompactionEvent } from './types';
import { normalizeModel } from './helpers';
import { MAX_TURN_COMPACTIONS } from './token-usage-schemas';

const ENUM_RE = /^[A-Za-z][A-Za-z_-]{0,31}$/;

/** Logged compaction triggers, lower-case: started by the harness at its threshold, or by you (`/compact`). */
export const AUTO_COMPACTION_TRIGGERS: ReadonlySet<string> = new Set(['threshold', 'auto', 'automatic']);
export const MANUAL_COMPACTION_TRIGGERS: ReadonlySet<string> = new Set(['manual', 'user', 'command', 'slash_command']);

/** Who started a compaction: `other` for a logged trigger outside both sets, `null` when none was logged. */
export function compactionKind(trigger: string | undefined): 'automatic' | 'manual' | 'other' | null {
  if (!trigger) return null;
  const value = trigger.toLowerCase();
  if (AUTO_COMPACTION_TRIGGERS.has(value)) return 'automatic';
  return MANUAL_COMPACTION_TRIGGERS.has(value) ? 'manual' : 'other';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function enumValue(value: unknown): string | undefined {
  return typeof value === 'string' && ENUM_RE.test(value) ? value.toLowerCase() : undefined;
}

function readTokensUsed(usage: Record<string, unknown> | undefined): CompactionEvent['tokensUsed'] {
  const input = count(usage?.inputTokens);
  const output = count(usage?.outputTokens);
  if (input == null && output == null) return undefined;
  return {
    input: input ?? 0,
    output: output ?? 0,
    cacheRead: count(usage?.cacheReadTokens) ?? 0,
    cacheWrite: count(usage?.cacheWriteTokens) ?? 0,
  };
}

function readOutcome(data: Record<string, unknown>): string {
  if (data.success === false) return 'failed';
  return enumValue(data.outcome) ?? 'success';
}

/** Context size before and after; after is derived from the tokens removed when not logged. */
function readSizes(data: Record<string, unknown>): { before: number; after?: number } {
  const before = count(data.preCompactionTokens) ?? count(data.contextLengthBefore) ?? 0;
  const removed = count(data.tokensRemoved);
  const after = count(data.postCompactionTokens) ?? (removed == null ? null : Math.max(0, before - removed));
  return before > 0 && after != null ? { before, after: Math.min(after, before) } : { before };
}

/** The optional fields current builds log; absent ones are left out. */
function readDetails(data: Record<string, unknown>, usage: Record<string, unknown> | undefined): Partial<CompactionEvent> {
  const limit = count(data.tokenLimit);
  const trigger = enumValue(data.trigger);
  const checkpoint = count(data.checkpointNumber);
  const tokensUsed = readTokensUsed(usage);
  return {
    ...(limit != null && limit > 0 ? { tokenLimit: limit } : {}),
    ...(trigger ? { trigger } : {}),
    ...(checkpoint == null ? {} : { checkpointNumber: Math.floor(checkpoint) }),
    ...(tokensUsed ? { tokensUsed } : {}),
  };
}

/** Map one `session.compaction_complete` payload to a compaction event. */
export function readCliCompaction(data: Record<string, unknown>): CompactionEvent {
  const usage = isRecord(data.compactionTokensUsed) ? data.compactionTokensUsed : undefined;
  const { before, after } = readSizes(data);
  const model = typeof usage?.model === 'string' ? usage.model : typeof data.model === 'string' ? data.model : '';
  return {
    mode: data.mode === 'simple' ? 'simple' : 'full',
    numRounds: count(data.numRounds) ?? 0,
    numRoundsSinceLastSummarization: count(data.numRoundsSinceLastSummarization) ?? 0,
    contextLengthBefore: before,
    durationMs: count(usage?.duration) ?? count(data.durationMs) ?? 0,
    model: model ? normalizeModel(model).slice(0, 64) : '',
    outcome: readOutcome(data),
    ...(after == null ? {} : { contextLengthAfter: after }),
    ...readDetails(data, usage),
  };
}

/** Keep every compaction of a turn, in order, up to the cap. */
export function addTurnCompaction(compactions: CompactionEvent[], event: CompactionEvent): void {
  if (compactions.length < MAX_TURN_COMPACTIONS) compactions.push(event);
}
