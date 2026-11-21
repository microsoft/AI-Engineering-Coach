/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* A Codex fork's own token usage: its cumulative snapshots start with the source's, so its responses' own usage records
 * decide it, whatever snapshots it holds or copied. */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { Analyzer } from './analyzer';
import { parseCodexSessions } from './parser-codex';

function withCodexFile(lines: object[], run: (sessionsDir: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-fork-usage-test-'));
  const dayDir = path.join(root, 'sessions', '2025', '06', '15');
  fs.mkdirSync(dayDir, { recursive: true });
  fs.writeFileSync(path.join(dayDir, 'rollout-2025-06-15-test.jsonl'), lines.map(l => JSON.stringify(l)).join('\n'), 'utf-8');
  try { run(path.join(root, 'sessions')); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

describe('Codex fork usage', () => {  it('counts a fork’s own responses by their thread and response IDs, whatever snapshots it holds (B8)', () => {
    const own = { type: 'token_usage_record', timestamp: '2025-06-15T09:00:09Z', payload: { thread_id: 'fork', response_id: 'r-own', usage: { input_tokens: 13_580, output_tokens: 34, total_tokens: 13_614 } } };
    const total = (ts: string, t: [number, number], last: [number, number]) => ({ type: 'event_msg', timestamp: ts, payload: { type: 'token_count', info: {
      total_token_usage: { input_tokens: t[0], output_tokens: t[1], total_tokens: t[0] + t[1] },
      last_token_usage: { input_tokens: last[0], output_tokens: last[1], total_tokens: last[0] + last[1] },
    } } });
    const parse = (lines: object[]) => {
      let out: (number | null)[] = [];
      withCodexFile([
        { type: 'session_meta', payload: { id: 'fork', forked_from_id: 'src', cwd: '/Users/me/proj' } },
        { type: 'event_msg', timestamp: '2025-06-15T09:00:00Z', payload: { type: 'user_message', message: 'Go on.' } },
        ...lines,
        { type: 'event_msg', timestamp: '2025-06-15T09:00:20Z', payload: { type: 'agent_message', message: 'Done.' } },
      ], (sessionsDir) => {
        const [request] = parseCodexSessions(sessionsDir)[0].requests;
        out = [request.promptTokens, request.completionTokens];
      });
      return out;
    };
    // No cumulative snapshot at all: the response's own record still counts.
    expect(parse([own])).toEqual([13_580, 34]);
    // A snapshot copied from the source (its own last call), then the fork's response and its snapshot: counted once.
    expect(parse([total('2025-06-15T09:00:05Z', [145_729, 723], [13_580, 34]), own, total('2025-06-15T09:00:10Z', [159_309, 757], [13_580, 34])]))
      .toEqual([13_580, 34]);
    // The source's response records, copied with the history, aren't the fork's.
    expect(parse([{ ...own, payload: { ...own.payload, thread_id: 'src', response_id: 'r-src' } }, own, own])).toEqual([13_580, 34]);
  });
});

describe('Codex fork usage over several turns (C3)', () => {
  // The fork's source used 101,000 tokens. Its first turn uses 13,614, its second 3,137 (1,000 of them cached).
  const inherited = { input: 100_000, output: 1_000 };
  const usage = [{ input_tokens: 13_580, output_tokens: 34, total_tokens: 13_614 }, { input_tokens: 3_021, cached_input_tokens: 1_000, output_tokens: 116, total_tokens: 3_137 }];
  const ts = (s: number) => `2025-06-15T09:00:${String(s).padStart(2, '0')}Z`;
  const record = (i: number, s: number) => ({ type: 'token_usage_record', timestamp: ts(s), payload: { thread_id: 'fork', turn_id: `t${i}`, response_id: `r${i}`, usage: usage[i] } });
  const snapshot = (i: number, s: number) => {
    const input = inherited.input + usage.slice(0, i + 1).reduce((a, u) => a + u.input_tokens, 0);
    const output = inherited.output + usage.slice(0, i + 1).reduce((a, u) => a + u.output_tokens, 0);
    return { type: 'event_msg', timestamp: ts(s), payload: { type: 'token_count', info: {
      total_token_usage: { input_tokens: input, cached_input_tokens: 1_000, output_tokens: output, total_tokens: input + output },
      last_token_usage: usage[i],
    } } };
  };
  const turn = (i: number, s: number, withRecord: boolean) => [
    { type: 'event_msg', timestamp: ts(s), payload: { type: 'task_started', turn_id: `t${i}` } },
    { type: 'turn_context', timestamp: ts(s), payload: { turn_id: `t${i}`, model: 'gpt-5-mini' } },
    { type: 'event_msg', timestamp: ts(s + 1), payload: { type: 'user_message', message: `Step ${i + 1}.` } },
    ...(withRecord ? [record(i, s + 2)] : []),
    snapshot(i, s + 3),
    { type: 'event_msg', timestamp: ts(s + 4), payload: { type: 'agent_message', message: 'Done.' } },
    { type: 'event_msg', timestamp: ts(s + 5), payload: { type: 'task_complete', turn_id: `t${i}` } },
  ];
  function totals(lines: object[]) {
    let out: { turns: number[]; session: number; coverage: number } = { turns: [], session: 0, coverage: 0 };
    withCodexFile([{ type: 'session_meta', payload: { id: 'fork', forked_from_id: 'src', cwd: '/Users/me/proj' } }, ...lines], (dir) => {
      const sessions = parseCodexSessions(dir);
      const usages = Object.values(sessions[0].modelUsage ?? {});
      const coverage = new Analyzer(sessions, new Map()).getTokenCoverage();
      out = {
        turns: sessions[0].requests.map(r => (r.promptTokens ?? 0) + (r.completionTokens ?? 0)),
        session: usages.reduce((a, u) => a + u.inputTokens + u.cacheReadTokens + u.outputTokens, 0),
        coverage: Math.round(coverage.totalInputTokens + coverage.totalOutputTokens),
      };
    });
    return out;
  }
  const truth = { turns: [13_614, 3_137], session: 16_751, coverage: 16_751 };

  it('agrees with both records, with none, and with either one alone', () => {
    expect(totals([...turn(0, 0, true), ...turn(1, 10, true)])).toEqual(truth);
    expect(totals([...turn(0, 0, false), ...turn(1, 10, false)])).toEqual(truth);
    expect(totals([...turn(0, 0, true), ...turn(1, 10, false)])).toEqual(truth);
    expect(totals([...turn(0, 0, false), ...turn(1, 10, true)])).toEqual(truth);
  });

  it('puts a record logged late into the turn it names', () => {
    const second = turn(1, 10, true);
    expect(totals([...turn(0, 0, false), ...second.slice(0, 3), record(0, 12), ...second.slice(3)])).toEqual(truth);
  });
});

// Shaped like codex-cli 0.167 rollout files: each response's record carries its own usage and the turn's and thread's running
// totals; the thread's start with the 159,309 tokens the source used. Turn 1 makes three calls, turn 2 one.
const inherited = 159_309;
const calls = [[12_824, 12_881, 13_636], [13_614]];
const use = (total: number) => ({ input_tokens: total - 100, output_tokens: 100, total_tokens: total });
const ts = (s: number) => `2025-06-15T09:${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}Z`;
type Keep = (turn: number, call: number) => { record: boolean; snapshot: boolean; counters?: boolean };
function nativeLines(keep: Keep, plan: number[][] = calls) {
  const out: object[] = [{ type: 'session_meta', payload: { id: 'fork', forked_from_id: 'src', cwd: '/Users/me/proj' } }];
  // Running totals, field by field: each call adds its input and 100 output tokens.
  const sum = (a: { input_tokens: number; output_tokens: number }, total: number) =>
    ({ input_tokens: a.input_tokens + total - 100, output_tokens: a.output_tokens + 100, total_tokens: a.input_tokens + a.output_tokens + total });
  let thread = use(inherited);
  let s = 0;
  for (const [i, turn] of plan.entries()) {
    out.push({ type: 'event_msg', timestamp: ts(s++), payload: { type: 'task_started', turn_id: `t${i}` } },
      { type: 'event_msg', timestamp: ts(s++), payload: { type: 'user_message', message: `Step ${i + 1}.` } });
    let inTurn = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
    for (const [j, call] of turn.entries()) {
      thread = sum(thread, call);
      inTurn = sum(inTurn, call);
      const { record, snapshot, counters = true } = keep(i, j);
      if (record) {
        out.push({ type: 'token_usage_record', timestamp: ts(s++), payload: {
          thread_id: 'fork', turn_id: `t${i}`, response_id: `r${i}-${j}`, usage: use(call),
          ...(counters ? { turn_token_usage: inTurn, thread_token_usage: thread } : {}),
        } });
      }
      if (snapshot) out.push({ type: 'event_msg', timestamp: ts(s++), payload: { type: 'token_count', info: { total_token_usage: thread, last_token_usage: use(call) } } });
    }
    out.push({ type: 'event_msg', timestamp: ts(s++), payload: { type: 'agent_message', message: 'Done.' } },
      { type: 'event_msg', timestamp: ts(s++), payload: { type: 'task_complete', turn_id: `t${i}` } });
  }
  return out;
}
function nativeTotals(keep: Keep, plan: number[][] = calls) {
  let out: { turns: number[]; session: number; coverage: number } = { turns: [], session: 0, coverage: 0 };
  withCodexFile(nativeLines(keep, plan), (dir) => {
    const sessions = parseCodexSessions(dir);
    const usages = Object.values(sessions[0].modelUsage ?? {});
    const coverage = new Analyzer(sessions, new Map()).getTokenCoverage();
    out = {
      turns: sessions[0].requests.map(r => (r.promptTokens ?? 0) + (r.completionTokens ?? 0)),
      session: usages.reduce((a, u) => a + u.inputTokens + u.cacheReadTokens + u.outputTokens, 0),
      coverage: Math.round(coverage.totalInputTokens + coverage.totalOutputTokens),
    };
  });
  return out;
}
const nativeTruth = { turns: [39_341, 13_614], session: 52_955, coverage: 52_955 };

describe('Codex fork usage from native turn and thread counters (E5)', () => {
  it('keeps a turn’s whole usage when some of its responses logged no record', () => {
    expect(nativeTotals(() => ({ record: true, snapshot: true }))).toEqual(nativeTruth);
    // Only the turn's last response has a record: its turn and thread totals still say what the turn used.
    expect(nativeTotals((i, j) => ({ record: i > 0 || j === 2, snapshot: true }))).toEqual(nativeTruth);
    // One response's record missing, no snapshots at all.
    expect(nativeTotals((i, j) => ({ record: !(i === 0 && j === 1), snapshot: false }))).toEqual(nativeTruth);
  });

  it('does not reuse another turn’s last call as a snapshot’s own when a turn logged no snapshot', () => {
    expect(nativeTotals(i => ({ record: i === 0, snapshot: i === 1 }))).toEqual(nativeTruth);
  });
});

describe('Codex fork usage when counters are partial or a tail is missing (G3, G4)', () => {
  // Three turns; the middle one makes five calls (65,955 tokens).
  const plan = [[13_614], [12_824, 12_881, 13_636, 13_705, 12_909], [13_602]];
  const truth = { turns: [13_614, 65_955, 13_602], session: 93_171, coverage: 93_171 };

  it('lets the middle turn’s known responses win over a partial running counter', () => {
    // Every response logged, but only the middle turn's first record carries the turn and thread counters.
    expect(nativeTotals((i, j) => ({ record: true, snapshot: false, counters: i !== 1 || j === 0 }), plan)).toEqual(truth);
    // No anchor (the first turn's record carries no counters), with snapshots.
    expect(nativeTotals((i, j) => ({ record: true, snapshot: true, counters: i !== 0 && (i !== 1 || j === 0) }), plan)).toEqual(truth);
  });

  it('keeps a missing tail with its own turn, by where the next turn began, not with the next turn', () => {
    expect(nativeTotals((i, j) => ({ record: !(i === 1 && j === 4), snapshot: !(i === 1 && j === 4) }), plan)).toEqual(truth);
  });
});
