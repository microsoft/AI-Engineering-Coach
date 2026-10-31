/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Per-turn context: the prompt size of the turn's last and largest model call, and the context limit the
 * harness reported. Copilot CLI and Copilot App feed it once per `session.usage_record` with the call the parser
 * already read (see cli-model-calls.ts), so the records are walked once; Codex, Claude Code and OpenCode feed
 * their own per-call usage. */

import type { TurnContextUsage } from './types';

/** The fields of one model call this accumulator needs: `CliModelCall` plus `maxPromptTokens`. */
export interface ContextCall {
  stream: 'main' | 'subagent';
  /** Prompt tokens, including cached tokens. */
  inputTokens: number;
  /** Context limit reported for the call (`maxPromptTokens`); `null` when not reported. */
  maxPromptTokens: number | null;
}

function positive(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

export class TurnContextAccumulator {
  private calls = 0;
  private last = 0;
  private peak = 0;
  private limit: number | null = null;
  private fallbackLimit: number | null = null;

  /** Sub-agent calls have their own context and are ignored. */
  addCall(call: ContextCall): void {
    const input = positive(call.inputTokens);
    if (call.stream !== 'main' || input == null) return;
    this.calls++;
    this.last = input;
    this.peak = Math.max(this.peak, input);
    this.limit = positive(call.maxPromptTokens) ?? this.limit;
  }

  /** A limit logged elsewhere in the turn (a compaction's `tokenLimit`), used when no call reported one. */
  addLimit(limit: number | null | undefined): void {
    this.fallbackLimit = positive(limit) ?? this.fallbackLimit;
  }

  /** `undefined` when the turn logged no main-agent call. */
  result(): TurnContextUsage | undefined {
    if (this.calls === 0) return undefined;
    return {
      lastPromptTokens: this.last,
      peakPromptTokens: this.peak,
      contextLimit: this.limit ?? this.fallbackLimit,
      calls: this.calls,
    };
  }

  /** The turn's result; the accumulator then starts the next turn. */
  take(): TurnContextUsage | undefined {
    const out = this.result();
    this.calls = 0;
    this.last = 0;
    this.peak = 0;
    this.limit = null;
    this.fallbackLimit = null;
    return out;
  }
}
