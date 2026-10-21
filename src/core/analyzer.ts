/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Analyzer facade and warm-up helpers. */

import {
  Session, SessionRequest, DateFilter, DailyActivity, HourlyDistribution, HeatmapData,
  CodeProductionData, ConsumptionData, BurndownConfig, BurndownData, AiCreditData, AiCreditBurndownData, TokenCoverageData,
  DayTimeline, SessionList, WorkspaceBreakdown, RecommendationResult,
  AntiPatternData, WorkLifeBalanceResult, StatsResult, HarnessComparisonData,
  WorkflowOptimizationData, ConfigHealthData, FlowStateData, Workspace,
  CalendarActivityData, ProjectOverviewData, ContextManagementData, InsightsData,
  ParserCoverageData, ParserPreviewData,
} from './types';
import { DashboardAnalyzer } from './analyzer-dashboard';
import { ProductionAnalyzer } from './analyzer-production';
import { ConsumptionAnalyzer } from './analyzer-consumption';
import { TimelineAnalyzer } from './analyzer-timeline';
import { PatternsAnalyzer } from './analyzer-patterns';
import { WorkflowAnalyzer } from './analyzer-workflows';
import { ConfigAnalyzer } from './analyzer-config';
import { FlowAnalyzer } from './analyzer-flow';
import { ContextAnalyzer } from './analyzer-context';
import { InsightsAnalyzer } from './analyzer-insights';
import { ImageAnalyzer, ImageGalleryData } from './analyzer-images';
import { CuriosityAnalyzer } from './analyzer-curiosity';
import type { CuriosityData, CuriosityFilter } from './types/curiosity-types';
import { curiosityPatternContribution } from './curiosity-patterns';
import { AnalyzerBase } from './analyzer-base';
import { EditLoc, EditLocIndex } from './edit-loc-diff';
import { errorCore, infoCore, warnCore } from './log';
import type { ForkFn } from './parser-worker-host';
import { runWarmUpWorker } from './warm-up-worker-host';

export class Analyzer {
  private readonly dashboard: DashboardAnalyzer;
  private readonly production: ProductionAnalyzer;
  private readonly consumption: ConsumptionAnalyzer;
  private readonly timeline: TimelineAnalyzer;
  private readonly patterns: PatternsAnalyzer;
  private readonly workflows: WorkflowAnalyzer;
  private readonly config: ConfigAnalyzer;
  private readonly insights: InsightsAnalyzer;
  private readonly flow: FlowAnalyzer;
  private readonly context: ContextAnalyzer;
  private readonly images: ImageAnalyzer;
  private readonly curiosity: CuriosityAnalyzer;
  private readonly sessions: Session[];
  private readonly editLocIndex: EditLocIndex;
  private readonly workspaces: Map<string, Workspace>;
  private cache = new Map<string, unknown>();

  constructor(sessions: Session[], editLocIndex?: EditLocIndex, workspaces?: Map<string, Workspace>) {
    const elIdx = editLocIndex ?? new Map<string, Map<string, EditLoc>>();
    this.sessions = sessions;
    this.editLocIndex = elIdx;
    this.workspaces = workspaces ?? new Map<string, Workspace>();
    const sharedMap = AnalyzerBase.buildRequestSessionMap(sessions);
    this.dashboard = new DashboardAnalyzer(sessions, elIdx, sharedMap);
    this.production = new ProductionAnalyzer(sessions, elIdx, sharedMap);
    this.consumption = new ConsumptionAnalyzer(sessions, elIdx, sharedMap);
    this.timeline = new TimelineAnalyzer(sessions, elIdx, sharedMap);
    this.patterns = new PatternsAnalyzer(sessions, elIdx, sharedMap);
    this.workflows = new WorkflowAnalyzer(sessions, elIdx, sharedMap);
    this.config = new ConfigAnalyzer(sessions, elIdx, this.workspaces, sharedMap);
    this.insights = new InsightsAnalyzer(sessions, elIdx, sharedMap);
    this.flow = new FlowAnalyzer(sessions, elIdx, sharedMap);
    this.context = new ContextAnalyzer(sessions, elIdx, sharedMap);
    this.images = new ImageAnalyzer(sessions, elIdx, sharedMap);
    this.curiosity = new CuriosityAnalyzer(sessions, elIdx, sharedMap);
  }

