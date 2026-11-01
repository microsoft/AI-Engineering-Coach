/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Per-request prompt-cache accumulation shared by the parsers (Copilot CLI and Copilot App, Claude Code,
 * OpenCode). Only token counts, model names and cost ratios pass through here. */

import type { CacheStream, CallRow, ModelCallRow, RequestPromptCache } from './types';
import { normalizeModel } from './helpers';
import { addRowOutputs, addStopReason, finishRowOutputs, type CallOutputSample } from './call-outputs';

/** Prices a harness logged for one call: the input price per token, in the harness's price unit (one unit for
 *  every model, so costs add up across models with different prices), and the cache read and cache write
 *  prices as multiples of it. */
export interface RelativeRates {
  inputPrice: number;
  cacheRead: number;
  cacheWrite: number;
}

/** What one model call adds to its row, whether or not it reported its cache usage. `input` includes any tokens
 *  read from and written to the cache. */
export interface CallSample {
  input: number;
  reasoningEffort?: string | null;
  /** Output-side fields (token types); absent when the harness logs none of them per call. */
  outputs?: CallOutputSample;
}

/** Token counts of one model call that reported its cache usage. */
export interface CacheCallSample extends CallSample {
  cacheRead: number;
  cacheWrite: number;
  rates?: RelativeRates | null;
  ttlSeconds?: number | null;
}

const STREAM_ORDER: readonly CacheStream[] = ['main', 'subagent', 'compaction'];
const MAX_ROWS = 12;
const MODEL_NAME_RE = /^[\w.:/@+ -]{1,64}$/;

/** A display-safe model name: normalized like the rest of the dashboard, else `unknown`. */
export function cacheModelName(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) return 'unknown';
  const name = normalizeModel(raw);
  return MODEL_NAME_RE.test(name) ? name : 'unknown';
}

export function uncachedTokens(sample: CacheCallSample): number {
  return Math.max(0, sample.input - sample.cacheRead - sample.cacheWrite);
}

/** Prompt tokens not read from the cache: written to it or sent uncached. */
export function missTokens(sample: CacheCallSample): number {
  return Math.max(0, sample.input - sample.cacheRead);
}

/** Input cost of a call in the harness's price unit: what it cost, the part spent on tokens not read from the
 *  cache, and what the same prompt would have cost uncached. `null` without logged rates. */
export function callCost(sample: CacheCallSample): { cost: number; missCost: number; baseline: number } | null {
  const rates = sample.rates;
  if (!rates) return null;
  const missCost = rates.inputPrice * (uncachedTokens(sample) + sample.cacheWrite * rates.cacheWrite);
  return {
    cost: missCost + rates.inputPrice * sample.cacheRead * rates.cacheRead,
    missCost,
    baseline: rates.inputPrice * sample.input,
  };
}

/** Cache hit ratio in percent (Σ cacheRead ÷ Σ input, token-weighted) over the rows of one stream,
 *  main agent by default; `null` without prompt tokens. Shared by every view that shows a hit ratio. */
export function cacheHitPct(rows: Iterable<ModelCallRow>, stream: CacheStream = 'main'): number | null {
  let input = 0;
  let read = 0;
  for (const row of rows) {
    if (row.stream !== stream) continue;
    input += row.input;
    read += row.cacheRead;
  }
  return input > 0 ? Math.round((read / input) * 1000) / 10 : null;
}

/** The request logged cache usage. A request whose calls didn't report their cache has no rows, but it can still
 *  carry the returns it counted. */
export function hasCacheRows(cache: RequestPromptCache | undefined): boolean {
  return (cache?.rows.length ?? 0) > 0;
}

function emptyRow(stream: CacheStream, model: string): ModelCallRow {
  return { stream, model, calls: 0, input: 0, cacheRead: 0, cacheWrite: 0 };
}

function emptyCallRow(stream: CacheStream, model: string): CallRow {
  return { stream, model, calls: 0, input: 0 };
}

/** The row of a stream and model in `rows`, created on first use; past `MAX_ROWS`, new models share an `other` row. */
function rowOf<R extends CallRow>(rows: Map<string, R>, stream: CacheStream, model: string, create: (stream: CacheStream, model: string) => R): R {
  let key = `${stream}\u0000${model}`;
  let row = rows.get(key);
  if (!row && rows.size >= MAX_ROWS) {
    key = `${stream}\u0000other`;
    row = rows.get(key);
  }
  if (!row) {
    row = create(stream, rows.size >= MAX_ROWS ? 'other' : model);
    rows.set(key, row);
  }
  return row;
}

/** The fields every call adds after its counts: its reasoning effort and its token types. */
function addCallFields(row: CallRow, sample: CallSample): void {
  if (sample.reasoningEffort) row.reasoningEffort = sample.reasoningEffort.slice(0, 16);
  if (sample.outputs) addRowOutputs(row, sample.outputs, sample.reasoningEffort);
}

function addSample(row: ModelCallRow, sample: CacheCallSample): void {
  row.calls++;
  row.input += sample.input;
  row.cacheRead += sample.cacheRead;
  row.cacheWrite += sample.cacheWrite;
  const cost = callCost(sample);
  if (cost) {
    row.cost = (row.cost ?? 0) + cost.cost;
    row.missCost = (row.missCost ?? 0) + cost.missCost;
    row.baselineCost = (row.baselineCost ?? 0) + cost.baseline;
    row.ratedInput = (row.ratedInput ?? 0) + sample.input;
  }
  if (sample.ttlSeconds != null && sample.ttlSeconds > 0) row.ttlSeconds = sample.ttlSeconds;
  addCallFields(row, sample);
}

