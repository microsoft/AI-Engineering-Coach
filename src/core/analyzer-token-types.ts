/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Token types beyond input and output, for the Token Types tab: reasoning share, compaction
 * overhead, sub-agent tokens, truncated calls and model-call latency. Each source is summarized on
 * its own and never pooled with another, and a harness that doesn't log a type gets "not reported"
 * instead of a zero. Counts the requests sent in the date range, like Context Composition. Row-based
 * figures (reasoning, truncation, latency) come from token-types-rows.ts. */

import type {
  CompactionEvent,
  DateFilter,
  HarnessTokenTypes,
  Session,
  SessionRequest,
  SessionTokenTypes,
  SourceTokenTypes,
  SubagentRun,
  SubagentTypeSummary,
  TokenTypeAvailability,
  TokenTypeKey,
  TokenTypesCompaction,
  TokenTypesData,
  TokenTypesReasoning,
  TokenTypesSource,
  TokenTypesSubagents,
  TokenTypesTruncation,
} from './types';
import { AnalyzerBase } from './analyzer-base';
import { requestCompactions } from './context-window';
import { compactionKind } from './cli-compaction';
import {
  callRows,
  hasPerCallOutputs,
  mainTokens,
  pct,
  percentile,
  reasoningShare,
  rowLatency,
  rowReasoning,
  rowTruncation,
} from './token-types-rows';

const SOURCE_ORDER: readonly TokenTypesSource[] = ['copilot-cli', 'codex', 'claude', 'opencode'];

/** What each source logs. Copilot CLI/App logs every type; the other harnesses log a subset. */
const AVAILABILITY: Record<TokenTypesSource, Record<TokenTypeKey, TokenTypeAvailability>> = {
  'copilot-cli': { reasoning: 'reported', compaction: 'reported', subagents: 'reported', truncation: 'reported', latency: 'reported' },
  codex: { reasoning: 'reported', compaction: 'not-reported', subagents: 'not-reported', truncation: 'not-reported', latency: 'not-reported' },
  claude: { reasoning: 'not-reported', compaction: 'not-reported', subagents: 'not-reported', truncation: 'reported', latency: 'not-reported' },
  opencode: { reasoning: 'not-comparable', compaction: 'not-reported', subagents: 'not-reported', truncation: 'reported', latency: 'not-reported' },
};

const NOT_REPORTED: Record<TokenTypeKey, TokenTypeAvailability> = {
  reasoning: 'not-reported', compaction: 'not-reported', subagents: 'not-reported', truncation: 'not-reported', latency: 'not-reported',
};

/** Tips need enough data to be worth acting on. */
const TIP_MIN_COMPACTIONS = 3;
const TIP_MIN_SUBAGENT_RUNS = 5;
const TIP_REASONING_SHARE = 50;
const TIP_MIN_TRUNCATED = 5;
const TIP_TRUNCATED_PCT = 1;
/** Sub-agent types listed in the session strip. */
const MAX_STRIP_TYPES = 4;

/** The token-types source of a harness, judged by its name. */
export function tokenTypesSource(harness: string): TokenTypesSource | null {
  if (harness === 'GitHub Copilot CLI' || harness === 'GitHub Copilot App') return 'copilot-cli';
  if (harness.startsWith('Codex')) return 'codex';
  if (harness.startsWith('Claude')) return 'claude';
  if (harness === 'OpenCode') return 'opencode';
  return null;
}

function sourceLabel(source: TokenTypesSource, harnesses: string[]): string {
  if (source === 'copilot-cli') {
    const names = harnesses.map(h => h.replace(/^GitHub /, '')).sort();
    return names.length > 0 ? names.join(' and ') : 'Copilot CLI';
  }
  return source === 'codex' ? 'Codex' : source === 'claude' ? 'Claude Code' : 'OpenCode';
}

