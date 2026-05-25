/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest';
import { TeamModeSyncClient, createFetchTeamModeTransport } from './team-sync';
import type { TeamModeSettings } from './types';
import { createEmptyTeamModeSnapshot } from './types/team-mode-types';

function makeSettings(overrides: Partial<TeamModeSettings> = {}): TeamModeSettings {
  return {
    enabled: true,
    serverUrl: 'https://team.example.com/api/team-mode',
    developerId: 'dev-123',
    ...overrides,
  };
}

function makeSnapshot() {
  const snapshot = createEmptyTeamModeSnapshot();
  snapshot.developerId = 'dev-123';
  snapshot.windowStartMs = 1715479200000;
  snapshot.windowEndMs = 1716084000000;
  snapshot.categoryScores = {
    'prompt-quality': 80,
    'session-hygiene': 75,
    'code-review': 90,
    'tool-mastery': 70,
    'context-management': 65,
  };
  snapshot.tokenUsage.requests = 4;
  snapshot.tokenUsage.countedRequests = 4;
  snapshot.tokenUsage.inputTokens = 1000;
  snapshot.tokenUsage.outputTokens = 500;
  snapshot.antiPatterns.topViolations = [
    { ruleId: 'lazy-prompting', severity: 'medium', count: 2 },
  ];
  snapshot.weeklyTrend.weekStartMs = [1715479200000, 1716084000000];
  snapshot.weeklyTrend.scoresByCategory['prompt-quality'] = [78, 80];
  return snapshot;
}

describe('Team Mode sync client', () => {
  it('does nothing when Team Mode is disabled', async () => {
    const post = vi.fn();
    const client = new TeamModeSyncClient({
      post,
    }, () => makeSettings({ enabled: false }));

    const result = await client.enqueue(makeSnapshot());

    expect(result).toMatchObject({ ok: true, skipped: true, uploaded: false, queued: false });
    expect(post).not.toHaveBeenCalled();
  });

  it('uploads a privacy-safe snapshot payload when enabled', async () => {
    const post = vi.fn(async (_url: string, body: string, _headers: Record<string, string>) => ({
      ok: true,
      status: 200,
      text: async () => body,
    }));
    const client = new TeamModeSyncClient({
      post,
    }, () => makeSettings());

    const snapshot = makeSnapshot();
    const result = await client.enqueue(snapshot);

    expect(result).toMatchObject({ ok: true, uploaded: true, queued: false, skipped: false });
    expect(post).toHaveBeenCalledTimes(1);
    const [url, body, headers] = post.mock.calls[0] as [string, string, Record<string, string>];
    expect(url).toBe('https://team.example.com/api/team-mode');
    expect(headers).toMatchObject({
      'content-type': 'application/json',
      'x-team-developer-id': 'dev-123',
    });
    expect(body).toContain('"developerId":"dev-123"');
    expect(body).toContain('"prompt-quality":80');
    expect(body).not.toContain('messageText');
    expect(body).not.toContain('filePath');
    expect(body).not.toContain('workspaceName');
    expect(client.pendingCount()).toBe(0);
  });

  it('keeps the snapshot queued after a transient failure and retries later', async () => {
    const post = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => 'retry later' })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => 'ok' });
    const client = new TeamModeSyncClient({
      post,
    }, () => makeSettings());

    const snapshot = makeSnapshot();
    const first = await client.enqueue(snapshot);

    expect(first).toMatchObject({ ok: false, uploaded: false, queued: true, skipped: false });
    expect(client.pendingCount()).toBe(1);

    const retry = await client.flushPending();

    expect(retry).toMatchObject({ ok: true, uploaded: true, queued: false, skipped: false });
    expect(client.pendingCount()).toBe(0);
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('creates a fetch-backed transport when given fetch', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = String(init?.body ?? '');
      return new Response(body, { status: 200 });
    });

    const transport = createFetchTeamModeTransport(fetchImpl);
    const response = await transport.post('https://team.example.com/api/team-mode', '{"ok":true}', {
      'content-type': 'application/json',
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(response.ok).toBe(true);
    expect(await response.text()).toBe('{"ok":true}');
  });
});
