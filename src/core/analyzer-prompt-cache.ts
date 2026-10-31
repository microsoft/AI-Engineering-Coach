/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Prompt Cache tab: cache efficiency per harness (never pooled across harnesses) and, for Copilot CLI and
 * Copilot App, why the cache broke. Totals count the requests sent in the date range, like Context
 * Composition; a break counts when the request it happened in is in range. */

import type {
  CacheAttribution,
  CacheBreak,
  CacheCauseKey,
  CacheSessionSummary,
  CacheStream,
  DateFilter,
  HarnessPromptCache,
  ModelPromptCache,
  PromptCacheData,
  PromptCacheSessionsData,
  PromptCacheTrend,
  RequestPromptCache,
  Session,
  SessionRequest,
  SessionTimelineData,
  WorkspacePromptCache,
} from './types';
import { AnalyzerBase } from './analyzer-base';
import { toDateStr } from './helpers';
import { addUsage, emptyTotals, mergeTotals, missesOf, pct, toCost, toTotals, type TotalsAcc } from './prompt-cache-totals';
import { addRequestExtras, buildIdle, buildOrigins, causeKey, controlShares, emptyOrigins, summarizeCauses, totalMisses, type OriginAcc } from './prompt-cache-causes';
import { attributesBreaks, buildSessionTimeline, expectedReporting, sessionTotals, summarizeSession } from './prompt-cache-sessions';
import { promptCacheTips } from './prompt-cache-tips';

const MAX_MODELS = 12;
const MAX_WORKSPACES = 10;
const MAX_TOP_SESSIONS = 10;
const MAX_WORKSPACE_SESSIONS = 20;
const HARNESS_SHORT_NAMES = new Map([['GitHub Copilot CLI', 'Copilot CLI'], ['GitHub Copilot App', 'Copilot App']]);

interface HarnessAcc {
  streams: Record<CacheStream, TotalsAcc>;
  requests: number;
  requestsWithData: number;
  sessions: Set<Session>;
  sessionsWithData: Set<Session>;
  breaks: number;
  perCall: boolean;
  sessionTotals: boolean;
}

interface ModelAcc { harness: string; model: string; totals: TotalsAcc; mainCalls: number; breaks: number; ttl: Map<number, number> }
interface WorkspaceAcc { name: string; harness: string; sessions: Set<Session>; totals: TotalsAcc; rebuilt: number; breaks: number; causes: Map<CacheCauseKey, number> }
interface WeekAcc { input: number; read: number; mainCalls: number; breaks: number }

interface Collected {
  harnesses: Map<string, HarnessAcc>;
  included: Set<SessionRequest>;
  sessions: Set<Session>;
  origin: OriginAcc;
  attributionHarnesses: Set<string>;
  ttlCalls: Map<string, Map<number, number>>;
  models: Map<string, ModelAcc>;
  workspaces: Map<string, WorkspaceAcc>;
  weeks: Map<string, Map<string, WeekAcc>>;
  /** Listed breaks whose request is in range: they drive the cause, confidence and idle cards. */
  breaks: CacheBreak[];
  /** Every break in range, listed or not, from the request rows: they drive counts and rates. */
  countedBreaks: number;
}

function getOrCreate<K, V>(map: Map<K, V>, key: K, create: () => V): V {
  let value = map.get(key);
  if (value === undefined) {
    value = create();
    map.set(key, value);
  }
  return value;
}

function newHarness(): HarnessAcc {
  return {
    streams: { main: emptyTotals(), subagent: emptyTotals(), compaction: emptyTotals() },
    requests: 0,
    requestsWithData: 0,
    sessions: new Set(),
    sessionsWithData: new Set(),
    breaks: 0,
    perCall: false,
    sessionTotals: false,
  };
}

/** ISO date of the Monday of the timestamp's week. */
function weekLabel(ts: number): string {
  const d = new Date(ts);
  const day = d.getDay() || 7;
  const monday = new Date(d);
  monday.setDate(d.getDate() - day + 1);
  return toDateStr(monday.getTime());
}

function weekOf(c: Collected, harness: string, ts: number | null): WeekAcc | null {
  if (ts == null || ts <= 0) return null;
  const weeks = getOrCreate(c.weeks, harness, () => new Map<string, WeekAcc>());
  return getOrCreate(weeks, weekLabel(ts), () => ({ input: 0, read: 0, mainCalls: 0, breaks: 0 }));
}

