/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Builds the consolidated report payload consumed by every CLI renderer. */

import { formatPatterns, formatContextHealth } from '../mcp/formatters';

export type PatternsData = ReturnType<typeof formatPatterns>;
export type ContextHealthData = ReturnType<typeof formatContextHealth>;

export interface ReportAntiPattern {
  name: string;
  severity: string;
  group: string;
  occurrences: number;
  suggestion: string;
  trend?: string;
}

export interface ReportGroupScore {
  group: string;
  score: number;
  topIssue?: string;
  improvements?: string[];
}

export interface ReportMissingSignal {
  label: string;
  detail: string;
}

export interface ReportWorkspaceSummary {
  workspace: string;
  qualityScore?: number;
  hasInstructions?: boolean;
  hasPrompts?: boolean;
  hasAgents?: boolean;
  staleContext?: boolean;
  suggestions?: string[];
}

export interface ReportPayload {
  generatedAt: string;
  filter: string;
  totals: Record<string, string>;
  flow: Record<string, string>;
  topLanguages: string[];
  topAntiPatterns: ReportAntiPattern[];
  groupScores: ReportGroupScore[];
  contextHealth: {
    overallScore?: number;
    agenticReadinessScore?: number;
    missingSignals: ReportMissingSignal[];
    workspaceSummary: ReportWorkspaceSummary[];
  };
  nextActions: string[];
}

/** Returns the markdown block starting at `heading` up to the next `## ` heading. */
export function extractSection(markdown: string, heading: string): string {
  const lines = markdown.split('\n');
  const start = lines.findIndex(line => line.trim() === heading);

  if (start === -1) return '';

  let end = lines.length;

  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ') && lines[i].trim() !== heading) {
      end = i;
      break;
    }
  }

  return lines.slice(start, end).join('\n').trim();
}

export function extractBulletMap(markdown: string, sectionHeading: string): Record<string, string> {
  const section = extractSection(markdown, sectionHeading);
  const result: Record<string, string> = {};

  for (const line of section.split('\n')) {
    const match = line.match(/^- ([^:]+):\s*(.+)$/);
    if (match) {
      result[match[1].trim()] = match[2].trim();
    }
  }

  return result;
}

export function extractBullets(markdown: string, sectionHeading: string): string[] {
  const section = extractSection(markdown, sectionHeading);

  return section
    .split('\n')
    .filter(line => line.trim().startsWith('- '))
    .map(line => line.replace(/^- /, '').trim());
}

export function buildNextActions(payload: {
  topAntiPatterns: ReportAntiPattern[];
  contextHealth: ReportPayload['contextHealth'];
}): string[] {
  const actions: string[] = [];

  const firstHigh = payload.topAntiPatterns.find(item => item.severity === 'high');

  if (firstHigh?.suggestion) {
    actions.push(firstHigh.suggestion);
  }

  for (const signal of payload.contextHealth.missingSignals.slice(0, 2)) {
    actions.push(`Fix: ${signal.label}. ${signal.detail}`);
  }

  const workspaceSuggestion = payload.contextHealth.workspaceSummary
    .flatMap(w => w.suggestions ?? [])
    .find(Boolean);

  if (workspaceSuggestion) actions.push(workspaceSuggestion);

  return [...new Set(actions)].slice(0, 5);
}

function toAntiPatterns(patternsData: PatternsData, top: number): ReportAntiPattern[] {
  return patternsData.antiPatterns.patterns.slice(0, top).map(item => ({
    name: item.name,
    severity: item.severity,
    group: item.group,
    occurrences: item.occurrences,
    suggestion: item.suggestion,
    trend: item.trend,
  }));
}

function toGroupScores(patternsData: PatternsData): ReportGroupScore[] {
  return patternsData.groupScores.map(item => ({
    group: item.group,
    score: item.score,
    topIssue: item.topIssue ?? undefined,
    improvements: item.improvements,
  }));
}

function toWorkspaceSummary(contextData: ContextHealthData, top: number): ReportWorkspaceSummary[] {
  return contextData.configHealth.workspaceSummary.slice(0, top).map(item => ({
    workspace: item.workspace,
    qualityScore: item.qualityScore,
    hasInstructions: item.hasInstructions,
    hasPrompts: item.hasPrompts,
    hasAgents: item.hasAgents,
    staleContext: item.staleContext,
    suggestions: item.suggestions,
  }));
}

export function buildReportPayload(
  baseMarkdown: string,
  patternsData: PatternsData,
  contextData: ContextHealthData,
  top: number,
): ReportPayload {
  const totals = extractBulletMap(baseMarkdown, '## Totals');

  const payloadWithoutActions = {
    generatedAt: new Date().toISOString(),
    filter: totals['Filter'] ?? 'All data',
    totals,
    flow: extractBulletMap(baseMarkdown, '## Flow'),
    topLanguages: extractBullets(baseMarkdown, '## Top Languages').slice(0, top),
    topAntiPatterns: toAntiPatterns(patternsData, top),
    groupScores: toGroupScores(patternsData),
    contextHealth: {
      overallScore: contextData.configHealth.overallScore,
      agenticReadinessScore: contextData.configHealth.agenticReadiness.score,
      missingSignals: contextData.configHealth.agenticReadiness.missingSignals,
      workspaceSummary: toWorkspaceSummary(contextData, top),
    },
  };

  return {
    ...payloadWithoutActions,
    nextActions: buildNextActions(payloadWithoutActions),
  };
}
