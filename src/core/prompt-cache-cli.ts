/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Prompt-cache tracker for Copilot CLI and Copilot App sessions. It consumes model calls in order (from
 * `cli-model-calls.ts`) plus compaction, mode, resume and usage-checkpoint events, and records:
 *   - per-request cache usage (main agent, sub-agents, compaction summaries);
 *   - cache breaks: a main-agent call that couldn't reuse most of the previous call's cached prompt,
 *     with the logged cause and how many tokens were rebuilt.
 * Checkpoint hashes and tool names are compared in memory only and never stored. */

import type { CacheBreak, CacheBreakCause, RequestPromptCache, SessionPromptCache } from './types';
import type { CliModelCall } from './cli-model-calls';
import { relativeRates } from './cli-model-calls';
import { RequestCacheBuilder, cacheModelName, callCost, missTokens, type CacheCallSample } from './prompt-cache-usage';
import {
  CACHE_BREAK_MIN_LOST,
  CACHE_BREAK_MIN_LOST_SHARE,
  CACHE_BREAK_MIN_PREFIX,
  CACHE_MAX_BREAKS_PER_SESSION,
} from './constants';

/** Most explanatory first: compaction and model switches rebuild everything by design, an expired cache
 *  rebuilds everything, configuration changes rebuild from the point that changed. */
export const CACHE_CAUSE_PRIORITY: readonly CacheBreakCause[] = [
  'compaction', 'model-switch', 'ttl-expired', 'reasoning-effort', 'tools-changed', 'system-prompt', 'mode-change', 'resume',
];

type Signal = 'compaction' | 'mode-change' | 'resume';

/** A compaction event still to attribute: when it was logged (`null` without a time) and, for a completion, what
 *  triggered it. */
interface CompactionMark {
  at: number | null;
  trigger?: CacheBreak['compactionTrigger'];
}

const MAX_SEGMENTS = 6;
const SEGMENT_NAME_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const AUTO_TRIGGERS = new Set(['threshold', 'auto', 'automatic']);
const MANUAL_TRIGGERS = new Set(['manual', 'user', 'command', 'slash_command']);

interface PendingBreak {
  brk: CacheBreak;
  logged: Set<CacheBreakCause>;
  inferred: Set<CacheBreakCause>;
  segments: string[];
}

