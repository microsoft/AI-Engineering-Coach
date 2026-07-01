/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Consumption + burndown analytics */

import { DateFilter, ConsumptionData, BurndownConfig, BurndownData, SKU_BUDGETS, AiCreditData, AiCreditBurndownData, Session, SessionRequest, ModelUsage, TokenCoverageData, TokenCoverageHarness, TokenCoverageWorkspace, TokenCoverageSession, TokenCoverageTimeline, TokenCoverageTimelineCell } from './types';
import { toDateStr, normalizeModel, modelMultiplier, isoWeek, resolveTokens, tokenCostInCredits, fillDayRange, fillWeekRange, fillMonthRange } from './helpers';
import { AnalyzerBase } from './analyzer-base';

/** Per-request billing token attribution.
 *
 *  `status` distinguishes:
 *  - `complete`   — both input and output tokens are known (can be billed).
 *  - `partial`    — only output tokens are known (e.g. VS Code chat with the
 *                   newer top-level `completionTokens` field on a `copilot/auto`
 *                   request that lacks `metadata.promptTokens`). The output
 *                   count is real and surfaced separately, but the request is
 *                   not counted as covered for billing.
 *  - `pending`    — the parent session is still active or was aborted before
 *                   any model response. Excluded from the missing% denominator
 *                   because token data was never finalizable.
 *  - `missing`    — no token data and no excuse — a real coverage gap. */
interface RequestBilling {
  uncachedInput: number;
  totalInput: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  credits: number;
  /** Per-request token-data classification.
   *    complete   — both input and output token counts are known.
   *    partial    — only output is known (e.g. VS Code top-level r.completionTokens).
   *    pending    — request not yet finalized; tokens may still arrive.
   *    no-data    — request finalized but the harness/source did not record token
   *                 usage (Xcode never captures, some VS Code copilot/auto reqs,
   *                 CLI turns aborted before any model output). Permanent. */
  status: 'complete' | 'partial' | 'pending' | 'no-data' | 'missing';
  /** Output tokens captured for partial requests (output-only data). 0 otherwise. */
  partialOutput: number;
  /** Provenance of the input/output values when `status === 'complete'`. */
  kind: 'exact' | 'session-aggregated';
}

/** Harnesses that emit authoritative token totals at session shutdown
 *  (rather than per-request). For active sessions of these harnesses, we
 *  classify per-request data as `pending` rather than `partial`/`missing`
 *  because the real numbers will arrive when the session shuts down — the
 *  per-request output we have so far is just a placeholder. */
function harnessUsesSessionAggregated(harness: string | undefined): boolean {
  return harness === 'GitHub Copilot CLI' || harness === 'GitHub Copilot App' || harness === 'Codex';
}
function computeBilling(sessions: Session[]): Map<SessionRequest, RequestBilling> {
  const map = new Map<SessionRequest, RequestBilling>();
  for (const session of sessions) {
    if (session.modelUsage) {
      attributeSessionLevel(session, session.modelUsage, map, new Set());
    } else {
      const isPending = session.endReason === 'active' || session.endReason === 'aborted';
      // For session-aggregated harnesses with no shutdown totals yet, treat
      // every request as pending — the authoritative numbers will replace the
      // per-request output entirely once the session shuts down.
      const preferPending = isPending && harnessUsesSessionAggregated(session.harness);
      for (const r of session.requests) {
        attributePerRequest(r, map, isPending, preferPending);
      }
    }
  }
  return map;
}

/** Compute "missing %" using the same denominator semantics as Token Coverage:
 *  pending and no-data requests are excluded from the denominator because
 *  neither category can ever produce token data (pending = in-flight, may yet
 *  arrive; no-data = harness/source structurally cannot record). Returns
 *  `0` when the denominator is zero — callers should check `finalizable`
 *  separately to distinguish "0% missing because perfect coverage" from
 *  "no finalizable requests in this slice." */
export function computeMissingPct(
  requests: number, counted: number, partial: number, pending: number, noData: number,
): number {
  const denom = requests - pending - noData;
  if (denom <= 0) return 0;
  const missing = denom - counted - partial;
  return Math.round((missing / denom) * 100);
}

interface AiCreditModelEntry {
  requests: number;
  countedRequests: number;
  partialRequests: number;
  pendingRequests: number;
  noDataRequests: number;
  missingRequests: number;
  uncachedInputTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  credits: number;
  harnesses: Set<string>;
}

function attributeSessionLevel(
  session: Session,
  modelUsage: Record<string, ModelUsage>,
  out: Map<SessionRequest, RequestBilling>,
  delegatedRequests?: Set<SessionRequest>,
): void {
  // Group requests by normalized model. Use ALL requests in the session
  // (not filtered) so that share math is invariant to date filtering —
  // filtering is applied later when we iterate requests.
  const byModel = new Map<string, SessionRequest[]>();
  for (const r of session.requests) {
    if (delegatedRequests?.has(r)) continue;
    const m = normalizeModel(r.modelId || 'untracked', true);
    if (!byModel.has(m)) byModel.set(m, []);
    byModel.get(m)!.push(r);
  }

  for (const [model, reqs] of byModel) {
    const usage = modelUsage[model];
    if (!usage) {
      // Model used by request but not present in shutdown totals — fall back
      // to per-request data for those requests.
      for (const r of reqs) attributePerRequest(r, out, false);
      continue;
    }
    // Weight each request by its native output tokens (which CLI does record
    // per assistant.message). Fall back to equal weighting when none have
    // output data (rare — would mean every request crashed pre-response).
    const weights = reqs.map(r => Math.max(0, r.completionTokens ?? 0));
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    const fallback = totalWeight === 0;
    const n = reqs.length;
    for (let i = 0; i < n; i++) {
      const share = fallback ? 1 / n : weights[i] / totalWeight;
      const uncachedInput = usage.inputTokens * share;
      const output = usage.outputTokens * share;
      const cacheRead = usage.cacheReadTokens * share;
      const cacheWrite = usage.cacheWriteTokens * share;
      const totalInput = uncachedInput + cacheRead + cacheWrite;
      const credits = tokenCostInCredits(model, uncachedInput, output, cacheRead, cacheWrite);
      out.set(reqs[i], {
        uncachedInput, totalInput, output, cacheRead, cacheWrite, credits,
        status: 'complete',
        partialOutput: 0,
        kind: 'session-aggregated',
      });
    }
  }
}

