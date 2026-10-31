/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Prompt-cache types: cache usage recorded per request by the parsers, Copilot CLI and Copilot App
 * cache breaks, and the Prompt Cache tab payloads. Only token counts, model names, enum values and
 * harness-defined system-prompt segment names are kept, never prompt text, hashes or tool names. */

/* ---- Recorded by the parsers ---- */

/** Which model calls a row covers: the main agent, sub-agents, or compaction summaries. */
export type CacheStream = 'main' | 'subagent' | 'compaction';

/** Sums over the model calls a request made on one stream with one model. Neutral: prompt-cache fields
 *  today; other per-call sums can be added. */
export interface ModelCallRow {
  stream: CacheStream;
  model: string;
  calls: number;
  /** Reasoning effort logged for these calls (an attribute, not part of the row key). */
  reasoningEffort?: string;
  /** Prompt tokens, including tokens read from and written to the cache. */
  input: number;
  cacheRead: number;
  cacheWrite: number;
  /** Input cost of the calls that logged prices, in the harness's price unit (Copilot: nano-AIU, one unit for
   *  every model, so costs add up across models): Σ (uncached + cacheRead × read rate + cacheWrite × write
   *  rate) × input price. Only percentages are shown. */
  cost?: number;
  /** The part of `cost` spent on tokens not read from the cache (uncached and written tokens). */
  missCost?: number;
  /** What the same prompts would have cost uncached: Σ prompt tokens × input price. */
  baselineCost?: number;
  /** Prompt tokens of the calls that logged prices (the base of the rated share). */
  ratedInput?: number;
  /** Cache lifetime the harness logged for these calls, in seconds. */
  ttlSeconds?: number;
  /** Main-agent cache breaks on these calls (Copilot CLI and Copilot App), including breaks beyond the
   *  per-session cap on listed `CacheBreak`s. Break counts and rates come from here, so they follow the
   *  date filter. */
  cacheBreaks?: number;
  /* Token types (see call-outputs.ts). Each is absent when the harness doesn't log it per call. */
  /** Output tokens, including reasoning (Copilot CLI and Copilot App). */
  outputTokens?: number;
  /** Reasoning tokens, part of `outputTokens` (Copilot CLI and Copilot App). */
  reasoningTokens?: number;
  /** Calls that stopped at the output-token limit (Copilot CLI and Copilot App, Claude Code, OpenCode). */
  truncatedCalls?: number;
  /** Calls the content filter stopped or changed (Copilot CLI and Copilot App). */
  filteredCalls?: number;
  /** Time to first token of these calls, in ms (at most `MAX_LATENCY_SAMPLES`, evenly thinned). */
  ttftMs?: number[];
  /** Duration of these calls, in ms (at most `MAX_LATENCY_SAMPLES`, evenly thinned). */
  durationMs?: number[];
}

/** Prompt-cache usage of one request (a Copilot CLI turn, a Claude Code or an OpenCode request). */
export interface RequestPromptCache {
  /** One row per stream and model, main agent first. */
  rows: ModelCallRow[];
  /** Main-agent prompt tokens not read from the cache on the session's first model call. */
  coldStart?: number;
  /** In the price unit of `ModelCallRow.cost`, like `rebuiltCost`. */
  coldStartCost?: number;
  /** Main-agent prompt tokens rebuilt after cache breaks (Copilot CLI and Copilot App). */
  rebuilt?: number;
  rebuiltCost?: number;
  /** Main-agent calls you started after an earlier call, and how many started after its cache had expired. */
  returns?: number;
  expiredReturns?: number;
}

/** Why the prompt cache broke, as logged by Copilot CLI and Copilot App. */
export type CacheBreakCause =
  | 'compaction'
  | 'model-switch'
  | 'ttl-expired'
  | 'reasoning-effort'
  | 'tools-changed'
  | 'system-prompt'
  | 'mode-change'
  | 'resume';

/** `logged`: a per-call field or event shows the cause. `checkpoint`: a change between two usage
 *  checkpoints shows it, so it happened somewhere in that window. `unattributed`: nothing was logged. */
export type CacheBreakConfidence = 'logged' | 'checkpoint' | 'unattributed';