interface CheckpointState {
  model: string;
  segments: Map<string, string>;
  toolsKey: number;
  toolCount: number | null;
  toolTokens: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function text(value: unknown): string {
  if (typeof value === 'string') return value;
  return typeof value === 'number' ? String(value) : '';
}

/** 32-bit FNV-1a, so tool-set comparisons keep a number in memory rather than tool names. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function readCheckpointState(model: Record<string, unknown>, modelName: string): CheckpointState {
  const segments = new Map<string, string>();
  if (Array.isArray(model.system_segments)) {
    for (const segment of model.system_segments) {
      if (!isRecord(segment) || typeof segment.segment !== 'string' || !SEGMENT_NAME_RE.test(segment.segment)) continue;
      segments.set(segment.segment, text(segment.hash));
    }
  }
  const tools: string[] = [];
  if (Array.isArray(model.tools)) {
    for (const tool of model.tools) {
      if (isRecord(tool)) tools.push(`${text(tool.name)}\u0000${text(tool.schema_hash)}`);
    }
  }
  return {
    model: cacheModelName(modelName),
    segments,
    toolsKey: fnv1a(tools.sort().join('\u0001')),
    toolCount: num(model.tool_count),
    toolTokens: num(model.tool_tokens),
  };
}

function changedSegments(before: Map<string, string>, after: Map<string, string>): string[] {
  const names = new Set([...before.keys(), ...after.keys()]);
  return [...names].filter(name => before.get(name) !== after.get(name)).sort();
}

function differs(a: number | null, b: number | null): boolean {
  return a != null && b != null && a !== b;
}

function compactionTrigger(value: unknown): CacheBreak['compactionTrigger'] {
  if (typeof value !== 'string') return undefined;
  const trigger = value.toLowerCase();
  if (AUTO_TRIGGERS.has(trigger)) return 'auto';
  return MANUAL_TRIGGERS.has(trigger) ? 'manual' : undefined;
}

/** The compaction logged that it failed (`success: false`, or an `outcome` of `failed`), so it didn't rewrite the
 *  context. */
function compactionFailed(data: Record<string, unknown>): boolean {
  return data.success === false || (typeof data.outcome === 'string' && data.outcome.toLowerCase() === 'failed');
}

function sampleOf(call: CliModelCall): CacheCallSample {
  return {
    input: call.inputTokens,
    cacheRead: call.cacheReadTokens,
    cacheWrite: call.cacheWriteTokens,
    rates: call.rates,
    ttlSeconds: call.cacheTtlSeconds,
    reasoningEffort: call.reasoningEffort,
  };
}

/** The previous main-agent call's cached prompt was mostly lost. */
export function isCacheBreak(previousInput: number, cacheRead: number): boolean {
  if (previousInput < CACHE_BREAK_MIN_PREFIX) return false;
  return previousInput - cacheRead >= Math.max(CACHE_BREAK_MIN_LOST, CACHE_BREAK_MIN_LOST_SHARE * previousInput);
}

/** Whether the previous main-agent call's cache had expired when `call` started. The cache lifetime counts from
 *  the previous call's start, and `call` reads the cache when it starts; the record itself is logged when the call
 *  finishes. `null` when either time is missing, or when the previous call didn't report its cache. */
function expiredBefore(previous: CliModelCall, call: CliModelCall): boolean | null {
  if (!previous.cacheReported || previous.cacheExpiresAt == null || call.startTs == null) return null;
  return call.startTs > previous.cacheExpiresAt;
}

/** The compaction event was logged before `call` started: a call's prompt is built when it starts, and its record
 *  is logged when it finishes, so a call already running when a compaction completed didn't see the rewrite. An
 *  unknown time counts as before. */
function loggedBefore(mark: CompactionMark, call: CliModelCall): boolean {
  return mark.at == null || call.startTs == null || mark.at <= call.startTs;
}

/** Causes logged on the call itself or in events since the previous main-agent call. */
function loggedCauses(previous: CliModelCall, call: CliModelCall, expired: boolean, signals: ReadonlySet<Signal>): Set<CacheBreakCause> {
  const logged = new Set<CacheBreakCause>();
  if (signals.has('compaction')) logged.add('compaction');
  if (call.model !== previous.model) logged.add('model-switch');
  if (expired) logged.add('ttl-expired');
  if (previous.reasoningEffort && call.reasoningEffort && previous.reasoningEffort !== call.reasoningEffort) logged.add('reasoning-effort');
  if (differs(previous.availableTools, call.availableTools) || differs(previous.toolTokens, call.toolTokens)) logged.add('tools-changed');
  if (signals.has('mode-change')) logged.add('mode-change');
  if (signals.has('resume')) logged.add('resume');
  return logged;
}

function finalize(pending: PendingBreak): CacheBreak {
  const logged = CACHE_CAUSE_PRIORITY.filter(cause => pending.logged.has(cause));
  const inferred = CACHE_CAUSE_PRIORITY.filter(cause => pending.inferred.has(cause) && !pending.logged.has(cause));
  const brk: CacheBreak = {
    ...pending.brk,
    causes: [...logged, ...inferred],
    confidence: logged.length > 0 ? 'logged' : inferred.length > 0 ? 'checkpoint' : 'unattributed',
  };
  if (inferred.length > 0) brk.inferred = inferred;
  if (pending.segments.length > 0 && pending.inferred.has('system-prompt')) brk.segments = pending.segments;
  return brk;
}

export class CliCacheTracker {
  private readonly request = new RequestCacheBuilder();
  /** The previous main-agent call, while it reported its cache: the cached prompt the next call can reuse. */
  private previous: CliModelCall | null = null;
  /** The previous main-agent call, whether or not it reported its cache: a prompt you send returns to it. */
  private lastMain: CliModelCall | null = null;
  /** A main-agent call has reported its cache, so the session has cache data. */
  private sawMain = false;
  private readonly signals = new Set<Signal>();
  /** Successful compactions that no main-agent call has started after yet: each rewrote the context for the next
   *  call that started after it. */
  private completedCompactions: CompactionMark[] = [];
  /** The first compaction start no main-agent call has started after yet, while no compaction has completed since. */
  private startedCompaction: CompactionMark | null = null;
  /** Breaks attributed to a compaction that had only started. A completion logged later shows they came before any
   *  compaction rewrote the context, and takes that cause back. A log without one keeps it: the start is then the
   *  only record of the compaction. */
  private startedCompactionBreaks: PendingBreak[] = [];
  private checkpoint: CheckpointState | null = null;
  private windowBreaks: PendingBreak[] = [];
  private readonly breaks: PendingBreak[] = [];
  private omitted = 0;