function attributePerRequest(
  r: SessionRequest,
  out: Map<SessionRequest, RequestBilling>,
  isPending: boolean,
  preferPending: boolean = false,
): void {
  const t = resolveTokens(r.promptTokens, r.completionTokens, r.cacheReadTokens, r.cacheWriteTokens);
  const credits = t.missing ? 0 : tokenCostInCredits(
    r.modelId || 'untracked',
    t.uncachedInput, t.output, t.cacheRead, t.cacheWrite,
  );
  let status: RequestBilling['status'];
  let partialOutput = 0;
  if (!t.missing) {
    status = 'complete';
  } else if (r.endState === 'no-data') {
    // Request finalized but the harness/source recorded no token data. Either
    // the harness inherently doesn't capture tokens (Xcode), or the chat
    // extension didn't write usage for this completion (some 2026-04 VS Code
    // copilot/auto and copilot/gpt-5.4 requests). Excluded from coverage
    // denominator; surfaced separately so the user can see the volume.
    status = 'no-data';
  } else if (r.endState === 'pending' || r.endState === 'errored') {
    // Request never had a chance to record token data:
    //   - `pending`: still in-flight or abandoned (no result was ever written).
    //   - `errored`: completed with an error (canceled, network, length, etc.).
    // Either way the missing tokens aren't a parser gap, so exclude from the
    // coverage denominator by treating as pending.
    status = 'pending';
  } else if (preferPending) {
    // Session-aggregated harness with no shutdown totals yet — the per-request
    // output is just a placeholder, so don't classify as partial/missing.
    status = 'pending';
  } else if (t.hasOutput && !t.hasInput) {
    // We have output tokens (e.g. VS Code chat top-level r.completionTokens)
    // but no input — surface the output but don't count as covered.
    status = 'partial';
    partialOutput = t.output;
  } else if (isPending) {
    status = 'pending';
  } else {
    status = 'missing';
  }
  out.set(r, {
    uncachedInput: t.uncachedInput,
    totalInput: t.input,
    output: status === 'complete' ? t.output : 0,
    cacheRead: t.cacheRead,
    cacheWrite: t.cacheWrite,
    credits,
    status,
    partialOutput,
    kind: 'exact',
  });
}

export class ConsumptionAnalyzer extends AnalyzerBase {

  getConsumption(f?: DateFilter): ConsumptionData {
    const reqs = this.filter(f);
    const modelTotals = new Map<string, number>();
    const dailyMap = new Map<string, Map<string, number>>();
    const weeklyMap = new Map<string, Map<string, number>>();
    const monthlyMap = new Map<string, Map<string, number>>();
    const defaultMultipliers: Record<string, number> = {};

    for (const r of reqs) {
      const model = normalizeModel(r.modelId || 'untracked', true);
      const mult = modelMultiplier(model);
      defaultMultipliers[model] = mult;
      modelTotals.set(model, (modelTotals.get(model) || 0) + 1);

      const d = new Date(r.timestamp!);
      const day = toDateStr(r.timestamp!);
      const week = isoWeek(d);
      const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

      for (const [mapRef, key] of [[dailyMap, day], [weeklyMap, week], [monthlyMap, month]] as const) {
        if (!mapRef.has(key)) mapRef.set(key, new Map());
        const inner = mapRef.get(key)!;
        inner.set(model, (inner.get(model) || 0) + 1);
      }
    }

    const totalRequests = reqs.length;
    const dayCount = new Set(reqs.map(r => toDateStr(r.timestamp!))).size || 1;
    const weekCount = weeklyMap.size || 1;
    const monthCount = monthlyMap.size || 1;

    const allModels = Array.from(modelTotals.keys()).sort((a, b) =>
      (modelTotals.get(b) || 0) - (modelTotals.get(a) || 0)
    );

    function buildSeries(map: Map<string, Map<string, number>>, fillRange: (keys: string[]) => string[]) {
      const keys = fillRange(Array.from(map.keys()));
      const values = keys.map(k => {
        const inner = map.get(k);
        if (!inner) return 0;
        let sum = 0;
        for (const v of inner.values()) sum += v;
        return sum;
      });
      const byModel: Record<string, number[]> = {};
      for (const model of allModels) {
        byModel[model] = keys.map(k => map.get(k)?.get(model) || 0);
      }
      return { labels: keys, values, byModel };
    }

    return {
      totalRequests,
      avgPerDay: totalRequests / dayCount,
      avgPerWeek: totalRequests / weekCount,
      avgPerMonth: totalRequests / monthCount,
      modelTotals: Object.fromEntries(modelTotals),
      defaultMultipliers,
      daily: buildSeries(dailyMap, fillDayRange),
      weekly: buildSeries(weeklyMap, fillWeekRange),
      monthly: buildSeries(monthlyMap, fillMonthRange),
    };
  }

  getBurndown(config: BurndownConfig, f?: DateFilter): BurndownData {
    const budget = config.customBudget ?? SKU_BUDGETS[config.sku] ?? 300;
    const now = new Date();
    const targetMonth = config.month || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const [yr, mo] = targetMonth.split('-').map(Number);
    const daysInMonth = new Date(yr, mo, 0).getDate();
    const dayOfMonth = (yr === now.getFullYear() && mo === now.getMonth() + 1) ? now.getDate() : daysInMonth;

    const monthStart = `${targetMonth}-01`;
    const monthEnd = `${targetMonth}-${String(daysInMonth).padStart(2, '0')}`;

    const reqs = this.filter({ ...f, fromDate: monthStart, toDate: monthEnd });
    const dailyReqs = new Map<number, number>();
    for (const r of reqs) {
      const d = new Date(r.timestamp!).getDate();
      const mult = modelMultiplier(normalizeModel(r.modelId || 'untracked', true));
      dailyReqs.set(d, (dailyReqs.get(d) || 0) + mult);
    }

    const labels: string[] = [];
    const values: number[] = [];
    const cumulative: number[] = [];
    let cum = 0;
    for (let d = 1; d <= daysInMonth; d++) {
      labels.push(String(d));
      const v = dailyReqs.get(d) || 0;
      values.push(v);
      cum += v;
      cumulative.push(cum);
    }

    const consumed = cum;
    const dailyRate = dayOfMonth > 0 ? consumed / dayOfMonth : 0;
    const projected = dailyRate * daysInMonth;

    const projectedLine = labels.map((_, i) => dailyRate * (i + 1));
    const budgetLine = labels.map((_, i) => (budget / daysInMonth) * (i + 1));

    let status: 'on-track' | 'warning' | 'over-budget' = 'on-track';
    let recommendation: string;
    if (consumed > budget) {
      status = 'over-budget';
      recommendation = `Over budget by ${Math.round(consumed - budget)} requests. Consider switching to lighter models (gpt-4.1-mini, gemini-flash).`;
    } else if (projected > budget * 0.9) {
      status = 'warning';
      const remaining = budget - consumed;
      const daysLeft = daysInMonth - dayOfMonth;
      const allowPerDay = daysLeft > 0 ? Math.round(remaining / daysLeft) : 0;
      recommendation = `On pace to exceed budget. ${remaining} requests remaining, ~${allowPerDay}/day left.`;
    } else {
      const remaining = budget - consumed;
      recommendation = `Healthy usage. ${remaining} requests remaining. Projected ${Math.round(projected)} of ${budget}.`;
    }

    return {
      currentMonth: targetMonth,
      daysInMonth, dayOfMonth, budget,
      consumed, projected,
      dailyConsumption: { labels, values, cumulative },
      projectedLine, budgetLine,
      status, recommendation,
    };
  }

