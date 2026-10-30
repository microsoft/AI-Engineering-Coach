/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Context-composition extraction from VS Code chat sessions and Copilot CLI events.
 * Fixtures mirror the shapes observed in real logs, with content redacted. */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, it, expect } from 'vitest';
import { parseSessionFile } from './parser-vscode';
import { parseCLIEventsFile, parseCLIEventsFileAsync } from './parser-vscode-cli';
import { SessionSchema } from './schemas';
import { stripSingleSession } from './parser-shared';

const tempDirs: string[] = [];

function writeTemp(name: string, content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-engineer-coach-composition-'));
  tempDirs.push(dir);
  const file = path.join(dir, name);
  fs.writeFileSync(file, content, 'utf-8');
  return file;
}

function writeEvents(events: Array<Record<string, unknown>>): string {
  return writeTemp('events.jsonl', events.map(e => JSON.stringify(e)).join('\n') + '\n');
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

const DETAILS = [
  { category: 'System', label: 'System Instructions', percentageOfPrompt: 11 },
  { category: 'System', label: 'Tool Definitions', percentageOfPrompt: 36 },
  { category: 'User Context', label: 'Messages', percentageOfPrompt: 21 },
  { category: 'User Context', label: 'Tool Results', percentageOfPrompt: 31 },
  { category: 'User Context', label: 'Files', percentageOfPrompt: 2 },
];

function vscodeRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: 'req-1',
    timestamp: 1_790_000_001_000,
    message: { text: 'refactor the parser' },
    response: [{ value: 'done' }],
    modelId: 'copilot/claude-sonnet-5',
    result: { metadata: { promptTokens: 52_000, outputTokens: 900, toolCallRounds: [] } },
    ...overrides,
  };
}

describe('VS Code promptTokenDetails extraction', () => {
  it('reads details from a legacy .json session next to promptTokens', () => {
    const file = writeTemp('legacy.json', JSON.stringify({
      sessionId: 'legacy-1',
      creationDate: 1_790_000_000_000,
      requests: [vscodeRequest({ promptTokens: 50_000, promptTokenDetails: DETAILS })],
    }));
    const session = parseSessionFile(file, 'ws', 'demo', 'Local Agent');
    expect(session?.requests[0].promptComposition).toEqual({
      source: 'vscode',
      promptTokens: 50_000,
      shares: { systemInstructions: 11, toolDefinitions: 36, messages: 21, toolResults: 31, files: 2 },
    });
    // The billing/token fields keep their existing meaning.
    expect(session?.requests[0].promptTokens).toBe(52_000);
  });

  it('applies JSONL patches: the latest promptTokenDetails and request-level promptTokens win', () => {
    const lines = [
      { kind: 0, v: { sessionId: 'jsonl-1', creationDate: 1_790_000_000_000, requests: [] } },
      { kind: 2, k: ['requests'], v: [vscodeRequest({ result: {} })] },
      { kind: 1, k: ['requests', 0, 'promptTokens'], v: 12_000 },
      { kind: 1, k: ['requests', 0, 'promptTokenDetails'], v: [{ category: 'System', label: 'Tool Definitions', percentageOfPrompt: 80 }, { category: 'User Context', label: 'Messages', percentageOfPrompt: 20 }] },
      { kind: 1, k: ['requests', 0, 'promptTokens'], v: 61_000 },
      { kind: 1, k: ['requests', 0, 'promptTokenDetails'], v: DETAILS },
      { kind: 1, k: ['requests', 0, 'result'], v: { metadata: { promptTokens: 61_000, outputTokens: 400, toolCallRounds: [] } } },
    ];
    const file = writeTemp('patched.jsonl', lines.map(line => JSON.stringify(line)).join('\n'));
    const composition = parseSessionFile(file, 'ws', 'demo', 'Local Agent')?.requests[0].promptComposition;
    expect(composition?.promptTokens).toBe(61_000);
    expect(composition?.shares.toolDefinitions).toBe(36);
    expect(composition?.shares.files).toBe(2);
  });

  it('reads details carried inside appended (kind 2) requests', () => {
    const lines = [
      { kind: 0, v: { sessionId: 'jsonl-2', requests: [] } },
      { kind: 2, k: ['requests'], v: [vscodeRequest({ promptTokens: 30_000, promptTokenDetails: DETAILS.slice(0, 3) })] },
    ];
    const file = writeTemp('appended.jsonl', lines.map(line => JSON.stringify(line)).join('\n'));
    const composition = parseSessionFile(file, 'ws', 'demo', 'Local Agent')?.requests[0].promptComposition;
    expect(composition?.shares).toEqual({ systemInstructions: 11, toolDefinitions: 36, messages: 21, toolResults: 0, files: 0 });
    expect(composition?.promptTokens).toBe(30_000);
  });

  it('falls back to result.metadata.promptTokens and keeps sums that are not 100 as reported', () => {
    const file = writeTemp('fallback.json', JSON.stringify({
      sessionId: 'fallback-1',
      requests: [vscodeRequest({ promptTokenDetails: [
        { category: 'System', label: 'System Instructions', percentageOfPrompt: 40 },
        { category: 'System', label: 'Tool Definitions', percentageOfPrompt: 61 },
      ] })],
    }));
    const composition = parseSessionFile(file, 'ws', 'demo', 'Local Agent')?.requests[0].promptComposition;
    expect(composition?.promptTokens).toBe(52_000);
    expect(composition?.shares.systemInstructions).toBe(40);
    expect(composition?.shares.toolDefinitions).toBe(61);
  });

  it('leaves composition undefined for builds that do not emit details', () => {
    const file = writeTemp('old.json', JSON.stringify({ sessionId: 'old-1', requests: [vscodeRequest()] }));
    const request = parseSessionFile(file, 'ws', 'demo', 'Local Agent')?.requests[0];
    expect(request).toBeDefined();
    expect(request).not.toHaveProperty('promptComposition');
  });
});

