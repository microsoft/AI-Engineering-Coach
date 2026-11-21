/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* A Codex fork's own token usage, turn by turn. A fork (`codex fork`) continues its source's thread: its cumulative
 * counters (`token_count` snapshots, a record's `thread_token_usage`) start with everything the source used. Its own
 * usage is read from what Codex logged for the fork:
 *
 * - With an anchor (the first own record's `thread_token_usage` less its `turn_token_usage`: exactly what the fork
 *   inherited), each turn's own cumulative usage is the largest of the lower bounds the logs give: the thread counter
 *   and the snapshot less the anchor, and the previous turn's plus this turn's `turn_token_usage` (or its records' sum).
 *   A turn's usage is the growth since the previous turn. A missing response record or snapshot can only lower a bound,
 *   never add usage that wasn't logged.
 * - Without one (older builds, records without the counters), a turn takes its `turn_token_usage`, else the sum of its
 *   records, else the growth of its snapshots.
 *
 * Requests and session totals (so Token Coverage) come from the same allocation. Browser-safe: no Node imports. */

export interface CodexUsage { input: number; output: number; cached: number; reasoning: number | null; total: number }

export const noUsage = (): CodexUsage => ({ input: 0, output: 0, cached: 0, reasoning: 0, total: 0 });

export function addUsage(a: CodexUsage, b: CodexUsage): CodexUsage {
  return {
    input: a.input + b.input, output: a.output + b.output, cached: a.cached + b.cached,
    reasoning: a.reasoning == null || b.reasoning == null ? null : a.reasoning + b.reasoning, total: a.total + b.total,
  };
}

/** `a` less `b`, never below zero. */
export function lessUsage(a: CodexUsage, b: CodexUsage): CodexUsage {
  const less = (x: number, y: number) => Math.max(0, x - y);
  return {
    input: less(a.input, b.input), output: less(a.output, b.output), cached: less(a.cached, b.cached),
    reasoning: a.reasoning == null || b.reasoning == null ? null : less(a.reasoning, b.reasoning), total: less(a.total, b.total),
  };
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** A Codex usage object (`input_tokens`, `cached_input_tokens`, `output_tokens`, `reasoning_output_tokens`,
 *  `total_tokens`); undefined when it isn't one. */
export function usageOf(value: unknown): CodexUsage | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const v = value as Record<string, unknown>;
  const input = count(v.input_tokens);
  const output = count(v.output_tokens);
  if (input == null && output == null && count(v.total_tokens) == null) return undefined;
  return {
    input: input ?? 0, output: output ?? 0, cached: count(v.cached_input_tokens) ?? 0,
    reasoning: count(v.reasoning_output_tokens), total: count(v.total_tokens) ?? (input ?? 0) + (output ?? 0),
  };
}

const larger = (a: CodexUsage | undefined, b: CodexUsage | undefined) => (!a ? b : !b || a.total >= b.total ? a : b);

interface TurnEvidence {
  /** The sum of its responses' own usage, each response once. */
  responses?: CodexUsage;
  /** The largest `turn_token_usage` and `thread_token_usage` its records logged. */
  turn?: CodexUsage;
  thread?: CodexUsage;
  /** The turn the first of them arrived in, for a record whose turn has no request. */
  arrival: string;
}

export class CodexForkUsage {
  private readonly turns: { key: string; snapshot: CodexUsage }[] = [];
  private readonly evidence = new Map<string, TurnEvidence>();
  private readonly snapshots = new Map<string, CodexUsage>();
  private readonly responses = new Set<string>();
  private previous = noUsage();
  private anchor?: CodexUsage;

  /** A response's own record, of turn `turnId` (else the turn being read, `current`). */
  noteRecord(payload: Record<string, unknown>, current: string): void {
    const usage = usageOf(payload.usage);
    if (!usage) return;
    const id = typeof payload.response_id === 'string' ? payload.response_id : '';
    if (id && this.responses.has(id)) return;
    if (id) this.responses.add(id);
    const key = (typeof payload.turn_id === 'string' && payload.turn_id) || current;
    const turn = usageOf(payload.turn_token_usage);
    const thread = usageOf(payload.thread_token_usage);
    // Before the fork's first request is read, the thread counter less the turn's is what the fork inherited.
    if (!this.anchor && this.turns.length === 0 && turn && thread) this.anchor = lessUsage(thread, turn);
    const known = this.evidence.get(key) ?? { arrival: current };
    this.evidence.set(key, {
      ...known,
      responses: known.responses ? addUsage(known.responses, usage) : usage,
      turn: larger(known.turn, turn),
      thread: larger(known.thread, thread),
    });
  }

  /** A snapshot's cumulative thread total, read during turn `current`. */
  noteSnapshot(total: CodexUsage, current: string): void {
    this.snapshots.set(current, larger(this.snapshots.get(current), total) ?? total);
  }

  /** A request was read for turn `key`; `own` is the fork's own cumulative usage by the snapshots so far. */
  noteTurn(key: string, own: CodexUsage): void {
    this.turns.push({ key, snapshot: lessUsage(own, this.previous) });
    this.previous = own;
  }

  /** Each request's own usage, in order, and their sum; undefined when the fork logged no response record. */
  allocate(): { turns: (CodexUsage | undefined)[]; total: CodexUsage } | undefined {
    if (this.evidence.size === 0) return undefined;
    const keys = new Set(this.turns.map(t => t.key));
    const byTurn = new Map<string, TurnEvidence>();
    for (const [key, e] of this.evidence) {
      const at = keys.has(key) ? key : keys.has(e.arrival) ? e.arrival : this.turns[this.turns.length - 1]?.key;
      if (at === undefined) continue;
      const known = byTurn.get(at);
      byTurn.set(at, known ? {
        arrival: known.arrival, responses: known.responses && e.responses ? addUsage(known.responses, e.responses) : known.responses ?? e.responses,
        turn: larger(known.turn, e.turn), thread: larger(known.thread, e.thread),
      } : e);
    }
    const turns = this.anchor ? this.anchored(byTurn, this.anchor) : this.turns.map(t => {
      const e = byTurn.get(t.key);
      return e ? e.turn ?? e.responses : undefined;
    });
    const total = this.turns.reduce((sum, t, i) => addUsage(sum, turns[i] ?? t.snapshot), noUsage());
    return { turns, total };
  }

  private anchored(byTurn: Map<string, TurnEvidence>, anchor: CodexUsage): CodexUsage[] {
    let before = noUsage();
    return this.turns.map(t => {
      const e = byTurn.get(t.key);
      const snapshot = this.snapshots.get(t.key);
      const own = e?.turn ?? e?.responses;
      const after = [before, e?.thread && lessUsage(e.thread, anchor), snapshot && lessUsage(snapshot, anchor), own && addUsage(before, own)]
        .reduce<CodexUsage | undefined>(larger, undefined) ?? before;
      const turn = lessUsage(after, before);
      before = after;
      return turn;
    });
  }
}
