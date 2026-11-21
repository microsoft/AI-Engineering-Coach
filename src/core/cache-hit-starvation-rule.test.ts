/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* The cache-hit-starvation rule counts only requests whose harness reports cache usage. VS Code leaves the
 * cache fields null (not reported), which the DSL's sumField would otherwise read as "nothing cached";
 * Claude Code and OpenCode report 0 when nothing was cached, which must count as fully uncached. */

import { beforeEach, describe, expect, it } from 'vitest';
import { invalidateDetectorRegistry, runDetectors } from './detector-registry';
import { createRequest, createSession } from './parser-shared';
import type { SessionRequest } from './types';

type Cache = Pick<SessionRequest, 'cacheReadTokens' | 'cacheWriteTokens'>;

function requests(count: number, cache: Cache, offset = 0): SessionRequest[] {
  return Array.from({ length: count }, (_, i) => createRequest({
    messageText: 'Refactor the payment service to use the new client.',
    responseText: 'Done.',
    timestamp: Date.parse('2026-10-20T10:00:00Z') + (offset + i) * 60_000,
    promptTokens: 40_000,
    ...cache,
  }));
}

function starvation(harness: string, reqs: SessionRequest[]) {
  const session = createSession({ sessionId: 's', workspaceId: 'ws', workspaceName: 'demo', harness, requests: reqs });
  return runDetectors(reqs, [session], false).find(pattern => pattern.id === 'cache-hit-starvation');
}

/** A session that writes the cache on its first `writes` requests and reads it on the rest. */
function warmingUp(writes: number, total: number): SessionRequest[] {
  return [
    ...requests(writes, { cacheReadTokens: 0, cacheWriteTokens: 40_000 }),
    ...requests(total - writes, { cacheReadTokens: 36_000, cacheWriteTokens: 4_000 }, writes),
  ];
}

describe('cache-hit-starvation rule', () => {
  beforeEach(() => invalidateDetectorRegistry());

  it('ignores requests whose harness does not report cache usage (VS Code: null)', () => {
    expect(starvation('Local Agent', requests(30, { cacheReadTokens: null, cacheWriteTokens: null }))).toBeUndefined();
  });

  it('fires when caching is off and the harness reports zero reads and writes (Claude Code, OpenCode)', () => {
    for (const harness of ['Claude', 'OpenCode']) {
      const pattern = starvation(harness, requests(30, { cacheReadTokens: 0, cacheWriteTokens: 0 }));
      expect(pattern, harness).toBeDefined();
      expect(pattern?.occurrences, harness).toBe(30);
    }
  });

  it('judges a session that warms up its cache on the real read ratio', () => {
    // First request writes the cache, later ones read it: 87% read overall.
    expect(starvation('Claude', warmingUp(1, 30))).toBeUndefined();
    // Mostly rewrites with only two reads: 6% read overall.
    expect(starvation('Claude', warmingUp(28, 30))).toBeDefined();
  });

  it('stays quiet when most of the prompt is read from the cache', () => {
    expect(starvation('Claude', requests(30, { cacheReadTokens: 36_000, cacheWriteTokens: 4_000 }))).toBeUndefined();
  });
});
