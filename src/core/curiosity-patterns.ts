/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CURIOSITY_TIER_LABELS, type CuriosityBalance, type CuriosityData, type CuriositySession } from './types/curiosity-types';
import { activityCount, inquiryCount } from './curiosity-activity';
import type { AntiPattern, OccurrenceDetail, PatternContribution, WeeklyPatternObservation } from './types/analytics-types';

function curiositySeverity(balance: CuriosityBalance): AntiPattern['severity'] | undefined {
  return balance.tier === 'strongly-skewed' ? 'high' : balance.tier === 'needs-review' ? 'medium' : undefined;
}

export function curiosityPatternContribution(data: CuriosityData): PatternContribution {
  const weekly: WeeklyPatternObservation[] = [];
  for (const row of data.weeklyChecks) {
    const severity = curiositySeverity(row.balance);
    if (severity) weekly.push({ week: row.week, group: 'prompt-quality', severity, occurrences: 1 });
    if (row.repeatedGroups) weekly.push({ week: row.week, group: 'prompt-quality', severity: 'low', occurrences: row.repeatedGroups });
  }
  return { patterns: curiosityAntiPatterns(data), weekly };
}

const percent = (value: number, total: number) => total ? `${(value / total * 100).toFixed(1)}%` : 'not recorded';
const detailsFor = (sessions: CuriositySession[]): OccurrenceDetail[] => sessions.map(session => ({
  timestamp: session.timestamp, workspace: session.workspace, sessionId: session.sessionId,
  message: session.name, model: '', kind: 'session',
}));

export function curiosityAntiPatterns(data: CuriosityData): AntiPattern[] {
  const patterns: AntiPattern[] = [];
  const severity = curiositySeverity(data.balance);
  const total = activityCount(data.counts);
  const inquiries = inquiryCount(data.counts);
  const thresholds = data.balance.thresholds;
  if (severity) {
    const sessions = new Map<string, CuriositySession>();
    for (const warning of data.balance.warnings) {
      const activity = warning.activity ?? (warning.id === 'little-inquiry' || warning.id === 'build-heavy' ? 'action' : undefined);
      const examples = activity ? data.evidence[activity] : [...data.evidence.direct, ...data.evidence.web, ...data.evidence.repository];
      for (const session of examples) {
        const key = JSON.stringify([session.harness, session.workspace, session.sessionId]);
        const previous = sessions.get(key);
        if (!previous || session.timestamp > previous.timestamp) sessions.set(key, session);
      }
    }
    const samples = [...sessions.values()].sort((a, b) => b.timestamp - a.timestamp).slice(0, 20);
    const weeks = data.weeklyChecks.filter(row => curiositySeverity(row.balance));
    patterns.push({
      id: 'curiosity-balance', name: `Curiosity balance: ${CURIOSITY_TIER_LABELS[data.balance.tier]}`,
      severity, group: 'prompt-quality', occurrences: 1, aggregate: true,
      description: `${inquiries} inquiry / ${data.counts.action} Task execution turns (${percent(inquiries, total)} / ${percent(data.counts.action, total)}). `
        + `Inquiry mix: model knowledge ${percent(data.counts.direct, inquiries)}, web ${percent(data.counts.web, inquiries)}, repository ${percent(data.counts.repository, inquiries)}. `
        + `${data.balance.warnings.map(warning => warning.title).join('; ')}. `
        + `Coaching ranges for mixed coding work: ${percent(thresholds.suggestedLowInquiry, 1)}-${percent(thresholds.suggestedHighInquiry, 1)} inquiry, with no single inquiry type above ${percent(thresholds.maxInvestigationShare, 1)}. `
        + 'This measures activity balance, not question quality or learning.',
      suggestion: data.balance.warnings.map(warning => warning.recommendation).join(' '),
      examples: samples.map(session => `${session.date} / ${session.workspace}: ${session.name}`),
      details: detailsFor(samples),
      weeklyHist: { labels: weeks.map(row => row.week), counts: weeks.map(() => 1) },
    });
  }
  if (data.repeated.length) {
    const weeks = data.weeklyChecks.filter(row => row.repeatedGroups);
    patterns.push({
      id: 'curiosity-repeated-wording', name: 'Repeated inquiry wording',
      severity: 'low', group: 'prompt-quality', occurrences: data.repeated.length, aggregate: true,
      description: `${data.repeated.length} recorded normalized question group(s) repeat across distinct sessions. `
        + 'This is exact wording reuse, not semantic similarity or proof of forgetting.',
      suggestion: 'If retention is a goal, try answering the question yourself before asking again. Reuse can also be intentional.',
      examples: data.repeated.map(row => `${row.text} (${row.count} occurrences across ${row.sessions} sessions)`),
      details: data.repeated.map(row => ({
        timestamp: row.example.timestamp, workspace: row.example.workspace, sessionId: row.example.sessionId,
        message: row.text, model: '', kind: 'session',
      })),
      weeklyHist: { labels: weeks.map(row => row.week), counts: weeks.map(row => row.repeatedGroups) },
    });
  }
  return patterns;
}
