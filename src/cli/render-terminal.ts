/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* ANSI terminal dashboard renderer for `aicoach report`. */

import { ReportPayload } from './report-payload';

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

function useAnsi(): boolean {
  return Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
}

function paint(text: string, code: string): string {
  if (!useAnsi()) return text;
  return `${code}${text}${ANSI.reset}`;
}

function truncateText(input: string, max = 96): string {
  if (input.length <= max) return input;
  return `${input.slice(0, max - 1)}…`;
}

function scoreBar(score: number | undefined, width = 12): string {
  const value = Math.max(0, Math.min(100, Number(score ?? 0)));
  const filled = Math.round((value / 100) * width);
  const empty = width - filled;

  let color = ANSI.red;
  if (value >= 75) color = ANSI.green;
  else if (value >= 55) color = ANSI.yellow;

  return `${paint('█'.repeat(filled), color)}${paint('░'.repeat(empty), ANSI.gray)} ${value}/100`;
}

function severityBadge(severity: string): string {
  const label = severity.toUpperCase();

  if (severity === 'high') return paint(label, ANSI.red + ANSI.bold);
  if (severity === 'medium') return paint(label, ANSI.yellow + ANSI.bold);
  if (severity === 'low') return paint(label, ANSI.green + ANSI.bold);

  return label;
}

function statusIcon(score: number | undefined): string {
  const value = Number(score ?? 0);

  if (value >= 80) return paint('●', ANSI.green);
  if (value >= 60) return paint('●', ANSI.yellow);
  return paint('●', ANSI.red);
}

function renderScoreLine(label: string, score: number | undefined): string {
  return `${statusIcon(score)} ${label.padEnd(18)} ${scoreBar(score)}`;
}

function renderHeader(payload: ReportPayload): string[] {
  const sessions = payload.totals['Sessions'] ?? 'n/a';
  const requests = payload.totals['Requests'] ?? 'n/a';
  const workspaces = payload.totals['Workspaces'] ?? 'n/a';
  const aiLoc = payload.totals['AI-generated LoC'] ?? 'n/a';
  const flow = payload.flow['Overall flow score'] ?? 'n/a';

  return [
    '',
    paint('AI Engineer Coach', ANSI.bold + ANSI.cyan),
    paint('────────────────────────────────────────────', ANSI.cyan),
    `${paint('Summary', ANSI.bold)} ${sessions} sessions · ${requests} requests · ${workspaces} workspaces`,
    `${paint('Output', ANSI.bold)}  ${aiLoc} AI LoC · Flow ${flow}/100`,
    '',
  ];
}

function renderScores(payload: ReportPayload): string[] {
  const lines = [paint('Scores', ANSI.bold)];

  lines.push(renderScoreLine('Context health', payload.contextHealth.overallScore));
  lines.push(renderScoreLine('Agentic readiness', payload.contextHealth.agenticReadinessScore));

  for (const group of payload.groupScores.slice(0, 4)) {
    lines.push(renderScoreLine(group.group, group.score));
  }

  return lines;
}

function renderPriorities(payload: ReportPayload): string[] {
  const lines = ['', paint('Priorities', ANSI.bold)];
  const topRisks = payload.topAntiPatterns.slice(0, 3);

  if (topRisks.length === 0) {
    lines.push(`${paint('✓', ANSI.green)} No top risks found.`);
    return lines;
  }

  for (const [index, item] of topRisks.entries()) {
    lines.push(`${index + 1}. ${severityBadge(item.severity)} ${paint(item.name, ANSI.bold)} ${paint(`(${item.occurrences})`, ANSI.gray)}`);
    lines.push(`   ${truncateText(item.suggestion, 86)}`);
  }

  return lines;
}

function renderContext(payload: ReportPayload): string[] {
  const lines = ['', paint('Context', ANSI.bold)];
  const missing = payload.contextHealth.missingSignals.map(item => item.label);

  if (missing.length === 0) {
    lines.push(`${paint('✓', ANSI.green)} Readiness complete.`);
  } else {
    lines.push(`${paint('Missing:', ANSI.yellow)} ${missing.join(' · ')}`);
  }

  const topWorkspace = payload.contextHealth.workspaceSummary[0];

  if (topWorkspace) {
    lines.push(`${paint('Workspace:', ANSI.gray)} ${topWorkspace.workspace} · score ${topWorkspace.qualityScore ?? 'n/a'}/100`);
  }

  return lines;
}

function renderActions(payload: ReportPayload): string[] {
  const lines = ['', paint('Next 3 actions', ANSI.bold)];

  const actions = payload.nextActions
    .map(action => truncateText(action, 86))
    .filter(Boolean)
    .slice(0, 3);

  if (actions.length === 0) {
    lines.push('1. No immediate actions detected.');
  } else {
    for (const [index, action] of actions.entries()) {
      lines.push(`${index + 1}. ${action}`);
    }
  }

  return lines;
}

export function renderTerminalDashboard(payload: ReportPayload): string {
  return [
    ...renderHeader(payload),
    ...renderScores(payload),
    ...renderPriorities(payload),
    ...renderContext(payload),
    ...renderActions(payload),
    '',
    paint('Full report:', ANSI.gray) + ' aicoach report --format all --out ./reports',
    '',
  ].join('\n');
}

export function stripAnsi(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replaceAll(/\x1b\[[0-9;]*m/g, '');
}
