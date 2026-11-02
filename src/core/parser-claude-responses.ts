/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* The API responses of one Claude Code request. Claude Code writes one transcript line per content block
 * (thinking, text, each tool use), repeats the response's `usage` on each, and logs why the response stopped on
 * some of them only. The lines of one `message.id` build one record, which counts once: as a prompt-cache call, or
 * as a call without cache data when none of its lines reports cache usage for a prompt. Once every line of the
 * request is read, each call goes on the request's rows with the stop reason any of its lines logged. */

import type { CacheStream, CallRow, RequestPromptCache } from './types';
import { RequestCacheBuilder, cacheModelName, missTokens, type CacheCallSample } from './prompt-cache-usage';
import { stopReasonSample } from './call-outputs';

/** The fields of an assistant line's `message` read here. Logs are untrusted, so each is checked before use. */
export interface ClaudeResponseMessage {
  id?: unknown;
  model?: unknown;
  usage?: Record<string, unknown>;
  stop_reason?: unknown;
}

/** What the responses of a request add to it. */
export interface ClaudeRequestUsage {
  promptCache?: RequestPromptCache;
  callRowsWithoutCacheData?: CallRow[];
}

/** A response's call: the stream, model and prompt tokens of the line that counts it. */
interface ResponseCall {
  stream: CacheStream;
  model: string;
  input: number;
}

/** One API response: the lines of one `message.id`, or a single line without an id. */
interface ClaudeResponse {
  /** `false` for a line without an id: a whole response, complete when the line is read. */
  hasId: boolean;
  /** Its prompt-cache call, from the first of its lines that reported cache tokens for a prompt. Later lines don't
   *  change it. */
  cacheCall?: ResponseCall & { cacheRead: number; cacheWrite: number };
  /** Its call without cache data, unless it gets a prompt-cache call: from the latest of its lines that reported a
   *  prompt without cache fields. */
  noCacheCall?: ResponseCall;
  /** Stopped at the output-token limit: `true` once one of its lines logs `max_tokens`, `false` once one logs
   *  another reason, `null` while none logs a reason. */
  truncated: boolean | null;
}

function count(usage: Record<string, unknown>, key: string): number {
  const value = usage[key];
  return typeof value === 'number' ? value : 0;
}

/** The usage block reports cache tokens, even zero ones. Without them the request's cache fields stay null. */
export function reportsCacheUsage(usage: Record<string, unknown> | undefined): boolean {
  return typeof usage?.cache_read_input_tokens === 'number' || typeof usage?.cache_creation_input_tokens === 'number';
}

/** A response's truncation after one of its lines logged `stopReason`. */
function afterStopReason(truncated: boolean | null, stopReason: unknown): boolean | null {
  if (typeof stopReason !== 'string' || !stopReason) return truncated;
  return truncated === true || stopReason === 'max_tokens';
}

/** A response's call on the request's rows, with its final stop reason: with its cache sums when one of its lines
 *  reported them for a prompt, else without cache data. The transcript's first main-agent call with cache sums is
 *  the session's cold start. */
function addResponseCall(cache: RequestCacheBuilder, cacheState: { sawMain: boolean }, response: ClaudeResponse): void {
  const outputs = stopReasonSample(response.truncated);
  const call = response.cacheCall;
  if (!call) {
    const noCache = response.noCacheCall;
    if (noCache) cache.addCallWithoutCacheData(noCache.stream, noCache.model, { input: noCache.input, outputs });
    return;
  }
  const sample: CacheCallSample = { input: call.input, cacheRead: call.cacheRead, cacheWrite: call.cacheWrite };
  cache.addCall(call.stream, call.model, { ...sample, outputs });
  if (call.stream === 'main' && !cacheState.sawMain) {
    cacheState.sawMain = true;
    cache.addColdStart(missTokens(sample), undefined);
  }
}

/** The responses of one request, one record per `message.id`. A line adds its stop reason to its response; until the
 *  response is a prompt-cache call, its usage can still make it one, or a call without cache data. */
export class ClaudeResponseAccumulator {
  /** Prompt-cache calls, in the order their responses became ones. */
  private readonly responses: ClaudeResponse[] = [];
  /** Responses that reported a prompt without cache fields, in the order they first did. */
  private readonly withoutCacheData: ClaudeResponse[] = [];
  private readonly byId = new Map<string, ClaudeResponse>();

  /** Add an assistant line: its `message`, and whether the line is a sub-agent's (sidechain). */
  add(message: ClaudeResponseMessage | undefined, sidechain: boolean): void {
    const id = typeof message?.id === 'string' ? message.id : '';
    // A line without an id is a response of its own, which counts only with usage.
    if (!message || (!id && !message.usage)) return;
    let response = id ? this.byId.get(id) : undefined;
    if (!response) {
      response = { hasId: id !== '', truncated: null };
      if (id) this.byId.set(id, response);
    }
    response.truncated = afterStopReason(response.truncated, message.stop_reason);
    // Once a response is a prompt-cache call, its later lines add only their stop reason.
    if (!message.usage || response.cacheCall) return;
    this.addUsage(response, message.usage, sidechain ? 'subagent' : 'main', cacheModelName(message.model));
  }

  /** A line's usage, while its response isn't a prompt-cache call. Cache tokens and a prompt make it one, with this
   *  line's stream, model and tokens. A prompt without cache fields makes it a call without cache data until then,
   *  the latest such line counting: usage without cache fields didn't report cache usage, so it never counts as
   *  uncached. */
  private addUsage(response: ClaudeResponse, usage: Record<string, unknown>, stream: CacheStream, model: string): void {
    if (!reportsCacheUsage(usage)) {
      const input = count(usage, 'input_tokens');
      if (input <= 0) return;
      if (!response.noCacheCall) this.withoutCacheData.push(response);
      response.noCacheCall = { stream, model, input };
      return;
    }
    const cacheRead = count(usage, 'cache_read_input_tokens');
    const cacheWrite = count(usage, 'cache_creation_input_tokens');
    const input = count(usage, 'input_tokens') + cacheRead + cacheWrite;
    if (input <= 0) return;
    response.cacheCall = { stream, model, input, cacheRead, cacheWrite };
    this.responses.push(response);
  }

  /** The request's rows, from the final responses: its prompt-cache calls in the order they became ones, then its
   *  calls without cache data, lines without an id first, as each is complete when read. `cacheState` spans a
   *  transcript's requests: its first main-agent call is the session's cold start. */
  finish(cacheState: { sawMain: boolean }): ClaudeRequestUsage {
    const cache = new RequestCacheBuilder();
    for (const response of this.responses) addResponseCall(cache, cacheState, response);
    const withoutCacheData = this.withoutCacheData.filter(response => !response.cacheCall);
    for (const response of withoutCacheData) if (!response.hasId) addResponseCall(cache, cacheState, response);
    for (const response of withoutCacheData) if (response.hasId) addResponseCall(cache, cacheState, response);
    const promptCache = cache.take();
    const callRowsWithoutCacheData = cache.takeRowsWithoutCacheData();
    return {
      ...(promptCache ? { promptCache } : {}),
      ...(callRowsWithoutCacheData ? { callRowsWithoutCacheData } : {}),
    };
  }
}
