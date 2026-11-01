/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* The API responses of one Claude Code request. Claude Code writes one transcript line per content block
 * (thinking, text, each tool use), repeats the response's `usage` on each, and logs why the response stopped on
 * some of them only. The lines of one `message.id` build one record. Once every line of the request is read, its
 * token totals, its context, its prompt-cache calls and its calls without cache data all come from those final
 * records, in order. */

import type { CacheStream, CallRow, RequestPromptCache, TurnContextUsage } from './types';
import { RequestCacheBuilder, cacheModelName, missTokens, type CacheCallSample } from './prompt-cache-usage';
import { stopReasonSample } from './call-outputs';
import { TurnContextAccumulator } from './cli-turn-context';

/** The fields of an assistant line's `message` read here. Logs are untrusted, so each is checked before use. */
export interface ClaudeResponseMessage {
  id?: unknown;
  model?: unknown;
  usage?: Record<string, unknown>;
  stop_reason?: unknown;
}

/** What the responses of a request add up to. */
export interface ClaudeRequestUsage {
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** A response reported cache tokens, even zero ones; otherwise the request's cache fields are null (not reported). */
  cacheReported: boolean;
  /** The last and largest prompt of the calls on the request's own chain. */
  contextUsage?: TurnContextUsage;
  promptCache?: RequestPromptCache;
  callRowsWithoutCacheData?: CallRow[];
}

/** Tokens of one response: the largest value of each field over its lines, which normally repeat the same usage. */
interface ResponseTokens {
  uncached: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

/** One API response: the lines of one `message.id`, or a single line without an id. */
interface ClaudeResponse {
  /** A sub-agent's response, as its first line says. */
  sidechain: boolean;
  /** The first model its lines log. */
  model?: string;
  /** `null` until one of its lines logs usage. */
  tokens: ResponseTokens | null;
  /** One of its lines reported cache tokens, even zero ones. */
  cacheReported: boolean;
  /** One of its lines reported cache tokens and a prompt: the response is a prompt-cache call. */
  cacheCall: boolean;
  /** One of its lines reported a prompt without cache fields: unless the response is a prompt-cache call, it counts
   *  on a row without cache data, so its token types don't depend on its cache. */
  noCacheCall: boolean;
  /** Stopped at the output-token limit: `true` once one of its lines logs `max_tokens`, `false` once one logs
   *  another reason, `null` while none logs a reason. */
  truncated: boolean | null;
}

function count(usage: Record<string, unknown>, key: string): number {
  const value = usage[key];
  return typeof value === 'number' ? value : 0;
}

/** A response's truncation after one of its lines logged `stopReason`. */
function afterStopReason(truncated: boolean | null, stopReason: unknown): boolean | null {
  if (typeof stopReason !== 'string' || !stopReason) return truncated;
  return truncated === true || stopReason === 'max_tokens';
}

/** Merge a line's usage into its response. A line decides alone whether it makes the response a prompt-cache call
 *  (cache fields and a prompt) or a call without cache data (a prompt without cache fields): usage without cache
 *  fields didn't report cache usage, so it never counts as uncached. */
function addUsage(response: ClaudeResponse, usage: Record<string, unknown>): void {
  const line: ResponseTokens = {
    uncached: count(usage, 'input_tokens'),
    cacheRead: count(usage, 'cache_read_input_tokens'),
    cacheWrite: count(usage, 'cache_creation_input_tokens'),
    output: count(usage, 'output_tokens'),
  };
  const reportsCache = typeof usage.cache_read_input_tokens === 'number' || typeof usage.cache_creation_input_tokens === 'number';
  response.cacheReported ||= reportsCache;
  response.cacheCall ||= reportsCache && line.uncached + line.cacheRead + line.cacheWrite > 0;
  response.noCacheCall ||= !reportsCache && line.uncached > 0;
  const seen = response.tokens;
  response.tokens = !seen ? line : {
    uncached: Math.max(seen.uncached, line.uncached),
    cacheRead: Math.max(seen.cacheRead, line.cacheRead),
    cacheWrite: Math.max(seen.cacheWrite, line.cacheWrite),
    output: Math.max(seen.output, line.output),
  };
}

/** A response's call on the request's rows, with its final stop reason: with its cache sums when one of its lines
 *  reported them, else without cache data when one reported a prompt. The transcript's first main-agent call with
 *  cache sums is the session's cold start. */
function addResponseCall(cache: RequestCacheBuilder, cacheState: { sawMain: boolean }, response: ClaudeResponse, tokens: ResponseTokens): void {
  const stream: CacheStream = response.sidechain ? 'subagent' : 'main';
  const model = cacheModelName(response.model);
  const outputs = stopReasonSample(response.truncated);
  if (!response.cacheCall) {
    if (response.noCacheCall) cache.addCallWithoutCacheData(stream, model, { input: tokens.uncached, outputs });
    return;
  }
  const sample: CacheCallSample = { input: tokens.uncached + tokens.cacheRead + tokens.cacheWrite, cacheRead: tokens.cacheRead, cacheWrite: tokens.cacheWrite };
  cache.addCall(stream, model, { ...sample, outputs });
  if (stream === 'main' && !cacheState.sawMain) {
    cacheState.sawMain = true;
    cache.addColdStart(missTokens(sample), undefined);
  }
}

/** The responses of one request, one record per `message.id`. Lines without usage contribute only their stop reason
 *  and model, so a response takes its place in the sequence with its first usage. */
export class ClaudeResponseAccumulator {
  private readonly responses: ClaudeResponse[] = [];
  private readonly byId = new Map<string, ClaudeResponse>();