  /* ---- AI Credit (usage-based billing) analytics ---- */

  getAiCredits(f?: DateFilter): AiCreditData {
    const reqs = this.filter(f);
    const billing = computeBilling(this.sessions);
    const summary = this.createAiCreditSummary();

    for (const request of reqs) {
      this.applyAiCreditRequest(summary, request, billing.get(request));
    }

    summary.topRequests.sort((a, b) => (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens));
    summary.topRequests.splice(10);
    const allModels = Array.from(summary.costByModel.keys()).sort((a, b) =>
      (summary.costByModel.get(b)?.credits || 0) - (summary.costByModel.get(a)?.credits || 0)
    );
    const countedDays = new Set(
      reqs.filter(request => billing.get(request)?.status === 'complete').map(request => toDateStr(request.timestamp!)),
    );

    return {
      totalCredits: Math.round(summary.totalCredits * 100) / 100,
      totalInputTokens: Math.round(summary.totalInputTokens),
      totalOutputTokens: Math.round(summary.totalOutputTokens),
      totalCacheReadTokens: Math.round(summary.totalCacheReadTokens),
      totalCacheWriteTokens: Math.round(summary.totalCacheWriteTokens),
      totalRequests: reqs.length,
      countedRequests: summary.countedCount,
      partialRequests: summary.partialCount,
      pendingRequests: summary.pendingCount,
      noDataRequests: summary.noDataCount,
      delegatedRequests: 0,
      finalizableRequests: reqs.length - summary.pendingCount - summary.noDataCount,
      missingPct: computeMissingPct(reqs.length, summary.countedCount, summary.partialCount, summary.pendingCount, summary.noDataCount),
      avgCreditsPerRequest: summary.countedCount > 0 ? Math.round((summary.totalCredits / summary.countedCount) * 100) / 100 : 0,
      avgCreditsPerDay: Math.round((summary.totalCredits / Math.max(countedDays.size, 1)) * 100) / 100,
      costByModel: this.buildAiCreditCostByModel(summary.costByModel),
      daily: this.buildAiCreditSeries(summary.dailyMap, allModels, keys => fillDayRange(this.anchorFromDate(keys, f))),
      weekly: this.buildAiCreditSeries(summary.weeklyMap, allModels, fillWeekRange),
      dailyTokensByWorkspace: this.buildDailyTokensByWorkspace(summary.dailyTokensByWorkspace, keys => fillDayRange(this.anchorFromDate(keys, f))),
      dailyTokensByHarness: this.buildDailyTokensByHarness(summary.dailyTokensByHarness, keys => fillDayRange(this.anchorFromDate(keys, f))),
      topRequests: summary.topRequests,
    };
  }

  private createAiCreditSummary(): {
    costByModel: Map<string, AiCreditModelEntry>;
    dailyMap: Map<string, Map<string, number>>;
    weeklyMap: Map<string, Map<string, number>>;
    /** workspace → day → total tokens (input + output). */
    dailyTokensByWorkspace: Map<string, Map<string, number>>;
    /** harness → day → total tokens (input + output). */
    dailyTokensByHarness: Map<string, Map<string, number>>;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheReadTokens: number;
    totalCacheWriteTokens: number;
    totalCredits: number;
    countedCount: number;
    partialCount: number;
    pendingCount: number;
    noDataCount: number;
    topRequests: AiCreditData['topRequests'];
  } {
    return {
      costByModel: new Map<string, AiCreditModelEntry>(),
      dailyMap: new Map<string, Map<string, number>>(),
      weeklyMap: new Map<string, Map<string, number>>(),
      dailyTokensByWorkspace: new Map<string, Map<string, number>>(),
      dailyTokensByHarness: new Map<string, Map<string, number>>(),
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
      totalCredits: 0,
      countedCount: 0,
      partialCount: 0,
      pendingCount: 0,
      noDataCount: 0,
      topRequests: [],
    };
  }

  private applyAiCreditRequest(
    summary: ReturnType<ConsumptionAnalyzer['createAiCreditSummary']>,
    request: SessionRequest,
    billing: RequestBilling | undefined,
  ): void {
    const model = normalizeModel(request.modelId || 'untracked', true);
    const resolvedBilling: RequestBilling = billing ?? {
      uncachedInput: 0,
      totalInput: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      credits: 0,
      status: 'missing',
      partialOutput: 0,
      kind: 'exact',
    };
    const harness = this.requestSessionMap.get(request)?.harness ?? 'unknown';
    this.tallyAiCreditTotals(summary, resolvedBilling);
    this.updateAiCreditModelEntry(summary.costByModel, model, resolvedBilling, harness);
    this.addAiCreditSeriesPoint(summary, model, request, resolvedBilling);
    summary.topRequests.push({
      timestamp: request.timestamp!,
      model,
      inputTokens: Math.round(resolvedBilling.totalInput),
      outputTokens: Math.round(resolvedBilling.status === 'partial' ? resolvedBilling.partialOutput : resolvedBilling.output),
      credits: resolvedBilling.credits,
      status: resolvedBilling.status,
      aggregationKind: resolvedBilling.kind,
      preview: request.messageText.slice(0, 80),
      workspace: this.requestSessionMap.get(request)?.workspaceName ?? '',
      harness: this.requestSessionMap.get(request)?.harness ?? 'unknown',
      fullPrompt: request.messageText,
    });
  }

  private tallyAiCreditTotals(
    summary: ReturnType<ConsumptionAnalyzer['createAiCreditSummary']>,
    billing: RequestBilling,
  ): void {
    if (billing.status === 'complete') summary.countedCount++;
    else if (billing.status === 'partial') summary.partialCount++;
    else if (billing.status === 'pending') summary.pendingCount++;
    else if (billing.status === 'no-data') summary.noDataCount++;

    if (billing.status !== 'complete') return;
    summary.totalInputTokens += billing.totalInput;
    summary.totalOutputTokens += billing.output;
    summary.totalCacheReadTokens += billing.cacheRead;
    summary.totalCacheWriteTokens += billing.cacheWrite;
    summary.totalCredits += billing.credits;
  }

