/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AnalyzerBase } from './analyzer-base';
import type { Session, SessionRequest } from './types';
import type { CuriosityData, CuriosityFilter, CuriositySession, CuriosityExample, InvestigationSource } from './types/curiosity-types';
import { fillDayRange, isoWeek, toDateStr } from './helpers';
import { curiosityBalance } from './curiosity-balance';
import { eventKey, sessionReference, sessionContext, sessionLanguageFiles, keepSession, keepRecent } from './curiosity-context';
import { InquirySequences } from './curiosity-sequences';
import {
  activityCount, classifyCuriosityActivity, emptyActivityCounts, isCuriosityActivity,
  toolCapability,
  type ActivityCounts, type CuriosityActivity,
} from './curiosity-activity';

const sessionLists = (): Record<CuriosityActivity, CuriositySession[]> => ({ direct: [], web: [], repository: [], action: [] });

function questionExample(request: SessionRequest, session: Session, context?: CuriositySession['context']): CuriosityExample {
  const signal = request.curiosity;
  return {
    ...sessionReference(session, request, context),
    text: (signal?.kind === 'analyzed' && signal.features.question.excerpts[0] || request.messageText).slice(0, 240),
  };
}

export class CuriosityAnalyzer extends AnalyzerBase {
  private readonly summaries = new Map<string, CuriosityData>();
  private summaryDate = '';

  getCuriosity(filter?: CuriosityFilter): CuriosityData {
    const today = toDateStr(Date.now());
    if (today !== this.summaryDate) {
      this.summaries.clear();
      this.summaryDate = today;
    }
    const key = JSON.stringify([
      filter?.fromDate || null, filter?.toDate || null,
      filter?.workspaceId || null, filter?.harness || null, filter?.language || null,
    ]);
    const cached = this.summaries.get(key);
    if (cached) return cached;
    const result = this.computeCuriosity(filter);
    if (this.summaries.size >= 32) this.summaries.delete(this.summaries.keys().next().value!);
    this.summaries.set(key, result);
    return result;
  }

  private computeCuriosity(filter?: CuriosityFilter): CuriosityData {
    const bySession = new Map<Session, SessionRequest[]>();
    for (const request of this.filter(filter)) {
      const session = this.requestSessionMap.get(request)!;
      const requests = bySession.get(session) ?? [];
      requests.push(request);
      bySession.set(session, requests);
    }
    // Stable ownership of copied events does not depend on parser discovery order.
    const orderedSessions = [...bySession].sort(([a], [b]) =>
      (a.creationDate ?? 0) - (b.creationDate ?? 0) || a.sessionId.localeCompare(b.sessionId));
    const summary = new CuriositySummary();
    for (const [session, requests] of orderedSessions) summary.addSession(session, requests, filter?.language);
    const data = summary.build();
    const daily = new Map(data.daily.map(row => [row.date, row]));
    data.daily = daily.size ? fillDayRange(this.anchorFromDate([...daily.keys()], filter))
      .map(date => daily.get(date) ?? { date, counts: emptyActivityCounts(), sessions: sessionLists() }) : [];
    return data;
  }
}

type AnalyzedSignal = Extract<NonNullable<SessionRequest['curiosity']>, { kind: 'analyzed' }>;
type Activity = ReturnType<typeof classifyCuriosityActivity>;
interface SessionEvidence {
  session: Session;
  profile: Map<string, Set<string>>;
  context: CuriositySession['context'];
  reference: (request: SessionRequest) => CuriositySession;
  human: boolean;
  activities: Set<CuriosityActivity>;
  sources: Set<InvestigationSource>;
}
interface LanguageEvidence {
  sessions: Set<Session>;
  inquirySessions: Set<Session>;
  files: Set<string>;
  counts: ActivityCounts;
  events: Set<string>;
  humanEvents: Set<string>;
  sessionSamples: CuriositySession[];
}
interface RepeatedQuestion {
  count: number;
  sessions: Set<Session>;
  example: CuriosityExample;
  weeks: Map<string, Set<Session>>;
}
interface WeeklyEvidence {
  counts: ActivityCounts;
  human: number;
  dates: Set<string>;
  repeatedGroups: number;
}

