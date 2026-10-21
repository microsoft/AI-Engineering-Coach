/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CuriosityTier } from './curiosity-types';

export interface DailyHarnessData {
  harness: string;
  requests: number[];
  sessions: number[];
  loc: number[];
}

export interface DailyActivity {
  labels: string[];
  values: number[];
  loc: number[];
  sessions: number[];
  workspaces: number[];
  byHarness: DailyHarnessData[];
}

export interface HourlyDistribution {
  hours: number[];
  byType: Record<string, number[]>;
}

export interface HeatmapData {
  heatmap: number[][];
  byType: Record<string, number[][]>;
  /** 7×24 grid of focus scores (0-100) based on activity density */
  focusHeatmap: number[][];
}

export interface CalendarDay {
  date: string;
  requests: number;
  focusScore: number;
  dow: number;
}

export interface CalendarActivityData {
  days: CalendarDay[];
  maxRequests: number;
}

export interface CodeProductionData {
  summary: {
    totalAiLoc: number;
    totalUserLoc: number;
    totalLoc: number;
    totalRemovedAiLoc: number;
    totalNetAiLoc: number;
    aiBlocks: number;
    userBlocks: number;
    aiRatio: number;
    locCost2010: number;
    costPerLoc: number;
  };
  byLanguage: {
    labels: string[];
    aiLoc: number[];
    userLoc: number[];
  };
  dailyTimeline: {
    labels: string[];
    aiLoc: number[];
    removedLoc: number[];
    userLoc: number[];
  };
  byWorkspace: {
    labels: string[];
    aiLoc: number[];
    userLoc: number[];
  };
  dailyByWorkspace: Record<string, number[]>;
  dailyRemovedByWorkspace: Record<string, number[]>;
  dailyByModel: Record<string, number[]>;
  dailyRemovedByModel: Record<string, number[]>;
  dailyByHarness: Record<string, number[]>;
  dailyRemovedByHarness: Record<string, number[]>;
}

export interface ConsumptionData {
  totalRequests: number;
  avgPerDay: number;
  avgPerWeek: number;
  avgPerMonth: number;
  modelTotals: Record<string, number>;
  defaultMultipliers: Record<string, number>;
  daily: { labels: string[]; values: number[]; byModel: Record<string, number[]> };
  weekly: { labels: string[]; values: number[]; byModel: Record<string, number[]> };
  monthly: { labels: string[]; values: number[]; byModel: Record<string, number[]> };
}

export interface TimelineSession {
  sessionId: string;
  workspaceName: string;
  sessionName: string;
  firstActivity: number;
  lastActivity: number;
  requestCount: number;
  totalRequestCount: number;
  requests: TimelineRequest[];
}

export interface TimelineRequest {
  timestamp: number;
  messageText: string;
  responseText: string;
  messageLength: number;
  responseLength: number;
  agentName: string;
  modelId: string;
  toolsUsed: string[];
  editedFiles: string[];
  referencedFiles: string[];
  preview: string;
  loc?: number;
  workType?: string;
}

export interface DayTimeline {
  date: string;
  mode: string;
  rangeLabel: string;
  dayStart: number;
  dayEnd: number;
  sessions: TimelineSession[];
  sessionCount: number;
  maxConcurrent: number;
  prevDay: string | null;
  nextDay: string | null;
  firstDay: string | null;
  activeDates: { date: string; count: number }[];
}

export interface SessionListItem {
  sessionId: string;
  workspaceName: string;
  workspaceId: string;
  creationDate: number | null;
  lastMessageDate: number | null;
  requestCount: number;
  firstMessage: string;
}

export interface SessionList {
  total: number;
  page: number;
  pageSize: number;
  sessions: SessionListItem[];
}

export interface WorkspaceBreakdown {
  labels: string[];
  values: number[];
}

export interface BurndownConfig {
  sku: string;
  customBudget?: number;
  modelBudgets?: Record<string, number>;
  month?: string;
}

export interface BurndownData {
  currentMonth: string;
  daysInMonth: number;
  dayOfMonth: number;
  budget: number;
  consumed: number;
  projected: number;
  dailyConsumption: { labels: string[]; values: number[]; cumulative: number[] };
  projectedLine: number[];
  budgetLine: number[];
  status: 'on-track' | 'warning' | 'over-budget';
  recommendation: string;
}