/* ── Copilot CLI ─────────────────────────────────────────────────── */

const START = { type: 'session.start', timestamp: '2026-10-28T09:00:00Z', data: { sessionId: 'cli-1', startTime: '2026-10-28T09:00:00Z', selectedModel: 'claude-opus-5.5', copilotVersion: '1.0.102' } };

function user(id: string, minute: number): Record<string, unknown> {
  return { type: 'user.message', id, timestamp: `2026-10-28T09:${String(minute).padStart(2, '0')}:00Z`, data: { content: `secret prompt ${id}` } };
}

function assistant(id: string): Record<string, unknown> {
  return { type: 'assistant.message', id, data: { content: 'secret answer', outputTokens: 10 } };
}

function usageRecord(inputTokens: number, toolTokenCount: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'session.usage_record',
    data: {
      usage: {
        model: 'claude-opus-5.5',
        inputTokens,
        outputTokens: 500,
        cacheReadTokens: Math.round(inputTokens * 0.9),
        cacheWriteTokens: Math.round(inputTokens * 0.1),
        toolTokenCount,
        availableToolCount: 271,
        maxPromptTokens: 968_000,
        initiator: 'agent',
        interactionType: 'conversation-agent',
        apiCallId: 'call-secret-id',
        ...overrides,
      },
    },
  };
}

function checkpoint(segments: Array<{ segment: string; tokens: number }>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'session.usage_checkpoint',
    data: {
      totalNanoAiu: 1,
      promptCacheBreakState: [{
        conversation: 'main',
        lastActiveModel: 'claude-opus-5.5',
        pendingRewriteSources: [],
        models: {
          'claude-opus-5.5': {
            api_endpoint: '/v1/messages',
            prompt_tokens: 120_000,
            tool_count: 64,
            tool_tokens: 33_000,
            tools: [{ name: 'powershell', safe: true, schema_hash: 'schema-hash-1' }],
            system_segments: segments.map((s, i) => ({ ...s, hash: `segment-hash-${i}` })),
            ...extra,
          },
        },
      }],
    },
  };
}

const SEGMENTS = [
  { segment: 'tool_instructions', tokens: 9_000 },
  { segment: 'custom_instructions', tokens: 6_000 },
  { segment: 'memory', tokens: 5_000 },
];

