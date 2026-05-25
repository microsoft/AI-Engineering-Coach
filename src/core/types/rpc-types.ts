/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Canonical error-payload shape returned by RPC handlers that surface a
 * user-visible failure reason. Keep this tiny; additional fields should be
 * added inline by the caller.
 */
export interface ErrorResult {
  error: string;
}

/**
 * Discriminated-ish union: either the success value `T` or an ErrorResult.
 * Callers narrow via `'error' in result`.
 */
export type RpcResult<T> = T | ErrorResult;

/** Type guard for ErrorResult. */
export function isErrorResult(v: unknown): v is ErrorResult {
  return typeof v === 'object' && v !== null && typeof (v as { error?: unknown }).error === 'string';
}

import type { DateFilter, Session } from './session-types';
import type {
  AiCreditBurndownData,
  AiCreditData,
  AntiPatternData,
  BurndownConfig,
  BurndownData,
  CalendarActivityData,
  CodeProductionData,
  ConsumptionData,
  DailyActivity,
  DayTimeline,
  HarnessComparisonData,
  HeatmapData,
  HourlyDistribution,
  ParserCoverageData,
  ParserPreviewData,
  ProjectOverviewData,
  SessionList,
  StatsResult,
  TokenCoverageData,
  WorkspaceBreakdown,
  WorkLifeBalanceResult,
  WorkflowOptimizationData,
} from './analytics-types';
import type { ConfigHealthData } from './config-types';
import type { InsightsData } from './insights-types';
import type { ContextManagementData, FlowStateData, WorkspaceContextSessionsData } from './context-types';
import type { ImageGalleryData } from '../analyzer-images';

/* RPC method map: method name -> { params, result } */
export interface RpcMethodMap {
  getWorkspaces: { params: undefined; result: { id: string; name: string; recent?: boolean; harnesses?: string[] }[] };
  getHarnesses: { params: undefined; result: string[] };
  getHarnessBreakdown: { params: DateFilter | undefined; result: { labels: string[]; sessions: number[]; requests: number[] } };
  getDailyActivity: { params: DateFilter | undefined; result: DailyActivity };
  getWorkspaceBreakdown: { params: DateFilter | undefined; result: WorkspaceBreakdown };
  getHourlyDistribution: { params: DateFilter | undefined; result: HourlyDistribution };
  getHeatmap: { params: DateFilter | undefined; result: HeatmapData };
  getCodeProduction: { params: DateFilter | undefined; result: CodeProductionData };
  getConsumption: { params: DateFilter | undefined; result: ConsumptionData };
  getBurndown: { params: { config: BurndownConfig; filter?: DateFilter }; result: BurndownData };
  getAiCredits: { params: DateFilter | undefined; result: AiCreditData };
  getAiCreditBurndown: { params: { config: BurndownConfig; filter?: DateFilter }; result: AiCreditBurndownData };
  getTokenCoverage: { params: DateFilter | undefined; result: TokenCoverageData };
  getDayTimeline: { params: { date?: string; mode?: string; filter?: DateFilter }; result: DayTimeline };
  getSessions: { params: { page: number; pageSize: number; filter?: DateFilter; search?: string }; result: SessionList };
  getSessionDetail: { params: { sessionId: string }; result: Session | null };
  getWorkLifeBalance: { params: DateFilter | undefined; result: WorkLifeBalanceResult | null };
  getAntiPatterns: { params: DateFilter | undefined; result: AntiPatternData };
  getHarnessComparison: { params: DateFilter | undefined; result: HarnessComparisonData };
  getParserCoverage: { params: undefined; result: ParserCoverageData };
  getParserPreview: { params: { focusField?: string } | undefined; result: ParserPreviewData };
  getWorkflowOptimization: { params: DateFilter | undefined; result: WorkflowOptimizationData };
  getStats: { params: DateFilter | undefined; result: StatsResult };
  getConfigHealth: { params: DateFilter | undefined; result: ConfigHealthData };
  getInsights: { params: DateFilter | undefined; result: InsightsData };
  getFlowState: { params: DateFilter | undefined; result: FlowStateData };
  getContextManagement: { params: { filter?: DateFilter } | undefined; result: ContextManagementData };
  getWorkspaceContextSessions: { params: { workspaceId: string; filter?: DateFilter }; result: WorkspaceContextSessionsData };
  getContextRangeAvailability: { params: { filter?: DateFilter } | undefined; result: { rangesWithTokens: number[]; matchingSessions: number; sessionsWithRequestTokens: number; harnessesWithoutRequestTokens: string[] } };
  getCalendarActivity: { params: DateFilter | undefined; result: CalendarActivityData };
  getProjectOverview: { params: DateFilter | undefined; result: ProjectOverviewData };
  getImageGallery: { params: DateFilter | undefined; result: ImageGalleryData };
  getSessionImages: { params: { sessionId: string; requestId: string }; result: { images: string[] } };
  getRuleEditor: { params: DateFilter | Record<string, unknown>; result: unknown };
  getRulePreview: { params: Record<string, unknown>; result: unknown };
  getRuleSource: { params: { ruleId: string }; result: { source: string } };
  saveRule: { params: { markdown: string; ruleId?: string }; result: { ok: boolean; filePath?: string; error?: string } };
  updateRuleThreshold: { params: { ruleId: string; key: string; value: number }; result: { ok: boolean } };
  reviewLocalRules: { params: undefined; result: { ok: boolean; error?: string } };
  generateRule: { params: { prompt: string }; result: { markdown: string } };
  testRuleLive: { params: { markdown: string; filter?: DateFilter }; result: { ok: boolean; triggered: boolean; occurrences: number; total: number; pct: string; severity: string; description: string; suggestion: string; examples: string[]; error?: string } };
  explainOccurrence: { params: { ruleId: string; sessionId: string; filter?: DateFilter }; result: { ok: boolean; explanation: string; error?: string } };
  getRuleCoverage: { params: { filter?: DateFilter }; result: { rules: Array<{ id: string; name: string; group: string }>; workspaces: string[]; matrix: Record<string, Record<string, number>>; error?: string } };
  /* ---- DSL / Metric / Playground / Explorer methods ---- */
  getFieldSchema: { params: undefined; result: unknown };
  getMetricPrimitives: { params: undefined; result: unknown };
  getFunctionCatalog: { params: undefined; result: unknown };
  getMetricList: { params: undefined; result: unknown };
  evaluateExpression: { params: { expr: string; scope: string; filter?: DateFilter }; result: unknown };
  calibrateRule: { params: { ruleId: string; filter?: DateFilter }; result: unknown };
  runRuleTests: { params: { ruleId: string }; result: unknown };
  compileNlRule: { params: { prompt: string; group?: string; severity?: string; scope?: string }; result: unknown };
  getDataExplorer: { params: { field: string; filter?: DateFilter }; result: unknown };
  getDataExplorerFields: { params: DateFilter | undefined; result: unknown };
  importRegistryRules: { params: { ruleIds?: string[] }; result: unknown };
  getRegistryCatalog: { params: undefined; result: unknown };
}