/* ---- AI Credit (usage-based billing) types ---- */

export interface AiCreditModelBreakdown {
  requests: number;
  /** Number of requests included in token/credit math (with both native input + output, or session-aggregated). */
  countedRequests: number;
  /** Output-only requests (output tokens captured, input not) — billed lower-bound, surfaced separately. */
  partialRequests: number;
  /** Requests in still-active or aborted-pre-response sessions (token data not yet finalized).
   *  Excluded from `missingPct` denominator — they may still arrive. */
  pendingRequests: number;
  /** Requests where the harness/source structurally cannot record token data (Xcode, CLI abort-only, etc.).
   *  Permanent and excluded from `missingPct` denominator. */
  noDataRequests: number;
  /** @deprecated No longer tracked (Claude harness unified). Always 0. */
  delegatedRequests: number;
  /** Uncached input tokens (subset of `inputTokens`) — used for input-rate billing math. */
  uncachedInputTokens: number;
  /** Total input tokens (uncached + cached). */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  credits: number;
  /** % of *finalizable* requests for this model with no token data (denominator excludes pending + no-data, same as Token Coverage). */
  missingPct: number;
  /** Number of finalizable requests (`requests - pendingRequests - noDataRequests`).
   *  When this is 0, `missingPct` is 0 by convention but the UI should render "N/A" — there's
   *  nothing in this slice that *could* have token data. */
  finalizableRequests: number;
  /** Harness names that contributed requests for this model (sorted). */
  harnesses: string[];
}

export interface AiCreditData {
  totalCredits: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  /** Total request count in the filter window (includes those with missing token data) */
  totalRequests: number;
  /** Number of requests with complete billing data (counted in totals/credits — includes session-aggregated CLI requests) */
  countedRequests: number;
  /** Output-only requests (see `AiCreditModelBreakdown.partialRequests`). */
  partialRequests: number;
  /** In-flight / aborted-pre-response requests (excluded from `missingPct`). */
  pendingRequests: number;
  /** Permanently untracked requests (excluded from `missingPct`). */
  noDataRequests: number;
  /** @deprecated No longer tracked (Claude harness unified). Always 0. */
  delegatedRequests: number;
  /** Finalizable requests = `totalRequests - pendingRequests - noDataRequests`. */
  finalizableRequests: number;
  /** % of *finalizable* requests with no token data (matches Token Coverage semantics). */
  missingPct: number;
  avgCreditsPerRequest: number;
  avgCreditsPerDay: number;
  costByModel: Record<string, AiCreditModelBreakdown>;
  daily: { labels: string[]; credits: number[]; cumulative: number[]; byModel: Record<string, number[]> };
  weekly: { labels: string[]; credits: number[]; cumulative: number[]; byModel: Record<string, number[]> };
  /** Daily total-token (input + output) consumption broken down by workspace.
   *  `labels` matches `daily.labels`; each workspace key maps to an aligned array of token totals. */
  dailyTokensByWorkspace: { labels: string[]; byWorkspace: Record<string, number[]> };
  /** Daily total-token (input + output) consumption broken down by harness.
   *  `labels` matches `daily.labels`; each harness key maps to an aligned array of token totals. */
  dailyTokensByHarness: { labels: string[]; byHarness: Record<string, number[]> };
  topRequests: Array<{
    timestamp: number;
    model: string;
    inputTokens: number;
    outputTokens: number;
    credits: number;
    /** Per-request token-data classification (matches RequestBilling.status). */
    status: 'complete' | 'partial' | 'pending' | 'no-data' | 'missing';
    /** "exact" = per-request native data; "session-aggregated" = derived from session-level totals (CLI). */
    aggregationKind: 'exact' | 'session-aggregated';
    preview: string;
    workspace: string;
    harness: string;
    fullPrompt: string;
  }>;
}

/** Token-data coverage breakdown — surfaces how many sessions/requests
 *  per harness and per workspace have native token data available. Used by
 *  the "Token Coverage" overview to diagnose data quality. */
