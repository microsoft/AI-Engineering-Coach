/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AntiPattern } from './analytics-types';
import type { CompositionSource, ContextCategory, SystemPromptSegment } from './session-types';

/* ---- Context Composition (what fills the prompt) ---- */

export interface CompositionSlice {
  category: ContextCategory;
  /** Percent of the prompt (slices of a breakdown sum to 100). */
  pct: number;
  /** Estimated tokens per request (pct × average prompt size); `null` without prompt sizes. */
  tokens: number | null;
}

export interface CompositionBreakdown {
  /** Slices in canonical category order, limited to categories the source reports. */
  slices: CompositionSlice[];
  /** `tokens` = weighted by each request's prompt size; `requests` = every request counts equally. */
  weighting: 'tokens' | 'requests';
  /** Requests that contributed to the breakdown. */
  samples: number;
  /** Average prompt size of those requests; `null` when unknown. */
  avgPromptTokens: number | null;
}

export interface HarnessComposition {
  harness: string;
  /** How this harness reports composition; `null` = not reported by this harness. */
  source: CompositionSource | null;
  /** `null` when no request in range carries composition data. */
  breakdown: CompositionBreakdown | null;
  totalRequests: number;
  requestsWithData: number;
  sessions: number;
  sessionsWithData: number;
  /** Percent of sampled requests whose prompt is at least half tool definitions. */
  toolHeavyPct: number | null;
  /** Copilot CLI: average tool-definition tokens per model call. */
  avgToolDefinitionTokens: number | null;
  /** Copilot CLI: most tools offered to the model in one turn. */
  maxAvailableTools: number | null;
}

export interface WorkspaceComposition {
  workspaceId: string;
  workspaceName: string;
  harnesses: string[];
  breakdown: CompositionBreakdown;
}

/** Weekly share of a category per harness, aligned to `CompositionTrend.labels`. */
export interface CompositionTrendSeries {
  harness: string;
  toolDefinitions: (number | null)[];
  systemInstructions: (number | null)[];
  samples: number[];
}

export interface CompositionTrend {
  labels: string[];
  series: CompositionTrendSeries[];
}

/** A Copilot CLI system-prompt segment averaged over sessions. */
export interface SystemSegmentSummary {
  name: string;
  avgTokens: number;
  sessions: number;
}

export interface ContextCompositionData {
  /** All harnesses pooled; `null` when no request carries composition data. */
  overall: CompositionBreakdown | null;
  harnesses: HarnessComposition[];
  /** Top workspaces by sampled requests. */
  workspaces: WorkspaceComposition[];
  trend: CompositionTrend;
  /** Copilot CLI system-prompt segments, largest first. */
  systemSegments: SystemSegmentSummary[];
  /** Sessions that contributed to `systemSegments`. */
  systemSegmentSessions: number;
  coverage: {
    requestsWithData: number;
    totalRequests: number;
    sessionsWithData: number;
    totalSessions: number;
  };
  /** Tool-definition share (%) at which a request counts as tool-heavy. */
  toolHeavyThreshold: number;
}

/** Context snapshot at a Copilot CLI compaction. Slice `tokens` are absolute token counts. */
export interface CompactionCompositionSnapshot {
  timestamp: number | null;
  currentTokens: number;
  tokenLimit: number | null;
  slices: CompositionSlice[];
}

/** Composition of one session's prompts, for the session drill-down. */
export interface SessionCompositionDetail {
  source: CompositionSource;
  /** `null` when only session-level details (segments, compactions) were recorded. */
  breakdown: CompositionBreakdown | null;
  /** Normalized shares per request, aligned with `SessionContextDetail.tokenCurve` (`null` = no data);
   *  empty when no request carries composition data. */
  perRequest: (Partial<Record<ContextCategory, number>> | null)[];
  /** Copilot CLI: largest system-prompt segments from the latest checkpoint. */
  systemSegments: SystemPromptSegment[];
  toolCount: number | null;
  toolTokens: number | null;
  compactions: CompactionCompositionSnapshot[];
}

/* ---- Context Management (token-level health) ---- */

export interface ContextVerdictThresholds {
  optimalUtilization: number;
  limitedUtilization: number;
  adaptive: boolean;
  sampleSize: number;
}

export interface WorkspaceContextScore {
  workspaceId: string;
  workspaceName: string;
  harness: string;
  sessionCount: number;
  requestsWithTokens: number;
  avgPromptTokens: number;
  maxPromptTokens: number;
  /** Percentage of estimated context window used on average (0-100) */
  avgUtilization: number;
  /** Percentage of estimated context window used at peak (0-100) */
  peakUtilization: number;
  /** Percentage of requests that are at or above the saturation threshold (60% utilization) */
  saturation: number;
  compactionCount: number;
  /** Reserved for compatibility; context views no longer surface cost efficiency */
  costEfficiency: number | null;
  /** Composite score 0-100 — higher is better context hygiene */
  score: number;
  verdict: 'optimal' | 'degraded' | 'limited';
}

export interface ContextTrend {
  label: string;  // week label
  avgUtilization: number;
  compactions: number;
  sessionsOverThreshold: number;
}

/** Per-workspace weekly utilization data for the trend chart "per-workspace" view */
export interface WorkspaceTrendSeries {
  workspaceName: string;
  /** Sparse array aligned to the same week labels as ContextTrend[], null = no data that week */
  data: (number | null)[];
}

/** A timeline event that occurred during a session (compaction, todo change, etc.) */
export interface SessionTimelineEvent {
  /** 0-based request index within the session */
  requestIndex: number;
  type: 'compaction' | 'todo-add' | 'todo-progress' | 'todo-complete';
  label: string;
}