describe('Copilot CLI composition extraction', () => {
  it('aggregates main-agent usage per turn and back-fills the system size from a later checkpoint', () => {
    const file = writeEvents([
      START,
      user('u1', 1),
      usageRecord(80_000, 30_000),
      usageRecord(120_000, 30_000),
      usageRecord(50_000, 10_000, { interactionType: 'conversation-subagent', initiator: 'sub-agent' }),
      assistant('a1'),
      user('u2', 5),
      // Arrives after turn 1 was flushed, so turn 1 must be back-filled.
      checkpoint(SEGMENTS),
      usageRecord(200_000, 30_000, { availableToolCount: 300 }),
      assistant('a2'),
    ]);
    const session = parseCLIEventsFile(file, 'ws', 'demo');
    const [first, second] = session?.requests ?? [];

    expect(first.promptComposition).toEqual({
      source: 'copilot-cli',
      promptTokens: 100_000,
      calls: 2,
      toolDefinitionTokens: 30_000,
      availableTools: 271,
      shares: { toolDefinitions: 30, systemInstructions: 20, conversation: 50 },
    });
    expect(second.promptComposition?.shares).toEqual({ toolDefinitions: 15, systemInstructions: 10, conversation: 75 });
    expect(second.promptComposition?.availableTools).toBe(300);
    // Existing token fields stay untouched for CLI turns.
    expect(first.promptTokens).toBeNull();
    expect(session?.contextComposition).toEqual({
      systemSegments: [
        { name: 'tool_instructions', tokens: 9_000 },
        { name: 'custom_instructions', tokens: 6_000 },
        { name: 'memory', tokens: 5_000 },
      ],
      toolCount: 64,
      toolTokens: 33_000,
      compactions: [],
    });
  });

  it('keeps the remainder unattributed when no system size is ever recorded', () => {
    const file = writeEvents([START, user('u1', 1), usageRecord(100_000, 25_000), assistant('a1')]);
    const session = parseCLIEventsFile(file, 'ws', 'demo');
    expect(session?.requests[0].promptComposition?.shares).toEqual({ toolDefinitions: 25, other: 75 });
    expect(session).not.toHaveProperty('contextComposition');
  });

  it('records compaction snapshots with their unattributed residual and ignores shutdown tool totals', () => {
    const file = writeEvents([
      START,
      user('u1', 1),
      usageRecord(700_000, 33_000),
      { type: 'session.compaction_start', timestamp: '2026-10-28T09:02:00Z', data: { model: 'claude-opus-5.5', systemTokens: 17_190, conversationTokens: 675_206, toolDefinitionsTokens: 33_370, currentTokens: 774_836, tokenLimit: 968_000, trigger: 'threshold' } },
      { type: 'session.compaction_complete', data: { success: true, systemTokens: 17_190, conversationTokens: 18_381, toolDefinitionsTokens: 33_370, preCompactionTokens: 736_793, postCompactionTokens: 68_945, summaryContent: 'secret summary of the conversation', tokenLimit: 968_000 } },
      assistant('a1'),
      { type: 'session.shutdown', data: { currentTokens: 545_116, systemTokens: 17_051, conversationTokens: 433_328, toolDefinitionsTokens: 94_733, modelMetrics: {} } },
    ]);
    const session = parseCLIEventsFile(file, 'ws', 'demo');
    expect(session?.contextComposition?.compactions).toEqual([{
      timestamp: Date.parse('2026-10-28T09:02:00Z'),
      systemTokens: 17_190,
      toolDefinitionTokens: 33_370,
      conversationTokens: 675_206,
      currentTokens: 774_836,
      tokenLimit: 968_000,
    }]);
    // Tool share comes from the per-call toolTokenCount, not shutdown's 94,733 tool total; the
    // system share uses the latest known system size when the turn is flushed (shutdown: 17,051).
    const shares = session?.requests[0].promptComposition?.shares;
    expect(shares?.toolDefinitions).toBeCloseTo(4.71, 2);
    expect(shares?.systemInstructions).toBeCloseTo(2.44, 2);
  });

  it('leaves composition undefined for older CLI builds without usage records or checkpoints', () => {
    const file = writeEvents([
      { ...START, data: { ...START.data, copilotVersion: '1.0.80' } },
      user('u1', 1),
      assistant('a1'),
      { type: 'session.usage_checkpoint', data: { totalNanoAiu: 5 } },
      { type: 'session.shutdown', data: { currentTokens: 23_542, systemTokens: 10_526, conversationTokens: 13_012, toolDefinitionsTokens: 0, modelMetrics: {} } },
    ]);
    const session = parseCLIEventsFile(file, 'ws', 'demo');
    expect(session?.requests).toHaveLength(1);
    expect(session?.requests[0]).not.toHaveProperty('promptComposition');
    expect(session).not.toHaveProperty('contextComposition');
  });

  it('ignores records without tool counts, records outside a turn and prototype model keys', () => {
    const file = writeEvents([
      START,
      usageRecord(90_000, 30_000),
      user('u1', 1),
      usageRecord(90_000, 30_000, { toolTokenCount: undefined }),
      usageRecord(50_000, 10_000, { interactionType: undefined, initiator: 'agent' }),
      { type: 'session.usage_checkpoint', data: { promptCacheBreakState: [{ conversation: 'main', lastActiveModel: '__proto__', models: { other: { system_segments: [{ segment: 'identity', tokens: 5_000, hash: 'h' }] } } }] } },
      assistant('a1'),
    ]);
    const session = parseCLIEventsFile(file, 'ws', 'demo');
    expect(session?.requests[0].promptComposition).toMatchObject({ calls: 1, promptTokens: 50_000, shares: { toolDefinitions: 20, systemInstructions: 10, conversation: 70 } });
    expect(session?.contextComposition?.systemSegments).toEqual([{ name: 'identity', tokens: 5_000 }]);
  });

  it('never stores prompt text, summaries, hashes or tool names in composition data', () => {
    const file = writeEvents([
      START,
      user('u1', 1),
      usageRecord(100_000, 30_000),
      checkpoint(SEGMENTS),
      { type: 'session.compaction_start', data: { systemTokens: 20_000, conversationTokens: 50_000, toolDefinitionsTokens: 30_000, currentTokens: 100_000, tokenLimit: 200_000 } },
      { type: 'session.compaction_complete', data: { summaryContent: 'secret summary of the conversation', systemTokens: 20_000 } },
      assistant('a1'),
    ]);
    const session = parseCLIEventsFile(file, 'ws', 'demo');
    const stored = JSON.stringify({ request: session?.requests[0].promptComposition, session: session?.contextComposition });
    for (const forbidden of ['secret', 'hash', 'powershell', 'schema', 'api_endpoint', '/v1/messages', 'call-secret-id']) {
      expect(stored).not.toContain(forbidden);
    }
  });

  it('produces the same composition through the async parser', async () => {
    const file = writeEvents([START, user('u1', 1), usageRecord(80_000, 20_000), checkpoint(SEGMENTS), assistant('a1')]);
    const sync = parseCLIEventsFile(file, 'ws', 'demo');
    const asyncSession = await parseCLIEventsFileAsync(file, 'ws', 'demo');
    expect(asyncSession?.requests[0].promptComposition).toEqual(sync?.requests[0].promptComposition);
    expect(asyncSession?.contextComposition).toEqual(sync?.contextComposition);
  });
});

