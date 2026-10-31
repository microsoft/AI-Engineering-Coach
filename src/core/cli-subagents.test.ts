/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect } from 'vitest';
import { SubagentRunTracker, subagentTypeOf } from './cli-subagents';
import { createRequest } from './parser-shared';
import { MAX_TURN_SUBAGENT_RUNS } from './token-usage-schemas';
import type { SessionRequest } from './types';

function requests(count: number): SessionRequest[] {
  return Array.from({ length: count }, (_, i) => createRequest({ requestId: `r${i}`, messageText: `turn ${i}`, responseText: '' }));
}

function started(toolCallId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    toolCallId,
    agentName: 'research',
    agentDisplayName: 'Research Agent',
    agentDescription: 'SECRET description of a private agent',
    agentType: 'research',
    executionMode: 'background',
    model: 'claude-sonnet-5',
    ...extra,
  };
}

function completed(toolCallId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { toolCallId, agentName: 'research', model: 'claude-sonnet-5', totalTokens: 1_200_000, totalToolCalls: 40, durationMs: 180_000, ...extra };
}

describe('subagentTypeOf', () => {
  it('keeps built-in types and groups everything else as custom', () => {
    expect(subagentTypeOf('explore', 'explore')).toBe('explore');
    expect(subagentTypeOf('code-review', 'anything')).toBe('code-review');
    expect(subagentTypeOf('custom', 'my-private-agent')).toBe('custom');
    expect(subagentTypeOf('some-future-type', 'x')).toBe('custom');
  });

  it('falls back to the agent name on older builds that log no agentType', () => {
    expect(subagentTypeOf(undefined, 'general-purpose')).toBe('general-purpose');
    expect(subagentTypeOf(undefined, 'my-private-agent')).toBe('custom');
    expect(subagentTypeOf(undefined, undefined)).toBe('custom');
  });
});

describe('SubagentRunTracker', () => {
  it('attributes a background run to the turn that launched it, even when it finishes later', () => {
    const tracker = new SubagentRunTracker();
    tracker.start(started('call-1'), 0);
    tracker.complete(completed('call-1'), 2);
    const reqs = requests(3);
    tracker.attach(reqs);
    expect(reqs[0].subagentRuns).toEqual([{
      agentType: 'research', model: 'claude-sonnet-5', mode: 'background',
      totalTokens: 1_200_000, toolCalls: 40, durationMs: 180_000, cancelled: false,
    }]);
    expect(reqs[1].subagentRuns).toBeUndefined();
    expect(reqs[2].subagentRuns).toBeUndefined();
  });

  it('records cancelled sync runs and runs whose start was not logged', () => {
    const tracker = new SubagentRunTracker();
    tracker.start(started('call-1', { agentType: 'explore', executionMode: 'sync' }), 1);
    tracker.complete(completed('call-1', { cancelled: true, totalTokens: 5_000 }), 1);
    tracker.complete(completed('call-orphan', { model: 'gpt-6.1-sol' }), 1);
    const reqs = requests(2);
    tracker.attach(reqs);
    expect(reqs[1].subagentRuns).toMatchObject([
      { agentType: 'explore', mode: 'sync', cancelled: true, totalTokens: 5_000 },
      { agentType: 'unknown', mode: null, model: 'gpt-6.1-sol' },
    ]);
  });

  it('does not count runs still in flight or launched before the first prompt', () => {
    const tracker = new SubagentRunTracker();
    tracker.start(started('running'), 0);
    tracker.start(started('early'), null);
    tracker.complete(completed('early'), 0);
    const reqs = requests(1);
    tracker.attach(reqs);
    expect(reqs[0].subagentRuns).toBeUndefined();
  });

  it('caps the runs kept per turn', () => {
    const tracker = new SubagentRunTracker();
    for (let i = 0; i < MAX_TURN_SUBAGENT_RUNS + 3; i++) {
      tracker.start(started(`call-${i}`), 0);
      tracker.complete(completed(`call-${i}`), 0);
    }
    const reqs = requests(1);
    tracker.attach(reqs);
    expect(reqs[0].subagentRuns).toHaveLength(MAX_TURN_SUBAGENT_RUNS);
  });

  it('never stores agent names, descriptions or ids', () => {
    const tracker = new SubagentRunTracker();
    tracker.start(started('call-secret-id', { agentType: 'custom', agentName: 'my-private-agent' }), 0);
    tracker.complete(completed('call-secret-id', { agentName: 'my-private-agent' }), 0);
    const reqs = requests(1);
    tracker.attach(reqs);
    const json = JSON.stringify(reqs[0].subagentRuns);
    for (const secret of ['my-private-agent', 'SECRET', 'call-secret-id', 'Research Agent']) expect(json).not.toContain(secret);
    expect(reqs[0].subagentRuns?.[0].agentType).toBe('custom');
  });
});