  private updateAiCreditModelEntry(
    costByModel: Map<string, AiCreditModelEntry>,
    model: string,
    billing: RequestBilling,
    harness: string,
  ): void {
    const entry = costByModel.get(model) ?? {
      requests: 0,
      countedRequests: 0,
      partialRequests: 0,
      pendingRequests: 0,
      noDataRequests: 0,
      missingRequests: 0,
      uncachedInputTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      credits: 0,
      harnesses: new Set<string>(),
    };
    entry.harnesses.add(harness);
    entry.requests++;
    if (billing.status === 'complete') {
      entry.countedRequests++;
      entry.uncachedInputTokens += billing.uncachedInput;
      entry.inputTokens += billing.totalInput;
      entry.outputTokens += billing.output;
      entry.cacheReadTokens += billing.cacheRead;
      entry.cacheWriteTokens += billing.cacheWrite;
      entry.credits += billing.credits;
    } else if (billing.status === 'partial') {
      entry.partialRequests++;
      entry.outputTokens += billing.partialOutput;
    } else if (billing.status === 'pending') {
      entry.pendingRequests++;
    } else if (billing.status === 'no-data') {
      entry.noDataRequests++;
    } else {
      entry.missingRequests++;
    }
    costByModel.set(model, entry);
  }

  private addAiCreditSeriesPoint(
    summary: ReturnType<ConsumptionAnalyzer['createAiCreditSummary']>,
    model: string,
    request: SessionRequest,
    billing: RequestBilling,
  ): void {
    if (billing.status !== 'complete' && billing.status !== 'partial') return;
    const day = toDateStr(request.timestamp!);
    const week = isoWeek(new Date(request.timestamp!));
    const totalTokens = billing.status === 'complete'
      ? billing.totalInput + billing.output
      : billing.partialOutput;
    for (const [mapRef, key] of [[summary.dailyMap, day], [summary.weeklyMap, week]] as const) {
      if (!mapRef.has(key)) mapRef.set(key, new Map());
      const inner = mapRef.get(key)!;
      inner.set(model, (inner.get(model) || 0) + totalTokens);
    }
    // Accumulate total tokens (input + output) per workspace and per harness per day
    const session = this.requestSessionMap.get(request);
    const ws = session?.workspaceName || 'unknown';
    if (!summary.dailyTokensByWorkspace.has(ws)) summary.dailyTokensByWorkspace.set(ws, new Map());
    const wsDay = summary.dailyTokensByWorkspace.get(ws)!;
    wsDay.set(day, (wsDay.get(day) || 0) + totalTokens);

    const harness = session?.harness || 'unknown';
    if (!summary.dailyTokensByHarness.has(harness)) summary.dailyTokensByHarness.set(harness, new Map());
    const hDay = summary.dailyTokensByHarness.get(harness)!;
    hDay.set(day, (hDay.get(day) || 0) + totalTokens);
  }

  private buildAiCreditSeries(
    map: Map<string, Map<string, number>>,
    allModels: string[],
    fillRange: (keys: string[]) => string[],
  ): AiCreditData['daily'] {
    const labels = fillRange(Array.from(map.keys()));
    const credits: number[] = [];
    const cumulative: number[] = [];
    const byModel: Record<string, number[]> = {};
    let runningTotal = 0;
    for (const model of allModels) byModel[model] = [];
    for (const label of labels) {
      const inner = map.get(label);
      let dayTotal = 0;
      if (inner) { for (const value of inner.values()) dayTotal += value; }
      credits.push(Math.round(dayTotal));
      runningTotal += dayTotal;
      cumulative.push(Math.round(runningTotal));
      for (const model of allModels) {
        byModel[model].push(Math.round(inner?.get(model) || 0));
      }
    }
    return { labels, credits, cumulative, byModel };
  }

  private buildDailyTokensByWorkspace(
    wsMap: Map<string, Map<string, number>>,
    fillRange: (keys: string[]) => string[],
  ): AiCreditData['dailyTokensByWorkspace'] {
    const allDays = new Set<string>();
    for (const dayMap of wsMap.values()) {
      for (const day of dayMap.keys()) allDays.add(day);
    }
    const labels = fillRange(Array.from(allDays));
    const byWorkspace: Record<string, number[]> = {};
    for (const [ws, dayMap] of wsMap) {
      byWorkspace[ws] = labels.map(d => Math.round(dayMap.get(d) || 0));
    }
    return { labels, byWorkspace };
  }

  private buildDailyTokensByHarness(
    harnessMap: Map<string, Map<string, number>>,
    fillRange: (keys: string[]) => string[],
  ): AiCreditData['dailyTokensByHarness'] {
    const allDays = new Set<string>();
    for (const dayMap of harnessMap.values()) {
      for (const day of dayMap.keys()) allDays.add(day);
    }
    const labels = fillRange(Array.from(allDays));
    const byHarness: Record<string, number[]> = {};
    for (const [harness, dayMap] of harnessMap) {
      byHarness[harness] = labels.map(d => Math.round(dayMap.get(d) || 0));
    }
    return { labels, byHarness };
  }

  private buildAiCreditCostByModel(
    costByModel: Map<string, AiCreditModelEntry>,
  ): Record<string, AiCreditData['costByModel'][string]> {
    const out: Record<string, AiCreditData['costByModel'][string]> = {};
    for (const [model, entry] of costByModel) {
      const finalizableRequests = entry.requests - entry.pendingRequests - entry.noDataRequests;
      out[model] = {
        requests: entry.requests,
        countedRequests: entry.countedRequests,
        partialRequests: entry.partialRequests,
        pendingRequests: entry.pendingRequests,
        noDataRequests: entry.noDataRequests,
        delegatedRequests: 0,
        finalizableRequests,
        uncachedInputTokens: Math.round(entry.uncachedInputTokens),
        inputTokens: Math.round(entry.inputTokens),
        outputTokens: Math.round(entry.outputTokens),
        cacheReadTokens: Math.round(entry.cacheReadTokens),
        cacheWriteTokens: Math.round(entry.cacheWriteTokens),
        credits: entry.credits,
        missingPct: computeMissingPct(entry.requests, entry.countedRequests, entry.partialRequests, entry.pendingRequests, entry.noDataRequests),
        harnesses: Array.from(entry.harnesses).sort(),
      };
    }
    return out;
  }