  /** `requestSidechain`: the request is a sub-agent's prompt, so the sub-agent's calls are its own chain. */
  constructor(private readonly requestSidechain: boolean) {}

  /** Add an assistant line: its `message`, and whether the line is a sub-agent's (sidechain). */
  add(message: ClaudeResponseMessage | undefined, sidechain: boolean): void {
    const id = typeof message?.id === 'string' ? message.id : '';
    // A line without an id is a response of its own, which counts only with usage.
    if (!message || (!id && !message.usage)) return;
    let response = id ? this.byId.get(id) : undefined;
    if (!response) {
      response = { sidechain, tokens: null, cacheReported: false, cacheCall: false, noCacheCall: false, truncated: null };
      if (id) this.byId.set(id, response);
    }
    if (response.model === undefined && typeof message.model === 'string' && message.model) response.model = message.model;
    response.truncated = afterStopReason(response.truncated, message.stop_reason);
    if (!message.usage) return;
    if (!response.tokens) this.responses.push(response);
    addUsage(response, message.usage);
  }

  /** The request's token totals, its context from the calls on its own chain, and its rows, from the final
   *  responses. `cacheState` spans a transcript's requests: its first main-agent call is the session's cold start. */
  finish(cacheState: { sawMain: boolean }): ClaudeRequestUsage {
    const usage: ClaudeRequestUsage = { promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheReported: false };
    const context = new TurnContextAccumulator();
    const cache = new RequestCacheBuilder();
    for (const response of this.responses) {
      const tokens = response.tokens;
      if (!tokens) continue;
      const prompt = tokens.uncached + tokens.cacheRead + tokens.cacheWrite;
      usage.promptTokens += prompt;
      usage.completionTokens += tokens.output;
      usage.cacheReadTokens += tokens.cacheRead;
      usage.cacheWriteTokens += tokens.cacheWrite;
      usage.cacheReported ||= response.cacheReported;
      if (response.sidechain === this.requestSidechain) context.addCall({ stream: 'main', inputTokens: prompt, maxPromptTokens: null });
      addResponseCall(cache, cacheState, response, tokens);
    }
    // Only sub-agent calls logged usage: the turn's own context is unknown, and its prompt tokens are theirs.
    const contextUsage = context.result() ?? (this.responses.length > 0 ? { lastPromptTokens: 0, peakPromptTokens: 0, contextLimit: null, calls: 0 } : undefined);
    const promptCache = cache.take();
    const callRowsWithoutCacheData = cache.takeRowsWithoutCacheData();
    return {
      ...usage,
      ...(contextUsage ? { contextUsage } : {}),
      ...(promptCache ? { promptCache } : {}),
      ...(callRowsWithoutCacheData ? { callRowsWithoutCacheData } : {}),
    };
  }
}
