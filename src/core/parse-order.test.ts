/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Tests for the canonical order of parse results. A cold parse visits workspaces in directory
 * mtime and readdir order, while a cache hit appends the sources it re-reads from disk (Copilot
 * CLI, Claude, ...) after the cached sessions. Analyses that show the first N matches or break
 * ties by input order then changed with the cache state, so every load path must return the
 * same canonical order. The load tests run the real bundled parse worker, as the extension does:
 * a fresh process per load, so the second load is a disk cache hit. */

import { fork } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bundleParseWorkers } from '../test/parse-worker-bundle';
import { Analyzer } from './analyzer';
import { clearCache, flushCacheWrites, type ParseResult } from './cache';
import { getCacheDir } from './cache-paths';
import { compareSessions, sortParseResult } from './parse-order';
import { parseAllLogsAsyncDetailed } from './parser';
import { createRequest, createSession } from './parser-shared';
import { parseAllLogsViaWorker } from './parser-worker-host';
import type { Session, Workspace } from './types';

let bundleDir: string;
let home: string;
let previousHome: { HOME?: string; USERPROFILE?: string };

beforeAll(async () => {
  bundleDir = await bundleParseWorkers();
}, 60_000);

afterAll(() => {
  fs.rmSync(bundleDir, { recursive: true, force: true });
});

