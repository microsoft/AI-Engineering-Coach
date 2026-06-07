/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * Authless data-pipeline harness.
 *
 * Points the REAL extension parser + analyzer at a fixtures HOME directory and
 * exposes:
 *   - buildPipeline(home): run findLogsDirs → parseAllLogs → new Analyzer
 *   - assertPipeline(...): structural assertions over the parsed analytics
 *   - buildRpcFixtures(analyzer): precompute every read-only RPC response that
 *     the webview issues on page load, so a static harness can serve REAL data
 *     (driven by fixtures, no VS Code / Copilot account required).
 *
 * This is the core of the authless verification: it proves the entire
 * fixtures → parser → analyzer → RPC contract works end-to-end without any
 * login, exactly the surface the webview renders from.
 */

import * as path from 'path';
import { findLogsDirs, parseAllLogs, type ParseResult } from '../../../src/core/parser';
import { Analyzer } from '../../../src/core/analyzer';
import { getRpcHandler } from '../../../src/webview/panel-rpc';

export interface Pipeline {
  result: ParseResult;
  analyzer: Analyzer;
}

/** Run the production discovery + parse + analyzer build against `home`. */
export function buildPipeline(home: string): Pipeline {
  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const dirs = findLogsDirs();
    const result = parseAllLogs(dirs);
    const analyzer = new Analyzer(result.sessions, result.editLocIndex, result.workspaces);
    return { result, analyzer };
  } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevProfile;
  }
}

export interface AssertionResult {
  label: string;
  ok: boolean;
  detail?: string;
}

/** Structural assertions over the analytics produced from the fixtures. */
export function assertPipeline(p: Pipeline): AssertionResult[] {
  const out: AssertionResult[] = [];
  const add = (label: string, ok: boolean, detail?: string) => out.push({ label, ok, detail });

  const sessions = p.result.sessions;
  add('parsed at least 10 sessions', sessions.length >= 10, `got ${sessions.length}`);
  add('parsed at least 3 workspaces', p.result.workspaces.size >= 3, `got ${p.result.workspaces.size}`);

  const harnesses = p.analyzer.getHarnesses();
  // Expect a mix of harnesses from the different fixture generators.
  const expectedHarnessHints = ['Claude', 'Codex', 'Copilot', 'Local Agent', 'OpenCode'];
  const matched = expectedHarnessHints.filter(h => harnesses.some(x => x.includes(h)));
  add('multiple harnesses detected (>=4 of 5 families)', matched.length >= 4, `matched ${matched.join(', ')} of ${harnesses.join(', ')}`);

  const stats = p.analyzer.getStats();
  add('stats report sessions', (stats.totalSessions ?? 0) > 0, JSON.stringify(stats));
  add('stats report requests', (stats.totalRequests ?? 0) > 0);

  const prod = p.analyzer.getCodeProduction();
  add('code production attributes AI lines of code', (prod.summary?.totalAiLoc ?? 0) > 0, `aiLoc=${prod.summary?.totalAiLoc}`);
  add('code production has language breakdown', (prod.byLanguage?.labels?.length ?? 0) > 0);

  const daily = p.analyzer.getDailyActivity();
  add('daily activity has labels', (daily.labels?.length ?? 0) > 0);

  const anti = p.analyzer.getAntiPatterns();
  add('anti-patterns analysis returns group scores', (anti.groupScores?.length ?? 0) > 0);

  const ctx = p.analyzer.getContextManagement();
  add('context management produces an overall score', typeof ctx.overallScore === 'number');

  return out;
}

/** The RPC methods the webview issues on page load that depend only on the
 *  active dataset. Each is dispatched through the REAL production RPC handler
 *  (`getRpcHandler`), so a static harness can serve REAL data — exactly the
 *  bytes the extension would return — driven by fixtures with no login.
 *
 *  Driving the real handlers (rather than calling the analyzer directly) means
 *  feature-flag gating, param validation and the data-explorer / rule-coverage
 *  logic are all exercised authentically.
 */
export function buildRpcFixtures(p: Pipeline): Record<string, unknown> {
  const { analyzer, result } = p;
  const filter = {}; // "all workspaces / all harnesses / full range" default
  const fixtures: Record<string, unknown> = {};

  // Methods the webview pages fetch on load, with the params each expects.
  const firstWs = analyzer.getWorkspaces()[0];
  const calls: Array<[string, Record<string, unknown>]> = [
    ['getStats', filter],
    ['getWorkspaces', {}],
    ['getHarnesses', {}],
    ['getHarnessBreakdown', filter],
    ['getDailyActivity', filter],
    ['getWorkspaceBreakdown', filter],
    ['getHourlyDistribution', filter],
    ['getHeatmap', filter],
    ['getCalendarActivity', filter],
    ['getCodeProduction', filter],
    ['getProjectOverview', filter],
    ['getAntiPatterns', filter],
    ['getRuleEditor', filter],
    ['getRuleCoverage', { filter }],
    ['getHarnessComparison', filter],
    ['getWorkLifeBalance', filter],
    ['getInsights', filter],
    ['getFlowState', filter],
    ['getContextManagement', { filter }],
    ['getContextRangeAvailability', { filter }],
    ['getConfigHealth', filter],
    ['getImageGallery', filter],
    ['getWorkflowOptimization', filter],
    ['getParserCoverage', {}],
    ['getDayTimeline', { filter }],
    ['getSessions', { page: 1, pageSize: 25, filter }],
    ['getDataExplorerFields', filter],
    // Token-reporting methods self-gate on the feature flag inside the handler,
    // so these naturally return the production "disabled" error when the flag is off.
    ['getConsumption', filter],
    ['getAiCredits', filter],
    ['getTokenCoverage', filter],
    ['getBurndown', { config: {}, filter }],
    ['getAiCreditBurndown', { config: {}, filter }],
  ];
  if (firstWs) {
    calls.push(['getWorkspaceContextSessions', { workspaceId: firstWs.id, filter }]);
  }

  for (const [name, params] of calls) {
    try {
      const handler = getRpcHandler(name);
      if (!handler) {
        fixtures[name] = { error: `No RPC handler registered for ${name}` };
        continue;
      }
      const value = handler(analyzer, result, params);
      fixtures[name] = value instanceof Promise ? { error: `${name} is async; not precomputed` } : value;
    } catch (err) {
      fixtures[name] = { error: err instanceof Error ? err.message : String(err) };
    }
  }

  return fixtures;
}

/** Convenience: resolve a default fixtures HOME inside the artifacts dir. */
export function defaultFixturesHome(): string {
  return path.resolve(__dirname, '..', '.artifacts', 'home');
}