export interface TokenCoverageData {
  totalSessions: number;
  totalRequests: number;
  totalWorkspaces: number;
  totalHarnesses: number;
  /** Sessions where every counted request has billing-complete tokens. */
  countedSessions: number;
  /** Requests with billing-complete data (per-request native input + output OR session-level aggregated). */
  countedRequests: number;
  /** Requests genuinely missing token data — excludes pending, partial, and no-data. */
  missingRequests: number;
  /** Requests where we have output tokens but no input (e.g. VS Code copilot/auto). */
  partialRequests: number;
  /** Requests in active or aborted sessions where token data was never finalized. */
  pendingRequests: number;
  /** Requests that finalized but the harness/source recorded no token usage
   *  — Xcode (no token capture in the source DB), some 2026-04 VS Code
   *  copilot/auto and copilot/gpt-5.4 requests, and Copilot CLI turns
   *  aborted before any model output. Permanent: there's nothing to recover.
   *  Excluded from the missing% denominator and surfaced separately. */
  noDataRequests: number;
  /** Sessions still running (no shutdown event seen). */
  activeSessions: number;
  /** Sessions where the user aborted before any model response, so no tokens exist. */
  abortedSessions: number;
  /** % of finalizable requests with no billing data. Excludes pending and no-data. */
  missingPct: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  /** Output tokens captured for partial (output-only) requests, kept separate
   *  from `totalOutputTokens` so the latter only reflects billing-complete totals. */
  partialOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  byHarness: TokenCoverageHarness[];
  byWorkspace: TokenCoverageWorkspace[];
  bySession: TokenCoverageSession[];
  /** Per-month per-harness coverage trend so the user can see when each
   *  harness started reporting reliable token data. */
  timeline: TokenCoverageTimeline;
}

export interface TokenCoverageHarness {
  harness: string;
  sessions: number;
  workspaces: number;
  requests: number;
  countedRequests: number;
  partialRequests: number;
  pendingRequests: number;
  /** Requests permanently without token data (harness limitation or
   *  finalized-but-not-recorded). Excluded from missingPct denominator. */
  noDataRequests: number;
  missingPct: number;
  inputTokens: number;
  outputTokens: number;
  partialOutputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** How requests in this harness are billed: "per-request" (Claude/OpenCode/VS Code),
   *  "session-aggregated" (Copilot CLI shutdown.modelMetrics), or "mixed". */
  source: 'per-request' | 'session-aggregated' | 'mixed' | 'none';
}

export interface TokenCoverageWorkspace {
  workspaceId: string;
  workspaceName: string;
  harnesses: string[];
  sessions: number;
  requests: number;
  countedRequests: number;
  partialRequests: number;
  pendingRequests: number;
  noDataRequests: number;
  missingPct: number;
  inputTokens: number;
  outputTokens: number;
}

/** Per-session coverage row used by the drill-down table in the
 *  "Token Coverage" overview. Surfaces which individual sessions are
 *  missing token data so the user can target their reindexing or
 *  parser investigation. */
export interface TokenCoverageSession {
  sessionId: string;
  harness: string;
  workspaceId: string;
  workspaceName: string;
  firstMessageDate: number | null;
  lastMessageDate: number | null;
  requests: number;
  countedRequests: number;
  partialRequests: number;
  pendingRequests: number;
  noDataRequests: number;
  missingPct: number;
  inputTokens: number;
  outputTokens: number;
  /** Session disposition. 'shutdown' = closed cleanly, 'active' = still open,
   *  'aborted' = user cancelled before any model response, 'unknown' = harness
   *  doesn't expose disposition. Drives pending vs missing classification. */
  endReason: 'shutdown' | 'active' | 'aborted' | 'unknown';
  /** How this session's tokens are sourced — same vocabulary as
   *  TokenCoverageHarness.source, applied to a single session. */
  source: 'per-request' | 'session-aggregated' | 'mixed' | 'none';
}

/** Monthly per-harness token coverage timeline. The user can scan this to
 *  answer "since when does harness X actually report tokens?". Months are
 *  ISO `YYYY-MM` strings, sorted ascending. */
export interface TokenCoverageTimeline {
  months: string[];
  harnesses: string[];
  /** `cells[harness][month]` — undefined when the harness had no requests
   *  in that bucket. */
  cells: Record<string, Record<string, TokenCoverageTimelineCell | undefined>>;
}

export interface TokenCoverageTimelineCell {
  requests: number;
  countedRequests: number;
  partialRequests: number;
  pendingRequests: number;
  noDataRequests: number;
  /** Missing % over finalizable requests in this bucket (excludes pending and no-data). */
  missingPct: number;
}