/** A main-agent call that couldn't reuse most of the previous call's cached prompt. */
export interface CacheBreak {
  /** Index of the request (turn) the call belongs to. */
  requestIndex: number;
  /** Index of the call among the session's main-agent calls (see `Session.callTimeline`). */
  callIndex: number;
  /** When the call was logged, which is when it finished (epoch ms). */
  timestamp: number | null;
  model: string;
  /** Primary cause first; empty when no cause was logged. */
  causes: CacheBreakCause[];
  /** Causes known only from a usage-checkpoint window. */
  inferred?: CacheBreakCause[];
  confidence: CacheBreakConfidence;
  /** Prompt tokens the previous call had cached that this call had to send again. */
  rebuiltTokens: number;
  rebuiltCost?: number;
  /** Time since the cache was last refreshed: this call's start minus the previous main-agent call's start,
   *  since a call refreshes the cache when it starts and the lifetime counts from there. Longer than
   *  `ttlSeconds` exactly when the cache had expired. */
  idleSeconds: number | null;
  /** Cache lifetime logged for the previous call. */
  ttlSeconds: number | null;
  /** Who made the call: `user` = a prompt you sent, `agent` = the agent continuing on its own. */
  initiator: 'user' | 'agent' | null;
  /** The model was switched by automatic model selection. */
  autoModel?: boolean;
  /** System-prompt segments whose content changed (names only). */
  segments?: string[];
  compactionTrigger?: 'auto' | 'manual';
}

/** Session-level prompt-cache data (Copilot CLI and Copilot App). */
export interface SessionPromptCache {
  /** The session's first breaks, up to a cap; every break is counted in `ModelCallRow.cacheBreaks`. */
  breaks: CacheBreak[];
  /** Breaks beyond the per-session cap: counted on the request rows but not listed. */
  omittedBreaks?: number;
}

/* ---- Prompt Cache tab ---- */

/** `per-call`: the harness logs cache tokens for every model call. `per-session`: only session totals. */
export type CacheReporting = 'per-call' | 'per-session' | 'none';

export interface CacheTotals {
  /** Model calls; 0 when the harness reports session totals only. */
  calls: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  uncached: number;
  /** Percent of prompt tokens read from the cache; `null` without prompt tokens. */
  hitPct: number | null;
  writePct: number | null;
  uncachedPct: number | null;
}

/** Cost effect of caching, from per-call prices the harness logged. Percentages only, never amounts. */
export interface CacheCost {
  /** How much caching cut input cost, in percent: 1 − cost ÷ what the same prompts would have cost uncached,
   *  both summed in the logged price unit, so pricier models weigh more. */
  savedPct: number;
  /** Percent of input cost spent on tokens not read from the cache. */
  missCostPct: number;
  /** Percent of prompt tokens whose calls logged rates. */
  ratedPct: number;
}

export interface HarnessPromptCache {
  harness: string;
  reporting: CacheReporting;
  /** Cache breaks are detected and attributed for this harness (Copilot CLI and Copilot App). */
  attribution: boolean;
  /** `null` when no request in range carries cache data. */
  all: CacheTotals | null;
  main: CacheTotals | null;
  subagents: CacheTotals | null;
  compaction: CacheTotals | null;
  cost: CacheCost | null;
  breaks: number | null;
  breaksPer100: number | null;
  totalRequests: number;
  requestsWithData: number;
  sessions: number;
  sessionsWithData: number;
}

/** A cause row in the tab. TTL expiry is split by who made the call after the idle time, a model switch by
 *  whether automatic model selection made it, and a system-prompt change by whether your instructions or
 *  memory changed. */
export type CacheCauseKey =
  | 'ttl-user'
  | 'ttl-agent'
  | 'resume'
  | 'model-switch'
  | 'model-auto'
  | 'reasoning-effort'
  | 'tools-changed'
  | 'instructions-changed'
  | 'system-prompt'
  | 'compaction'
  | 'mode-change'
  | 'unattributed';

/** Who can change a cause: you, partly you, the harness, or unknown. */
export type CacheControl = 'you' | 'partly' | 'harness' | 'unknown';

export interface CacheCauseSummary {
  key: CacheCauseKey;
  control: CacheControl;
  breaks: number;
  rebuiltTokens: number;
  /** Percent of all rebuilt tokens in range. */
  pctOfRebuilt: number;
  /** Percent of input cost, when rates were logged. */
  costPct: number | null;
  /** Breaks whose primary cause was logged, or seen in a checkpoint window. */
  logged: number;
  checkpoint: number;
  /** Changed system-prompt segments, most frequent first. */
  segments: { name: string; breaks: number }[];
  /** Other causes logged on the same breaks. */
  alsoSeen: { cause: CacheBreakCause; breaks: number }[];
}

/** Where tokens that weren't read from the cache came from. */
export type CacheMissOrigin = 'growth' | 'cold-start' | 'rebuilt' | 'subagents' | 'compaction';

export interface CacheOriginSlice {
  origin: CacheMissOrigin;
  tokens: number;
  /** Percent of all cache misses. */
  pct: number;
  /** Percent of input cost, when rates were logged. */
  costPct: number | null;
}

