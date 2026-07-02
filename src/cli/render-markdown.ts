/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Markdown renderers for the CLI report and the improve subcommands. */

import { ContextHealthData, PatternsData, ReportAntiPattern, ReportPayload } from './report-payload';

function renderExecutiveSummary(payload: ReportPayload): string[] {
  return [
    '## Executive Summary',
    '',
    `- Sessions: ${payload.totals['Sessions'] ?? 'n/a'}`,
    `- Requests: ${payload.totals['Requests'] ?? 'n/a'}`,
    `- Workspaces: ${payload.totals['Workspaces'] ?? 'n/a'}`,
    `- AI-generated LoC: ${payload.totals['AI-generated LoC'] ?? 'n/a'}`,
    `- Flow score: ${payload.flow['Overall flow score'] ?? 'n/a'}`,
    `- Context health: ${payload.contextHealth.overallScore ?? 'n/a'}`,
    `- Agentic readiness: ${payload.contextHealth.agenticReadinessScore ?? 'n/a'}`,
    '',
  ];
}

function renderTopLanguages(payload: ReportPayload): string[] {
  const lines = ['## Top Languages', ''];

  if (payload.topLanguages.length === 0) {
    lines.push('- No language data found.');
  } else {
    for (const item of payload.topLanguages) lines.push(`- ${item}`);
  }

  lines.push('');
  return lines;
}

function renderAntiPatternItems(patterns: ReportAntiPattern[]): string[] {
  const lines: string[] = [];

  for (const [index, item] of patterns.entries()) {
    lines.push(`${index + 1}. ${item.name} (${item.severity}, ${item.occurrences} occurrences)`);
    lines.push(`   - Group: ${item.group}`);
    lines.push(`   - Action: ${item.suggestion}`);
    if (item.trend) lines.push(`   - Trend: ${item.trend}`);
  }

  return lines;
}

function renderTopAntiPatterns(payload: ReportPayload): string[] {
  const lines = ['## Top Anti-Patterns', ''];

  if (payload.topAntiPatterns.length === 0) {
    lines.push('- No anti-patterns found.');
  } else {
    lines.push(...renderAntiPatternItems(payload.topAntiPatterns));
  }

  lines.push('');
  return lines;
}

function renderGroupScores(payload: ReportPayload): string[] {
  const lines = ['## Group Scores', ''];

  if (payload.groupScores.length === 0) {
    lines.push('- No group scores found.');
  } else {
    for (const item of payload.groupScores) {
      lines.push(`- ${item.group}: ${item.score}/100`);
      if (item.topIssue) lines.push(`  - Main issue: ${item.topIssue}`);
      for (const improvement of item.improvements ?? []) {
        lines.push(`  - Improvement: ${improvement}`);
      }
    }
  }

  lines.push('');
  return lines;
}

function renderContextHealthSection(payload: ReportPayload): string[] {
  const lines = [
    '## Context Health',
    '',
    `- Overall score: ${payload.contextHealth.overallScore ?? 'n/a'}`,
    `- Agentic readiness: ${payload.contextHealth.agenticReadinessScore ?? 'n/a'}`,
    '',
    '### Missing Signals',
    '',
  ];

  if (payload.contextHealth.missingSignals.length === 0) {
    lines.push('- No missing signals found.');
  } else {
    for (const item of payload.contextHealth.missingSignals) {
      lines.push(`- ${item.label}: ${item.detail}`);
    }
  }

  lines.push('', '### Workspace Context', '');

  if (payload.contextHealth.workspaceSummary.length === 0) {
    lines.push('- No workspace data found.');
  } else {
    for (const item of payload.contextHealth.workspaceSummary) {
      lines.push(`- ${item.workspace}: ${item.qualityScore ?? 'n/a'}/100`);
      lines.push(`  - Instructions: ${item.hasInstructions ? 'yes' : 'no'}`);
      lines.push(`  - Prompts: ${item.hasPrompts ? 'yes' : 'no'}`);
      lines.push(`  - Agents: ${item.hasAgents ? 'yes' : 'no'}`);
      lines.push(`  - Stale context: ${item.staleContext ? 'yes' : 'no'}`);

      for (const suggestion of item.suggestions ?? []) {
        lines.push(`  - Suggestion: ${suggestion}`);
      }
    }
  }

  lines.push('');
  return lines;
}

function renderNextActions(payload: ReportPayload): string[] {
  const lines = ['## Next Actions', ''];

  if (payload.nextActions.length === 0) {
    lines.push('- No immediate actions found.');
  } else {
    for (const [index, action] of payload.nextActions.entries()) {
      lines.push(`${index + 1}. ${action}`);
    }
  }

  lines.push('');
  return lines;
}

export function renderProductMarkdown(payload: ReportPayload): string {
  return [
    '# AI Engineer Coach Report',
    '',
    `Generated: ${payload.generatedAt}`,
    '',
    ...renderExecutiveSummary(payload),
    ...renderTopLanguages(payload),
    ...renderTopAntiPatterns(payload),
    ...renderGroupScores(payload),
    ...renderContextHealthSection(payload),
    ...renderNextActions(payload),
  ].join('\n');
}

export function renderAntiPatternsMarkdown(data: PatternsData, top: number): string {
  const lines: string[] = ['# Anti-Patterns', ''];

  if (data.groupScores.length > 0) {
    lines.push('## Group Scores', '');

    for (const group of data.groupScores) {
      lines.push(`- ${group.group}: ${group.score}/100`);
      if (group.topIssue) lines.push(`  - Main issue: ${group.topIssue}`);
    }

    lines.push('');
  }

  const patterns = data.antiPatterns.patterns.slice(0, top);

  lines.push('## Top Issues', '');

  if (patterns.length === 0) {
    lines.push('- No anti-patterns found.');
  } else {
    lines.push(...renderAntiPatternItems(patterns));
  }

  lines.push('');
  return lines.join('\n');
}

export function renderContextHealthMarkdown(data: ContextHealthData): string {
  const lines: string[] = [
    '# Context Health',
    '',
    `Overall score: ${data.configHealth.overallScore ?? 'n/a'}`,
    `Agentic readiness: ${data.configHealth.agenticReadiness.score ?? 'n/a'}`,
    '',
    '## Missing Signals',
    '',
  ];

  const missingSignals = data.configHealth.agenticReadiness.missingSignals;

  if (missingSignals.length === 0) {
    lines.push('- No missing signals found.');
  } else {
    for (const signal of missingSignals) {
      lines.push(`- ${signal.label}: ${signal.detail}`);
    }
  }

  lines.push('', '## Workspaces', '');

  const workspaces = data.configHealth.workspaceSummary;

  if (workspaces.length === 0) {
    lines.push('- No workspace context data found.');
  } else {
    for (const workspace of workspaces) {
      lines.push(`- ${workspace.workspace}: ${workspace.qualityScore ?? 'n/a'}/100`);
      lines.push(`  - Instructions: ${workspace.hasInstructions ? 'yes' : 'no'}`);
      lines.push(`  - Prompts: ${workspace.hasPrompts ? 'yes' : 'no'}`);
      lines.push(`  - Agents: ${workspace.hasAgents ? 'yes' : 'no'}`);

      for (const suggestion of workspace.suggestions) {
        lines.push(`  - Suggestion: ${suggestion}`);
      }
    }
  }

  lines.push('');
  return lines.join('\n');
}