beforeEach(() => {
  previousHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'aec-order-home-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});

afterEach(async () => {
  await flushCacheWrites();
  clearCache();
  vi.restoreAllMocks();
  process.env.HOME = previousHome.HOME;
  process.env.USERPROFILE = previousHome.USERPROFILE;
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

/** 1 October 2026, at the given UTC hour and minute. */
function at(hour: number, minute = 0): number {
  return Date.UTC(2026, 9, 1, hour, minute);
}

interface LogsDirs { vscode: string; cli: string }

/** Two short prompts per session, distinct across sessions, so rules that show the first three
 *  matching prompts as examples reveal the order in which they saw the sessions. */
function prompts(sessionId: string): string[] {
  return [`fix ${sessionId}`, `retry ${sessionId}`];
}

function writeVsCodeSession(logs: LogsDirs, wsId: string, sessionId: string, start: number): void {
  const workspaceDir = path.join(logs.vscode, wsId);
  fs.mkdirSync(path.join(workspaceDir, 'chatSessions'), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, 'workspace.json'), JSON.stringify({ folder: pathToFileURL(path.join(home, 'repos', wsId)).href }));
  fs.writeFileSync(path.join(workspaceDir, 'chatSessions', `${sessionId}.json`), JSON.stringify({
    sessionId, creationDate: start, lastMessageDate: start + 120_000,
    requests: prompts(sessionId).map((prompt, index) => ({
      requestId: `${sessionId}-r${index}`, timestamp: start + index * 60_000, modelId: 'gpt-4o',
      message: { text: prompt }, response: [{ value: 'Done.' }],
    })),
  }));
}

function writeCliSession(logs: LogsDirs, sessionId: string, start: number): void {
  const dir = path.join(logs.cli, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const time = (offsetMs: number): string => new Date(start + offsetMs).toISOString();
  fs.writeFileSync(path.join(dir, 'events.jsonl'), [
    { type: 'session.start', timestamp: time(0), data: { sessionId, startTime: time(0) } },
    ...prompts(sessionId).flatMap((prompt, index) => [
      { type: 'user.message', id: `${sessionId}-user-${index}`, timestamp: time(index * 60_000 + 1_000), data: { content: prompt } },
      { type: 'assistant.message', id: `${sessionId}-answer-${index}`, timestamp: time(index * 60_000 + 2_000), data: { content: 'Done.' } },
    ]),
  ].map(event => JSON.stringify(event)).join('\n'));
}

function writeClaudeSession(sessionId: string, start: number): void {
  const dir = path.join(home, '.claude', 'projects', 'claude-app');
  fs.mkdirSync(dir, { recursive: true });
  const time = (offsetMs: number): string => new Date(start + offsetMs).toISOString();
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), prompts(sessionId).flatMap((prompt, index) => [
    { type: 'user', timestamp: time(index * 60_000), sessionId, message: { role: 'user', content: [{ type: 'text', text: prompt }] } },
    {
      type: 'assistant', timestamp: time(index * 60_000 + 2_000), sessionId,
      message: { role: 'assistant', model: 'claude-sonnet-4', content: [{ type: 'text', text: 'Done.' }], usage: { input_tokens: 1_000, output_tokens: 50 } },
    },
  ]).map(line => JSON.stringify(line)).join('\n'));
}

function setMtime(dir: string, isoDate: string): void {
  const time = new Date(isoDate);
  fs.utimesSync(dir, time, time);
}

/**
 * Sessions from VS Code, the Copilot CLI and Claude whose start times interleave. The directory
 * modification times make a cold parse visit the first CLI session before the VS Code
 * workspaces, while a cache hit re-reads the CLI sessions after the cached VS Code sessions.
 */
function writeFixture(): LogsDirs {
  const logs = { vscode: path.join(home, 'workspaceStorage'), cli: path.join(home, '.copilot', 'session-state') };
  writeCliSession(logs, 'cli-early', at(9));
  writeVsCodeSession(logs, 'ws-alpha', 'alpha-1', at(10));
  writeClaudeSession('claude-1', at(10, 30));
  writeVsCodeSession(logs, 'ws-beta', 'beta-1', at(11));
  writeCliSession(logs, 'cli-late', at(12));
  writeVsCodeSession(logs, 'ws-alpha', 'alpha-2', at(13));
  fs.mkdirSync(path.join(logs.vscode, 'ws-empty'));
  setMtime(path.join(logs.cli, 'cli-early'), '2026-01-01T00:00:00Z');
  setMtime(path.join(logs.vscode, 'ws-alpha'), '2026-02-01T00:00:00Z');
  setMtime(path.join(logs.vscode, 'ws-beta'), '2026-03-01T00:00:00Z');
  setMtime(path.join(logs.vscode, 'ws-empty'), '2026-03-15T00:00:00Z');
  setMtime(path.join(logs.cli, 'cli-late'), '2026-04-01T00:00:00Z');
  return logs;
}

/** Load through the real parse worker in a fresh process, as the extension does. */
function loadViaWorker(logs: LogsDirs): Promise<ParseResult> {
  return parseAllLogsViaWorker([logs.vscode, logs.cli], undefined, {
    fork: (_file, args, options) => fork(path.join(bundleDir, 'parse-worker.js'), args, {
      ...options, env: { ...process.env, HOME: home, USERPROFILE: home },
    }),
  });
}

function runtimeLog(): string {
  return fs.readFileSync(path.join(getCacheDir(), 'runtime.log'), 'utf-8');
}

function countMatches(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

/** What users see: the result order plus analyses that pick the first N matches or break ties
 *  by input order. */
function view(result: ParseResult) {
  const analyzer = new Analyzer(result.sessions, result.editLocIndex, result.workspaces);
  return {
    sessions: result.sessions.map(session => session.sessionId),
    workspaces: [...result.workspaces.entries()],
    antiPatterns: analyzer.getAntiPatterns(),
    configHealth: analyzer.getConfigHealth(),
    workspaceList: analyzer.getWorkspaces(),
  };
}

describe('cold and warm loads return the same result', () => {
  it('a disk cache hit returns the cold parse order and the same first-N picks', { timeout: 60_000 }, async () => {
    const logs = writeFixture();

    const cold = view(await loadViaWorker(logs));
    const warm = view(await loadViaWorker(logs));

    expect(countMatches(runtimeLog(), /\[parser\] disk-cache-hit/g)).toBe(1);
    expect(warm).toEqual(cold);
    expect(cold.sessions).toEqual(['cli-early', 'alpha-1', 'claude-1', 'beta-1', 'cli-late', 'alpha-2']);
    // Examples are the first three matching prompts, so they follow the session order.
    expect(cold.antiPatterns.patterns.find(pattern => pattern.id === 'lazy-prompting')?.examples)
      .toEqual(['"fix cli-early" (13 chars)', '"retry cli-early" (15 chars)', '"fix alpha-1" (11 chars)']);
  });

  it('an incremental update after sources change equals a cold parse of the same logs', { timeout: 60_000 }, async () => {
    const logs = writeFixture();
    await loadViaWorker(logs);
    // A new VS Code session makes ws-beta stale; a deleted and a new CLI session change what the
    // update re-reads. The deleted session's workspace must not survive from the cache.
    writeVsCodeSession(logs, 'ws-beta', 'beta-0', at(9, 30));
    fs.rmSync(path.join(logs.cli, 'cli-early'), { recursive: true });
    writeCliSession(logs, 'cli-first', at(8));
    setMtime(path.join(logs.cli, 'cli-first'), '2025-12-01T00:00:00Z');

    const incremental = view(await loadViaWorker(logs));
    clearCache();
    const cold = view(await loadViaWorker(logs));

    expect(countMatches(runtimeLog(), /\[parser\] cold-parse-breakdown \|[^\n]*mode=incremental/g)).toBe(1);
    expect(incremental).toEqual(cold);
    expect(cold.sessions).toEqual(['cli-first', 'beta-0', 'alpha-1', 'claude-1', 'beta-1', 'cli-late', 'alpha-2']);
    expect(cold.workspaces.map(([id]) => id)).not.toContain('cli-early');
  });

  it('a memory cache hit in the same process returns the cold parse order', { timeout: 60_000 }, async () => {
    const logs = writeFixture();
    const logsDirs = [logs.vscode, logs.cli];
    const steps: string[] = [];

    const cold = view((await parseAllLogsAsyncDetailed(logsDirs)).result);
    const warm = view((await parseAllLogsAsyncDetailed(logsDirs, progress => steps.push(progress.detail ?? ''))).result);

    expect(steps).toContain('Loaded from memory');
    expect(warm).toEqual(cold);
  });
});

function session(sessionId: string, creationDate: number | null, overrides: Partial<Session> = {}): Session {
  return createSession({
    sessionId, workspaceId: overrides.workspaceId ?? 'ws', workspaceName: 'workspace', harness: 'Local Agent', creationDate,
    requests: [createRequest({ requestId: `${sessionId}-r1`, timestamp: creationDate, messageText: 'hello', responseText: '' })],
    ...overrides,
  });
}

function workspace(id: string): Workspace {
  return { id, name: id, path: `/logs/${id}` };
}

describe('sortParseResult', () => {
  it('orders sessions oldest first, whatever order they were collected in', () => {
    const sessions = [session('b', at(11)), session('a', at(11)), session('c', at(9)), session('d', at(10))];
    const orders = [sessions, [...sessions].reverse(), [sessions[2], sessions[0], sessions[3], sessions[1]]]
      .map(collected => {
        const result = { sessions: [...collected], workspaces: new Map([['ws', workspace('ws')]]) };
        sortParseResult(result);
        return result.sessions.map(s => s.sessionId);
      });

    expect(orders).toEqual([['c', 'd', 'a', 'b'], ['c', 'd', 'a', 'b'], ['c', 'd', 'a', 'b']]);
  });

  it('falls back to the first request time and sorts sessions without a valid time last', () => {
    const noTime = session('no-time', null);
    const invalid = session('invalid', Number.NaN);
    const fromRequest = session('from-request', null);
    fromRequest.requests[0].timestamp = at(10);
    const result = { sessions: [noTime, invalid, session('dated', at(12)), fromRequest], workspaces: new Map<string, Workspace>() };

    sortParseResult(result);

    expect(result.sessions.map(s => s.sessionId)).toEqual(['from-request', 'dated', 'invalid', 'no-time']);
  });

  it('separates sessions that share an id and start time by harness and workspace', () => {
    const cli = session('same', at(9), { harness: 'GitHub Copilot CLI', workspaceId: 'ws-b' });
    const vscode = session('same', at(9), { harness: 'Local Agent', workspaceId: 'ws-a' });

    expect([compareSessions(cli, vscode), compareSessions(vscode, cli)]).toEqual([-1, 1]);
  });

  it('orders workspaces by their first session, then workspaces without sessions by id', () => {
    const workspaces = new Map(['empty-b', 'late', 'empty-a', 'early'].map(id => [id, workspace(id)]));
    const result = {
      sessions: [session('s3', at(12), { workspaceId: 'late' }), session('s1', at(9), { workspaceId: 'early' }), session('s2', at(10), { workspaceId: 'late' })],
      workspaces,
    };

    sortParseResult(result);

    expect(result.workspaces).toBe(workspaces);
    expect([...result.workspaces.keys()]).toEqual(['early', 'late', 'empty-a', 'empty-b']);
  });
});
