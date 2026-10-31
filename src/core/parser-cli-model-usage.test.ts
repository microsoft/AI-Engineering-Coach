/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Copilot CLI `session.shutdown.modelMetrics` → `Session.modelUsage`. `usage.inputTokens` counts the tokens read
 * from and written to the cache, while `ModelUsage.inputTokens` is the uncached part. Fixtures mirror real
 * shutdown and usage-record shapes (CLI 1.0.80–1.0.102), with ids and content replaced. */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseCLIEventsFile } from './parser-vscode-cli';
import { Analyzer } from './analyzer';

const tempDirs: string[] = [];
const BASE = Date.parse('2026-10-28T09:00:00Z');
const MODEL = 'claude-opus-5.5';

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function iso(seconds: number): string {
  return new Date(BASE + seconds * 1000).toISOString();
}

function parse(events: Array<Record<string, unknown>>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-engineer-coach-cli-model-usage-'));
  tempDirs.push(dir);
  const file = path.join(dir, 'events.jsonl');
  fs.writeFileSync(file, events.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf-8');
  const session = parseCLIEventsFile(file, 'ws', 'demo');
  if (!session) throw new Error('session not parsed');
  return session;
}

interface Tokens { input: number; cacheRead: number; cacheWrite: number; output: number }

function details(t: Tokens): Record<string, unknown> {
  return {
    input: { tokenCount: t.input - t.cacheRead - t.cacheWrite },
    cache_read: { tokenCount: t.cacheRead },
    cache_write: { tokenCount: t.cacheWrite },
    output: { tokenCount: t.output },
  };
}

function metrics(usage: Tokens, billed?: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requests: { count: 3, cost: 0 },
    usage: { inputTokens: usage.input, outputTokens: usage.output, cacheReadTokens: usage.cacheRead, cacheWriteTokens: usage.cacheWrite, reasoningTokens: 40 },
    ...(billed ? { tokenDetails: billed, totalNanoAiu: 123_000_000 } : {}),
    ...extra,
  };
}

function shutdown(at: number, modelMetrics: Record<string, unknown>): Record<string, unknown> {
  return { type: 'session.shutdown', timestamp: iso(at), data: { shutdownType: 'routine', modelMetrics } };
}

const START = { type: 'session.start', timestamp: iso(0), data: { sessionId: 'cli-model-usage', startTime: iso(0), selectedModel: MODEL } };
const PROMPT = { type: 'user.message', id: 'u1', timestamp: iso(1), data: { content: 'secret prompt' } };
const REPLY = { type: 'assistant.message', id: 'a1', timestamp: iso(2), data: { content: 'secret reply', outputTokens: 500 } };