export interface AiCreditBurndownData {
  currentMonth: string;
  daysInMonth: number;
  dayOfMonth: number;
  budget: number;
  consumed: number;
  projected: number;
  dailyConsumption: { labels: string[]; values: number[]; cumulative: number[] };
  projectedLine: number[];
  budgetLine: number[];
  /** Status semantics:
   *    on-track / warning / will-exceed — billing data exists, projection meaningful.
   *    no-data       — no requests at all in this period (or 100% structurally untracked).
   *    pending-only  — requests exist but all are still in-flight; nothing finalized yet. */
  status: 'on-track' | 'warning' | 'will-exceed' | 'no-data' | 'pending-only';
  daysUntilExhaustion: number | null;
  safeDailyBudget: number;
  projectedOverage: number;
  recommendation: string;
  /** % of *finalizable* requests (excluding pending + no-data) with no token data. */
  missingPct: number;
  /** Total request count in the period (regardless of token availability) */
  totalRequests: number;
  /** Requests with complete native token data (input + output) */
  countedRequests: number;
  /** Output-only requests in the period. */
  partialRequests: number;
  /** In-flight / aborted-pre-response requests in the period. */
  pendingRequests: number;
  /** Permanently untracked requests in the period. */
  noDataRequests: number;
  /** @deprecated No longer tracked (Claude harness unified). Always 0. */
  delegatedRequests: number;
  /** Finalizable requests = total - pending - no-data. */
  finalizableRequests: number;
  /** Per-day request counts in each coverage bucket (length = daysInMonth, index 0 = day 1).
   *  Drives the coverage strip in the Burndown view so users can see *where* in the month
   *  data is missing. Future days (after `dayOfMonth`) are zero across the board. */
  coverageByDay: {
    complete: number[];
    partial: number[];
    pending: number[];
    noData: number[];
    /** @deprecated No longer tracked. Always zeros. */
    delegated: number[];
    missing: number[];
  };
  /** Per-model cumulative token consumption for the month. Each entry has daily cumulative values (length = daysInMonth). */
  byModel: Record<string, { cumulative: number[]; budget: number }>;
}

export interface HarnessComparisonItem {
  harness: string;
  sessions: number;
  requests: number;
  avgRequestsPerSession: number;
  totalAiLoc: number;
  avgResponseLength: number;
  topModels: { name: string; count: number }[];
  topTools: { name: string; count: number }[];
  avgElapsed: number | null;
  cancelRate: number;
  activeDays: number;
  firstSeen: string | null;
  lastSeen: string | null;
}

export interface HarnessComparisonData {
  harnesses: HarnessComparisonItem[];
  dailyByHarness: { labels: string[]; series: Record<string, number[]> };
}

/* ---- Parser field-population matrix ---- */

export type FieldCategory = 'core' | 'enrichment' | 'auto-computed';

export interface FieldMeta {
  name: string;
  label: string;
  category: FieldCategory;
}

export interface FieldPopulationCell {
  populated: number;
  total: number;
}

export interface ParserCoverageData {
  fields: FieldMeta[];
  harnesses: string[];
  /** matrix[fieldName][harness] → { populated, total } */
  matrix: Record<string, Record<string, FieldPopulationCell>>;
}

/** Preview of a representative sample request per harness showing extracted vs missing data */
export interface ParserPreviewSample {
  harness: string;
  sessionId: string;
  workspaceName: string;
  requestIndex: number;
  /** Per-field breakdown: field name → { value (stringified), populated } */
  fields: Record<string, { value: string; populated: boolean }>;
  /** Total fields populated out of total tracked */
  populatedCount: number;
  totalFields: number;
}

export interface ParserPreviewData {
  samples: ParserPreviewSample[];
  fields: FieldMeta[];
}

export type WorkType = 'feature' | 'bug fix' | 'refactor' | 'code review' | 'docs' | 'test' | 'style' | 'config' | 'other';

export const WORK_TYPES: WorkType[] = ['feature', 'bug fix', 'refactor', 'code review', 'docs', 'test', 'style', 'config', 'other'];

export const WORK_TYPE_COLORS: Record<WorkType, string> = {
  'feature': '#58a6ff',
  'bug fix': '#f85149',
  'refactor': '#d29922',
  'code review': '#da7756',
  'docs': '#3fb950',
  'test': '#bc8cff',
  'style': '#f778ba',
  'config': '#79c0ff',
  'other': '#8b949e',
};