  /** A model call, in log order. `callIndex` is its index in the session's call timeline (main agent only). */
  onCall(call: CliModelCall, callIndex: number | null, requestIndex: number): void {
    const lastMain = this.lastMain;
    const expired = call.stream === 'main' && lastMain ? expiredBefore(lastMain, call) : null;
    if (call.stream === 'main') {
      this.lastMain = call;
      // A prompt you sent returns to the previous main-agent call, whether or not either call reported its cache.
      if (lastMain && call.initiator === 'user') this.request.addReturn(expired);
    }
    if (!call.cacheReported) {
      // The cached prompt can't be compared across a call that didn't report its cache.
      if (call.stream === 'main') this.previous = null;
      return;
    }
    const sample = sampleOf(call);
    this.request.addCall(call.stream, call.model, sample);
    if (call.stream !== 'main') return;
    const cost = callCost(sample);
    const previous = this.previous;
    const compaction = this.takeCompactions(call);
    if (!this.sawMain) {
      // Cache data starts here. Its misses are the session's start only on the first main-agent call: after
      // calls that didn't report their cache, nothing says what this call could have reused.
      this.sawMain = true;
      if (callIndex === 0) this.request.addColdStart(missTokens(sample), cost?.missCost);
    } else if (previous && isCacheBreak(previous.inputTokens, call.cacheReadTokens)) {
      const pending = this.recordBreak(previous, call, { callIndex: callIndex ?? -1, requestIndex, expired: expired === true, cost, trigger: compaction.trigger });
      if (pending && compaction.startedOnly) this.startedCompactionBreaks.push(pending);
    }
    this.previous = call;
    this.signals.clear();
  }

  /** Adds the compaction signal for a main-agent call that started after a successful compaction completed, and
   *  takes those compactions; or, tentatively, after a compaction started. Returns the completions' trigger and
   *  whether the signal is only tentative. */
  private takeCompactions(call: CliModelCall): { trigger: CacheBreak['compactionTrigger']; startedOnly: boolean } {
    const completed = this.completedCompactions.filter(mark => loggedBefore(mark, call));
    this.completedCompactions = this.completedCompactions.filter(mark => !completed.includes(mark));
    if (completed.length > 0) this.signals.add('compaction');
    const started = this.startedCompaction != null && loggedBefore(this.startedCompaction, call);
    if (started) this.startedCompaction = null;
    const startedOnly = started && !this.signals.has('compaction');
    if (startedOnly) this.signals.add('compaction');
    const trigger = completed.reduce<CacheBreak['compactionTrigger']>((last, mark) => mark.trigger ?? last, undefined);
    return { trigger, startedOnly };
  }

  /** The break, or `null` when the session's list of breaks is full. */
  private recordBreak(
    previous: CliModelCall,
    call: CliModelCall,
    at: { callIndex: number; requestIndex: number; expired: boolean; cost: { missCost: number } | null; trigger: CacheBreak['compactionTrigger'] },
  ): PendingBreak | null {
    const rebuilt = Math.max(0, Math.min(previous.inputTokens, call.inputTokens) - call.cacheReadTokens);
    const misses = missTokens(sampleOf(call));
    const rebuiltCost = at.cost && misses > 0 ? at.cost.missCost * (rebuilt / misses) : undefined;
    this.request.addRebuilt(rebuilt, rebuiltCost);
    this.request.addBreak(call.model);
    if (this.breaks.length >= CACHE_MAX_BREAKS_PER_SESSION) {
      this.omitted++;
      return null;
    }
    const logged = loggedCauses(previous, call, at.expired, this.signals);
    const brk: CacheBreak = {
      requestIndex: at.requestIndex,
      callIndex: at.callIndex,
      timestamp: call.timestamp,
      model: call.model,
      causes: [],
      confidence: 'unattributed',
      rebuiltTokens: rebuilt,
      idleSeconds: call.startTs != null && previous.startTs != null ? Math.max(0, Math.round((call.startTs - previous.startTs) / 1000)) : null,
      ttlSeconds: previous.cacheTtlSeconds,
      initiator: call.initiator,
    };
    if (rebuiltCost != null) brk.rebuiltCost = Math.round(rebuiltCost);
    if (logged.has('model-switch') && call.autoModel) brk.autoModel = true;
    if (logged.has('compaction') && at.trigger) brk.compactionTrigger = at.trigger;
    const pending: PendingBreak = { brk, logged, inferred: new Set(), segments: [] };
    this.breaks.push(pending);
    this.windowBreaks.push(pending);
    return pending;
  }