describe('composition persistence', () => {
  it('survives memory stripping and a JSON cache round trip through the session schema', () => {
    const file = writeEvents([
      START,
      user('u1', 1),
      usageRecord(100_000, 30_000),
      checkpoint(SEGMENTS),
      { type: 'session.compaction_start', data: { systemTokens: 20_000, conversationTokens: 50_000, toolDefinitionsTokens: 30_000, currentTokens: 110_000, tokenLimit: 200_000 } },
      assistant('a1'),
    ]);
    const session = parseCLIEventsFile(file, 'ws', 'demo');
    expect(session).not.toBeNull();
    if (!session) return;
    stripSingleSession(session);
    const parsed = SessionSchema.safeParse(JSON.parse(JSON.stringify(session)));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.requests[0].promptComposition).toEqual(session.requests[0].promptComposition);
    expect(parsed.data.contextComposition).toEqual(session.contextComposition);
  });

  it('rejects composition objects that carry anything beyond names and numbers', () => {
    const file = writeEvents([START, user('u1', 1), usageRecord(100_000, 30_000), checkpoint(SEGMENTS), assistant('a1')]);
    const session = parseCLIEventsFile(file, 'ws', 'demo');
    const tampered = JSON.parse(JSON.stringify(session)) as { contextComposition: { systemSegments: Array<Record<string, unknown>> } };
    tampered.contextComposition.systemSegments[0].hash = 'segment-hash-0';
    expect(SessionSchema.safeParse(tampered).success).toBe(false);
  });
});
