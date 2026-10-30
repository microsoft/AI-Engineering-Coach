/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Context composition aggregation: what fills the prompt, by category, per harness,
 * workspace and week, plus coaching tips. Used by ContextAnalyzer. */

import type {
  CompactionCompositionSnapshot,
  CompactionContextSnapshot,
  CompositionBreakdown,
  CompositionSource,
  CompositionTrend,
  ContextCategory,
  ContextCompositionData,
  HarnessComposition,
  Session,
  SessionCompositionDetail,
  SessionRequest,
  SourceComposition,
  SystemSegmentSummary,
  WorkspaceComposition,
} from './types';
import { CONTEXT_CATEGORIES, normalizeShares } from './context-composition';
import { COMPOSITION_TIP_MIN_SAMPLES, COMPOSITION_TOOL_HEAVY_PCT } from './constants';
import { toDateStr } from './helpers';

type Shares = Partial<Record<ContextCategory, number>>;

interface Sample {
  session: Session;
  source: CompositionSource;
  /** Normalized to sum to 100. */
  shares: Shares;
  /** Average prompt size over the sample's model calls. */
  basis: number | null;
  week: string | null;
  /** Model calls behind the sample: one for VS Code, every main-agent call of a Copilot CLI turn. */
  calls: number;
  toolDefinitionTokens: number | null;
  availableTools: number | null;
}

const MAX_WORKSPACES = 10;
const MAX_SEGMENTS = 12;
const MAX_SESSION_SEGMENTS = 8;
/** Residuals below this share of a compaction snapshot are accounting noise. */
const MIN_RESIDUAL_PCT = 0.5;

const TIP_TOOL_SHARE = 30;
const TIP_TOOL_HEAVY_REQUESTS = 20;
const TIP_TOOL_TOKENS_PER_CALL = 20_000;
const TIP_SYSTEM_SHARE = 20;
const TIP_TOOL_RESULTS_SHARE = 40;
const TIP_CONVERSATION_SHARE = 85;

const HARNESS_SHORT_NAMES = new Map([['GitHub Copilot CLI', 'Copilot CLI'], ['GitHub Copilot App', 'Copilot App']]);
const OPTIMIZE_GUIDE = 'GitHub\u2019s \u201cOptimizing your AI usage\u201d guide (docs.github.com/en/copilot/tutorials/optimize-ai-usage)';

/** The source a harness reports composition through, judged by its name. */
function expectedSource(harness: string): CompositionSource | null {
  if (harness === 'GitHub Copilot CLI' || harness === 'GitHub Copilot App') return 'copilot-cli';
  if (harness.startsWith('Local Agent') || /\bvs ?code\b/i.test(harness)) return 'vscode';
  return null;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function weekLabel(ts: number): string {
  const d = new Date(ts);
  const day = d.getDay() || 7;
  const monday = new Date(d);
  monday.setDate(d.getDate() - day + 1);
  return toDateStr(monday.getTime());
}

function groupBy<T, K>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const group = groups.get(k);
    if (group) group.push(item);
    else groups.set(k, [item]);
  }
  return groups;
}

function toSample(request: SessionRequest, session: Session): Sample | null {
  const composition = request.promptComposition;
  if (!composition) return null;
  const shares = normalizeShares(composition.shares);
  if (!shares) return null;
  return {
    session,
    source: composition.source,
    shares,
    basis: composition.promptTokens != null && composition.promptTokens > 0 ? composition.promptTokens : null,
    week: request.timestamp != null && request.timestamp > 0 ? weekLabel(request.timestamp) : null,
    calls: Math.max(1, composition.calls ?? 1),
    toolDefinitionTokens: composition.toolDefinitionTokens ?? null,
    availableTools: composition.availableTools ?? null,
  };
}

/** Token-weighted when prompt sizes are known (requests without one are left out), else request-weighted.
 *  A sample's prompt size is its average per model call, so it weighs `basis × calls`: every Copilot CLI
 *  call counts, and the average prompt is per call. VS Code records one call per request. */
function breakdownOf(samples: Sample[]): CompositionBreakdown | null {
  if (samples.length === 0) return null;
  const withBasis = samples.filter(sample => sample.basis != null);
  const weighting: CompositionBreakdown['weighting'] = withBasis.length > 0 ? 'tokens' : 'requests';
  const used = weighting === 'tokens' ? withBasis : samples;
  const totals = new Map<ContextCategory, number>();
  let weightSum = 0;
  let calls = 0;
  for (const sample of used) {
    const weight = sample.basis == null ? 1 : sample.basis * sample.calls;
    weightSum += weight;
    calls += sample.calls;
    for (const category of CONTEXT_CATEGORIES) {
      const share = sample.shares[category];
      if (share != null) totals.set(category, (totals.get(category) ?? 0) + share * weight);
    }
  }
  const avgPromptTokens = weighting === 'tokens' ? Math.round(weightSum / calls) : null;
  const slices = CONTEXT_CATEGORIES.filter(category => totals.has(category)).map(category => {
    const pct = (totals.get(category) ?? 0) / weightSum;
    return {
      category,
      pct: round1(pct),
      tokens: avgPromptTokens == null ? null : Math.round((pct / 100) * avgPromptTokens),
    };
  });
  return { slices, weighting, samples: used.length, avgPromptTokens };
}