function addRows(c: Collected, session: Session, request: SessionRequest, cache: RequestPromptCache): void {
  const harness = c.harnesses.get(session.harness) ?? newHarness();
  const attributed = attributesBreaks(session.harness);
  const workspace = getOrCreate(c.workspaces, `${session.workspaceName}\u0000${session.harness}`, () => (
    { name: session.workspaceName, harness: session.harness, sessions: new Set(), totals: emptyTotals(), rebuilt: 0, breaks: 0, causes: new Map() }));
  workspace.sessions.add(session);
  workspace.rebuilt += cache.rebuilt ?? 0;
  const week = weekOf(c, session.harness, request.timestamp);
  for (const row of cache.rows) {
    const breaks = row.stream === 'main' && attributed ? row.cacheBreaks ?? 0 : 0;
    addUsage(harness.streams[row.stream], row);
    addUsage(workspace.totals, row);
    harness.breaks += breaks;
    workspace.breaks += breaks;
    c.countedBreaks += breaks;
    if (week) {
      week.input += row.input;
      week.read += row.cacheRead;
      if (row.stream === 'main') week.mainCalls += row.calls;
      week.breaks += breaks;
    }
    if (attributed) addUsage(row.stream === 'main' ? c.origin.main : row.stream === 'subagent' ? c.origin.subagents : c.origin.compaction, row);
    if (row.stream === 'compaction') continue;
    const model = getOrCreate(c.models, `${session.harness}\u0000${row.model}`, () => (
      { harness: session.harness, model: row.model, totals: emptyTotals(), mainCalls: 0, breaks: 0, ttl: new Map<number, number>() }));
    addUsage(model.totals, row);
    if (row.stream !== 'main') continue;
    model.mainCalls += row.calls;
    model.breaks += breaks;
    if (row.ttlSeconds != null) {
      model.ttl.set(row.ttlSeconds, (model.ttl.get(row.ttlSeconds) ?? 0) + row.calls);
      if (attributed) {
        const ttl = getOrCreate(c.ttlCalls, row.model, () => new Map<number, number>());
        ttl.set(row.ttlSeconds, (ttl.get(row.ttlSeconds) ?? 0) + row.calls);
      }
    }
  }
  if (attributed) {
    addRequestExtras(c.origin, cache);
    c.attributionHarnesses.add(session.harness);
  }
}

function collectRequests(requests: SessionRequest[], sessionOf: (request: SessionRequest) => Session | undefined): Collected {
  const c: Collected = {
    harnesses: new Map(), included: new Set(), sessions: new Set(), origin: emptyOrigins(), attributionHarnesses: new Set(),
    ttlCalls: new Map(), models: new Map(), workspaces: new Map(), weeks: new Map(), breaks: [], countedBreaks: 0,
  };
  for (const request of requests) {
    const session = sessionOf(request);
    if (!session) continue;
    c.included.add(request);
    c.sessions.add(session);
    const harness = getOrCreate(c.harnesses, session.harness, newHarness);
    harness.requests++;
    harness.sessions.add(session);
    if (!request.promptCache) continue;
    harness.requestsWithData++;
    harness.sessionsWithData.add(session);
    harness.perCall = true;
    addRows(c, session, request, request.promptCache);
  }
  return c;
}

/** Codex logs session totals only; count each session in range once, on the main stream. */
function addSessionTotals(c: Collected): void {
  for (const session of c.sessions) {
    const totals = sessionTotals(session);
    if (!totals) continue;
    const harness = getOrCreate(c.harnesses, session.harness, newHarness);
    mergeTotals(harness.streams.main, totals);
    harness.sessionTotals = true;
    harness.sessionsWithData.add(session);
    harness.requestsWithData += session.requests.filter(request => c.included.has(request)).length;
    const workspace = getOrCreate(c.workspaces, `${session.workspaceName}\u0000${session.harness}`, () => (
      { name: session.workspaceName, harness: session.harness, sessions: new Set(), totals: emptyTotals(), rebuilt: 0, breaks: 0, causes: new Map() }));
    workspace.sessions.add(session);
    mergeTotals(workspace.totals, totals);
  }
}

/** Listed breaks whose request is in range, for the harnesses that attribute them. Counts come from the
 *  request rows instead (see `addRows`), so breaks beyond a session's listing cap are counted too. */
function collectBreaks(c: Collected): void {
  for (const session of c.sessions) {
    const cache = session.promptCache;
    if (!cache || !attributesBreaks(session.harness)) continue;
    for (const brk of cache.breaks) {
      const request = session.requests[brk.requestIndex];
      if (!request || !c.included.has(request)) continue;
      c.breaks.push(brk);
      const workspace = c.workspaces.get(`${session.workspaceName}\u0000${session.harness}`);
      if (workspace) {
        const key = causeKey(brk);
        workspace.causes.set(key, (workspace.causes.get(key) ?? 0) + brk.rebuiltTokens);
      }
    }
  }
}