  getAiCreditBurndown(config: BurndownConfig, f?: DateFilter): AiCreditBurndownData {
    const modelBudgetsIn = config.modelBudgets ?? {};
    const budget = config.customBudget ?? Object.values(modelBudgetsIn).reduce((a, b) => a + b, 0);
    const now = new Date();
    const targetMonth = config.month || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const [yr, mo] = targetMonth.split('-').map(Number);
    const daysInMonth = new Date(yr, mo, 0).getDate();
    const dayOfMonth = (yr === now.getFullYear() && mo === now.getMonth() + 1) ? now.getDate() : daysInMonth;
    const monthStart = `${targetMonth}-01`;
    const monthEnd = `${targetMonth}-${String(daysInMonth).padStart(2, '0')}`;
    const reqs = this.filter({ ...f, fromDate: monthStart, toDate: monthEnd });
    const burndown = this.buildAiCreditBurndownData(reqs, computeBilling(this.sessions), daysInMonth);
    const series = this.buildAiCreditBurndownSeries(burndown.dailyTokens, daysInMonth);
    const consumed = Math.round(series.total);
    const dailyRate = dayOfMonth > 0 ? consumed / dayOfMonth : 0;
    const projected = Math.round(dailyRate * daysInMonth);
    const projectedLine = series.labels.map((_, i) => Math.round(dailyRate * (i + 1)));
    // Budget line is a flat horizontal line at the budget value (a ceiling)
    const budgetLine = series.labels.map(() => budget);
    const remaining = budget > 0 ? budget - consumed : 0;
    const safeDailyBudget = budget > 0 && daysInMonth > dayOfMonth ? Math.round(remaining / (daysInMonth - dayOfMonth)) : 0;
    const daysUntilExhaustion = budget > 0 && dailyRate > 0 ? Math.round(remaining / dailyRate) : null;
    const projectedOverage = budget > 0 ? Math.max(0, projected - budget) : 0;
    const missingPct = computeMissingPct(reqs.length, burndown.countedCount, burndown.partialCount, burndown.pendingCount, burndown.noDataCount);
    const recommendation = this.getAiCreditBurndownRecommendation({
      budget,
      consumed,
      projected,
      totalRequests: reqs.length,
      countedCount: burndown.countedCount,
      pendingCount: burndown.pendingCount,
      noDataCount: burndown.noDataCount,
      safeDailyBudget,
      missingPct,
      remaining,
    });

    // Build per-model cumulative data
    const byModel: Record<string, { cumulative: number[]; budget: number }> = {};
    for (const [model, dayMap] of burndown.dailyTokensByModel) {
      const cumulative: number[] = [];
      let running = 0;
      for (let day = 1; day <= daysInMonth; day++) {
        running += dayMap.get(day) || 0;
        cumulative.push(Math.round(running));
      }
      byModel[model] = { cumulative, budget: modelBudgetsIn[model] || 0 };
    }

    return {
      currentMonth: targetMonth,
      daysInMonth,
      dayOfMonth,
      budget,
      consumed,
      projected,
      dailyConsumption: { labels: series.labels, values: series.values, cumulative: series.cumulative },
      projectedLine,
      budgetLine,
      status: recommendation.status,
      recommendation: recommendation.recommendation,
      daysUntilExhaustion,
      safeDailyBudget,
      projectedOverage,
      missingPct,
      totalRequests: reqs.length,
      countedRequests: burndown.countedCount,
      partialRequests: burndown.partialCount,
      pendingRequests: burndown.pendingCount,
      noDataRequests: burndown.noDataCount,
      delegatedRequests: 0,
      finalizableRequests: reqs.length - burndown.pendingCount - burndown.noDataCount,
      coverageByDay: burndown.coverageByDay,
      byModel,
    };
  }

  private buildAiCreditBurndownData(
    reqs: SessionRequest[],
    billing: Map<SessionRequest, RequestBilling>,
    daysInMonth: number,
  ): {
    dailyTokens: Map<number, number>;
    dailyTokensByModel: Map<string, Map<number, number>>;
    coverageByDay: AiCreditBurndownData['coverageByDay'];
    countedCount: number;
    partialCount: number;
    pendingCount: number;
    noDataCount: number;
  } {
    const dailyTokens = new Map<number, number>();
    const dailyTokensByModel = new Map<string, Map<number, number>>();
    const coverageByDay = {
      complete: Array<number>(daysInMonth).fill(0),
      partial: Array<number>(daysInMonth).fill(0),
      pending: Array<number>(daysInMonth).fill(0),
      noData: Array<number>(daysInMonth).fill(0),
      delegated: Array<number>(daysInMonth).fill(0),
      missing: Array<number>(daysInMonth).fill(0),
    };
    let countedCount = 0;
    let partialCount = 0;
    let pendingCount = 0;
    let noDataCount = 0;

    for (const request of reqs) {
      const requestBilling = billing.get(request);
      const status = requestBilling?.status ?? 'missing';
      const dayIdx = new Date(request.timestamp!).getDate() - 1;
      if (dayIdx >= 0 && dayIdx < daysInMonth) {
        const bucket =
          status === 'complete' ? 'complete' :
          status === 'partial' ? 'partial' :
          status === 'pending' ? 'pending' :
          status === 'no-data' ? 'noData' :
          'missing';
        coverageByDay[bucket][dayIdx]++;
      }
      if (status === 'complete') {
        countedCount++;
        const tokens = (requestBilling?.totalInput ?? 0) + (requestBilling?.output ?? 0);
        dailyTokens.set(dayIdx + 1, (dailyTokens.get(dayIdx + 1) || 0) + tokens);
        const model = normalizeModel(request.modelId ?? 'unknown', true);
        if (!dailyTokensByModel.has(model)) dailyTokensByModel.set(model, new Map());
        const modelDay = dailyTokensByModel.get(model)!;
        modelDay.set(dayIdx + 1, (modelDay.get(dayIdx + 1) || 0) + tokens);
      } else if (status === 'partial') {
        partialCount++;
      } else if (status === 'pending') {
        pendingCount++;
      } else if (status === 'no-data') {
        noDataCount++;
      }
    }

    return { dailyTokens, dailyTokensByModel, coverageByDay, countedCount, partialCount, pendingCount, noDataCount };
  }