function shareOf(breakdown: CompositionBreakdown | null, category: ContextCategory): number | null {
  return breakdown?.slices.find(slice => slice.category === category)?.pct ?? null;
}

function toolHeavyPct(samples: Sample[]): number | null {
  const withTools = samples.filter(sample => sample.shares.toolDefinitions != null);
  if (withTools.length === 0) return null;
  const heavy = withTools.filter(sample => (sample.shares.toolDefinitions ?? 0) >= COMPOSITION_TOOL_HEAVY_PCT).length;
  return round1((heavy / withTools.length) * 100);
}

/** Call-weighted average tool-definition tokens and the most tools offered (Copilot CLI). */
function toolStats(samples: Sample[]): { avg: number | null; max: number | null } {
  let calls = 0;
  let tokens = 0;
  let max = 0;
  for (const sample of samples) {
    if (sample.toolDefinitionTokens != null) {
      calls += sample.calls;
      tokens += sample.toolDefinitionTokens * sample.calls;
    }
    if (sample.availableTools != null && sample.availableTools > max) max = sample.availableTools;
  }
  return { avg: calls > 0 ? Math.round(tokens / calls) : null, max: max > 0 ? max : null };
}

function buildTrend(samples: Sample[]): CompositionTrend {
  const dated = samples.filter(sample => sample.week != null);
  const labels = [...new Set(dated.map(sample => sample.week ?? ''))].sort();
  const index = new Map(labels.map((label, i) => [label, i]));
  const series = [...groupBy(dated, sample => sample.session.harness)]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([harness, harnessSamples]) => {
      const perWeek = labels.map((): Sample[] => []);
      for (const sample of harnessSamples) perWeek[index.get(sample.week ?? '') ?? 0].push(sample);
      const breakdowns = perWeek.map(breakdownOf);
      return {
        harness,
        toolDefinitions: breakdowns.map(b => shareOf(b, 'toolDefinitions')),
        systemInstructions: breakdowns.map(b => shareOf(b, 'systemInstructions')),
        samples: perWeek.map(week => week.length),
      };
    });
  return { labels, series };
}

function summarizeSegments(sessions: Iterable<Session>): { segments: SystemSegmentSummary[]; sessions: number } {
  const totals = new Map<string, { tokens: number; sessions: number }>();
  let count = 0;
  for (const session of sessions) {
    const segments = session.contextComposition?.systemSegments ?? [];
    if (segments.length === 0) continue;
    count++;
    for (const segment of segments) {
      const total = totals.get(segment.name) ?? { tokens: 0, sessions: 0 };
      total.tokens += segment.tokens;
      total.sessions++;
      totals.set(segment.name, total);
    }
  }
  // Rank by total contribution so an everyday segment outranks a large but rare one.
  const segments = [...totals]
    .map(([name, total]) => ({ name, avgTokens: Math.round(total.tokens / total.sessions), sessions: total.sessions, total: total.tokens }))
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))
    .slice(0, MAX_SEGMENTS)
    .map(({ name, avgTokens, sessions }) => ({ name, avgTokens, sessions }));
  return { segments, sessions: count };
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(Math.round(n));
}

/** "VS Code", or the Copilot CLI/App harnesses actually present (they share one log format). */
function sourceLabel(source: CompositionSource, samples: Sample[]): string {
  if (source === 'vscode') return 'VS Code';
  const names = new Set(samples.map(sample => HARNESS_SHORT_NAMES.get(sample.session.harness) ?? sample.session.harness));
  return [...names].sort().join(' and ');
}

function toolTip(row: SourceComposition, tools: number): string | null {
  const { label } = row;
  const heavy = row.toolHeavyPct ?? 0;
  const avg = row.avgToolDefinitionTokens;
  if (row.source === 'copilot-cli' && avg != null && (avg >= TIP_TOOL_TOKENS_PER_CALL || tools >= TIP_TOOL_SHARE)) {
    const offered = row.maxAvailableTools == null ? '' : ` (${row.maxAvailableTools} tools offered)`;
    return `Tool definitions add about ${formatTokens(avg)} tokens to every ${label} model call${offered}, ${Math.round(tools)}% of your prompts. Remove MCP servers you don't use before you start a session (changing them mid-session breaks the prompt cache). See ${OPTIMIZE_GUIDE}.`;
  }
  if (tools >= TIP_TOOL_SHARE || heavy >= TIP_TOOL_HEAVY_REQUESTS) {
    return `Tool definitions take ${Math.round(tools)}% of your ${label} prompts and at least half of the prompt in ${Math.round(heavy)}% of requests. Turn off MCP servers and tools you don't need, or pick a smaller tool set, before you start a chat (changing them mid-session breaks the prompt cache). See ${OPTIMIZE_GUIDE}.`;
  }
  return null;
}