function sortRows<R extends CallRow>(rows: Iterable<R>): R[] {
  return [...rows].sort((a, b) => STREAM_ORDER.indexOf(a.stream) - STREAM_ORDER.indexOf(b.stream) || b.input - a.input);
}

function roundRow(row: ModelCallRow): ModelCallRow {
  const out: ModelCallRow = { ...row };
  if (out.baselineCost != null) out.baselineCost = Math.round(out.baselineCost);
  if (out.cost != null) out.cost = Math.round(out.cost);
  if (out.missCost != null) out.missCost = Math.round(out.missCost);
  finishRowOutputs(out);
  return out;
}

function finishCallRow(row: CallRow): CallRow {
  const out: CallRow = { ...row };
  finishRowOutputs(out);
  return out;
}

/** Accumulates one request's model calls: rows with cache sums for the calls that reported their cache usage and the
 *  request's cache counts (`take()`), and rows without cache data for the other calls (`takeRowsWithoutCacheData()`).
 *  Take both when the request ends. */
export class RequestCacheBuilder {
  private rows = new Map<string, ModelCallRow>();
  private rowsWithoutCacheData = new Map<string, CallRow>();
  private extra: Omit<RequestPromptCache, 'rows'> = {};

  private row(stream: CacheStream, model: string): ModelCallRow {
    return rowOf(this.rows, stream, model, emptyRow);
  }

  addCall(stream: CacheStream, model: string, sample: CacheCallSample): void {
    addSample(this.row(stream, model), sample);
  }

  /** A model call that didn't report its cache usage. Its token types count, on a row without cache fields, so the
   *  call never counts as uncached. */
  addCallWithoutCacheData(stream: CacheStream, model: string, sample: CallSample): void {
    const row = rowOf(this.rowsWithoutCacheData, stream, model, emptyCallRow);
    row.calls++;
    row.input += sample.input;
    addCallFields(row, sample);
  }

  /** A main-agent cache break on a call already passed to `addCall`. Counted even when the session's list of
   *  breaks is full. */
  addBreak(model: string): void {
    const row = this.row('main', model);
    row.cacheBreaks = (row.cacheBreaks ?? 0) + 1;
  }

  /** A call already passed to `addCall` turned out to stop at the output-token limit. For harnesses that log
   *  why a response stopped on a later line than its usage (Claude Code). */
  addTruncated(stream: CacheStream, model: string): void {
    const row = this.row(stream, model);
    row.truncatedCalls = (row.truncatedCalls ?? 0) + 1;
  }

  /** A call already passed to `addCall` without a stop reason logged one on a later line (Claude Code). */
  addStopReason(stream: CacheStream, model: string, truncated: boolean): void {
    addStopReason(this.row(stream, model), truncated);
  }

  addColdStart(tokens: number, cost: number | undefined): void {
    this.extra.coldStart = (this.extra.coldStart ?? 0) + tokens;
    if (cost != null) this.extra.coldStartCost = (this.extra.coldStartCost ?? 0) + cost;
  }

  addRebuilt(tokens: number, cost: number | undefined): void {
    this.extra.rebuilt = (this.extra.rebuilt ?? 0) + tokens;
    if (cost != null) this.extra.rebuiltCost = (this.extra.rebuiltCost ?? 0) + cost;
  }

  /** A main-agent call you started after an earlier one. `expired` is `null` when the earlier call didn't log
   *  when its cache expires: such a return is counted apart, never as one before expiry. */
  addReturn(expired: boolean | null): void {
    if (expired == null) {
      this.extra.unmeasuredReturns = (this.extra.unmeasuredReturns ?? 0) + 1;
      return;
    }
    this.extra.returns = (this.extra.returns ?? 0) + 1;
    if (expired) this.extra.expiredReturns = (this.extra.expiredReturns ?? 0) + 1;
  }

  /** The request's cache usage; the builder then starts the next request. `undefined` when the request has neither
   *  rows nor counts: one whose calls didn't report their cache keeps the returns it counted, with no rows. */
  take(): RequestPromptCache | undefined {
    const rows = sortRows(this.rows.values()).map(roundRow);
    const extra = this.extra;
    this.rows = new Map();
    this.extra = {};
    if (rows.length === 0 && Object.keys(extra).length === 0) return undefined;
    const out: RequestPromptCache = { rows };
    for (const [key, value] of Object.entries(extra) as [keyof typeof extra, number][]) {
      if (value != null) out[key] = Math.round(value);
    }
    return out;
  }

  /** The rows of the request's calls that didn't report their cache usage (`SessionRequest.callRowsWithoutCacheData`),
   *  and starts the next request's. `undefined` when every call reported it. */
  takeRowsWithoutCacheData(): CallRow[] | undefined {
    const rows = sortRows(this.rowsWithoutCacheData.values()).map(finishCallRow);
    this.rowsWithoutCacheData = new Map();
    return rows.length > 0 ? rows : undefined;
  }
}