function allStreams(acc: HarnessAcc): TotalsAcc {
  const all = emptyTotals();
  for (const stream of Object.values(acc.streams)) mergeTotals(all, stream);
  return all;
}

function buildHarnessRows(c: Collected): HarnessPromptCache[] {
  return [...c.harnesses]
    .map(([harness, acc]) => {
      const all = allStreams(acc);
      const hasData = acc.perCall || acc.sessionTotals;
      const attribution = attributesBreaks(harness) && acc.perCall;
      const mainCalls = acc.streams.main.calls;
      return {
        harness,
        reporting: acc.perCall ? 'per-call' : acc.sessionTotals ? 'per-session' : expectedReporting(harness),
        attribution,
        all: hasData ? toTotals(all) : null,
        main: toTotals(acc.streams.main),
        subagents: toTotals(acc.streams.subagent),
        compaction: toTotals(acc.streams.compaction),
        cost: toCost(all),
        breaks: attribution ? acc.breaks : null,
        breaksPer100: attribution && mainCalls > 0 ? Math.round((acc.breaks / mainCalls) * 1000) / 10 : null,
        totalRequests: acc.requests,
        requestsWithData: acc.requestsWithData,
        sessions: acc.sessions.size,
        sessionsWithData: acc.sessionsWithData.size,
      } satisfies HarnessPromptCache;
    })
    .sort((a, b) => (b.all?.input ?? 0) - (a.all?.input ?? 0) || b.totalRequests - a.totalRequests || a.harness.localeCompare(b.harness));
}

function buildAttribution(c: Collected): CacheAttribution | null {
  if (c.attributionHarnesses.size === 0) return null;
  const harnesses = [...c.attributionHarnesses].sort();
  const all = emptyTotals();
  for (const stream of [c.origin.main, c.origin.subagents, c.origin.compaction]) mergeTotals(all, stream);
  const totalCost = all.cost;
  const causes = summarizeCauses(c.breaks, c.origin.rebuilt, totalCost);
  const mainCalls = c.origin.main.calls;
  const confidence = { logged: 0, checkpoint: 0, unattributed: 0 };
  for (const brk of c.breaks) confidence[brk.confidence]++;
  return {
    label: harnesses.map(h => HARNESS_SHORT_NAMES.get(h) ?? h).sort().join(' and '),
    harnesses,
    mainCalls,
    breaks: c.countedBreaks,
    breaksPer100: mainCalls > 0 ? Math.round((c.countedBreaks / mainCalls) * 1000) / 10 : 0,
    omittedBreaks: Math.max(0, c.countedBreaks - c.breaks.length),
    rebuiltTokens: c.origin.rebuilt,
    causes,
    confidence,
    controlPct: controlShares(causes, c.origin.rebuilt),
    misses: totalMisses(c.origin),
    origins: buildOrigins(c.origin, totalCost),
    idle: buildIdle(c.breaks, c.origin, c.ttlCalls),
  };
}

function dominantTtl(ttl: Map<number, number>): number | null {
  let best: number | null = null;
  let calls = -1;
  for (const [seconds, n] of ttl) {
    if (n > calls) {
      best = seconds;
      calls = n;
    }
  }
  return best;
}

function buildModels(c: Collected): ModelPromptCache[] {
  return [...c.models.values()]
    .sort((a, b) => b.totals.calls - a.totals.calls || a.model.localeCompare(b.model))
    .slice(0, MAX_MODELS)
    .map(acc => ({
      harness: acc.harness,
      model: acc.model,
      calls: acc.totals.calls,
      hitPct: pct(acc.totals.cacheRead, acc.totals.input),
      writePct: pct(acc.totals.cacheWrite, acc.totals.input),
      breaksPer100: attributesBreaks(acc.harness) && acc.mainCalls > 0 ? Math.round((acc.breaks / acc.mainCalls) * 1000) / 10 : null,
      ttlSeconds: dominantTtl(acc.ttl),
    }));
}

function topCause(causes: Map<CacheCauseKey, number>): CacheCauseKey | null {
  let best: CacheCauseKey | null = null;
  let max = -1;
  for (const [key, tokens] of causes) {
    if (tokens > max) {
      best = key;
      max = tokens;
    }
  }
  return best;
}

