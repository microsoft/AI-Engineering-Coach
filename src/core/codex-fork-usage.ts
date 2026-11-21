/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* A Codex fork's own token usage, turn by turn. A fork (`codex fork`) continues its source's thread: its cumulative
 * counters (`token_count` snapshots, a record's `thread_token_usage`) start with everything the source used. Its own
 * usage is read from what Codex logged for the fork:
 *
 * - A turn's own usage is at least the sum of its distinct responses' records and at least its `turn_token_usage`: the
 *   larger wins, so a partial counter never overrides known responses, and a counter only fills what records miss.
 * - With an anchor (the first own record's `thread_token_usage` less its `turn_token_usage`: exactly what the fork
 *   inherited), each turn's own cumulative usage at its end is the largest of the lower bounds the logs give: the
 *   previous turn's plus its own, the thread counter and the snapshot less the anchor, and where the next turn began
 *   (its `thread_token_usage` less its `turn_token_usage`, less the anchor), which is exact. A turn's usage is the growth
 *   since the previous turn. A missing record or snapshot only lowers a bound, so usage that a later turn's counter
 *   reveals stays with the turn it belongs to, never with the next one.
 * - Without one (older builds, records without the counters), a turn takes its own usage as above, else the growth of
 *   its snapshots.
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

/** A turn's own usage from its records: its distinct responses' sum or its `turn_token_usage`, whichever is larger. */
const ownUsage = (e: { responses?: CodexUsage; turn?: CodexUsage } | undefined) => larger(e?.responses, e?.turn);

interface TurnEvidence {
  /** The sum of its responses' own usage, each response once. */
  responses?: CodexUsage;
  /** The largest `turn_token_usage` and `thread_token_usage` its records logged, and where the turn began on the
   *  thread's counter (a record's thread less turn usage). */
  turn?: CodexUsage;
  thread?: CodexUsage;
  start?: CodexUsage;
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
      start: larger(known.start, turn && thread ? lessUsage(thread, turn) : undefined),
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
        turn: larger(known.turn, e.turn), thread: larger(known.thread, e.thread), start: larger(known.start, e.start),
      } : e);
    }
    const turns = this.anchor ? this.anchored(byTurn, this.anchor) : this.turns.map(t => ownUsage(byTurn.get(t.key)));
    const total = this.turns.reduce((sum, t, i) => addUsage(sum, turns[i] ?? t.snapshot), noUsage());
    return { turns, total };
  }

  private anchored(byTurn: Map<string, TurnEvidence>, anchor: CodexUsage): CodexUsage[] {
    let before = noUsage();
    return this.turns.map((t, i) => {
      const e = byTurn.get(t.key);
      const snapshot = this.snapshots.get(t.key);
      const own = ownUsage(e);
      const next = byTurn.get(this.turns[i + 1]?.key ?? '')?.start;
      const after = [before, e?.thread && lessUsage(e.thread, anchor), snapshot && lessUsage(snapshot, anchor), own && addUsage(before, own),
        next && lessUsage(next, anchor)]
        .reduce<CodexUsage | undefined>(larger, undefined) ?? before;
      const turn = lessUsage(after, before);
      before = after;
      return turn;
    });
  }
}