/** Coaching tips per source (VS Code, Copilot CLI) so harness variants don't repeat the same advice. */
function compositionTips(sources: SourceComposition[]): string[] {
  const tips: string[] = [];
  for (const row of sources) {
    if (row.requestsWithData < COMPOSITION_TIP_MIN_SAMPLES) continue;
    const { breakdown, label } = row;
    const tools = toolTip(row, shareOf(breakdown, 'toolDefinitions') ?? 0);
    if (tools) tips.push(tools);
    const system = shareOf(breakdown, 'systemInstructions') ?? 0;
    if (system >= TIP_SYSTEM_SHARE) {
      tips.push(`System instructions take ${Math.round(system)}% of your ${label} prompts. Trim always-on instruction files (copilot-instructions.md, AGENTS.md) and move task-specific guidance into prompt files or skills that load only when needed.`);
    }
    const toolResults = shareOf(breakdown, 'toolResults') ?? 0;
    if (toolResults >= TIP_TOOL_RESULTS_SHARE) {
      tips.push(`Tool results fill ${Math.round(toolResults)}% of your ${label} prompts. Ask for targeted reads (one file or line range instead of whole folders) and send broad searches to a subagent so only its summary comes back.`);
    }
    const conversation = shareOf(breakdown, 'conversation') ?? 0;
    if (conversation >= TIP_CONVERSATION_SHARE) {
      tips.push(`Conversation history fills ${Math.round(conversation)}% of your ${label} prompts. Start a new session between unrelated tasks, run /compact to continue a long one, and use subagents for exploration so their transcripts stay out of the main context.`);
    }
  }
  return tips;
}

interface CollectedSamples {
  samples: Sample[];
  sessions: Set<Session>;
  harnessTotals: Map<string, { requests: number; sessions: Set<Session> }>;
  totalRequests: number;
}

function collectSamples(requests: SessionRequest[], sessionOf: (request: SessionRequest) => Session | undefined): CollectedSamples {
  const collected: CollectedSamples = { samples: [], sessions: new Set(), harnessTotals: new Map(), totalRequests: 0 };
  for (const request of requests) {
    const session = sessionOf(request);
    if (!session) continue;
    collected.totalRequests++;
    collected.sessions.add(session);
    let totals = collected.harnessTotals.get(session.harness);
    if (!totals) {
      totals = { requests: 0, sessions: new Set() };
      collected.harnessTotals.set(session.harness, totals);
    }
    totals.requests++;
    totals.sessions.add(session);
    const sample = toSample(request, session);
    if (sample) collected.samples.push(sample);
  }
  return collected;
}

function buildHarnessRows(collected: CollectedSamples): HarnessComposition[] {
  const samplesByHarness = groupBy(collected.samples, sample => sample.session.harness);
  return [...collected.harnessTotals]
    .map(([harness, totals]) => {
      const harnessSamples = samplesByHarness.get(harness) ?? [];
      const stats = toolStats(harnessSamples);
      return {
        harness,
        source: harnessSamples[0]?.source ?? expectedSource(harness),
        breakdown: breakdownOf(harnessSamples),
        totalRequests: totals.requests,
        requestsWithData: harnessSamples.length,
        sessions: totals.sessions.size,
        sessionsWithData: new Set(harnessSamples.map(sample => sample.session)).size,
        toolHeavyPct: toolHeavyPct(harnessSamples),
        avgToolDefinitionTokens: stats.avg,
        maxAvailableTools: stats.max,
      };
    })
    .sort((a, b) => b.requestsWithData - a.requestsWithData || b.totalRequests - a.totalRequests || a.harness.localeCompare(b.harness));
}

/** One row per source. VS Code and Copilot CLI are never pooled: VS Code records only the last model
 *  call of each request while Copilot CLI records every call, so a pooled share would mostly be Copilot CLI's. */