export interface CacheIdleBucket {
  /** Time since the cache was last refreshed, in multiples of the cache lifetime, e.g. "2–6×". */
  label: string;
  user: number;
  agent: number;
}

export interface CacheIdleSummary {
  /** Logged cache lifetime per model, most main-agent calls first. */
  ttlByModel: { model: string; ttlSeconds: number; calls: number }[];
  /** Main-agent calls you started after an earlier call, and how many started after its cache expired. */
  returns: number;
  expiredReturns: number;
  /** Cache-expiry breaks by the time since the cache was last refreshed (see `CacheBreak.idleSeconds`). */
  buckets: CacheIdleBucket[];
  /** Median time since the cache was last refreshed, over cache-expiry breaks. */
  medianIdleMinutes: number | null;
}

/** Break attribution for the harnesses that log it (Copilot CLI and Copilot App, shown together). */
export interface CacheAttribution {
  /** Display name, e.g. "Copilot App" or "Copilot App and Copilot CLI". */
  label: string;
  harnesses: string[];
  mainCalls: number;
  /** Every break in range, from the request rows (`ModelCallRow.cacheBreaks`). */
  breaks: number;
  breaksPer100: number;
  /** Breaks in range that aren't listed because their session reached the cap (`breaks` − listed): their
   *  tokens and counts are included, their causes aren't. */
  omittedBreaks: number;
  rebuiltTokens: number;
  causes: CacheCauseSummary[];
  confidence: Record<CacheBreakConfidence, number>;
  /** Percent of rebuilt tokens by who can change the cause. */
  controlPct: Record<CacheControl, number>;
  /** Total prompt tokens not read from the cache, across main agent, sub-agents and compaction. */
  misses: number;
  origins: CacheOriginSlice[];
  idle: CacheIdleSummary;
}

export interface ModelPromptCache {
  harness: string;
  model: string;
  calls: number;
  hitPct: number | null;
  writePct: number | null;
  /** Breaks per 100 main-agent calls with this model; `null` when not attributed. */
  breaksPer100: number | null;
  ttlSeconds: number | null;
}

/** One workspace and harness; a workspace used from two harnesses gets two rows. */
export interface WorkspacePromptCache {
  workspaceId: string;
  workspaceName: string;
  harness: string;
  sessions: number;
  calls: number;
  hitPct: number | null;
  breaks: number | null;
  rebuiltTokens: number | null;
  misses: number;
  topCause: CacheCauseKey | null;
}

export interface PromptCacheTrendSeries {
  harness: string;
  hitPct: (number | null)[];
  breaksPer100: (number | null)[];
  calls: number[];
}

export interface PromptCacheTrend {
  /** ISO dates of the Monday of each week. */
  labels: string[];
  series: PromptCacheTrendSeries[];
}

export interface CacheBreakDetail extends CacheBreak {
  key: CacheCauseKey;
  control: CacheControl;
}

/** The prompt-cache layer of a session timeline: whole-session totals per stream and the breaks. */
export interface SessionCacheLayer {
  reporting: CacheReporting;
  main: CacheTotals | null;
  subagents: CacheTotals | null;
  compaction: CacheTotals | null;
  breaks: CacheBreakDetail[];
  omittedBreaks: number;
}

/** A session row in the tab. Covers the whole session; open it to fetch its timeline (`getSessionTimeline`). */
export interface CacheSessionSummary {
  sessionId: string;
  date: string;
  workspaceName: string;
  harness: string;
  calls: number;
  hitPct: number | null;
  breaks: number | null;
  rebuiltTokens: number | null;
  misses: number;
  topCause: CacheCauseKey | null;
  /** Tokens not read from the cache, over at most 24 equal slices of the session, for a sparkline. */
  sparkline: number[];
}

export interface PromptCacheData {
  /** One row per harness with requests in range, including harnesses that don't report cache. */
  harnesses: HarnessPromptCache[];
  attribution: CacheAttribution | null;
  models: ModelPromptCache[];
  workspaces: WorkspacePromptCache[];
  trend: PromptCacheTrend;
  /** Sessions with activity in range that rebuilt the most (or missed the most when not attributed). */
  topSessions: CacheSessionSummary[];
  tips: string[];
  coverage: {
    requestsWithData: number;
    totalRequests: number;
    sessionsWithData: number;
    totalSessions: number;
  };
}

export interface PromptCacheSessionsData {
  workspaceName: string;
  harness: string | null;
  /** Most recent first. */
  sessions: CacheSessionSummary[];
  /** Sessions with cache data, before the list was capped. */
  total: number;
}