function summarizeCompactions(events: CompactionEvent[]): TokenTypesCompaction | null {
  if (events.length === 0) return null;
  let automatic = 0, manual = 0, failed = 0, sized = 0, before = 0, after = 0;
  let withUsage = 0, inputTokens = 0, outputTokens = 0, modelTimeMs = 0;
  for (const event of events) {
    const kind = compactionKind(event.trigger);
    if (kind === 'automatic') automatic++;
    else if (kind) manual++;
    if (event.outcome === 'failed') failed++;
    if (event.contextLengthAfter != null && event.contextLengthBefore > 0) {
      sized++;
      before += event.contextLengthBefore;
      after += event.contextLengthAfter;
    }
    if (event.tokensUsed) {
      withUsage++;
      inputTokens += event.tokensUsed.input;
      outputTokens += event.tokensUsed.output;
    }
    modelTimeMs += event.durationMs;
  }
  return {
    count: events.length,
    automatic,
    manual,
    failed,
    avgTokensBefore: sized > 0 ? Math.round(before / sized) : null,
    avgTokensAfter: sized > 0 ? Math.round(after / sized) : null,
    yieldPct: pct(before - after, before),
    withUsage,
    inputTokens,
    outputTokens,
    shareOfMainInputPct: null,
    modelTimeMs,
  };
}

function summarizeSubagents(runs: SubagentRun[]): TokenTypesSubagents | null {
  if (runs.length === 0) return null;
  const byType = new Map<SubagentRun['agentType'], SubagentTypeSummary>();
  let totalTokens = 0;
  for (const run of runs) {
    totalTokens += run.totalTokens;
    const summary = byType.get(run.agentType)
      ?? { agentType: run.agentType, runs: 0, totalTokens: 0, toolCalls: 0, durationMs: 0, cancelled: 0, background: 0 };
    summary.runs++;
    summary.totalTokens += run.totalTokens;
    summary.toolCalls += run.toolCalls;
    summary.durationMs += run.durationMs;
    if (run.cancelled) summary.cancelled++;
    if (run.mode === 'background') summary.background++;
    byType.set(run.agentType, summary);
  }
  return {
    runs: runs.length,
    totalTokens,
    byType: [...byType.values()].sort((a, b) => b.totalTokens - a.totalTokens || b.runs - a.runs),
    shareOfAllTokensPct: null,
  };
}

/** Codex logs reasoning only as a session total, so it covers sessions with a request in range. */
function summarizeSessionReasoning(sessions: Iterable<Session>): TokenTypesReasoning | null {
  let output = 0, reasoning = 0, reported = false;
  for (const session of sessions) {
    for (const usage of Object.values(session.modelUsage ?? {})) {
      if (usage.reasoningTokens == null) continue;
      reported = true;
      output += usage.outputTokens;
      reasoning += usage.reasoningTokens;
    }
  }
  if (!reported || output <= 0) return null;
  return { basis: 'session-totals', main: reasoningShare(output, reasoning), subagent: null, byEffort: [] };
}

interface SourceGroup {
  harnesses: Set<string>;
  requests: SessionRequest[];
  sessions: Set<Session>;
}

/** Compaction-call input as a share of main-agent input, and sub-agent tokens as a share of all tokens, over
 *  the turns that log per-call usage (the only turns where both sides are known). */
function addShares(compaction: TokenTypesCompaction | null, subagents: TokenTypesSubagents | null, requests: SessionRequest[]): void {
  const perCall = requests.filter(hasPerCallOutputs);
  if (perCall.length === 0) return;
  const main = mainTokens(callRows(perCall));
  let compactionTokens = 0, compactionInput = 0, subagentTokens = 0;
  for (const request of perCall) {
    for (const event of requestCompactions(request)) {
      if (!event.tokensUsed) continue;
      compactionInput += event.tokensUsed.input;
      compactionTokens += event.tokensUsed.input + event.tokensUsed.output;
    }
    for (const run of request.subagentRuns ?? []) subagentTokens += run.totalTokens;
  }
  if (compaction) compaction.shareOfMainInputPct = pct(compactionInput, main.input);
  if (subagents) subagents.shareOfAllTokensPct = pct(subagentTokens, main.input + main.output + compactionTokens + subagentTokens);
}