function buildSourceRows(samples: Sample[]): SourceComposition[] {
  const rows: SourceComposition[] = [];
  for (const [source, sourceSamples] of groupBy(samples, sample => sample.source)) {
    const breakdown = breakdownOf(sourceSamples);
    if (!breakdown) continue;
    const stats = toolStats(sourceSamples);
    rows.push({
      source,
      label: sourceLabel(source, sourceSamples),
      harnesses: [...new Set(sourceSamples.map(sample => sample.session.harness))].sort(),
      breakdown,
      requestsWithData: sourceSamples.length,
      toolHeavyPct: toolHeavyPct(sourceSamples),
      avgToolDefinitionTokens: stats.avg,
      maxAvailableTools: stats.max,
    });
  }
  return rows.sort((a, b) => b.requestsWithData - a.requestsWithData || a.label.localeCompare(b.label));
}

/** One row per workspace and source, so a workspace used from VS Code and Copilot CLI isn't pooled. */
function buildWorkspaceRows(samples: Sample[]): WorkspaceComposition[] {
  const rows: WorkspaceComposition[] = [];
  const groups = [...groupBy(samples, sample => sample.session.workspaceName).values()]
    .flatMap(workspaceSamples => [...groupBy(workspaceSamples, sample => sample.source).values()])
    .sort((a, b) => b.length - a.length
      || a[0].session.workspaceName.localeCompare(b[0].session.workspaceName)
      || a[0].source.localeCompare(b[0].source))
    .slice(0, MAX_WORKSPACES);
  for (const group of groups) {
    const breakdown = breakdownOf(group);
    if (!breakdown) continue;
    const { session, source } = group[0];
    rows.push({
      workspaceId: session.workspaceName,
      workspaceName: session.workspaceName,
      source,
      label: sourceLabel(source, group),
      harnesses: [...new Set(group.map(sample => sample.session.harness))].sort(),
      breakdown,
    });
  }
  return rows;
}

/** Aggregate prompt composition over the requests in the current filter. */
export function analyzeComposition(
  requests: SessionRequest[],
  sessionOf: (request: SessionRequest) => Session | undefined,
): { data: ContextCompositionData; tips: string[] } {
  const collected = collectSamples(requests, sessionOf);
  const { samples } = collected;
  const sources = buildSourceRows(samples);
  const segments = summarizeSegments(collected.sessions);
  return {
    data: {
      sources,
      harnesses: buildHarnessRows(collected),
      workspaces: buildWorkspaceRows(samples),
      trend: buildTrend(samples),
      systemSegments: segments.segments,
      systemSegmentSessions: segments.sessions,
      coverage: {
        requestsWithData: samples.length,
        totalRequests: collected.totalRequests,
        sessionsWithData: new Set(samples.map(sample => sample.session)).size,
        totalSessions: collected.sessions.size,
      },
      toolHeavyThreshold: COMPOSITION_TOOL_HEAVY_PCT,
    },
    tips: compositionTips(sources),
  };
}

function snapshotComposition(snapshot: CompactionContextSnapshot): CompactionCompositionSnapshot {
  const parts: [ContextCategory, number][] = [
    ['systemInstructions', snapshot.systemTokens],
    ['toolDefinitions', snapshot.toolDefinitionTokens],
    ['conversation', snapshot.conversationTokens],
  ];
  const attributed = parts.reduce((sum, [, tokens]) => sum + tokens, 0);
  const total = Math.max(snapshot.currentTokens, attributed);
  const residual = total - attributed;
  if (total > 0 && (residual / total) * 100 >= MIN_RESIDUAL_PCT) parts.push(['other', residual]);
  return {
    timestamp: snapshot.timestamp,
    currentTokens: snapshot.currentTokens,
    tokenLimit: snapshot.tokenLimit,
    slices: total > 0 ? parts.map(([category, tokens]) => ({ category, pct: round1((tokens / total) * 100), tokens })) : [],
  };
}

function roundShares(shares: Shares): Shares {
  const out: Shares = {};
  for (const category of CONTEXT_CATEGORIES) {
    const value = shares[category];
    if (value != null) out[category] = round1(value);
  }
  return out;
}

/** Composition of one session for the drill-down; `undefined` when the harness reports none. */
export function buildSessionCompositionDetail(session: Session): SessionCompositionDetail | undefined {
  const samples: Sample[] = [];
  const perRequest = session.requests.map(request => {
    const sample = toSample(request, session);
    if (!sample) return null;
    samples.push(sample);
    return roundShares(sample.shares);
  });
  const breakdown = breakdownOf(samples);
  const sessionComposition = session.contextComposition;
  if (!breakdown && !sessionComposition) return undefined;
  return {
    source: samples[0]?.source ?? 'copilot-cli',
    breakdown,
    perRequest: breakdown ? perRequest : [],
    systemSegments: (sessionComposition?.systemSegments ?? []).slice(0, MAX_SESSION_SEGMENTS),
    toolCount: sessionComposition?.toolCount ?? null,
    toolTokens: sessionComposition?.toolTokens ?? null,
    compactions: (sessionComposition?.compactions ?? []).map(snapshotComposition),
  };
}