export const SKU_BUDGETS: Record<string, number> = {
  'pro': 300,
  'pro-plus': 1500,
  'business': 300,
  'enterprise': 1000,
};

export interface RecommendationResult {
  checkId: string;
  name: string;
  category: string;
  score: number;
  status: 'good' | 'needs-improvement' | 'critical';
  finding: string;
  recommendation: string;
  details?: Record<string, unknown>;
}

export type PracticeGroup = 'prompt-quality' | 'session-hygiene' | 'code-review' | 'tool-mastery' | 'context-management';

export const PRACTICE_GROUPS: Record<PracticeGroup, string> = {
  'prompt-quality': 'Prompt Quality',
  'session-hygiene': 'Session Hygiene',
  'code-review': 'Code Review',
  'tool-mastery': 'Tool Mastery',
  'context-management': 'Context Management',
};

export interface OccurrenceDetail {
  timestamp: number;
  workspace: string;
  sessionId: string;
  message: string;
  model: string;
  /** 'workspace' = workspace-level finding, 'session' = session-level, default = request-level */
  kind?: 'workspace' | 'session' | 'request';
  /** Extra numeric stats for workspace-level findings (e.g. codeLoc, mdLoc) */
  stats?: Record<string, number>;
}

export interface AntiPattern {
  id: string;
  name: string;
  severity: 'high' | 'medium' | 'low';
  group: PracticeGroup;
  occurrences: number;
  description: string;
  suggestion: string;
  examples: string[];
  /** Rich per-occurrence details for timeline + session drilldown */
  details: OccurrenceDetail[];
  /** Weekly histogram: labels (ISO weeks) and counts per week */
  weeklyHist: { labels: string[]; counts: number[] };
  /** Aggregate checks use supporting examples, not per-request violations. */
  aggregate?: boolean;
}

export interface WeeklyPatternObservation {
  week: string;
  group: PracticeGroup;
  severity: AntiPattern['severity'];
  occurrences: number;
}

export interface PatternContribution {
  patterns: AntiPattern[];
  weekly: WeeklyPatternObservation[];
}

export interface GroupScore {
  group: PracticeGroup;
  score: number;
  wowPct: number;
  momPct: number;
  topIssue: string | null;
  improvements: string[];
  patternCount: number;
}

export interface AntiPatternData {
  patterns: AntiPattern[];
  totalOccurrences: number;
  weeklyTrend: { labels: string[]; counts: number[] };
  groupScores: GroupScore[];
  weeklyScores: { labels: string[]; series: { group: PracticeGroup; scores: number[] }[] };
  curiosityTier?: CuriosityTier;
}

export interface WorkLifeBalanceResult {
  score: number;
  totalRequests: number;
  weekdayReqs: number;
  weekendReqs: number;
  weekendRatio: number;
  timeDistribution: { lateNight: number; earlyMorning: number; workHours: number; evening: number };
  hours: number[];
  weekdayHours: number[];
  weekendHours: number[];
  avgStartHour: number;
  avgEndHour: number;
  avgSpanHours: number;
  maxStreak: number;
  maxBreak: number;
  activeDays: number;
  weeklyTrend: { labels: string[]; weekday: number[]; weekend: number[] };
}

export interface ProjectOverviewItem {
  workspaceName: string;
  workspaceId: string;
  totalRequests: number;
  estimatedHours: number;
  languages: string[];
  timePattern: string;
  topFiles: string[];
  estimatedLoc: number;
  gitPath: string | null;
}

export interface ProjectOverviewData {
  projects: ProjectOverviewItem[];
}

export interface StatsResult {
  totalSessions: number;
  totalWorkspaces: number;
  totalRequests: number;
}

export interface WorkflowCluster {
  id: string;
  label: string;
  canonicalPrompt: string;
  occurrences: number;
  sessions: number;
  workspaces: string[];
  harnesses: string[];
  avgCorrectionTurns: number;
  totalTurns: number;
  cancelRate: number;
  firstSeen: string | null;
  lastSeen: string | null;
  examples: string[];
  skillDraft: string;
}

export interface WorkflowOptimizationData {
  clusters: WorkflowCluster[];
  totalRepetitions: number;
  estimatedTimeSavedMins: number;
  topWorkspaces: { name: string; clusters: number }[];
}
