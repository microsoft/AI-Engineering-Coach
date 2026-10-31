/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Token types beyond input and output, for the Token Types tab: reasoning share, compaction
 * overhead, sub-agent tokens, truncated calls and model-call latency. Each source is summarized on
 * its own and never pooled with another, and a harness that doesn't log a type gets "not reported"
 * instead of a zero. Counts the requests sent in the date range, like Context Composition. */

import type {
  CompactionEvent,
  HarnessTokenTypes,
  ReasoningShare,
  Session,
  SessionRequest,
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
} from './types';
import { requestCompactions } from './context-window';

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

/** The token-types source of a harness, judged by its name. */
export function tokenTypesSource(harness: string): TokenTypesSource | null {
  if (harness === 'GitHub Copilot CLI' || harness === 'GitHub Copilot App') return 'copilot-cli';
  if (harness === 'Codex') return 'codex';
  if (harness === 'Claude') return 'claude';
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

function pct(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : null;
}

function share(outputTokens: number, reasoningTokens: number): ReasoningShare {
  return { outputTokens, reasoningTokens, sharePct: pct(Math.min(reasoningTokens, outputTokens), outputTokens) };
}

function summarizeCompactions(events: CompactionEvent[]): TokenTypesCompaction | null {
  if (events.length === 0) return null;
  let automatic = 0, manual = 0, failed = 0, sized = 0, before = 0, after = 0;
  let withUsage = 0, inputTokens = 0, outputTokens = 0, modelTimeMs = 0;
  for (const event of events) {
    if (event.trigger === 'threshold') automatic++;
    else if (event.trigger) manual++;
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
  return { basis: 'session-totals', main: share(output, reasoning), subagent: null, byEffort: [] };
}

interface SourceGroup {
  harnesses: Set<string>;
  requests: SessionRequest[];
  sessions: Set<Session>;
}

function summarizeSource(source: TokenTypesSource, group: SourceGroup): SourceTokenTypes {
  const compactions = group.requests.flatMap(requestCompactions);
  const runs = group.requests.flatMap(request => request.subagentRuns ?? []);
  const harnesses = [...group.harnesses].sort();
  return {
    source,
    label: sourceLabel(source, harnesses),
    harnesses,
    requests: group.requests.length,
    reasoning: source === 'codex' ? summarizeSessionReasoning(group.sessions) : null,
    compaction: source === 'copilot-cli' ? summarizeCompactions(compactions) : null,
    subagents: source === 'copilot-cli' ? summarizeSubagents(runs) : null,
    truncation: null,
    latency: null,
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
  return `Reasoning is ${Math.round(sharePct)}% of ${label} output tokens. Use a lower reasoning effort for routine edits and questions, and keep high effort for hard problems.`;
}

function tokenTypesTips(sources: SourceTokenTypes[]): string[] {
  const tips: string[] = [];
  for (const source of sources) {
    const tip = [
      source.reasoning ? reasoningTip(source.label, source.reasoning) : null,
      source.compaction ? compactionTip(source.label, source.compaction) : null,
      source.subagents ? subagentTip(source.label, source.subagents) : null,
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
    (request.subagentRuns?.length ?? 0) > 0 || request.contextUsage != null || requestCompactions(request).some(e => e.tokensUsed != null),
  ).length;

  return {
    sources,
    harnesses,
    tips: tokenTypesTips(sources),
    coverage: { requests: requests.length, requestsWithData },
  };
}