describe('Copilot CLI shutdown model usage', () => {
  it('takes the billed, uncached input from tokenDetails (real-shaped totals)', () => {
    // Real totals of one session (CLI 1.0.102): usage.inputTokens includes 68,075,628 read and 2,395,184 written.
    const usage = { input: 70_471_434, cacheRead: 68_075_628, cacheWrite: 2_395_184, output: 254_118 };
    const session = parse([START, PROMPT, REPLY, shutdown(10, { [MODEL]: metrics(usage, details(usage)) })]);
    expect(session.modelUsage?.[MODEL]).toEqual({
      inputTokens: 622,
      outputTokens: 254_118,
      cacheReadTokens: 68_075_628,
      cacheWriteTokens: 2_395_184,
      reasoningTokens: 40,
    });
  });

  it('takes every type from tokenDetails, which also counts compaction summaries', () => {
    const usage = { input: 1_000_000, cacheRead: 900_000, cacheWrite: 90_000, output: 20_000 };
    const billed = { input: { tokenCount: 10_050 }, cache_read: { tokenCount: 1_100_000 }, cache_write: { tokenCount: 120_000 }, output: { tokenCount: 23_000 } };
    const session = parse([START, PROMPT, REPLY, shutdown(10, { [MODEL]: metrics(usage, billed) })]);
    expect(session.modelUsage?.[MODEL]).toMatchObject({ inputTokens: 10_050, cacheReadTokens: 1_100_000, cacheWriteTokens: 120_000, outputTokens: 23_000 });
  });

  it('subtracts the cached tokens from usage.inputTokens when tokenDetails is missing or incomplete', () => {
    const usage = { input: 1_234, cacheRead: 800, cacheWrite: 100, output: 567 };
    const partial = { input: { tokenCount: 334 }, cache_read: { tokenCount: 800 }, output: { tokenCount: 567 } };
    for (const billed of [undefined, partial, { input: 'n/a' }]) {
      const session = parse([START, PROMPT, REPLY, shutdown(10, { [MODEL]: metrics(usage, billed) })]);
      expect(session.modelUsage?.[MODEL], JSON.stringify(billed)).toMatchObject({ inputTokens: 334, cacheReadTokens: 800, cacheWriteTokens: 100, outputTokens: 567 });
    }
  });

  it('keeps usage.inputTokens when it is below the cached tokens (cache reported separately)', () => {
    const session = parse([START, PROMPT, REPLY, shutdown(10, {
      [MODEL]: { usage: { inputTokens: 300, outputTokens: 50, cacheReadTokens: 6_000, cacheWriteTokens: 500 } },
    })]);
    expect(session.modelUsage?.[MODEL]).toMatchObject({ inputTokens: 300, cacheReadTokens: 6_000, cacheWriteTokens: 500 });
  });

  it('uses the last shutdown, whose totals are cumulative, and sums model ids that normalize alike', () => {
    const first = { input: 10_000, cacheRead: 9_000, cacheWrite: 500, output: 100 };
    const last = { input: 30_000, cacheRead: 27_000, cacheWrite: 1_500, output: 300 };
    const extra = { input: 2_000, cacheRead: 1_000, cacheWrite: 0, output: 10 };
    const session = parse([
      START, PROMPT, REPLY,
      shutdown(10, { [MODEL]: metrics(first, details(first)) }),
      shutdown(20, { [MODEL]: metrics(last, details(last)), [`copilot/${MODEL}`]: metrics(extra, details(extra)) }),
    ]);
    expect(session.modelUsage?.[MODEL]).toMatchObject({ inputTokens: 1_500 + 1_000, cacheReadTokens: 28_000, cacheWriteTokens: 1_500, outputTokens: 310 });
  });

  it('agrees with the per-call prompt-cache rows, and AI-credit totals count each prompt token once', () => {
    const call = (at: number, input: number, cacheRead: number, cacheWrite: number, output: number) => ({
      type: 'session.usage_record',
      timestamp: iso(at),
      data: {
        usage: {
          model: MODEL, initiator: 'agent', interactionType: 'conversation-agent', inputTokens: input, outputTokens: output,
          cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, cacheDetailsReported: true, maxPromptTokens: 968_000,
        },
      },
    });
    const compactionCall = { inputTokens: 120_000, outputTokens: 3_000, cacheReadTokens: 100_000, cacheWriteTokens: 15_000, model: MODEL };
    const events = [
      START, PROMPT,
      call(3, 50_000, 40_000, 8_000, 400),
      call(6, 100_000, 95_000, 5_000, 600),
      REPLY,
      {
        type: 'session.compaction_complete',
        timestamp: iso(8),
        data: { success: true, trigger: 'threshold', preCompactionTokens: 100_000, postCompactionTokens: 20_000, tokenLimit: 968_000, compactionTokensUsed: compactionCall },
      },
      // usage = the usage records; tokenDetails = the usage records plus the compaction call.
      shutdown(10, {
        [MODEL]: metrics(
          { input: 150_000, cacheRead: 135_000, cacheWrite: 13_000, output: 1_000 },
          details({ input: 270_000, cacheRead: 235_000, cacheWrite: 28_000, output: 4_000 }),
        ),
      }),
    ];
    const session = parse(events);
    const usage = session.modelUsage?.[MODEL];
    expect(usage).toMatchObject({ inputTokens: 7_000, cacheReadTokens: 235_000, cacheWriteTokens: 28_000, outputTokens: 4_000 });

    const rows = session.requests.flatMap(request => request.promptCache?.rows ?? []);
    expect(rows.map(row => row.stream).sort()).toEqual(['compaction', 'main']);
    const rowInput = rows.reduce((sum, row) => sum + row.input, 0);
    const rowRead = rows.reduce((sum, row) => sum + row.cacheRead, 0);
    expect(usage!.inputTokens + usage!.cacheReadTokens + usage!.cacheWriteTokens).toBe(rowInput);
    expect(usage!.cacheReadTokens).toBe(rowRead);

    const credits = new Analyzer([session]).getAiCredits();
    expect(credits.totalInputTokens).toBeCloseTo(270_000, 6);
    expect(credits.totalCacheReadTokens).toBeCloseTo(235_000, 6);
    expect(credits.totalOutputTokens).toBeCloseTo(4_000, 6);
  });
});
