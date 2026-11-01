/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseClaudeSessions } from './parser-claude';
import { createRequest, createSession } from './parser-shared';
import { promptCacheReport } from './prompt-cache-report';

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

/** A Claude Code project whose only log is a sub-agent without its parent session. The parser warns about it
 *  and names the session's directory. */
function orphanSubagentProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-cache-report-'));
  roots.push(root);
  const dir = path.join(root, 'projects', '-Users-me-secret-workspace', 'secret-session-id', 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    { type: 'user', timestamp: '2026-10-20T10:00:00Z', sessionId: 'agent-1', cwd: '/Users/me/secret-workspace', message: { role: 'user', content: [{ type: 'text', text: 'secret prompt' }] } },
    {
      type: 'assistant',
      timestamp: '2026-10-20T10:00:01Z',
      sessionId: 'agent-1',
      message: { id: 'msg-1', role: 'assistant', model: 'claude-sonnet-4', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 } },
    },
  ];
  fs.writeFileSync(path.join(dir, 'agent-1.jsonl'), lines.map(line => JSON.stringify(line)).join('\n'), 'utf-8');
  return path.join(root, 'projects');
}

describe('promptCacheReport', () => {
  it('reports aggregates only, holding back parser diagnostics that name sessions and files', () => {
    const projects = orphanSubagentProject();
    const consoleSpies = (['log', 'info', 'debug', 'warn', 'error'] as const).map(method => vi.spyOn(console, method).mockImplementation(() => undefined));

    const report = promptCacheReport(() => parseClaudeSessions(projects).flatMap(result => result.sessions)).join('\n');

    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
    expect(report).toContain('Prompt cache over 1 requests in 1 sessions');
    expect(report).toContain('hit 90.0%');
    expect(report).toMatch(/\n1 parser diagnostic not shown, because they can name sessions and files\n/);
    for (const secret of ['secret-session-id', 'secret-workspace', 'secret prompt', projects]) expect(report).not.toContain(secret);
  });

  it('reports Codex session totals without a count of model calls', () => {
    const codex = createSession({
      sessionId: 'c', workspaceId: 'ws', workspaceName: 'w', harness: 'Codex',
      requests: [createRequest({ messageText: 'prompt', responseText: '', timestamp: Date.parse('2026-10-20T11:00:00Z') })],
      modelUsage: { 'gpt-6.1-sol': { inputTokens: 20_000, outputTokens: 1_000, cacheReadTokens: 180_000, cacheWriteTokens: 0 } },
    });
    const report = promptCacheReport(() => [codex]).join('\n');
    expect(report).toContain('Codex [per-session]: 1/1 requests\n  session totals; input 0.2M\n  hit 90.0%');
    expect(report).not.toMatch(/calls 0/);
  });
});
