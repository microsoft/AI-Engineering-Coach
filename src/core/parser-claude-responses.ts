/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* The API responses of one Claude Code request. Claude Code writes one transcript line per content block
 * (thinking, text, each tool use), repeats the response's `usage` on each, and logs why the response stopped on
 * some of them only. The lines of one `message.id` build one record, which counts once: as a prompt-cache call, or
 * as a call without cache data when none of its lines reports cache usage for a prompt. Once every line of the
 * request is read, its token totals, its context and its rows come from those final records, in the order their first
 * usage appears: each call goes on the request's rows with the largest value of each usage field over its lines, the
 * values the totals count, and the stop reason any of its lines logged. */

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

/** What the responses of a request add to it. */
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

/** A response's call: the stream and model of the line that counts it. */
interface ResponseCall {
  stream: CacheStream;
  model: string;
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
  /** Its prompt-cache call, from the first of its lines that reported cache tokens for a prompt. Later lines don't
   *  change it. */
  cacheCall?: ResponseCall;
  /** Its call without cache data, unless it gets a prompt-cache call: from the latest of its lines that reported a
   *  prompt without cache fields. */
  noCacheCall?: ResponseCall;
  /** `null` until one of its lines logs usage. */
  tokens: ResponseTokens | null;
  /** One of its lines reported cache tokens, even zero ones. */
  cacheReported: boolean;
  /** Stopped at the output-token limit: `true` once one of its lines logs `max_tokens`, `false` once one logs
   *  another reason, `null` while none logs a reason. */
  truncated: boolean | null;
}

function count(usage: Record<string, unknown>, key: string): number {
  const value = usage[key];
  return typeof value === 'number' ? value : 0;
}

/** The usage block reports cache tokens, even zero ones. Without them the request's cache fields stay null. */
function reportsCacheUsage(usage: Record<string, unknown> | undefined): boolean {
  return typeof usage?.cache_read_input_tokens === 'number' || typeof usage?.cache_creation_input_tokens === 'number';
}

/** A response's truncation after one of its lines logged `stopReason`. */
function afterStopReason(truncated: boolean | null, stopReason: unknown): boolean | null {
  if (typeof stopReason !== 'string' || !stopReason) return truncated;
  return truncated === true || stopReason === 'max_tokens';
}

/** A response's call on the request's rows, with its final usage and stop reason: with its cache sums when one of its
 *  lines reported them for a prompt, else without cache data. The transcript's first main-agent call with cache sums
 *  is the session's cold start. */
function addResponseCall(cache: RequestCacheBuilder, cacheState: { sawMain: boolean }, response: ClaudeResponse, tokens: ResponseTokens): void {
  const outputs = stopReasonSample(response.truncated);
  const call = response.cacheCall;
  if (!call) {
    const noCache = response.noCacheCall;
    if (noCache) cache.addCallWithoutCacheData(noCache.stream, noCache.model, { input: tokens.uncached, outputs });
    return;
  }
  const sample: CacheCallSample = { input: tokens.uncached + tokens.cacheRead + tokens.cacheWrite, cacheRead: tokens.cacheRead, cacheWrite: tokens.cacheWrite };
  cache.addCall(call.stream, call.model, { ...sample, outputs });
  if (call.stream === 'main' && !cacheState.sawMain) {
    cacheState.sawMain = true;
    cache.addColdStart(missTokens(sample), undefined);
  }
}

/** The responses of one request, one record per `message.id`, in the order their first usage appears. A line adds its
 *  stop reason to its response, and its usage to the response's tokens; until the response is a prompt-cache call,
 *  its usage can still make it one, or a call without cache data. */
export class ClaudeResponseAccumulator {
  /** Responses with usage, in the order their first usage appears. */
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
      response = { tokens: null, cacheReported: false, truncated: null };
      if (id) this.byId.set(id, response);
    }
    response.truncated = afterStopReason(response.truncated, message.stop_reason);
    if (!message.usage) return;
    if (!response.tokens) this.responses.push(response);
    this.addUsage(response, message.usage, sidechain ? 'subagent' : 'main', cacheModelName(message.model));
  }

  /** A line's usage: the response keeps the largest value of each field. While the response isn't a prompt-cache
   *  call, cache tokens and a prompt make it one, with this line's stream and model. A prompt without cache fields
   *  makes it a call without cache data until then, with the latest such line's stream and model: usage without cache
   *  fields didn't report cache usage, so it never counts as uncached. */
  private addUsage(response: ClaudeResponse, usage: Record<string, unknown>, stream: CacheStream, model: string): void {
    const line: ResponseTokens = {
      uncached: count(usage, 'input_tokens'),
      cacheRead: count(usage, 'cache_read_input_tokens'),
      cacheWrite: count(usage, 'cache_creation_input_tokens'),
      output: count(usage, 'output_tokens'),
    };
    const seen = response.tokens;
    response.tokens = !seen ? line : {
      uncached: Math.max(seen.uncached, line.uncached),
      cacheRead: Math.max(seen.cacheRead, line.cacheRead),
      cacheWrite: Math.max(seen.cacheWrite, line.cacheWrite),
      output: Math.max(seen.output, line.output),
    };
    const reportsCache = reportsCacheUsage(usage);
    response.cacheReported ||= reportsCache;
    // Once a response is a prompt-cache call, its later lines add only their usage and stop reason.
    if (response.cacheCall) return;
    if (!reportsCache) {
      if (line.uncached > 0) response.noCacheCall = { stream, model };
      return;
    }
    if (line.uncached + line.cacheRead + line.cacheWrite > 0) response.cacheCall = { stream, model };
  }

  /** The request's token totals, its context from the calls on its own chain, and its rows, from the final responses
   *  in the order their first usage appears. `cacheState` spans a transcript's requests: its first main-agent call is
   *  the session's cold start. */
  finish(cacheState: { sawMain: boolean }): ClaudeRequestUsage {
    const usage: ClaudeRequestUsage = { promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheReported: false };
    const context = new TurnContextAccumulator();
    const cache = new RequestCacheBuilder();
    const ownStream: CacheStream = this.requestSidechain ? 'subagent' : 'main';
    for (const response of this.responses) {
      const tokens = response.tokens;
      if (!tokens) continue;
      const prompt = tokens.uncached + tokens.cacheRead + tokens.cacheWrite;
      usage.promptTokens += prompt;
      usage.completionTokens += tokens.output;
      usage.cacheReadTokens += tokens.cacheRead;
      usage.cacheWriteTokens += tokens.cacheWrite;
      usage.cacheReported ||= response.cacheReported;
      // A response with a prompt is a call of one kind or the other, on its line's stream.
      if ((response.cacheCall ?? response.noCacheCall)?.stream === ownStream) context.addCall({ stream: 'main', inputTokens: prompt, maxPromptTokens: null });
      addResponseCall(cache, cacheState, response, tokens);
    }
    // Only calls of the other chain logged usage: the turn's own context is unknown, and its prompt tokens are theirs.
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