export type RpcMethodName = keyof RpcMethodMap;

export interface ExtensionMethodMap extends RpcMethodMap {
  openExternal: { params: { url: string }; result: { ok: boolean } };
  createSkill: { params: { prompt: string }; result: { ok: boolean } };
  generateSkillContent: { params: Record<string, unknown>; result: { content: string; filename: string } };
  generateLearningQuiz: { params: Record<string, unknown>; result: { questions: unknown[] } };
  generateLearningResources: { params: Record<string, unknown>; result: { resources: unknown[]; error?: string } };
  generateCodeComparison: { params: Record<string, unknown>; result: { rounds: unknown[] } };
  generateDidYouKnow: { params: Record<string, unknown>; result: { facts: unknown[] } };
  exportSummary: { params: { filter?: DateFilter } | DateFilter | undefined; result: { ok: boolean; cancelled?: boolean; folder?: string; markdownPath?: string; jsonPath?: string } };
  installSkill: { params: { filename: string; content: string }; result: { ok: boolean; path?: string; error?: string } };
  installCatalogItem: { params: { path: string; kind?: string; title?: string }; result: { content: string; filename: string; error?: string } };
  triageSkills: { params: Record<string, unknown>; result: { triaged: unknown[] } };
  discoverCatalog: { params: Record<string, unknown> | undefined; result: { items: unknown[]; totalScanned: number } };
  triageCatalog: { params: Record<string, unknown>; result: { items: unknown[] } };
  reviewContextFiles: { params: { workspaceIds: string[]; count?: number }; result: { reviews?: unknown[]; error?: string } };
  getWorkspaceDeps: { params: { limit?: number } | undefined; result: { deps: { workspace: string; dependencies: string[]; devDependencies: string[] }[] } };
  getSdlcToolAnalysis: { params: { filter?: DateFilter } | Record<string, unknown>; result: { mcpServers: unknown[] } };
  getSdlcRepoScan: { params: Record<string, unknown> | undefined; result: { repos: unknown[] } };
  getSdlcGitHubData: { params: Record<string, unknown>; result: unknown };
  saveModelBudgets: { params: { budgets: Record<string, number> }; result: { ok: boolean } };
  loadModelBudgets: { params: Record<string, unknown> | undefined; result: Record<string, number> };
}

export type ExtensionMethodName = keyof ExtensionMethodMap;
export type WebviewRequestMessage<M extends ExtensionMethodName = ExtensionMethodName> = {
  type: 'request';
  id: string;
  method: M;
  params?: ExtensionMethodMap[M]['params'];
};
export type WebviewResponseMessage = { type: 'response'; id: string; data: unknown };

/* Message types for webview <-> extension communication */
export type WebviewMessage = WebviewRequestMessage | WebviewResponseMessage;