  private getCached<T>(key: string, filter: DateFilter | undefined, compute: () => T): T {
    if (filter) return compute();
    if (this.cache.has(key)) return this.cache.get(key) as T;
    const result = compute();
    this.cache.set(key, result);
    return result;
  }

  private addPatterns(target: AntiPatternData, patterns: AntiPatternData['patterns']): void {
    if (patterns.length === 0) return;
    target.patterns.push(...patterns);
    target.totalOccurrences += patterns.reduce((sum, pattern) => sum + pattern.occurrences, 0);
  }

  private addPatternsSafely(target: AntiPatternData, read: () => AntiPatternData['patterns']): void {
    try {
      this.addPatterns(target, read());
    } catch {
      return;
    }
  }

  private warmUpSync(): void {
    try {
      this.cache.set('getAntiPatterns', this.getAntiPatterns());
    } catch (error) {
      errorCore('warmUp', 'sync fallback failed', error);
    }
  }

  async warmUp(
    onProgress?: (phase: number, detail: string, pct: number) => void,
    forkWorker?: ForkFn,
  ): Promise<void> {
    const t0 = Date.now();
    const report = onProgress ?? (() => {});

    infoCore('warmUp', `start (${this.sessions.length} sessions)`);
    report(4, 'Computing analytics', 10);

    const result = await runWarmUpWorker({
      sessions: this.sessions, editLocIndex: this.editLocIndex, workspaces: this.workspaces,
    }, forkWorker).catch((error) => {
      if (forkWorker) throw error;
      warnCore('warmUp', 'worker unavailable, using sync fallback', error);
      return null;
    });

    if (result) {
      if (result.antiPatterns) this.cache.set('getAntiPatterns', result.antiPatterns);
      if (result.configHealth) this.cache.set('getConfigHealth', result.configHealth);
    } else {
      this.warmUpSync();
    }

    const ms = Date.now() - t0;
    infoCore('warmUp', `done in ${ms}ms`);
    report(5, `Cache ready (${ms}ms)`, 100);
  }

  getWorkspaces(): { id: string; name: string; recent?: boolean; harnesses?: string[] }[] { return this.dashboard.getWorkspaces(); }
  getHarnesses(): string[] { return this.dashboard.getHarnesses(); }
  getHarnessBreakdown(f?: DateFilter): { labels: string[]; sessions: number[]; requests: number[] } { return this.dashboard.getHarnessBreakdown(f); }

  /** Public access to filtered requests for rule editor preview. */
  filterRequests(f?: DateFilter): SessionRequest[] { return this.patterns.getFilteredRequests(f); }
  /** Public access to filtered sessions for rule editor preview. */
  filterSessions(f?: DateFilter): Session[] { return this.patterns.getFilteredSessions(f); }
  getHarnessComparison(f?: DateFilter): HarnessComparisonData { return this.dashboard.getHarnessComparison(f); }
  getParserCoverage(): ParserCoverageData { return this.dashboard.getParserCoverage(); }
  getParserPreview(focusField?: string): ParserPreviewData { return this.dashboard.getParserPreview(focusField); }
  getDailyActivity(f?: DateFilter): DailyActivity {
    return this.getCached('getDailyActivity', f, () => this.dashboard.getDailyActivity(f));
  }
  getWorkspaceBreakdown(f?: DateFilter): WorkspaceBreakdown {
    return this.getCached('getWorkspaceBreakdown', f, () => this.dashboard.getWorkspaceBreakdown(f));
  }
  getHourlyDistribution(f?: DateFilter): HourlyDistribution { return this.dashboard.getHourlyDistribution(f); }
  getHeatmap(f?: DateFilter): HeatmapData { return this.dashboard.getHeatmap(f); }

