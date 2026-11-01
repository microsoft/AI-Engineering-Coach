/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Per-turn main-agent context for Copilot CLI and Copilot App: the prompt size of the turn's last
 * and largest model call, and the context limit the CLI reported. Fed once per `session.usage_record`
 * with the call the parser already read (see cli-model-calls.ts), so the records are walked once. */

import type { TurnContextUsage } from './types';

/** The fields of one model call this accumulator needs: `CliModelCall` plus `maxPromptTokens`. */
export interface ContextCall {
  stream: 'main' | 'subagent';
  /** Prompt tokens, including cached tokens. */
  inputTokens: number;
  /** Context limit reported for the call (`maxPromptTokens`); `null` when not reported. */
  maxPromptTokens: number | null;
  /** The call's model, when the harness logs it. A reported limit carries over only to calls of the same model. */
  model?: string;
}

function positive(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

export class TurnContextAccumulator {
  private calls = 0;
  private last = 0;
  private peak = 0;
  /** Model of the latest main-agent call. Kept across turns: a compaction logged before a turn's first call
   *  compacted that model's context. */
  private model: string | undefined;
  /** The latest limit reported in the turn, per model, so a call is never measured against another model's. */
  private readonly limits = new Map<string | undefined, number>();
  /** Limits logged elsewhere in the turn (a compaction's `tokenLimit`), per model. */
  private readonly fallbackLimits = new Map<string | undefined, number>();

  /** Adds a main-agent call; sub-agent calls have their own context and are ignored. Returns the limit the call is
   *  measured against, by the rule of the turn's limit: its own, else the latest one a call of its model reported in
   *  the turn, else a compaction's limit for its model. `null` when there's none, or for a sub-agent call. */
  addCall(call: ContextCall): number | null {
    if (call.stream !== 'main') return null;
    const limit = positive(call.maxPromptTokens);
    const input = positive(call.inputTokens);
    if (input == null) return limit;
    this.calls++;
    this.last = input;
    this.peak = Math.max(this.peak, input);
    this.model = call.model;
    if (limit != null) this.limits.set(call.model, limit);
    return this.limitOf(call.model);
  }

  /** A limit logged elsewhere in the turn (a compaction's `tokenLimit`), for the model of the latest main-agent
   *  call, or `selectedModel` (the session's model) before the session's first one. Used when no call of that model
   *  reported one. */
  addLimit(limit: number | null | undefined, selectedModel?: string): void {
    const value = positive(limit);
    if (value != null) this.fallbackLimits.set(this.model ?? selectedModel, value);
  }

  /** `undefined` when the turn logged no main-agent call. The limit is one of the last call's model, or `null`. */
  result(): TurnContextUsage | undefined {
    if (this.calls === 0) return undefined;
    return {
      lastPromptTokens: this.last,
      peakPromptTokens: this.peak,
      contextLimit: this.limitOf(this.model),
      calls: this.calls,
    };
  }

  private limitOf(model: string | undefined): number | null {
    return this.limits.get(model) ?? this.fallbackLimits.get(model) ?? null;
  }

  /** The turn's result; the accumulator then starts the next turn. */
  take(): TurnContextUsage | undefined {
    const out = this.result();
    this.calls = 0;
    this.last = 0;
    this.peak = 0;
    this.limits.clear();
    this.fallbackLimits.clear();
    return out;
  }
}
