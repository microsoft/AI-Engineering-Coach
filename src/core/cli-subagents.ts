/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Sub-agent runs from Copilot CLI and Copilot App `subagent.started` and `subagent.completed` events,
 * joined by `toolCallId` and attributed to the turn that launched them, even when a background run
 * finishes during a later turn. Keeps the built-in agent type, model, mode and the totals Copilot
 * reported. Custom agent names, descriptions and ids are never stored; the id is used only to join. */

import { SUBAGENT_TYPES, type SessionRequest, type SubagentRun, type SubagentType } from './types';
import { normalizeModel } from './helpers';
import { MAX_TURN_SUBAGENT_RUNS } from './token-usage-schemas';

const BUILT_IN_TYPES = new Set<string>(SUBAGENT_TYPES.filter(type => type !== 'custom' && type !== 'unknown'));
/** Runs still waiting for their completion event; a session can't have more in flight. */
const MAX_PENDING_RUNS = 500;

interface StartedRun {
  requestIndex: number | null;
  agentType: SubagentType;
  model: string;
  mode: SubagentRun['mode'];
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function modelOf(value: unknown): string {
  return typeof value === 'string' && value ? normalizeModel(value).slice(0, 64) : '';
}

/** The built-in type of a sub-agent. Older builds log no `agentType`, but name built-in agents after it. */
export function subagentTypeOf(agentType: unknown, agentName: unknown): SubagentType {
  if (typeof agentType === 'string') return BUILT_IN_TYPES.has(agentType) ? agentType as SubagentType : 'custom';
  return typeof agentName === 'string' && BUILT_IN_TYPES.has(agentName) ? agentName as SubagentType : 'custom';
}

export class SubagentRunTracker {
  private readonly started = new Map<string, StartedRun>();
  private readonly finished: { requestIndex: number; run: SubagentRun }[] = [];

  /** `requestIndex`: the index the launching turn's request gets (`null` before the first prompt). */
  start(data: Record<string, unknown>, requestIndex: number | null): void {
    const id = data.toolCallId;
    if (typeof id !== 'string' || !id || this.started.size >= MAX_PENDING_RUNS) return;
    const mode = data.executionMode === 'background' || data.executionMode === 'sync' ? data.executionMode : null;
    this.started.set(id, { requestIndex, agentType: subagentTypeOf(data.agentType, data.agentName), model: modelOf(data.model), mode });
  }

  /** `requestIndex`: the current turn, used when the run's start wasn't logged. */
  complete(data: Record<string, unknown>, requestIndex: number | null): void {
    const id = typeof data.toolCallId === 'string' ? data.toolCallId : '';
    const started = id ? this.started.get(id) : undefined;
    if (id) this.started.delete(id);
    const owner = started ? started.requestIndex : requestIndex;
    if (owner == null) return;
    // Some runs log no start event; their completion still names built-in agents after their type.
    const agentType = started?.agentType ?? (typeof data.agentName === 'string' ? subagentTypeOf(undefined, data.agentName) : 'unknown');
    this.finished.push({
      requestIndex: owner,
      run: {
        agentType,
        model: modelOf(data.model) || (started?.model ?? ''),
        mode: started?.mode ?? null,
        totalTokens: count(data.totalTokens),
        toolCalls: Math.floor(count(data.totalToolCalls)),
        durationMs: count(data.durationMs),
        cancelled: data.cancelled === true,
      },
    });
  }

  /** Attach finished runs to their turns' requests. Runs still in flight are not counted. */
  attach(requests: SessionRequest[]): void {
    for (const { requestIndex, run } of this.finished) {
      const request = requests[requestIndex];
      if (!request) continue;
      const runs = request.subagentRuns ?? (request.subagentRuns = []);
      if (runs.length < MAX_TURN_SUBAGENT_RUNS) runs.push(run);
    }
  }
}