/** Per-session context detail returned when drilling into a workspace */
export interface SessionContextDetail {
  sessionId: string;
  date: string;
  harness: string;
  requestCount: number;
  requestsWithTokens: number;
  avgPromptTokens: number;
  maxPromptTokens: number;
  avgUtilization: number;
  peakUtilization: number;
  contextWindow: number;
  compactionCount: number;
  /** Token counts per request (for sparkline / token curve). `null` for
   *  requests without native token data — keeps the request index aligned
   *  with `events` and `requestQueries` while telling the chart to draw a
   *  gap rather than a misleading 0 dip. */
  tokenCurve: (number | null)[];
  /** Percentage of requests at or above the saturation threshold */
  saturation: number;
  /** Reserved for compatibility; context views no longer surface cost efficiency */
  costEfficiency: number | null;
  verdict: 'optimal' | 'degraded' | 'limited';
  /** Timeline events (compactions, todo additions/completions) indexed by request */
  events: SessionTimelineEvent[];
  /** Truncated user query per request (aligned with tokenCurve) for tooltip display */
  requestQueries: string[];
  /** True when per-request token data is available (enables token curve chart).
   *  False for harnesses that only report session-aggregated tokens (e.g. Copilot CLI). */
  hasPerRequestTokens: boolean;
  /** What filled this session's prompts; absent when the harness doesn't report it. */
  composition?: SessionCompositionDetail;
}

export interface WorkspaceContextSessionsData {
  workspaceName: string;
  estimatedContextWindow: number;
  thresholds: ContextVerdictThresholds;
  sessions: SessionContextDetail[];
}

export interface ContextManagementData {
  /** Overall context health score 0-100 */
  overallScore: number;
  /** Estimated context window size (tokens) based on observed maximums */
  estimatedContextWindow: number;
  /** Verdict cutoffs used for this filtered dataset */
  thresholds: ContextVerdictThresholds;
  /** Per-workspace breakdown */
  workspaces: WorkspaceContextScore[];
  /** Weekly trend data */
  trend: ContextTrend[];
  /** Per-workspace weekly trend (top 10 by request volume) */
  workspaceTrend: WorkspaceTrendSeries[];
  /** Total compaction events observed */
  totalCompactions: number;
  /** Full (deep summarization) compaction events — automated context management */
  fullCompactions: number;
  /** Simple (lightweight truncation) compaction events */
  simpleCompactions: number;
  /** Sessions with token data available */
  sessionsWithTokenData: number;
  totalSessions: number;
  /** Anti-patterns specific to context management */
  antiPatterns: AntiPattern[];
  /** Actionable tips based on observed patterns */
  tips: string[];
  /** What fills the prompt, by category, per harness and workspace. */
  composition?: ContextCompositionData;
}

/* ---- Context Review (agent-based) ---- */

export type ContextReviewCategory =
  | 'clarity'          // Is the intent clear to an AI agent?
  | 'specificity'      // Are constraints, tech stack, coding standards defined?
  | 'structure'        // Headings, sections, frontmatter, logical ordering
  | 'completeness'     // Missing typical sections (project overview, conventions, testing, etc.)
  | 'staleness'        // Outdated references, deprecated patterns
  | 'redundancy'       // Duplicated info across files, conflicting instructions
  | 'actionability';   // Can the AI act on these instructions or are they too vague?

export interface ContextReviewFinding {
  category: ContextReviewCategory;
  severity: 'good' | 'warning' | 'critical';
  file: string;
  finding: string;
  suggestion: string;
}

export interface ContextReviewResult {
  workspaceId: string;
  workspaceName: string;
  overallGrade: 'A' | 'B' | 'C' | 'D' | 'F';
  overallScore: number;           // 0-100
  categoryScores: Record<ContextReviewCategory, number>;  // 0-100 each
  findings: ContextReviewFinding[];
  summary: string;
}

/* ---- Agentic Readiness Score ---- */

export interface AgenticReadinessScore {
  score: number;                  // 0-100
  signals: AgenticReadinessSignal[];
}

export interface AgenticReadinessSignal {
  id: string;
  label: string;
  present: boolean;
  weight: number;
  detail: string;
}

/* ---- Flow State Analysis ---- */

export interface FlowSession {
  sessionId: string;
  workspaceName: string;
  harness: string;
  date: string;
  startTs: number;
  endTs: number;
  durationMin: number;
  requestCount: number;
  /** Median follow-up latency in seconds (time from response to next prompt) */
  medianFollowUpSec: number;
  /** Under 30s follow-up rate — fraction of gaps where user replied within 30s */
  rapidFollowUpRate: number;
  /** 0-100 flow score for this session */
  flowScore: number;
  flowLabel: 'deep' | 'moderate' | 'shallow' | 'fragmented';
}

export interface FlowDay {
  date: string;
  /** Longest uninterrupted work block in minutes */
  longestBlockMin: number;
  /** Total continuous hours on projects */
  totalHours: number;
  /** Number of distinct work blocks (gap > 15 min = new block) */
  blockCount: number;
  /** Average flow score across sessions that day */
  avgFlowScore: number;
  flowLabel: 'deep' | 'moderate' | 'shallow' | 'fragmented';
  sessions: FlowSession[];
}

export interface FlowStateData {
  days: FlowDay[];
  overallFlowScore: number;
  avgFollowUpSec: number;
  avgBlockMin: number;
  deepFlowDays: number;
  totalDays: number;
  /** Weekly trend: labels + avg flow scores */
  weeklyTrend: { labels: string[]; scores: number[] };
  /** Per-hour flow score distribution (24 slots) — best hours for deep work */
  hourlyFlow: number[];
  /** Top suggestions */
  suggestions: string[];
}
