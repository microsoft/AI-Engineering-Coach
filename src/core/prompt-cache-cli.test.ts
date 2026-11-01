/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Prompt-cache extraction from Copilot CLI and Copilot App events: per-request cache usage, cache breaks
 * and their causes, and the call timeline. Fixtures mirror real log shapes, with content redacted. */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseCLIEventsFile, parseCLIEventsFileAsync } from './parser-vscode-cli';
import { PromptCacheAnalyzer } from './analyzer-prompt-cache';
import { SessionSchema } from './schemas';
import { stripSingleSession } from './parser-shared';
import type { Session } from './types';

const tempDirs: string[] = [];
const BASE = Date.parse('2026-10-28T09:00:00Z');

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeEvents(events: Array<Record<string, unknown>>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-engineer-coach-prompt-cache-'));
  tempDirs.push(dir);
  const file = path.join(dir, 'events.jsonl');
  fs.writeFileSync(file, events.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf-8');
  return file;
}

function iso(seconds: number): string {
  return new Date(BASE + seconds * 1000).toISOString();
}

const START = { type: 'session.start', timestamp: iso(0), data: { sessionId: 'cli-cache', startTime: iso(0), selectedModel: 'claude-opus-5.5', remoteSteerable: true } };

function user(id: string, at: number): Record<string, unknown> {
  return { type: 'user.message', id, timestamp: iso(at), data: { content: `secret prompt ${id}` } };
}

interface CallOptions {
  input: number;
  read: number;
  write?: number;
  model?: string;
  ttl?: number;
  initiator?: 'user' | 'agent' | 'sub-agent';
  subagent?: boolean;
  effort?: string;
  tools?: number;
  toolTokens?: number;
  isAuto?: boolean;
  rates?: { input: number; read: number; write: number } | null;
  /** Call duration in seconds: the record is logged when the call finishes, at `at + duration`. */
  duration?: number;
  extra?: Record<string, unknown>;
}

/** A `session.usage_record` for a call that starts at `at` seconds. Like the CLI, the record is logged when
 *  the call finishes and the cache expires one lifetime after the start. Writes default to everything not read. */
function call(at: number, o: CallOptions): Record<string, unknown> {
  const ttl = o.ttl ?? 300;
  const write = o.write ?? o.input - o.read;
  const rates = o.rates === undefined ? { input: 1, read: 0.1, write: 1.25 } : o.rates;
  return {
    type: 'session.usage_record',
    timestamp: iso(at + (o.duration ?? 0)),
    data: {
      usage: {
        model: o.model ?? 'claude-opus-5.5',
        ...(o.duration == null ? {} : { duration: o.duration * 1000 }),
        isAuto: o.isAuto ?? false,
        reasoningEffort: o.effort ?? 'high',
        initiator: o.subagent ? 'sub-agent' : o.initiator ?? 'agent',
        interactionType: o.subagent ? 'conversation-subagent' : 'conversation-agent',
        inputTokens: o.input,
        outputTokens: 500,
        cacheReadTokens: o.read,
        cacheWriteTokens: write,
        cacheExpiresAt: iso(at + ttl),
        cacheTtlSeconds: ttl,
        cacheDetailsReported: true,
        frontierSource: 'reported_writes',
        availableToolCount: o.tools ?? 271,
        toolTokenCount: o.toolTokens ?? 30_000,
        apiCallId: 'call-secret-id',
        accounting: { sourceSessionId: 'source-session-secret' },
        ...(rates ? {
          copilotUsage: {
            totalNanoAiu: 123,
            tokenDetails: [
              { tokenType: 'input', tokenCount: o.input - o.read - write, batchSize: 1_000_000, costPerBatch: rates.input * 1_000_000, model: 'm' },
              { tokenType: 'cache_read', tokenCount: o.read, batchSize: 1_000_000, costPerBatch: rates.read * 1_000_000, model: 'm' },
              { tokenType: 'cache_write', tokenCount: write, batchSize: 1_000_000, costPerBatch: rates.write * 1_000_000, model: 'm' },
            ],
          },
        } : {}),
        ...o.extra,
      },
    },
  };
}

const SEGMENTS = ['identity_preamble', 'tool_instructions', 'custom_instructions', 'workspace_context'];

/** A main-agent usage checkpoint. `changed` segments get a different hash; `schema` changes one tool schema. */
function checkpoint(o: { changed?: string[]; schema?: string; toolCount?: number; pending?: string[]; conversation?: string | null } = {}): Record<string, unknown> {
  return {
    type: 'session.usage_checkpoint',
    data: {
      promptCacheBreakState: [{
        ...(o.conversation === null ? {} : { conversation: o.conversation ?? 'main' }),
        lastActiveModel: 'claude-opus-5.5',
        pendingRewriteSources: o.pending ?? [],
        models: {
          'claude-opus-5.5': {
            system_segments: SEGMENTS.map(segment => ({ segment, tokens: 4_000, hash: `segment-hash-${segment}-${o.changed?.includes(segment) ? 'v2' : 'v1'}` })),
            tools: [{ name: 'powershell', safe: true, schema_hash: o.schema ?? 'schema-hash-1' }, { name: 'view', safe: true, schema_hash: 'schema-hash-2' }],
            tool_count: o.toolCount ?? 64,
            tool_tokens: 33_000,
          },
        },
      }],
    },
  };
}

function parse(events: Array<Record<string, unknown>>): Session {
  const session = parseCLIEventsFile(writeEvents(events), 'ws', 'demo');
  if (!session) throw new Error('no session');
  return session;
}

function breaksOf(session: Session) {
  return session.promptCache?.breaks ?? [];
}

describe('Copilot CLI prompt-cache usage per request', () => {
  it('sums main-agent usage per turn with cold start, returns and cost from logged rates', () => {
    const session = parse([
      START,
      user('u1', 0),
      call(1, { input: 100_000, read: 0, initiator: 'user' }),
      call(30, { input: 110_000, read: 100_000 }),
      user('u2', 90),
      call(100, { input: 120_000, read: 110_000, initiator: 'user' }),
    ]);
    const [first, second] = session.requests;
    expect(first.promptCache).toEqual({
      rows: [{ stream: 'main', model: 'claude-opus-5.5', calls: 2, reasoningEffort: 'high', input: 210_000, cacheRead: 100_000, cacheWrite: 110_000, cost: 147_500, missCost: 137_500, baselineCost: 210_000, ratedInput: 210_000, ttlSeconds: 300, outputTokens: 1_000 }],
      coldStart: 100_000,
      coldStartCost: 125_000,
    });
    expect(second.promptCache).toMatchObject({ returns: 1, rows: [{ calls: 1, input: 120_000, cacheRead: 110_000 }] });
    expect(second.promptCache).not.toHaveProperty('expiredReturns');
    expect(breaksOf(session)).toEqual([]);
    expect(session.callTimeline?.buckets.map(bucket => [bucket.firstRequest, bucket.lastRequest])).toEqual([[0, 0], [0, 0], [1, 1]]);
    // Existing token fields stay untouched for CLI turns.
    expect(first.promptTokens).toBeNull();
    expect(first.cacheReadTokens).toBeNull();
  });

  it('keeps sub-agent and compaction calls on their own streams without breaking the main cache', () => {
    const session = parse([
      START,
      user('u1', 0),
      call(1, { input: 100_000, read: 0 }),
      call(5, { input: 40_000, read: 0, subagent: true, model: 'gpt-6-astra' }),
      call(9, { input: 45_000, read: 40_000, subagent: true, model: 'gpt-6-astra' }),
      call(12, { input: 105_000, read: 100_000 }),
    ]);
    expect(session.requests[0].promptCache?.rows.map(row => [row.stream, row.model, row.calls, row.input])).toEqual([
      ['main', 'claude-opus-5.5', 2, 205_000],
      ['subagent', 'gpt-6-astra', 2, 85_000],
    ]);
    expect(breaksOf(session)).toEqual([]);
    expect(session.callTimeline?.calls).toBe(2);
  });

  it('attaches calls logged before the first prompt to the first request', () => {
    const session = parse([START, call(1, { input: 50_000, read: 0 }), user('u1', 2), call(3, { input: 55_000, read: 50_000 })]);
    expect(session.requests).toHaveLength(1);
    expect(session.requests[0].promptCache?.rows[0]).toMatchObject({ calls: 2, input: 105_000 });
  });
});

describe('Copilot CLI prompt-cache usage from partial or older logs', () => {
  it('omits cost fields when a call logs no rates, and skips calls that report no cache details', () => {
    const session = parse([
      START,
      user('u1', 0),
      call(1, { input: 100_000, read: 0, rates: null }),
      call(5, { input: 101_000, read: 0, extra: { cacheDetailsReported: false } }),
      // Can't be compared across the unreported call, so no break even though nothing was read.
      call(9, { input: 102_000, read: 0, rates: null }),
    ]);
    const row = session.requests[0].promptCache?.rows[0];
    expect(row).toMatchObject({ calls: 2, input: 202_000 });
    expect(row).not.toHaveProperty('cost');
    expect(breaksOf(session)).toEqual([]);
    expect(session.callTimeline?.buckets.map(bucket => bucket.cacheCalls)).toEqual([1, 0, 1]);
  });

  it('records nothing cache-related for builds that log usage without cache fields', () => {
    const record = call(1, { input: 80_000, read: 0 });
    const usage = (record.data as { usage: Record<string, unknown> }).usage;
    delete usage.cacheReadTokens;
    delete usage.cacheWriteTokens;
    const session = parse([START, user('u1', 0), record]);
    expect(session.requests[0]).not.toHaveProperty('promptCache');
    expect(session).not.toHaveProperty('promptCache');
    expect(session.callTimeline?.buckets[0]).toMatchObject({ cacheCalls: 0, cacheRead: 0, cacheWrite: 0, uncached: 0 });
  });

  it('ignores compaction tokens from builds that log no per-call usage', () => {
    const session = parse([
      START,
      user('u1', 0),
      { type: 'session.compaction_complete', data: { trigger: 'threshold', compactionTokensUsed: { inputTokens: 400_000, cacheReadTokens: 100_000, cacheWriteTokens: 0, model: 'claude-opus-5.5' } } },
      { type: 'assistant.message', id: 'a1', data: { content: 'done' } },
    ]);
    expect(session.requests[0]).not.toHaveProperty('promptCache');
    expect(session).not.toHaveProperty('promptCache');
    expect(session).not.toHaveProperty('callTimeline');
  });
});

describe('Copilot CLI session-start misses', () => {
  it('counts them only on the first main-agent call, not where cache data starts mid-conversation', () => {
    const session = parse([
      START,
      user('u1', 0),
      call(1, { input: 100_000, read: 0, extra: { cacheDetailsReported: false } }),
      user('u2', 60),
      call(61, { input: 110_000, read: 0, initiator: 'user' }),
    ]);
    expect(session.requests[1].promptCache?.rows[0]).toMatchObject({ stream: 'main', calls: 1, input: 110_000 });
    expect(session.requests[1].promptCache).not.toHaveProperty('coldStart');
    expect(session.promptCache).toEqual({ breaks: [] });
  });
});

describe('Copilot CLI cache breaks from expiry', () => {
  it('attributes a return after the cache expired to TTL expiry, by who made the call', () => {
    const session = parse([
      START,
      user('u1', 0),
      call(1, { input: 150_000, read: 0 }),
      user('u2', 3_600),
      call(3_601, { input: 155_000, read: 30_000, initiator: 'user' }),
      call(4_000, { input: 160_000, read: 0, initiator: 'agent' }),
    ]);
    const [away, waiting] = breaksOf(session);
    expect(away).toMatchObject({
      requestIndex: 1,
      callIndex: 1,
      causes: ['ttl-expired'],
      confidence: 'logged',
      rebuiltTokens: 120_000,
      idleSeconds: 3_600,
      ttlSeconds: 300,
      initiator: 'user',
      model: 'claude-opus-5.5',
    });
    expect(waiting).toMatchObject({ causes: ['ttl-expired'], initiator: 'agent', idleSeconds: 399, rebuiltTokens: 155_000 });
    expect(session.requests[1].promptCache).toMatchObject({ returns: 1, expiredReturns: 1, rebuilt: 275_000 });
    // Breaks are also counted on the request's main row, by model.
    expect(session.requests[1].promptCache?.rows).toEqual([expect.objectContaining({ stream: 'main', model: 'claude-opus-5.5', calls: 2, cacheBreaks: 2 })]);
    expect(session.requests[0].promptCache?.rows[0]).not.toHaveProperty('cacheBreaks');
  });
});

describe('Copilot CLI cache expiry is measured from call starts', () => {
  // The cache lifetime counts from a call's start, but the record is logged when the call finishes.
  it('does not count a call sent before expiry as expired, even when it finishes after', () => {
    const session = parse([
      START,
      user('u1', 0),
      call(0, { input: 150_000, read: 0, duration: 20 }),
      user('u2', 290),
      // Starts at 290 (cache expires at 300) and is logged at 320.
      call(290, { input: 155_000, read: 150_000, initiator: 'user', duration: 30 }),
    ]);
    expect(session.requests[1].promptCache).toMatchObject({ returns: 1 });
    expect(session.requests[1].promptCache).not.toHaveProperty('expiredReturns');
    expect(breaksOf(session)).toEqual([]);
  });

  it('blames a break in that window on its logged cause rather than on expiry', () => {
    const session = parse([
      START,
      user('u1', 0),
      call(0, { input: 150_000, read: 0, duration: 20 }),
      user('u2', 290),
      call(290, { input: 155_000, read: 20_000, initiator: 'user', duration: 30, tools: 12 }),
    ]);
    expect(breaksOf(session)[0]).toMatchObject({ causes: ['tools-changed'], idleSeconds: 290, ttlSeconds: 300 });
  });

  it('measures the time since the cache was refreshed from start to start', () => {
    const session = parse([
      START,
      user('u1', 0),
      call(0, { input: 150_000, read: 0, duration: 20 }),
      user('u2', 400),
      call(400, { input: 155_000, read: 30_000, initiator: 'user', duration: 30 }),
    ]);
    // Logged at 20 and 430, but the cache was refreshed at 0 and read again at 400.
    expect(breaksOf(session)[0]).toMatchObject({ causes: ['ttl-expired'], idleSeconds: 400, ttlSeconds: 300, timestamp: BASE + 430_000 });
    expect(session.requests[1].promptCache).toMatchObject({ returns: 1, expiredReturns: 1 });
  });

  it('counts a return after a call that logged no cache expiry apart, never as one before expiry', () => {
    const noExpiry = call(0, { input: 150_000, read: 0 });
    delete (noExpiry.data as { usage: Record<string, unknown> }).usage.cacheExpiresAt;
    const session = parse([START, user('u1', 0), noExpiry, user('u2', 3_600), call(3_600, { input: 155_000, read: 150_000, initiator: 'user' })]);
    expect(session.requests[1].promptCache).toMatchObject({ unmeasuredReturns: 1 });
    expect(session.requests[1].promptCache).not.toHaveProperty('returns');
    expect(session.requests[1].promptCache).not.toHaveProperty('expiredReturns');
  });
});

describe('Copilot CLI returns after a call that didn\u2019t report its cache', () => {
  it('count apart, as unmeasured, and the next return is measured again', () => {
    const session = parse([
      START,
      user('u1', 0),
      call(0, { input: 150_000, read: 0 }),
      call(10, { input: 151_000, read: 150_000, extra: { cacheDetailsReported: false } }),
      user('u2', 3_600),
      // Its previous call says nothing about the cache, so whether it had expired is unknown.
      call(3_600, { input: 155_000, read: 150_000, initiator: 'user' }),
      user('u3', 3_700),
      call(3_700, { input: 156_000, read: 155_000, initiator: 'user' }),
    ]);
    const [, unmeasured, measured] = session.requests;
    expect(unmeasured.promptCache).toMatchObject({ unmeasuredReturns: 1 });
    expect(unmeasured.promptCache).not.toHaveProperty('returns');
    expect(measured.promptCache).toMatchObject({ returns: 1 });
    expect(measured.promptCache).not.toHaveProperty('unmeasuredReturns');
    expect(measured.promptCache).not.toHaveProperty('expiredReturns');
    // Nothing to compare the call after the unreported one with, so no break either.
    expect(breaksOf(session)).toEqual([]);
  });

  it('count when the session\u2019s first main-agent call didn\u2019t report its cache', () => {
    const session = parse([
      START,
      user('u1', 0),
      call(0, { input: 150_000, read: 0, extra: { cacheDetailsReported: false } }),
      user('u2', 3_600),
      call(3_600, { input: 155_000, read: 0, initiator: 'user' }),
    ]);
    expect(session.requests[1].promptCache).toMatchObject({ unmeasuredReturns: 1 });
    expect(session.requests[1].promptCache).not.toHaveProperty('returns');
    expect(session.requests[1].promptCache).not.toHaveProperty('coldStart');
  });
});

describe('Copilot CLI returns on a call that didn\u2019t report its cache', () => {
  const returning = (at: number, reported: boolean) => parse([
    { ...START, data: { ...START.data, sessionId: reported ? 'cli-measured' : 'cli-unreported' } },
    user('u1', 0),
    call(0, { input: 150_000, read: 0, ...(reported ? {} : { extra: { cacheDetailsReported: false } }) }),
    user('u2', at),
    call(at, { input: 155_000, read: 0, initiator: 'user', extra: { cacheDetailsReported: false } }),
  ]);

  it.each([[3_600, { returns: 1, expiredReturns: 1 }], [200, { returns: 1 }]])('count, measured against the previous call\u2019s expiry, with no rows or breaks (%i s later)', (at, counts) => {
    const session = returning(at, true);
    expect(session.requests[1].promptCache).toEqual({ rows: [], ...counts });
    expect(breaksOf(session)).toEqual([]);
  });

  it('reach the lifetime card without counting as cache data, even in a session with no cache rows', () => {
    const measured = returning(3_600, true);
    const unreported = returning(3_600, false);
    expect(unreported.requests.map(r => r.promptCache)).toEqual([undefined, { rows: [], unmeasuredReturns: 1 }]);
    const analyzer = new PromptCacheAnalyzer([measured, unreported], new Map());
    const data = analyzer.getPromptCache({});
    expect(data.attribution?.idle).toMatchObject({ returns: 1, expiredReturns: 1, unmeasuredReturns: 1 });
    expect(data.coverage).toEqual({ requestsWithData: 1, totalRequests: 4, sessionsWithData: 1, totalSessions: 2 });
    expect(analyzer.getSessionTimeline('cli-unreported')?.cache ?? null).toBeNull();
  });
});

describe('Copilot CLI cache breaks from compaction', () => {
  it('attributes compaction and records the compaction summary call', () => {
    const session = parse([
      START,
      user('u1', 0),
      call(1, { input: 400_000, read: 0 }),
      { type: 'session.compaction_start', timestamp: iso(20), data: { trigger: 'threshold' } },
      { type: 'session.compaction_complete', timestamp: iso(40), data: { trigger: 'threshold', summaryContent: 'secret summary', compactionTokensUsed: { inputTokens: 400_000, cacheReadTokens: 380_000, cacheWriteTokens: 10_000, outputTokens: 2_000, model: 'claude-opus-5.5' } } },
      call(41, { input: 60_000, read: 35_000 }),
    ]);
    expect(breaksOf(session)).toEqual([expect.objectContaining({ causes: ['compaction'], compactionTrigger: 'auto', rebuiltTokens: 25_000 })]);
    expect(session.requests[0].promptCache?.rows.find(row => row.stream === 'compaction')).toMatchObject({ calls: 1, input: 400_000, cacheRead: 380_000, cacheWrite: 10_000 });
    expect(JSON.stringify(session)).not.toContain('secret summary');
  });

  it('treats a pending compaction rewrite in a checkpoint as a compaction signal', () => {
    const session = parse([START, user('u1', 0), call(1, { input: 300_000, read: 0 }), checkpoint({ pending: ['compaction'] }), call(30, { input: 50_000, read: 30_000 })]);
    expect(breaksOf(session)[0].causes).toEqual(['compaction']);
  });
});

describe('Copilot CLI cache breaks after a failed compaction', () => {
  it.each([{ success: false }, { outcome: 'failed' }])('have no compaction cause (%j), and the compaction call still counts', failed => {
    const session = parse([
      START,
      user('u1', 0),
      call(1, { input: 300_000, read: 0 }),
      { type: 'session.compaction_start', timestamp: iso(20), data: { trigger: 'threshold' } },
      { type: 'session.compaction_complete', timestamp: iso(40), data: { ...failed, trigger: 'threshold', error: 'secret error', compactionTokensUsed: { inputTokens: 300_000, cacheReadTokens: 290_000, cacheWriteTokens: 0, model: 'claude-opus-5.5' } } },
      user('u2', 3_600),
      call(3_601, { input: 305_000, read: 0, initiator: 'user' }),
    ]);
    const [brk] = breaksOf(session);
    expect(brk.causes).toEqual(['ttl-expired']);
    expect(brk).not.toHaveProperty('compactionTrigger');
    expect(session.requests[0].promptCache?.rows.find(row => row.stream === 'compaction')).toMatchObject({ calls: 1, input: 300_000, cacheRead: 290_000 });
  });

  it('have no compaction cause on a call made while it ran', () => {
    const session = parse([
      START,
      user('u1', 0),
      call(1, { input: 300_000, read: 0 }),
      { type: 'session.compaction_start', data: { trigger: 'threshold' } },
      call(10, { input: 301_000, read: 0, tools: 12 }),
      { type: 'session.compaction_complete', data: { success: false, trigger: 'threshold' } },
      call(20, { input: 302_000, read: 0, tools: 12 }),
    ]);
    expect(breaksOf(session).map(brk => brk.causes)).toEqual([['tools-changed'], []]);
  });
});

describe('Copilot CLI cache breaks while a compaction runs', () => {
  it('have no compaction cause; the first call after it completes does', () => {
    const session = parse([
      START,
      user('u1', 0),
      call(1, { input: 300_000, read: 0 }),
      { type: 'session.compaction_start', timestamp: iso(3_600), data: { trigger: 'threshold' } },
      user('u2', 3_600),
      // The cache expired; the compaction hasn't rewritten anything yet.
      call(3_601, { input: 305_000, read: 0, initiator: 'user' }),
      call(3_610, { input: 306_000, read: 305_000 }),
      { type: 'session.compaction_complete', timestamp: iso(3_620), data: { success: true, trigger: 'threshold' } },
      call(3_621, { input: 60_000, read: 30_000 }),
    ]);
    expect(breaksOf(session).map(brk => [brk.callIndex, brk.causes, brk.compactionTrigger])).toEqual([
      [1, ['ttl-expired'], undefined],
      [3, ['compaction'], 'auto'],
    ]);
  });

  it('keep the compaction as their cause when the log never shows it completing', () => {
    const session = parse([
      START,
      user('u1', 0),
      call(1, { input: 300_000, read: 0 }),
      { type: 'session.compaction_start', data: { trigger: 'threshold' } },
      call(30, { input: 50_000, read: 30_000 }),
    ]);
    expect(breaksOf(session)[0].causes).toEqual(['compaction']);
  });

  it('give the compaction only to the first call after its start', () => {
    const session = parse([
      START,
      user('u1', 0),
      call(1, { input: 300_000, read: 0 }),
      { type: 'session.compaction_start', data: { trigger: 'threshold' } },
      call(10, { input: 301_000, read: 300_000 }),
      call(20, { input: 302_000, read: 0, tools: 12 }),
    ]);
    expect(breaksOf(session).map(brk => brk.causes)).toEqual([['tools-changed']]);
  });
});

const COMPACTED = { type: 'session.compaction_complete', data: { success: true, trigger: 'threshold' } };
const STARTED = { type: 'session.compaction_start', data: { trigger: 'threshold' } };

describe('Copilot CLI cache breaks after a compaction completed', () => {
  it('keep the compaction as their cause when a later compaction completes', () => {
    const session = parse([
      START,
      user('u1', 0),
      call(1, { input: 300_000, read: 0 }),
      STARTED, COMPACTED,
      call(41, { input: 60_000, read: 30_000 }),
      call(50, { input: 61_000, read: 60_000 }),
      STARTED, COMPACTED,
      call(81, { input: 25_000, read: 10_000 }),
    ]);
    expect(breaksOf(session).map(brk => [brk.callIndex, brk.causes, brk.compactionTrigger])).toEqual([
      [1, ['compaction'], 'auto'],
      [3, ['compaction'], 'auto'],
    ]);
  });

  it.each([
    ['a completed compaction', [STARTED, COMPACTED, STARTED]],
    ['a pending compaction rewrite in a checkpoint', [STARTED, checkpoint({ pending: ['compaction'] })]],
  ])('keep the compaction as their cause when %s came before another compaction\u2019s start', (_signal, events) => {
    const session = parse([START, user('u1', 0), call(1, { input: 300_000, read: 0 }), ...events, call(30, { input: 50_000, read: 30_000 }), COMPACTED]);
    expect(breaksOf(session)[0].causes).toEqual(['compaction']);
  });
});

describe('Copilot CLI cache breaks of calls logged after a compaction event', () => {
  // A call's record is logged when it finishes, so a call can start before a compaction event logged before it.
  it('give a completed compaction to the first call that started after it, not one that was running', () => {
    const session = parse([
      START,
      user('u1', 0),
      call(1, { input: 300_000, read: 0 }),
      { type: 'session.compaction_start', timestamp: iso(20), data: { trigger: 'threshold' } },
      { type: 'session.compaction_complete', timestamp: iso(40), data: { success: true, trigger: 'threshold' } },
      call(30, { input: 301_000, read: 0, tools: 12, duration: 20 }),
      call(60, { input: 60_000, read: 30_000, tools: 12 }),
    ]);
    expect(breaksOf(session).map(brk => [brk.callIndex, brk.causes, brk.compactionTrigger])).toEqual([
      [1, ['tools-changed'], undefined],
      [2, ['compaction'], 'auto'],
    ]);
  });

  it('give each call the compactions that completed before it started', () => {
    const session = parse([
      START,
      user('u1', 0),
      call(1, { input: 300_000, read: 0 }),
      { type: 'session.compaction_complete', timestamp: iso(100), data: { success: true, trigger: 'threshold' } },
      { type: 'session.compaction_complete', timestamp: iso(200), data: { success: true, trigger: 'manual' } },
      call(150, { input: 200_000, read: 0, duration: 100 }),
      call(260, { input: 60_000, read: 20_000 }),
    ]);
    expect(breaksOf(session).map(brk => [brk.causes, brk.compactionTrigger])).toEqual([[['compaction'], 'auto'], [['compaction'], 'manual']]);
  });

  it('give a compaction that only started to the first call that started after it', () => {
    const session = parse([
      START,
      user('u1', 0),
      call(1, { input: 300_000, read: 0 }),
      { type: 'session.compaction_start', timestamp: iso(20), data: { trigger: 'threshold' } },
      call(10, { input: 301_000, read: 0, tools: 12, duration: 15 }),
      call(30, { input: 50_000, read: 30_000, tools: 12 }),
    ]);
    expect(breaksOf(session).map(brk => brk.causes)).toEqual([['tools-changed'], ['compaction']]);
  });
});

describe('Copilot CLI cache breaks from setting changes', () => {
  it('attributes model switches, marking those made by automatic model selection', () => {
    const session = parse([
      START,
      user('u1', 0),
      call(1, { input: 100_000, read: 0 }),
      call(30, { input: 105_000, read: 0, model: 'gpt-6.1-sol' }),
      call(60, { input: 110_000, read: 0, model: 'claude-opus-5.5', isAuto: true }),
    ]);
    const [manual, auto] = breaksOf(session);
    expect(manual).toMatchObject({ causes: ['model-switch'], model: 'gpt-6.1-sol' });
    expect(manual).not.toHaveProperty('autoModel');
    expect(auto).toMatchObject({ causes: ['model-switch'], autoModel: true });
  });

  it('attributes reasoning-effort, tool-set, mode and resume changes', () => {
    const session = parse([
      START,
      user('u1', 0),
      call(1, { input: 100_000, read: 0 }),
      call(10, { input: 101_000, read: 0, effort: 'medium' }),
      call(20, { input: 102_000, read: 0, effort: 'medium', tools: 40 }),
      { type: 'session.mode_changed', data: { newMode: 'autopilot' } },
      call(30, { input: 103_000, read: 0, effort: 'medium', tools: 40 }),
      { type: 'session.resume', data: {} },
      call(40, { input: 104_000, read: 0, effort: 'medium', tools: 40 }),
    ]);
    expect(breaksOf(session).map(brk => brk.causes)).toEqual([['reasoning-effort'], ['tools-changed'], ['mode-change'], ['resume']]);
  });

  it('attributes a reasoning-effort change carried only in the model id', () => {
    const noEffort = { reasoningEffort: undefined };
    const session = parse([
      START,
      user('u1', 0),
      call(1, { input: 100_000, read: 0, model: 'copilot/claude-opus-4.7-high', extra: noEffort }),
      call(10, { input: 101_000, read: 0, model: 'copilot/claude-opus-4.7-low', extra: noEffort }),
    ]);
    expect(breaksOf(session)).toEqual([expect.objectContaining({ model: 'claude-opus-4.7', causes: ['reasoning-effort'], confidence: 'logged' })]);
  });
});

describe('Copilot CLI cache breaks from checkpoint windows', () => {
  it('infers system-prompt and tool-schema changes from the checkpoint window, naming only the segments', () => {
    const session = parse([
      START,
      user('u1', 0),
      checkpoint(),
      call(1, { input: 100_000, read: 0 }),
      call(10, { input: 102_000, read: 20_000 }),
      checkpoint({ changed: ['custom_instructions'] }),
      call(20, { input: 104_000, read: 25_000 }),
      checkpoint({ changed: ['custom_instructions'], schema: 'schema-hash-9' }),
    ]);
    const [instructions, schema] = breaksOf(session);
    expect(instructions).toMatchObject({ causes: ['system-prompt'], inferred: ['system-prompt'], confidence: 'checkpoint', segments: ['custom_instructions'] });
    expect(schema).toMatchObject({ causes: ['tools-changed'], inferred: ['tools-changed'], confidence: 'checkpoint' });
  });

  it('applies a checkpoint window\u2019s changes only to breaks on the checkpoint\u2019s model', () => {
    const session = parse([
      START,
      user('u1', 0),
      checkpoint(),
      call(1, { input: 100_000, read: 0 }),
      call(10, { input: 102_000, read: 0, model: 'gpt-6.1-sol' }),
      call(20, { input: 104_000, read: 20_000, model: 'gpt-6.1-sol' }),
      call(30, { input: 106_000, read: 0 }),
      call(40, { input: 108_000, read: 25_000 }),
      // Both checkpoints show claude-opus-5.5, whose instructions changed in between.
      checkpoint({ changed: ['custom_instructions'] }),
    ]);
    expect(breaksOf(session).map(brk => [brk.model, brk.causes, brk.confidence])).toEqual([
      ['gpt-6.1-sol', ['model-switch'], 'logged'],
      ['gpt-6.1-sol', [], 'unattributed'],
      ['claude-opus-5.5', ['model-switch', 'system-prompt'], 'logged'],
      ['claude-opus-5.5', ['system-prompt'], 'checkpoint'],
    ]);
  });
});

describe('Copilot CLI cache-break attribution order', () => {
  it('orders several causes by priority, logged before checkpoint-only', () => {
    const session = parse([
      START,
      user('u1', 0),
      checkpoint(),
      call(1, { input: 200_000, read: 0 }),
      { type: 'session.resume', data: {} },
      user('u2', 86_400),
      call(86_401, { input: 205_000, read: 18_000, initiator: 'user' }),
      checkpoint({ changed: ['workspace_context'] }),
    ]);
    expect(breaksOf(session)[0]).toMatchObject({
      causes: ['ttl-expired', 'resume', 'system-prompt'],
      inferred: ['system-prompt'],
      confidence: 'logged',
      segments: ['workspace_context'],
    });
  });

  it('leaves a break with no logged signal unattributed', () => {
    const session = parse([START, user('u1', 0), call(1, { input: 100_000, read: 0 }), call(10, { input: 101_000, read: 10_000 })]);
    expect(breaksOf(session)[0]).toMatchObject({ causes: [], confidence: 'unattributed', rebuiltTokens: 90_000 });
    expect(breaksOf(session)[0]).not.toHaveProperty('inferred');
  });
});

describe('Copilot CLI cache-break thresholds and limits', () => {
  it('applies the break thresholds: a 20K previous prompt and max(10K, 30%) of it lost', () => {
    const lost = (previous: number, read: number) => breaksOf(parse([
      START,
      user('u1', 0),
      call(1, { input: previous, read: 0 }),
      call(10, { input: previous + 1_000, read }),
    ])).length;
    expect(lost(19_999, 0)).toBe(0);
    expect(lost(100_000, 70_001)).toBe(0);
    expect(lost(100_000, 69_999)).toBe(1);
    expect(lost(25_000, 15_001)).toBe(0);
    expect(lost(25_000, 14_999)).toBe(1);
  });

  it('ignores checkpoints from another conversation', () => {
    const session = parse([
      START,
      user('u1', 0),
      checkpoint(),
      call(1, { input: 100_000, read: 0 }),
      call(10, { input: 102_000, read: 20_000 }),
      checkpoint({ changed: ['custom_instructions'], conversation: 'subagent-1' }),
    ]);
    expect(breaksOf(session)[0]).toMatchObject({ causes: [], confidence: 'unattributed' });
  });

  it('caps listed breaks per session and counts the rest', () => {
    const events: Array<Record<string, unknown>> = [START, user('u1', 0)];
    for (let i = 0; i < 104; i++) events.push(call(i * 10 + 1, { input: 100_000, read: 0 }));
    const session = parse(events);
    expect(breaksOf(session)).toHaveLength(100);
    expect(session.promptCache?.omittedBreaks).toBe(3);
    expect(session.requests[0].promptCache?.rebuilt).toBe(103 * 100_000);
    // The request row still counts every break, so rates include those over the cap.
    expect(session.requests[0].promptCache?.rows[0]).toMatchObject({ stream: 'main', calls: 104, cacheBreaks: 103 });
  });
});

describe('Copilot CLI call timeline', () => {
  it('buckets main-agent calls and doubles the bucket size beyond the cap', () => {
    const events: Array<Record<string, unknown>> = [START, user('u1', 0)];
    for (let i = 0; i < 250; i++) {
      if (i === 2) events.push(user('u2', 2));
      events.push(call(i + 1, { input: 50_000 + i, read: i === 0 ? 0 : 50_000 + i - 1 }));
    }
    const timeline = parse(events).callTimeline;
    expect(timeline).toMatchObject({ calls: 250, bucketSize: 4 });
    expect(timeline?.buckets).toHaveLength(63);
    expect(timeline?.buckets[0]).toMatchObject({ firstCall: 0, lastCall: 3, firstRequest: 0, lastRequest: 1, cacheCalls: 4, startTs: BASE + 1_000, endTs: BASE + 4_000 });
    expect(timeline?.buckets.at(-1)).toMatchObject({ firstCall: 248, lastCall: 249, firstRequest: 1, lastRequest: 1, cacheCalls: 2 });
    const total = timeline?.buckets.reduce((sum, bucket) => sum + bucket.cacheRead + bucket.cacheWrite + bucket.uncached, 0);
    expect(total).toBe(Array.from({ length: 250 }, (_, i) => 50_000 + i).reduce((a, b) => a + b, 0));
  });
});

describe('Copilot CLI prompt-cache privacy and storage', () => {
  const EVENTS = [
    START,
    user('u1', 0),
    checkpoint(),
    call(1, { input: 150_000, read: 0 }),
    user('u2', 3_600),
    call(3_601, { input: 155_000, read: 30_000, initiator: 'user' }),
    checkpoint({ changed: ['custom_instructions'], schema: 'schema-hash-9' }),
    call(3_700, { input: 30_000, read: 0, subagent: true }),
  ];

  it('stores no prompt text, hashes, tool names or ids, and survives schema validation and stripping', () => {
    const session = parse(EVENTS);
    const json = JSON.stringify({ callTimeline: session.callTimeline, promptCache: session.promptCache, requests: session.requests.map(r => r.promptCache) });
    for (const secret of ['segment-hash', 'schema-hash', 'powershell', 'secret prompt', 'call-secret-id', 'source-session-secret']) {
      expect(json).not.toContain(secret);
    }
    const parsed = SessionSchema.safeParse(JSON.parse(JSON.stringify(session)));
    expect(parsed.success).toBe(true);
    stripSingleSession(session);
    expect(session.requests[1].promptCache?.rebuilt).toBe(120_000);
    expect(breaksOf(session)).toHaveLength(1);
  });

  it('rejects tampered cache data in the schema', () => {
    const session = JSON.parse(JSON.stringify(parse(EVENTS))) as { promptCache: { breaks: Array<{ causes: string[] }> } };
    session.promptCache.breaks[0].causes = ['made-up'];
    expect(SessionSchema.safeParse(session).success).toBe(false);
  });

  it('gives the same result from the async parser', async () => {
    const file = writeEvents(EVENTS);
    const sync = parseCLIEventsFile(file, 'ws', 'demo');
    const async = await parseCLIEventsFileAsync(file, 'ws', 'demo');
    expect(async?.promptCache).toEqual(sync?.promptCache);
    expect(async?.callTimeline).toEqual(sync?.callTimeline);
    expect(async?.requests.map(r => r.promptCache)).toEqual(sync?.requests.map(r => r.promptCache));
  });
});