function buildWorkspaces(c: Collected): WorkspacePromptCache[] {
  return [...c.workspaces.values()]
    .sort((a, b) => missesOf(b.totals) - missesOf(a.totals) || a.name.localeCompare(b.name))
    .slice(0, MAX_WORKSPACES)
    .map(acc => {
      const attributed = attributesBreaks(acc.harness);
      return {
        workspaceId: acc.name,
        workspaceName: acc.name,
        harness: acc.harness,
        sessions: acc.sessions.size,
        calls: acc.totals.calls,
        hitPct: pct(acc.totals.cacheRead, acc.totals.input),
        breaks: attributed ? acc.breaks : null,
        rebuiltTokens: attributed ? acc.rebuilt : null,
        misses: missesOf(acc.totals),
        topCause: attributed ? topCause(acc.causes) : null,
      };
    });
}

function buildTrend(c: Collected): PromptCacheTrend {
  const labels = [...new Set([...c.weeks.values()].flatMap(weeks => [...weeks.keys()]))].sort();
  const series = [...c.weeks]
    .map(([harness, weeks]) => ({
      harness,
      hitPct: labels.map(label => {
        const week = weeks.get(label);
        return week ? pct(week.read, week.input) : null;
      }),
      breaksPer100: labels.map(label => {
        const week = weeks.get(label);
        return attributesBreaks(harness) && week && week.mainCalls > 0 ? Math.round((week.breaks / week.mainCalls) * 1000) / 10 : null;
      }),
      calls: labels.map(label => weeks.get(label)?.mainCalls ?? 0),
    }))
    .sort((a, b) => b.calls.reduce((s, n) => s + n, 0) - a.calls.reduce((s, n) => s + n, 0) || a.harness.localeCompare(b.harness));
  return { labels, series };
}

function rankSessions(summaries: CacheSessionSummary[]): CacheSessionSummary[] {
  return summaries.sort((a, b) => (b.rebuiltTokens ?? 0) - (a.rebuiltTokens ?? 0) || b.misses - a.misses || b.date.localeCompare(a.date));
}

/** Aggregate prompt-cache usage over the requests in the current filter. */
export function analyzePromptCache(
  requests: SessionRequest[],
  sessionOf: (request: SessionRequest) => Session | undefined,
): PromptCacheData {
  const c = collectRequests(requests, sessionOf);
  addSessionTotals(c);
  collectBreaks(c);
  const harnesses = buildHarnessRows(c);
  const attribution = buildAttribution(c);
  const attributionCost = attribution
    ? toCost([c.origin.main, c.origin.subagents, c.origin.compaction].reduce((all, stream) => { mergeTotals(all, stream); return all; }, emptyTotals()))
    : null;
  const summaries = [...c.sessions].map(summarizeSession).filter((s): s is CacheSessionSummary => s != null);
  return {
    harnesses,
    attribution,
    models: buildModels(c),
    workspaces: buildWorkspaces(c),
    trend: buildTrend(c),
    topSessions: rankSessions(summaries).slice(0, MAX_TOP_SESSIONS),
    tips: promptCacheTips(attribution, attributionCost),
    coverage: {
      requestsWithData: harnesses.reduce((sum, h) => sum + h.requestsWithData, 0),
      totalRequests: harnesses.reduce((sum, h) => sum + h.totalRequests, 0),
      sessionsWithData: harnesses.reduce((sum, h) => sum + h.sessionsWithData, 0),
      totalSessions: c.sessions.size,
    },
  };
}

export class PromptCacheAnalyzer extends AnalyzerBase {
  private sessionsById: Map<string, Session> | null = null;

  getPromptCache(f?: DateFilter): PromptCacheData {
    return analyzePromptCache(this.filter(f), request => this.requestSessionMap.get(request));
  }

  /** Sessions with a request in range for one workspace (and harness), most recent first. */
  getPromptCacheSessions(workspaceId: string, harness: string | undefined, f?: DateFilter): PromptCacheSessionsData {
    const sessions = this.sessionsWithRequestsInRange(f)
      .filter(session => this.matchesWorkspaceFilter(session, workspaceId) && (!harness || session.harness === harness));
    const summaries = sessions
      .map(summarizeSession)
      .filter((s): s is CacheSessionSummary => s != null)
      .sort((a, b) => b.date.localeCompare(a.date) || (b.rebuiltTokens ?? 0) - (a.rebuiltTokens ?? 0));
    return {
      workspaceName: sessions[0]?.workspaceName ?? workspaceId,
      harness: harness ?? null,
      sessions: summaries.slice(0, MAX_WORKSPACE_SESSIONS),
      total: summaries.length,
    };
  }

  /** One session's call timeline and cache layer, served from memory. */
  getSessionTimeline(sessionId: string): SessionTimelineData | null {
    this.sessionsById ??= new Map(this.sessions.map(session => [session.sessionId, session]));
    const session = this.sessionsById.get(sessionId);
    return session ? buildSessionTimeline(session) : null;
  }
}