function summarizeSource(source: TokenTypesSource, group: SourceGroup): SourceTokenTypes {
  const compactions = group.requests.flatMap(requestCompactions);
  const runs = group.requests.flatMap(request => request.subagentRuns ?? []);
  const rows = callRows(group.requests);
  const harnesses = [...group.harnesses].sort();
  const cli = source === 'copilot-cli';
  const compaction = cli ? summarizeCompactions(compactions) : null;
  const subagents = cli ? summarizeSubagents(runs) : null;
  if (cli) addShares(compaction, subagents, group.requests);
  return {
    source,
    label: sourceLabel(source, harnesses),
    harnesses,
    requests: group.requests.length,
    reasoning: source === 'codex' ? summarizeSessionReasoning(group.sessions) : cli ? rowReasoning(rows) : null,
    compaction,
    subagents,
    truncation: source === 'codex' ? null : rowTruncation(rows),
    latency: cli ? rowLatency(rows) : null,
  };
}

function hasData(source: SourceTokenTypes): boolean {
  return source.reasoning != null || source.compaction != null || source.subagents != null
    || source.truncation != null || source.latency != null;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return n >= 1000 ? `${Math.round(n / 1000)}K` : String(n);
}

function compactionTip(label: string, compaction: TokenTypesCompaction): string | null {
  if (compaction.count < TIP_MIN_COMPACTIONS || compaction.automatic < compaction.count / 2) return null;
  const sizes = compaction.avgTokensBefore != null && compaction.avgTokensAfter != null
    ? ` at about ${formatTokens(compaction.avgTokensBefore)} tokens, keeping ${formatTokens(compaction.avgTokensAfter)}`
    : '';
  const cost = compaction.withUsage > 0
    ? ` The compaction calls themselves read ${formatTokens(compaction.inputTokens)} tokens.`
    : '';
  return `${compaction.automatic} of ${compaction.count} ${label} compactions were automatic${sizes}.${cost} Run /compact yourself at a natural breakpoint, or start a new session, so you choose what is kept.`;
}

function subagentTip(label: string, subagents: TokenTypesSubagents): string | null {
  if (subagents.runs < TIP_MIN_SUBAGENT_RUNS || subagents.byType.length === 0) return null;
  const top = subagents.byType[0];
  return `${label} sub-agents used ${formatTokens(subagents.totalTokens)} tokens in ${subagents.runs} runs; ${top.agentType} runs used the most (${formatTokens(top.totalTokens)}). Their transcripts stay out of your main context, but their tokens still count. Pick a smaller model for routine sub-agent work.`;
}

function reasoningTip(label: string, reasoning: TokenTypesReasoning): string | null {
  const sharePct = reasoning.main?.sharePct;
  if (sharePct == null || sharePct < TIP_REASONING_SHARE) return null;
  const low = reasoning.byEffort.find(e => e.stream === 'main' && (e.effort === 'medium' || e.effort === 'low') && e.sharePct != null);
  const contrast = low ? ` At ${low.effort} effort it was ${Math.round(low.sharePct ?? 0)}%.` : '';
  return `Reasoning is ${Math.round(sharePct)}% of ${label} output tokens.${contrast} Use a lower reasoning effort for routine edits and questions, and keep high effort for hard problems.`;
}

function truncationTip(label: string, truncation: TokenTypesTruncation): string | null {
  const share = pct(truncation.truncatedCalls, truncation.calls) ?? 0;
  if (truncation.truncatedCalls < TIP_MIN_TRUNCATED || share < TIP_TRUNCATED_PCT) return null;
  return `${truncation.truncatedCalls} of ${truncation.calls} ${label} model calls (${share}%) stopped at the output-token limit, so their answers were cut off. Ask for smaller steps, such as one file or one function at a time.`;
}

function tokenTypesTips(sources: SourceTokenTypes[]): string[] {
  const tips: string[] = [];
  for (const source of sources) {
    const tip = [
      source.reasoning ? reasoningTip(source.label, source.reasoning) : null,
      source.compaction ? compactionTip(source.label, source.compaction) : null,
      source.subagents ? subagentTip(source.label, source.subagents) : null,
      source.truncation ? truncationTip(source.label, source.truncation) : null,
    ];
    tips.push(...tip.filter((t): t is string => t != null));
  }
  return tips;
}