  /** `session.compaction_start`, logged at `at`. A compaction rewrites the context only when it completes; current
   *  builds keep making main-agent calls while it runs. */
  onCompactionStart(at: number | null): void {
    this.startedCompaction ??= { at };
  }

  /** `session.compaction_complete`, logged at `at`. Only a successful compaction rewrote the context, so only it
   *  explains the break of the next main-agent call that started after it. Compaction summaries are their own model
   *  calls, recorded as the `compaction` stream once the session logs per-call usage (older builds log compaction
   *  tokens without it, and would show compaction calls alone); a failed compaction's call counts too. */
  onCompactionComplete(data: Record<string, unknown>, at: number | null): void {
    // Calls logged since a compaction started finished before this completion, so they ran on the context as it was.
    for (const pending of this.startedCompactionBreaks) pending.logged.delete('compaction');
    this.startedCompactionBreaks = [];
    this.startedCompaction = null;
    if (!compactionFailed(data)) this.completedCompactions.push({ at, trigger: compactionTrigger(data.trigger) });
    const used = isRecord(data.compactionTokensUsed) ? data.compactionTokensUsed : undefined;
    const input = num(used?.inputTokens);
    if (!this.sawMain || !used || input == null || input <= 0) return;
    const cacheRead = num(used.cacheReadTokens) ?? 0;
    const cacheWrite = num(used.cacheWriteTokens) ?? 0;
    this.request.addCall('compaction', cacheModelName(used.model), {
      input: Math.max(input, cacheRead + cacheWrite),
      cacheRead,
      cacheWrite,
      rates: relativeRates(used.copilotUsage, cacheRead, cacheWrite),
    });
  }

  onSignal(signal: 'mode-change' | 'resume'): void {
    this.signals.add(signal);
  }

  /** A main-agent `promptCacheBreakState` entry and its active model's state. Hash changes between two
   *  checkpoints of the same model explain that model's breaks inside the window; they say nothing about the
   *  prompt of another model used in between. */
  onCheckpoint(entry: Record<string, unknown>, model: Record<string, unknown> | undefined, modelName: string): void {
    const pending = Array.isArray(entry.pendingRewriteSources) ? entry.pendingRewriteSources : [];
    if (pending.includes('compaction')) this.signals.add('compaction');
    if (!model) return;
    const state = readCheckpointState(model, modelName);
    const before = this.checkpoint;
    if (before && before.model === state.model) {
      const segments = changedSegments(before.segments, state.segments);
      const toolsChanged = before.toolsKey !== state.toolsKey
        || differs(before.toolCount, state.toolCount)
        || differs(before.toolTokens, state.toolTokens);
      for (const brk of this.windowBreaks) {
        if (brk.brk.model !== state.model) continue;
        if (segments.length > 0) {
          brk.inferred.add('system-prompt');
          brk.segments = segments.slice(0, MAX_SEGMENTS);
        }
        if (toolsChanged) brk.inferred.add('tools-changed');
      }
    }
    this.checkpoint = state;
    this.windowBreaks = [];
  }

  /** Cache usage since the previous call; attach it to the request being flushed. */
  takeRequest(): RequestPromptCache | undefined {
    return this.request.take();
  }

  finish(): SessionPromptCache | undefined {
    if (!this.sawMain) return undefined;
    return {
      breaks: this.breaks.map(finalize),
      ...(this.omitted > 0 ? { omittedBreaks: this.omitted } : {}),
    };
  }
}