  getCodeProduction(f?: DateFilter): CodeProductionData { return this.production.getCodeProduction(f); }

  getConsumption(f?: DateFilter): ConsumptionData { return this.consumption.getConsumption(f); }
  getBurndown(config: BurndownConfig, f?: DateFilter): BurndownData { return this.consumption.getBurndown(config, f); }
  getAiCredits(f?: DateFilter): AiCreditData { return this.consumption.getAiCredits(f); }
  getAiCreditBurndown(config: BurndownConfig, f?: DateFilter): AiCreditBurndownData { return this.consumption.getAiCreditBurndown(config, f); }
  getTokenCoverage(f?: DateFilter): TokenCoverageData { return this.consumption.getTokenCoverage(f); }

  getDayTimeline(dateStr?: string, mode?: string, f?: DateFilter): DayTimeline { return this.timeline.getDayTimeline(dateStr, mode, f); }
  getSessions(page: number, pageSize: number, f?: DateFilter, search?: string): SessionList { return this.timeline.getSessions(page, pageSize, f, search); }
  getSessionDetail(sessionId: string): Session | null { return this.timeline.getSessionDetail(sessionId); }
  getWorkLifeBalance(f?: DateFilter): WorkLifeBalanceResult | null { return this.timeline.getWorkLifeBalance(f); }

  getRecommendations(f?: DateFilter): RecommendationResult[] { return this.patterns.getRecommendations(f); }
  getProjectOverview(f?: DateFilter): ProjectOverviewData { return this.patterns.getProjectOverview(f); }
  getAntiPatterns(f?: DateFilter): AntiPatternData {
    if (!f && this.cache.has('getAntiPatterns')) return this.cache.get('getAntiPatterns') as AntiPatternData;
    const curiosity = this.curiosity.getCuriosity(f);
    const data = this.patterns.getAntiPatterns(f, curiosityPatternContribution(curiosity));
    data.curiosityTier = curiosity.balance.tier;
    this.addPatternsSafely(data, () => this.getConfigHealth(f).contextAntiPatterns);
    this.addPatternsSafely(data, () => this.getContextManagement(f).antiPatterns);
    return data;
  }

  getWorkflowOptimization(f?: DateFilter): WorkflowOptimizationData { return this.workflows.getWorkflowOptimization(f); }

  getConfigHealth(f?: DateFilter): ConfigHealthData {
    return this.getCached('getConfigHealth', f, () => this.config.getConfigHealth(f));
  }
  getContextReviewPayload(wsIds: string[]): ReturnType<ConfigAnalyzer['getContextReviewPayload']> { return this.config.getContextReviewPayload(wsIds); }
  getInsights(f?: DateFilter): InsightsData { return this.insights.getInsights(f); }
  getCuriosity(f?: CuriosityFilter): CuriosityData { return this.curiosity.getCuriosity(f); }

  getFlowState(f?: DateFilter): FlowStateData { return this.flow.getFlowState(f); }

  getContextManagement(f?: DateFilter): ContextManagementData { return this.context.getContextManagement(f); }
  getWorkspaceContextSessions(workspaceId: string, f?: DateFilter): ReturnType<ContextAnalyzer['getWorkspaceContextSessions']> {
    return this.context.getWorkspaceContextSessions(workspaceId, f);
  }
  getContextRangeAvailability(f?: DateFilter): {
    rangesWithTokens: number[];
    matchingSessions: number;
    sessionsWithRequestTokens: number;
    harnessesWithoutRequestTokens: string[];
  } {
    return this.context.getContextRangeAvailability(f);
  }

  getCalendarActivity(f?: DateFilter): CalendarActivityData { return this.dashboard.getCalendarActivity(f); }

  getImageGallery(f?: DateFilter): ImageGalleryData { return this.images.getImageGallery(f); }

  getStats(f?: DateFilter): StatsResult {
    return this.getCached('getStats', f, () => this.dashboard.getStats(f));
  }
}
