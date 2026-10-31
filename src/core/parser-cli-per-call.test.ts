/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Copilot CLI and Copilot App per-call token types, read once per `session.usage_record`: the turn's context
 * (`contextUsage`), output-side row fields, call-timeline bucket fields and compaction positions. Fixtures
 * mirror real record shapes, with ids, tool names and content replaced. */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseCLIEventsFile, parseCLIEventsFileAsync } from './parser-vscode-cli';
import { SessionSchema } from './schemas';

const tempDirs: string[] = [];
const BASE = Date.parse('2026-10-28T09:00:00Z');

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeEvents(events: Array<Record<string, unknown>>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-engineer-coach-cli-per-call-'));
  tempDirs.push(dir);
  const file = path.join(dir, 'events.jsonl');
  fs.writeFileSync(file, events.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf-8');
  return file;
}

function iso(seconds: number): string {
  return new Date(BASE + seconds * 1000).toISOString();
}

interface CallOptions {
  input: number;
  subagent?: boolean;
  limit?: number | null;
  output?: number;
  reasoning?: number;
  finish?: string;
  filter?: boolean;
  ttft?: number;
  duration?: number;
}

function call(at: number, o: CallOptions): Record<string, unknown> {
  return {
    type: 'session.usage_record',
    timestamp: iso(at),
    data: {
      usage: {
        model: o.subagent ? 'claude-haiku-4.5' : 'claude-opus-5.5',
        reasoningEffort: o.subagent ? 'low' : 'high',
        initiator: o.subagent ? 'sub-agent' : 'agent',
        interactionType: o.subagent ? 'conversation-subagent' : 'conversation-agent',
        inputTokens: o.input,
        outputTokens: o.output ?? 100,
        ...(o.reasoning == null ? {} : { reasoningTokens: o.reasoning }),
        cacheReadTokens: Math.round(o.input * 0.9),
        cacheWriteTokens: Math.round(o.input * 0.1),
        cacheDetailsReported: true,
        ...(o.limit === null ? {} : { maxPromptTokens: o.limit ?? 968_000 }),
        maxOutputTokens: 32_000,
        finishReason: o.finish ?? 'tool_calls',
        contentFilterTriggered: o.filter ?? false,
        ...(o.ttft == null ? {} : { timeToFirstTokenMs: o.ttft, outputTtftMs: o.ttft + 500 }),
        ...(o.duration == null ? {} : { duration: o.duration }),
        toolCounts: { secret_tool_name: 3 },
        apiCallId: 'call-secret-id',
        parentToolCallId: o.subagent ? 'tool-secret-id' : undefined,
      },
    },
  };
}

function compaction(at: number, before: number, after: number, tokenLimit: number): Record<string, unknown> {
  return {
    type: 'session.compaction_complete',
    timestamp: iso(at),
    data: {
      success: true, trigger: 'threshold', preCompactionTokens: before, postCompactionTokens: after, tokensRemoved: before - after,
      tokenLimit, checkpointNumber: 1, summaryContent: 'SECRET SUMMARY', checkpointPath: '/home/someone/secret/checkpoint.md',
    },
  };
}

const EVENTS = [
  { type: 'session.start', timestamp: iso(0), data: { sessionId: 'cli-per-call', startTime: iso(0), selectedModel: 'claude-opus-5.5', remoteSteerable: true } },
  // Logged before the first prompt: taken by the first turn, like the cache rows.
  call(1, { input: 50_000 }),
  { type: 'user.message', id: 'u1', timestamp: iso(2), data: { content: 'secret prompt one' } },
  call(10, { input: 100_000, output: 2_000, reasoning: 1_200, ttft: 3_000, duration: 8_000 }),
  call(12, { input: 40_000, subagent: true, output: 500, reasoning: 100, finish: 'stop' }),
  call(70, { input: 250_000, output: 32_000, reasoning: 20_000, finish: 'length', ttft: 4_000, duration: 60_000 }),
  compaction(75, 250_000, 52_000, 968_000),
  call(80, { input: 60_000, filter: true }),
  { type: 'user.message', id: 'u2', timestamp: iso(100), data: { content: 'secret prompt two' } },
  call(101, { input: 70_000, limit: null }),
  compaction(120, 90_000, 20_000, 300_000),
];

describe('Copilot CLI per-call token types', () => {
  it('records each turn\u2019s context from its main-agent calls, with the reported limit or the compaction limit', () => {
    const session = parseCLIEventsFile(writeEvents(EVENTS), 'ws', 'demo');
    const [first, second] = session?.requests ?? [];
    expect(first.contextUsage).toEqual({ lastPromptTokens: 60_000, peakPromptTokens: 250_000, contextLimit: 968_000, calls: 4 });
    expect(second.contextUsage).toEqual({ lastPromptTokens: 70_000, peakPromptTokens: 70_000, contextLimit: 300_000, calls: 1 });
    // promptTokens keeps its meaning (not logged per request by the CLI).
    expect(first.promptTokens).toBeNull();
  });

  it('places each compaction at the next main-agent call of the call timeline', () => {
    const session = parseCLIEventsFile(writeEvents(EVENTS), 'ws', 'demo');
    expect(session?.requests[0].compaction?.atCall).toBe(3);
    // After the session's last call: the marker goes on the last bucket.
    expect(session?.requests[1].compaction?.atCall).toBe(5);
    expect(session?.callTimeline?.calls).toBe(5);
  });

  it('sums output, reasoning, truncation, content-filter stops and latency on the shared rows', () => {
    const session = parseCLIEventsFile(writeEvents(EVENTS), 'ws', 'demo');
    const [main, sub] = session?.requests[0].promptCache?.rows ?? [];
    expect(main).toMatchObject({
      stream: 'main', calls: 4, reasoningEffort: 'high',
      outputTokens: 34_200, reasoningTokens: 21_200, truncatedCalls: 1, filteredCalls: 1, ttftMs: [3_000, 4_000], durationMs: [8_000, 60_000],
    });
    expect(sub).toMatchObject({ stream: 'subagent', calls: 1, reasoningEffort: 'low', outputTokens: 500, reasoningTokens: 100, truncatedCalls: 0 });
  });

  it('adds the context and token types to the call timeline buckets', () => {
    const session = parseCLIEventsFile(writeEvents(EVENTS), 'ws', 'demo');
    const buckets = session?.callTimeline?.buckets ?? [];
    expect(buckets).toHaveLength(5);
    expect(buckets[2]).toMatchObject({ peakPrompt: 250_000, contextLimit: 968_000, output: 32_000, reasoning: 20_000, truncatedCalls: 1 });
    expect(buckets[4]).toMatchObject({ firstRequest: 1, peakPrompt: 70_000, output: 100 });
    expect(buckets[4]).not.toHaveProperty('contextLimit');
    expect(buckets[4]).not.toHaveProperty('truncatedCalls');
  });

  it('stores numbers only, passes the schema, and parses the same way asynchronously', async () => {
    const file = writeEvents(EVENTS);
    const session = parseCLIEventsFile(file, 'ws', 'demo');
    expect(session && SessionSchema.safeParse(session).success).toBe(true);
    const json = JSON.stringify(session);
    for (const secret of ['SECRET', 'secret_tool_name', 'call-secret-id', 'tool-secret-id', 'checkpoint.md']) expect(json).not.toContain(secret);
    const asyncSession = await parseCLIEventsFileAsync(file, 'ws', 'demo');
    expect(asyncSession?.requests.map(r => r.contextUsage)).toEqual(session?.requests.map(r => r.contextUsage));
    expect(asyncSession?.callTimeline).toEqual(session?.callTimeline);
  });

  it('leaves older builds without per-call usage unchanged', () => {
    const session = parseCLIEventsFile(writeEvents([
      EVENTS[0],
      { type: 'user.message', id: 'u1', timestamp: iso(2), data: { content: 'hi' } },
      compaction(30, 200_000, 40_000, 250_000),
      { type: 'assistant.message', id: 'a1', data: { content: 'done', outputTokens: 10 } },
    ]), 'ws', 'demo');
    expect(session?.requests[0].contextUsage).toBeUndefined();
    expect(session?.requests[0].compaction).toMatchObject({ contextLengthBefore: 200_000, tokenLimit: 250_000 });
    expect(session?.requests[0].compaction).not.toHaveProperty('atCall');
    expect(session?.callTimeline).toBeUndefined();
  });
});
