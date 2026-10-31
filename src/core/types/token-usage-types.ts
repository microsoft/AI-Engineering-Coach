/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Per-turn context size and token types beyond input and output: reasoning, compaction overhead,
 * sub-agent tokens, truncated calls and model-call latency. Only numbers, enum values and model
 * names, never prompt content, ids, paths or tool names. */

/** Context of one turn, from the harness's per-call usage: Copilot CLI and Copilot App `session.usage_record`,
 *  Codex `token_count`, and the model calls of Claude Code and OpenCode. Main-agent calls only, except for a
 *  Claude Code sub-agent's own turns, whose context is the sub-agent's. */
export interface TurnContextUsage {
  /** Prompt tokens, including cached tokens, of the turn's last main-agent model call:
   *  the size of the context when the turn ended. */
  lastPromptTokens: number;
  /** Largest main-agent prompt in the turn. Above `lastPromptTokens` when the context was
   *  compacted during the turn. */
  peakPromptTokens: number;
  /** Context limit the harness reported for the turn's last call (Copilot CLI `maxPromptTokens`,
   *  Codex `model_context_window`); `null` when it wasn't reported (Claude Code, OpenCode). */
  contextLimit: number | null;
  /** Main-agent model calls in the turn. 0 when every call of the turn was a sub-agent's (Claude Code), so the
   *  turn's own context is unknown and its other fields are 0. */
  calls: number;
}

/** Where a context-window size comes from: logged by the harness, or estimated from the largest
 *  prompt seen in the session (rounded up). */
export type ContextWindowSource = 'reported' | 'estimated';

/** Built-in sub-agent types that Copilot CLI and Copilot App log. Any other agent is `custom`;
 *  a run whose type can't be told (no start event and no agent name) is `unknown`. Custom agent
 *  names are never stored. */
export const SUBAGENT_TYPES = [
  'explore',
  'task',
  'general-purpose',
  'code-review',
  'security-review',
  'research',
  'rubber-duck',
  'custom',
  'unknown',
] as const;

export type SubagentType = typeof SUBAGENT_TYPES[number];

/** A sub-agent run launched during a turn (`subagent.started` and `subagent.completed`). */
export interface SubagentRun {
  agentType: SubagentType;
  /** Normalized model id; empty when not logged. */
  model: string;
  mode: 'sync' | 'background' | null;
  /** Tokens Copilot reported when the run finished: input, including cached tokens, plus output. */
  totalTokens: number;
  toolCalls: number;
  durationMs: number;
  cancelled: boolean;
}

/* ---- Token Types tab payload ---- */

/** Harness families whose token types are reported the same way. Never pooled with each other. */
export type TokenTypesSource = 'copilot-cli' | 'codex' | 'claude' | 'opencode';

export type TokenTypeKey = 'reasoning' | 'compaction' | 'subagents' | 'truncation' | 'latency';

/** `not-comparable`: the harness logs the value, but its meaning differs by provider. */
export type TokenTypeAvailability = 'reported' | 'not-reported' | 'not-comparable';

export interface ReasoningShare {
  outputTokens: number;
  reasoningTokens: number;
  /** Reasoning as a percent of output tokens (reasoning tokens are part of output). */
  sharePct: number | null;
}

export interface ReasoningByEffort extends ReasoningShare {
  effort: 'max' | 'high' | 'medium' | 'low' | 'unknown';
  stream: 'main' | 'subagent';
  calls: number;
}

export interface TokenTypesReasoning {
  /** `calls` = summed per model call; `session-totals` = from session totals (no effort split). */
  basis: 'calls' | 'session-totals';
  main: ReasoningShare | null;
  subagent: ReasoningShare | null;
  byEffort: ReasoningByEffort[];
}

export interface TokenTypesCompaction {
  count: number;
  /** Started by the harness when the context reached its threshold. */
  automatic: number;
  /** Any other logged trigger, such as a manual `/compact`. */
  manual: number;
  failed: number;
  /** Averages over compactions that logged both sizes. */
  avgTokensBefore: number | null;
  avgTokensAfter: number | null;
  /** Share of the context removed: (before − after) ÷ before, in percent. */
  yieldPct: number | null;
  /** Compactions that logged the tokens of the compaction call itself. */
  withUsage: number;
  /** Tokens the compaction calls used; input includes cached tokens. */
  inputTokens: number;
  outputTokens: number;
  /** Compaction-call input as a percent of main-agent input, over turns that log per-call usage. */
  shareOfMainInputPct: number | null;
  modelTimeMs: number;
}

export interface SubagentTypeSummary {
  agentType: SubagentType;
  runs: number;
  totalTokens: number;
  toolCalls: number;
  durationMs: number;
  cancelled: number;
  background: number;
}

export interface TokenTypesSubagents {
  runs: number;
  totalTokens: number;
  /** Largest token total first. */
  byType: SubagentTypeSummary[];
  /** Sub-agent tokens as a percent of all tokens (main-agent input and output plus sub-agent totals),
   *  over turns that log per-call usage. */
  shareOfAllTokensPct: number | null;
}

export interface TokenTypesTruncation {
  /** Calls that logged why they stopped. */
  calls: number;
  /** Of those, calls that stopped at the output-token limit. */
  truncatedCalls: number;
  /** Calls stopped or changed by the content filter, of the calls that logged it; `null` when none did. */
  filteredCalls: number | null;
}

export interface LatencyByModel {
  model: string;
  calls: number;
  ttftP50Ms: number | null;
  ttftP90Ms: number | null;
  durationP50Ms: number | null;
  durationP90Ms: number | null;
}

/** Token types for one source. A `null` section means the source doesn't report it. */
export interface SourceTokenTypes {
  source: TokenTypesSource;
  /** Display name, e.g. "Copilot App and Copilot CLI". */
  label: string;
  harnesses: string[];
  /** Requests (turns) in range from this source. */
  requests: number;
  reasoning: TokenTypesReasoning | null;
  compaction: TokenTypesCompaction | null;
  subagents: TokenTypesSubagents | null;
  truncation: TokenTypesTruncation | null;
  latency: LatencyByModel[] | null;
}

export interface HarnessTokenTypes {
  harness: string;
  source: TokenTypesSource | null;
  requests: number;
  reports: Record<TokenTypeKey, TokenTypeAvailability>;
}

export interface TokenTypesData {
  /** Sources with any token-type data, most requests first. */
  sources: SourceTokenTypes[];
  /** Every harness with requests in range and what it reports. */
  harnesses: HarnessTokenTypes[];
  tips: string[];
  coverage: { requests: number; requestsWithData: number };
}

/** Token types of one session, for the strip in Context Management's session drill-down. A `null` field
 *  means the harness doesn't log it. */
export interface SessionTokenTypes {
  /** Main-agent reasoning as a percent of main-agent output. */
  reasoningPct: number | null;
  /** Main-agent reasoning effort with the most calls. */
  effort: ReasoningByEffort['effort'] | null;
  subagentRuns: number;
  subagentTokens: number;
  /** Runs per sub-agent type, most runs first (at most 4). */
  subagentTypes: { agentType: SubagentType; runs: number }[];
  /** Compactions that logged the compaction call's own tokens, and those tokens (input + output). */
  compactionCalls: number;
  compactionTokens: number;
  compactionTimeMs: number;
  /** Calls that stopped at the output-token limit, of `calls`: the calls that logged why they stopped. */
  truncatedCalls: number | null;
  calls: number | null;
  /** Median time to first token of the main agent's calls. */
  ttftMedianMs: number | null;
}