export function analyzeTokenTypes(
  requests: SessionRequest[],
  sessionOf: (request: SessionRequest) => Session | undefined,
): TokenTypesData {
  const groups = new Map<TokenTypesSource, SourceGroup>();
  const harnessRequests = new Map<string, number>();
  for (const request of requests) {
    const session = sessionOf(request);
    if (!session) continue;
    harnessRequests.set(session.harness, (harnessRequests.get(session.harness) ?? 0) + 1);
    const source = tokenTypesSource(session.harness);
    if (!source) continue;
    const group = groups.get(source) ?? { harnesses: new Set<string>(), requests: [], sessions: new Set<Session>() };
    group.harnesses.add(session.harness);
    group.requests.push(request);
    group.sessions.add(session);
    groups.set(source, group);
  }

  const sources = SOURCE_ORDER
    .filter(source => groups.has(source))
    .map(source => summarizeSource(source, groups.get(source)!))
    .filter(hasData)
    .sort((a, b) => b.requests - a.requests);
  const harnesses: HarnessTokenTypes[] = [...harnessRequests]
    .map(([harness, count]) => {
      const source = tokenTypesSource(harness);
      return { harness, source, requests: count, reports: source ? AVAILABILITY[source] : NOT_REPORTED };
    })
    .sort((a, b) => b.requests - a.requests || a.harness.localeCompare(b.harness));
  const requestsWithData = requests.filter(request =>
    (request.subagentRuns?.length ?? 0) > 0 || hasPerCallOutputs(request) || requestCompactions(request).some(e => e.tokensUsed != null)
    || (request.promptCache?.rows.some(row => row.truncatedCalls != null) ?? false),
  ).length;

  return {
    sources,
    harnesses,
    tips: tokenTypesTips(sources),
    coverage: { requests: requests.length, requestsWithData },
  };
}

/** The main-agent effort with the most calls. */
function topEffort(reasoning: TokenTypesReasoning | null): SessionTokenTypes['effort'] {
  const main = (reasoning?.byEffort ?? []).filter(e => e.stream === 'main' && e.effort !== 'unknown');
  return main.length > 0 ? main.reduce((a, b) => (b.calls > a.calls ? b : a)).effort : null;
}

/** Token types of one session for Context Management's drill-down strip; `null` when the harness logs none. */
export function sessionTokenTypes(session: Session): SessionTokenTypes | null {
  const source = tokenTypesSource(session.harness);
  if (!source) return null;
  const rows = callRows(session.requests);
  const reasoning = source === 'codex' ? summarizeSessionReasoning([session]) : source === 'copilot-cli' ? rowReasoning(rows) : null;
  const runs = session.requests.flatMap(request => request.subagentRuns ?? []);
  const types = summarizeSubagents(runs)?.byType ?? [];
  const compactions = session.requests.flatMap(requestCompactions).filter(event => event.tokensUsed != null);
  const truncation = source === 'codex' ? null : rowTruncation(rows);
  const ttft = rows.filter(row => row.stream === 'main').flatMap(row => row.ttftMs ?? []).sort((a, b) => a - b);
  const strip: SessionTokenTypes = {
    reasoningPct: reasoning?.main?.sharePct ?? null,
    effort: topEffort(reasoning),
    subagentRuns: runs.length,
    subagentTokens: runs.reduce((sum, run) => sum + run.totalTokens, 0),
    subagentTypes: [...types].sort((a, b) => b.runs - a.runs).slice(0, MAX_STRIP_TYPES).map(t => ({ agentType: t.agentType, runs: t.runs })),
    compactionCalls: compactions.length,
    compactionTokens: compactions.reduce((sum, event) => sum + (event.tokensUsed?.input ?? 0) + (event.tokensUsed?.output ?? 0), 0),
    compactionTimeMs: compactions.reduce((sum, event) => sum + event.durationMs, 0),
    truncatedCalls: truncation?.truncatedCalls ?? null,
    calls: truncation?.calls ?? null,
    ttftMedianMs: percentile(ttft, 50),
  };
  const empty = strip.reasoningPct == null && strip.subagentRuns === 0 && strip.compactionCalls === 0
    && strip.truncatedCalls == null && strip.ttftMedianMs == null;
  return empty ? null : strip;
}

export class TokenTypesAnalyzer extends AnalyzerBase {
  /** Token types of the requests sent in the date range. */
  getTokenTypes(f?: DateFilter): TokenTypesData {
    return analyzeTokenTypes(this.filter(f), request => this.requestSessionMap.get(request));
  }
}