class CuriositySummary {
  private readonly data: CuriosityData = {
    counts: emptyActivityCounts(),
    coverage: { human: 0, classified: 0, excluded: 0, unscanned: 0, unclassified: 0, duplicates: 0,
      withoutLanguage: 0, legacyAnswers: 0,
      reasons: { noQuestion: 0, noAnswer: 0, unknownTool: 0, clarification: 0, canceled: 0 } },
    sessions: 0, questionLedActions: 0, daily: [], languages: [], balance: curiosityBalance(emptyActivityCounts(), 0, 0),
    weeklyChecks: [], sessionCounts: { human: 0, inquiry: 0, action: 0, mixed: 0 },
    research: { web: { turns: 0, sessions: 0, withinAction: 0, sessionSamples: [] },
      repository: { turns: 0, sessions: 0, withinAction: 0, sessionSamples: [] },
      delegated: { turns: 0, sessions: 0, withinAction: 0, sessionSamples: [] } },
    chains: { total: 0, sustained: 0, exchanges: 0, examples: [] },
    evidence: { direct: [], web: [], repository: [], action: [] }, repeated: [],
  };
  private readonly languages = new Map<string, LanguageEvidence>();
  private readonly seen = new Set<string>();
  private readonly daily = new Map<string, Required<CuriosityData['daily'][number]>>();
  private readonly sequences = new InquirySequences();
  private readonly repeated = new Map<string, RepeatedQuestion>();
  private readonly weeks = new Map<string, WeeklyEvidence>();

  addSession(session: Session, requests: SessionRequest[], language?: string): void {
    const profile = sessionLanguageFiles(requests, session);
    const context = sessionContext(session, requests);
    const evidence: SessionEvidence = {
      session, profile, context, human: false, activities: new Set(), sources: new Set(),
      reference: request => sessionReference(session, request, context),
    };
    this.addLanguageFiles(evidence);
    const selected = !language || profile.has(language) || language === 'unrecorded' && !profile.size;
    requests.sort((a, b) => a.timestamp! - b.timestamp!);
    for (const [index, request] of requests.entries()) {
      const id = eventKey(request, session, index);
      const activity = classifyCuriosityActivity(request);
      this.recordLanguages(request, id, activity, evidence);
      if (!selected) continue;
      if (this.seen.has(id)) this.data.coverage.duplicates++;
      else {
        this.seen.add(id);
        this.recordUniqueTurn(request, activity, evidence);
      }
      this.sequences.add(request, id, activity, evidence.reference);
    }
    this.sequences.finish();
    const inquiry = [...evidence.activities].some(activity => activity !== 'action');
    const action = evidence.activities.has('action');
    if (evidence.activities.size) this.data.sessions++;
    if (evidence.human) this.data.sessionCounts.human++;
    if (inquiry) this.data.sessionCounts.inquiry++;
    if (action) this.data.sessionCounts.action++;
    if (inquiry && action) this.data.sessionCounts.mixed++;
    for (const source of evidence.sources) this.data.research[source].sessions++;
  }

  private addLanguageFiles(evidence: SessionEvidence): void {
    for (const [language, files] of evidence.profile) {
      const row = this.languages.get(language) ?? {
        sessions: new Set<Session>(), files: new Set<string>(), inquirySessions: new Set<Session>(),
        counts: emptyActivityCounts(), events: new Set<string>(), humanEvents: new Set<string>(), sessionSamples: [],
      };
      for (const file of files) row.files.add(`${evidence.session.workspaceId}\0${file}`);
      this.languages.set(language, row);
    }
  }

  private recordLanguages(request: SessionRequest, id: string, activity: Activity, evidence: SessionEvidence): void {
    if (request.curiosity?.kind === 'excluded') return;
    // Language rows overlap and each has its own deduplicated human-turn denominator.
    for (const language of evidence.profile.keys()) {
      const row = this.languages.get(language)!;
      if (!row.humanEvents.has(id)) {
        row.humanEvents.add(id);
        row.sessions.add(evidence.session);
        keepSession(row.sessionSamples, evidence.reference(request));
      }
      if (request.curiosity?.kind !== 'analyzed' || !isCuriosityActivity(activity) || row.events.has(id)) continue;
      row.events.add(id);
      row.counts[activity]++;
      if (activity !== 'action') row.inquirySessions.add(evidence.session);
    }
  }