  private buildAiCreditBurndownSeries(
    dailyTokens: Map<number, number>,
    daysInMonth: number,
  ): { labels: string[]; values: number[]; cumulative: number[]; total: number } {
    const labels: string[] = [];
    const values: number[] = [];
    const cumulative: number[] = [];
    let total = 0;
    for (let day = 1; day <= daysInMonth; day++) {
      labels.push(String(day));
      const value = dailyTokens.get(day) || 0;
      values.push(Math.round(value));
      total += value;
      cumulative.push(Math.round(total));
    }
    return { labels, values, cumulative, total };
  }

  private getAiCreditBurndownRecommendation(params: {
    budget: number;
    consumed: number;
    projected: number;
    totalRequests: number;
    countedCount: number;
    pendingCount: number;
    noDataCount: number;
    safeDailyBudget: number;
    missingPct: number;
    remaining: number;
  }): { status: AiCreditBurndownData['status']; recommendation: string } {
    const partialNote = params.missingPct > 0 && params.missingPct < 100
      ? ` Note: ${params.missingPct}% of finalizable requests in this period are missing native token data, so consumed/projected values are a lower bound.`
      : '';
    if (params.countedCount === 0) {
      if (params.totalRequests === 0) {
        return { status: 'no-data', recommendation: 'No requests in this period.' };
      }
      if (params.pendingCount > 0) {
        return {
          status: 'pending-only',
          recommendation: `All ${params.totalRequests} request${params.totalRequests === 1 ? '' : 's'} in this period are still pending or were aborted before any model output. Token data may yet arrive — check back once sessions finalize.`,
        };
      }
      if (params.noDataCount === params.totalRequests) {
        return {
          status: 'no-data',
          recommendation: `All ${params.totalRequests} request${params.totalRequests === 1 ? '' : 's'} in this period are from sources that don't record token usage (e.g. Xcode). Token budget tracking is not possible for this slice.`,
        };
      }
      return {
        status: 'no-data',
        recommendation: `No native token data available for any of the ${params.totalRequests} requests in this period — the harness did not report token counts, so token usage cannot be computed.`,
      };
    }
    if (params.consumed > params.budget) {
      return {
        status: 'will-exceed',
        recommendation: `Over budget by ${Math.round(params.consumed - params.budget).toLocaleString()} tokens. Consider using lighter models or shorter prompts.${partialNote}`,
      };
    }
    if (params.projected > params.budget * 0.9) {
      return {
        status: 'warning',
        recommendation: `On pace to exceed budget. ${Math.round(params.remaining).toLocaleString()} tokens remaining, ~${Math.round(params.safeDailyBudget).toLocaleString()}/day safe. Consider switching to GPT-5 mini or Gemini Flash.${partialNote}`,
      };
    }
    return {
      status: 'on-track',
      recommendation: `Healthy usage. ${Math.round(params.remaining).toLocaleString()} tokens remaining. Projected ${Math.round(params.projected).toLocaleString()} of ${params.budget.toLocaleString()}.${partialNote}`,
    };
  }

  /** Token-data coverage across the analyzed window — diagnoses how much
   *  of the workspace/harness footprint actually has billable token data
   *  (vs missing). Used by the "Token Coverage" overview panel. */
  getTokenCoverage(f?: DateFilter): TokenCoverageData {
    const reqs = this.filter(f);
    const sessionByRequest = this.buildSessionByRequestMap();
    const aggregates = this.buildTokenCoverageAggregates(reqs, computeBilling(this.sessions), sessionByRequest);

    return {
      totalSessions: aggregates.inWindowSessions.size,
      totalRequests: reqs.length,
      totalWorkspaces: new Set(Array.from(aggregates.inWindowSessions, s => s.workspaceId || s.workspaceName || 'unknown')).size,
      totalHarnesses: aggregates.harnessMap.size,
      countedSessions: aggregates.countedSessionSet.size,
      countedRequests: aggregates.countedRequests,
      missingRequests: aggregates.missingRequests,
      partialRequests: aggregates.partialRequests,
      pendingRequests: aggregates.pendingRequests,
      noDataRequests: aggregates.noDataRequests,
      activeSessions: aggregates.activeSessionSet.size,
      abortedSessions: aggregates.abortedSessionSet.size,
      missingPct: this.computeOverallMissingPct(reqs.length, aggregates.pendingRequests, aggregates.noDataRequests, aggregates.missingRequests),
      totalInputTokens: aggregates.totalInputTokens,
      totalOutputTokens: aggregates.totalOutputTokens,
      partialOutputTokens: aggregates.partialOutputTotal,
      totalCacheReadTokens: aggregates.totalCacheReadTokens,
      totalCacheWriteTokens: aggregates.totalCacheWriteTokens,
      byHarness: this.buildTokenCoverageByHarness(aggregates.harnessMap),
      byWorkspace: this.buildTokenCoverageByWorkspace(aggregates.workspaceMap),
      bySession: this.buildTokenCoverageBySession(aggregates.sessionMap),
      timeline: this.buildTokenCoverageTimeline(aggregates.timelineMap, aggregates.harnessMap),
    };
  }

  private buildSessionByRequestMap(): Map<SessionRequest, Session> {
    const sessionByRequest = new Map<SessionRequest, Session>();
    for (const session of this.sessions) {
      for (const request of session.requests) sessionByRequest.set(request, session);
    }
    return sessionByRequest;
  }

