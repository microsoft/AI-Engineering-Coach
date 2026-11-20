/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Claude Code and Codex compactions, in the shape of the Copilot CLI events (`cli-compaction.ts`).
 *
 * Claude Code writes a `system` line with subtype `compact_boundary` and `compactMetadata`
 * (`trigger`, `preTokens`, `postTokens`, `durationMs`).
 * Codex logs no sizes: a compaction shows as a `compacted` line, a `compaction` response item, a
 * `context_compacted` event or a `ContextCompaction` item, often several of them for one compaction. The size
 * before is the prompt of the last model call and the limit its `model_context_window`.
 * Only numbers and enum values are kept, never the summary. */

import type { CompactionEvent, SessionRequest } from './types';
import { readCliCompaction } from './cli-compaction';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Map a Claude Code `compactMetadata` to a compaction event. */
export function readClaudeCompaction(metadata: unknown): CompactionEvent {
  const data = isRecord(metadata) ? metadata : {};
  return readCliCompaction({
    contextLengthBefore: data.preTokens,
    postCompactionTokens: data.postTokens,
    trigger: data.trigger,
    durationMs: data.durationMs,
  });
}

/** A Codex compaction: the context of the last model call before it, and that call's limit when logged. */
export function codexCompaction(contextBefore: number, tokenLimit: number | null): CompactionEvent {
  return readCliCompaction({ contextLengthBefore: contextBefore, ...(tokenLimit ? { tokenLimit } : {}) });
}

/** The request fields for a turn's compactions: `compaction` is the first, `compactions` all of them when several. */
export function requestCompactionFields(compactions: CompactionEvent[]): Partial<Pick<SessionRequest, 'compaction' | 'compactions'>> {
  if (compactions.length === 0) return {};
  return { compaction: compactions[0], ...(compactions.length > 1 ? { compactions: [...compactions] } : {}) };
}