  private recordUniqueTurn(request: SessionRequest, activity: Activity, evidence: SessionEvidence): void {
    const signal = request.curiosity;
    if (signal?.kind === 'excluded') { this.data.coverage.excluded++; return; }
    this.data.coverage.human++;
    evidence.human = true;
    if (!evidence.profile.size) this.data.coverage.withoutLanguage++;
    this.recordSources(request, activity, evidence);
    const date = toDateStr(request.timestamp!);
    const week = isoWeek(new Date(request.timestamp!));
    const weekly = this.weeks.get(week) ?? { counts: emptyActivityCounts(), human: 0, dates: new Set<string>(), repeatedGroups: 0 };
    weekly.human++;
    this.weeks.set(week, weekly);
    const daily = this.daily.get(date) ?? { date, counts: emptyActivityCounts(), sessions: sessionLists() };
    this.daily.set(date, daily);
    if (!signal || signal.kind === 'unscanned') { this.data.coverage.unscanned++; return; }
    if (!isCuriosityActivity(activity)) {
      this.data.coverage.unclassified++;
      this.data.coverage.reasons[activity]++;
      return;
    }
    evidence.activities.add(activity);
    this.data.counts[activity]++;
    daily.counts[activity]++;
    weekly.counts[activity]++;
    weekly.dates.add(date);
    keepSession(daily.sessions[activity], evidence.reference(request));
    this.recordActivity(request, activity, evidence, signal);
  }

  private recordSources(request: SessionRequest, activity: Activity, evidence: SessionEvidence): void {
    const capabilities = request.toolsUsed.map(toolCapability);
    for (const source of ['web', 'repository', 'delegated'] as const) {
      if (source === 'delegated' ? !request.investigationDelegations?.length : !capabilities.includes(source)) continue;
      const row = this.data.research[source];
      row.turns++;
      if (request.curiosity?.kind === 'analyzed' && activity === 'action') row.withinAction++;
      evidence.sources.add(source);
      keepSession(row.sessionSamples, evidence.reference(request));
    }
  }

  private recordActivity(request: SessionRequest, activity: CuriosityActivity, evidence: SessionEvidence, signal: AnalyzedSignal): void {
    if (request.answerEvidence === 'legacy' && activity !== 'action') this.data.coverage.legacyAnswers++;
    if (activity === 'action' && signal.features.question.count) this.data.questionLedActions++;
    keepRecent(this.data.evidence[activity], evidence.reference(request), item => item.timestamp, 20);
    if (activity === 'action' || !signal.repeatedQuestions.length) return;
    const example = questionExample(request, evidence.session, evidence.context);
    const week = isoWeek(new Date(request.timestamp!));
    for (const text of new Set(signal.repeatedQuestions)) {
      const group = this.repeated.get(text) ?? { count: 0, sessions: new Set<Session>(), example, weeks: new Map<string, Set<Session>>() };
      group.count++;
      group.sessions.add(evidence.session);
      const repeatedSessions = group.weeks.get(week) ?? new Set<Session>();
      repeatedSessions.add(evidence.session);
      group.weeks.set(week, repeatedSessions);
      if (example.timestamp > group.example.timestamp) group.example = example;
      this.repeated.set(text, group);
    }
  }

  build(): CuriosityData {
    const data = this.data;
    data.coverage.classified = activityCount(data.counts);
    data.daily = [...this.daily.values()];
    data.balance = curiosityBalance(data.counts, data.coverage.human, data.daily.filter(row => activityCount(row.counts)).length);
    data.languages = [...this.languages].map(([language, row]) => ({
      language, sessions: row.sessions.size, inquirySessions: row.inquirySessions.size, files: row.files.size, counts: row.counts,
      sessionSamples: row.sessionSamples,
    })).sort((a, b) => activityCount(b.counts) - activityCount(a.counts) || a.language.localeCompare(b.language));
    data.chains = this.sequences.summary();
    data.repeated = [...this.repeated].filter(([, group]) => group.sessions.size > 1)
      .sort(([, a], [, b]) => b.count - a.count || b.example.timestamp - a.example.timestamp).slice(0, 8)
      .map(([text, group]) => ({ text, count: group.count, sessions: group.sessions.size, example: group.example }));
    for (const group of this.repeated.values()) {
      for (const [week, sessions] of group.weeks) {
        if (sessions.size > 1) this.weeks.get(week)!.repeatedGroups++;
      }
    }
    data.weeklyChecks = [...this.weeks].sort(([a], [b]) => a.localeCompare(b)).map(([week, row]) => ({
      week, balance: curiosityBalance(row.counts, row.human, row.dates.size), repeatedGroups: row.repeatedGroups,
    }));
    return data;
  }
}