  private buildTokenCoverageAggregates(
    reqs: SessionRequest[],
    billing: Map<SessionRequest, RequestBilling>,
    sessionByRequest: Map<SessionRequest, Session>,
  ): {
    inWindowSessions: Set<Session>;
    harnessMap: Map<string, { sessions: Set<Session>; workspaces: Set<string>; requests: number; counted: number; partial: number; pending: number; noData: number; input: number; output: number; partialOutput: number; cacheRead: number; cacheWrite: number; hasExact: boolean; hasAggregated: boolean }>;
    workspaceMap: Map<string, { workspaceId: string; workspaceName: string; sessions: Set<Session>; harnesses: Set<string>; requests: number; counted: number; partial: number; pending: number; noData: number; input: number; output: number }>;
    sessionMap: Map<Session, { requests: number; counted: number; partial: number; pending: number; noData: number; input: number; output: number; hasExact: boolean; hasAggregated: boolean }>;
    timelineMap: Map<string, Map<string, { requests: number; counted: number; partial: number; pending: number; noData: number }>>;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheReadTokens: number;
    totalCacheWriteTokens: number;
    partialOutputTotal: number;
    countedRequests: number;
    missingRequests: number;
    partialRequests: number;
    pendingRequests: number;
    noDataRequests: number;
    countedSessionSet: Set<Session>;
    activeSessionSet: Set<Session>;
    abortedSessionSet: Set<Session>;
  } {
    const inWindowSessions = new Set<Session>();
    const harnessMap = new Map<string, { sessions: Set<Session>; workspaces: Set<string>; requests: number; counted: number; partial: number; pending: number; noData: number; input: number; output: number; partialOutput: number; cacheRead: number; cacheWrite: number; hasExact: boolean; hasAggregated: boolean }>();
    const workspaceMap = new Map<string, { workspaceId: string; workspaceName: string; sessions: Set<Session>; harnesses: Set<string>; requests: number; counted: number; partial: number; pending: number; noData: number; input: number; output: number }>();
    const sessionMap = new Map<Session, { requests: number; counted: number; partial: number; pending: number; noData: number; input: number; output: number; hasExact: boolean; hasAggregated: boolean }>();
    const timelineMap = new Map<string, Map<string, { requests: number; counted: number; partial: number; pending: number; noData: number }>>();
    const countedSessionSet = new Set<Session>();
    const activeSessionSet = new Set<Session>();
    const abortedSessionSet = new Set<Session>();
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheReadTokens = 0;
    let totalCacheWriteTokens = 0;
    let partialOutputTotal = 0;
    let countedRequests = 0;
    let missingRequests = 0;
    let partialRequests = 0;
    let pendingRequests = 0;
    let noDataRequests = 0;

    for (const request of reqs) {
      const session = sessionByRequest.get(request);
      if (!session) continue;
      inWindowSessions.add(session);
      if (session.endReason === 'active') activeSessionSet.add(session);
      if (session.endReason === 'aborted') abortedSessionSet.add(session);
      const harness = session.harness || 'Unknown';
      const wsKey = session.workspaceId || session.workspaceName || 'unknown';
      const requestBilling = billing.get(request);
      const status = requestBilling?.status ?? 'missing';
      const harnessEntry = this.getTokenCoverageHarnessEntry(harnessMap, harness, session, wsKey);
      const workspaceEntry = this.getTokenCoverageWorkspaceEntry(workspaceMap, wsKey, session, harness);
      const sessionEntry = this.getTokenCoverageSessionEntry(sessionMap, session);
      this.updateTokenCoverageTimeline(timelineMap, harness, request.timestamp, status);

      if (status === 'complete' && requestBilling) {
        countedRequests++;
        countedSessionSet.add(session);
        harnessEntry.counted++;
        workspaceEntry.counted++;
        sessionEntry.counted++;
        harnessEntry.input += requestBilling.totalInput;
        harnessEntry.output += requestBilling.output;
        harnessEntry.cacheRead += requestBilling.cacheRead;
        harnessEntry.cacheWrite += requestBilling.cacheWrite;
        workspaceEntry.input += requestBilling.totalInput;
        workspaceEntry.output += requestBilling.output;
        sessionEntry.input += requestBilling.totalInput;
        sessionEntry.output += requestBilling.output;
        if (requestBilling.kind === 'exact') {
          harnessEntry.hasExact = true;
          sessionEntry.hasExact = true;
        } else {
          harnessEntry.hasAggregated = true;
          sessionEntry.hasAggregated = true;
        }
        totalInputTokens += requestBilling.totalInput;
        totalOutputTokens += requestBilling.output;
        totalCacheReadTokens += requestBilling.cacheRead;
        totalCacheWriteTokens += requestBilling.cacheWrite;
        continue;
      }

      if (status === 'partial' && requestBilling) {
        partialRequests++;
        harnessEntry.partial++;
        harnessEntry.partialOutput += requestBilling.partialOutput;
        workspaceEntry.partial++;
        sessionEntry.partial++;
        partialOutputTotal += requestBilling.partialOutput;
      } else if (status === 'pending') {
        pendingRequests++;
        harnessEntry.pending++;
        workspaceEntry.pending++;
        sessionEntry.pending++;
      } else if (status === 'no-data') {
        noDataRequests++;
        harnessEntry.noData++;
        workspaceEntry.noData++;
        sessionEntry.noData++;
      } else {
        missingRequests++;
      }
    }

    return {
      inWindowSessions,
      harnessMap,
      workspaceMap,
      sessionMap,
      timelineMap,
      totalInputTokens,
      totalOutputTokens,
      totalCacheReadTokens,
      totalCacheWriteTokens,
      partialOutputTotal,
      countedRequests,
      missingRequests,
      partialRequests,
      pendingRequests,
      noDataRequests,
      countedSessionSet,
      activeSessionSet,
      abortedSessionSet,
    };
  }

  private getTokenCoverageHarnessEntry(
    harnessMap: Map<string, { sessions: Set<Session>; workspaces: Set<string>; requests: number; counted: number; partial: number; pending: number; noData: number; input: number; output: number; partialOutput: number; cacheRead: number; cacheWrite: number; hasExact: boolean; hasAggregated: boolean }>,
    harness: string,
    session: Session,
    wsKey: string,
  ) {
    let entry = harnessMap.get(harness);
    if (!entry) {
      entry = { sessions: new Set(), workspaces: new Set(), requests: 0, counted: 0, partial: 0, pending: 0, noData: 0, input: 0, output: 0, partialOutput: 0, cacheRead: 0, cacheWrite: 0, hasExact: false, hasAggregated: false };
      harnessMap.set(harness, entry);
    }
    entry.sessions.add(session);
    entry.workspaces.add(wsKey);
    entry.requests++;
    return entry;
  }

  private getTokenCoverageWorkspaceEntry(
    workspaceMap: Map<string, { workspaceId: string; workspaceName: string; sessions: Set<Session>; harnesses: Set<string>; requests: number; counted: number; partial: number; pending: number; noData: number; input: number; output: number }>,
    wsKey: string,
    session: Session,
    harness: string,
  ) {
    let entry = workspaceMap.get(wsKey);
    if (!entry) {
      entry = { workspaceId: session.workspaceId || wsKey, workspaceName: session.workspaceName || wsKey, sessions: new Set(), harnesses: new Set(), requests: 0, counted: 0, partial: 0, pending: 0, noData: 0, input: 0, output: 0 };
      workspaceMap.set(wsKey, entry);
    }
    entry.sessions.add(session);
    entry.harnesses.add(harness);
    entry.requests++;
    return entry;
  }

  private getTokenCoverageSessionEntry(
    sessionMap: Map<Session, { requests: number; counted: number; partial: number; pending: number; noData: number; input: number; output: number; hasExact: boolean; hasAggregated: boolean }>,
    session: Session,
  ) {
    let entry = sessionMap.get(session);
    if (!entry) {
      entry = { requests: 0, counted: 0, partial: 0, pending: 0, noData: 0, input: 0, output: 0, hasExact: false, hasAggregated: false };
      sessionMap.set(session, entry);
    }
    entry.requests++;
    return entry;
  }

  private updateTokenCoverageTimeline(
    timelineMap: Map<string, Map<string, { requests: number; counted: number; partial: number; pending: number; noData: number }>>,
    harness: string,
    timestamp: number | null,
    status: RequestBilling['status'] | 'missing',
  ): void {
    if (timestamp == null) return;
    const date = new Date(timestamp);
    const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    if (!timelineMap.has(harness)) timelineMap.set(harness, new Map());
    const monthMap = timelineMap.get(harness)!;
    if (!monthMap.has(month)) monthMap.set(month, { requests: 0, counted: 0, partial: 0, pending: 0, noData: 0 });
    const cell = monthMap.get(month)!;
    cell.requests++;
    if (status === 'complete') cell.counted++;
    else if (status === 'partial') cell.partial++;
    else if (status === 'pending') cell.pending++;
    else if (status === 'no-data') cell.noData++;
  }

  private getTokenCoverageSource(hasCounted: number, hasPartial: number, hasExact: boolean, hasAggregated: boolean): TokenCoverageHarness['source'] {
    if (hasCounted === 0 && hasPartial === 0) return 'none';
    if (hasExact && hasAggregated) return 'mixed';
    if (hasAggregated) return 'session-aggregated';
    return 'per-request';
  }

  private buildTokenCoverageByHarness(
    harnessMap: Map<string, { sessions: Set<Session>; workspaces: Set<string>; requests: number; counted: number; partial: number; pending: number; noData: number; input: number; output: number; partialOutput: number; cacheRead: number; cacheWrite: number; hasExact: boolean; hasAggregated: boolean }>,
  ): TokenCoverageHarness[] {
    return Array.from(harnessMap.entries())
      .map(([harness, entry]) => ({
        harness,
        sessions: entry.sessions.size,
        workspaces: entry.workspaces.size,
        requests: entry.requests,
        countedRequests: entry.counted,
        partialRequests: entry.partial,
        pendingRequests: entry.pending,
        noDataRequests: entry.noData,
        missingPct: computeMissingPct(entry.requests, entry.counted, entry.partial, entry.pending, entry.noData),
        inputTokens: Math.round(entry.input),
        outputTokens: Math.round(entry.output),
        partialOutputTokens: Math.round(entry.partialOutput),
        cacheReadTokens: Math.round(entry.cacheRead),
        cacheWriteTokens: Math.round(entry.cacheWrite),
        source: this.getTokenCoverageSource(entry.counted, entry.partial, entry.hasExact, entry.hasAggregated),
      }))
      .sort((a, b) => b.requests - a.requests);
  }

  private buildTokenCoverageByWorkspace(
    workspaceMap: Map<string, { workspaceId: string; workspaceName: string; sessions: Set<Session>; harnesses: Set<string>; requests: number; counted: number; partial: number; pending: number; noData: number; input: number; output: number }>,
  ): TokenCoverageWorkspace[] {
    return Array.from(workspaceMap.values())
      .map(entry => ({
        workspaceId: entry.workspaceId,
        workspaceName: entry.workspaceName,
        harnesses: [...entry.harnesses].sort(),
        sessions: entry.sessions.size,
        requests: entry.requests,
        countedRequests: entry.counted,
        partialRequests: entry.partial,
        pendingRequests: entry.pending,
        noDataRequests: entry.noData,
        missingPct: computeMissingPct(entry.requests, entry.counted, entry.partial, entry.pending, entry.noData),
        inputTokens: Math.round(entry.input),
        outputTokens: Math.round(entry.output),
      }))
      .sort((a, b) => b.requests - a.requests);
  }

  private buildTokenCoverageBySession(
    sessionMap: Map<Session, { requests: number; counted: number; partial: number; pending: number; noData: number; input: number; output: number; hasExact: boolean; hasAggregated: boolean }>,
  ): TokenCoverageSession[] {
    return Array.from(sessionMap.entries())
      .map(([session, entry]) => ({
        sessionId: session.sessionId,
        harness: session.harness || 'Unknown',
        workspaceId: session.workspaceId || session.workspaceName || 'unknown',
        workspaceName: session.workspaceName || 'unknown',
        firstMessageDate: session.creationDate ?? null,
        lastMessageDate: session.lastMessageDate ?? null,
        requests: entry.requests,
        countedRequests: entry.counted,
        partialRequests: entry.partial,
        pendingRequests: entry.pending,
        noDataRequests: entry.noData,
        missingPct: computeMissingPct(entry.requests, entry.counted, entry.partial, entry.pending, entry.noData),
        inputTokens: Math.round(entry.input),
        outputTokens: Math.round(entry.output),
        endReason: session.endReason ?? 'unknown',
        source: this.getTokenCoverageSource(entry.counted, entry.partial, entry.hasExact, entry.hasAggregated),
      }))
      .sort((a, b) => b.missingPct - a.missingPct || (b.lastMessageDate ?? 0) - (a.lastMessageDate ?? 0));
  }

  private buildTokenCoverageTimeline(
    timelineMap: Map<string, Map<string, { requests: number; counted: number; partial: number; pending: number; noData: number }>>,
    harnessMap: Map<string, unknown>,
  ): TokenCoverageTimeline {
    const months = Array.from(new Set(Array.from(timelineMap.values()).flatMap(monthMap => [...monthMap.keys()]))).sort();
    const harnesses = [...harnessMap.keys()].sort();
    const cells: Record<string, Record<string, TokenCoverageTimelineCell | undefined>> = {};
    for (const harness of harnesses) {
      cells[harness] = {};
      const monthMap = timelineMap.get(harness);
      if (!monthMap) continue;
      for (const month of months) {
        const cell = monthMap.get(month);
        if (!cell) continue;
        cells[harness][month] = {
          requests: cell.requests,
          countedRequests: cell.counted,
          partialRequests: cell.partial,
          pendingRequests: cell.pending,
          noDataRequests: cell.noData,
          missingPct: computeMissingPct(cell.requests, cell.counted, cell.partial, cell.pending, cell.noData),
        };
      }
    }
    return { months, harnesses, cells };
  }

  private computeOverallMissingPct(totalRequests: number, pendingRequests: number, noDataRequests: number, missingRequests: number): number {
    const finalizableTotal = totalRequests - pendingRequests - noDataRequests;
    return finalizableTotal > 0 ? Math.round((missingRequests / finalizableTotal) * 100) : 0;
  }
}
