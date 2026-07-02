#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Standalone CLI for AI Engineer Coach.
 *
 * Runs the same parsing/analysis pipeline as the VS Code extension against
 * every supported harness (VS Code/Copilot, Claude Code, Codex, OpenCode)
 * and renders reports to the terminal or to md/json/html files — no editor
 * required. Build with `npm run build:cli`; entry point is `dist/cli.js`.
 */

import * as fs from 'fs';
import * as path from 'path';

import { Analyzer } from './core/analyzer';
import { findLogsDirs, parseAllLogsViaWorker } from './core/parser';
import { loadAllRuleLayersAsync, loadAllMetricLayers } from './core/rule-loader';
import { TrustGate } from './core/rule-trust';

import {
  buildSummaryExportFromAnalyzer,
  renderSummaryJson,
  renderSummaryMarkdown,
  getSummaryExportFilenames,
} from './core/summary-export';

import {
  formatSummary,
  formatActivity,
  formatCredits,
  formatCodeProduction,
  formatFlow,
  formatPatterns,
  formatInsights,
  formatWellbeing,
  formatWorkflows,
  formatHarnessComparison,
  formatSessions,
  formatContextHealth,
} from './mcp/formatters';

import {
  CliOptions,
  HELP_TEXT,
  ReportFormat,
  getBool,
  getFilter,
  getNumber,
  getString,
  normalizeReportFormats,
  parseArgs,
} from './cli/args';
import { ReportPayload, buildReportPayload, extractSection } from './cli/report-payload';
import { renderAntiPatternsMarkdown, renderContextHealthMarkdown, renderProductMarkdown } from './cli/render-markdown';
import { markdownToHtml } from './cli/render-html';
import { renderTerminalDashboard, stripAnsi } from './cli/render-terminal';

function normalizeLogsDirs(opts: CliOptions): string[] {
  const explicit = opts['logs-dir'];

  if (Array.isArray(explicit) && explicit.length > 0) {
    return explicit.map(p => path.resolve(p));
  }

  return findLogsDirs();
}

function buildBlockingTrustGate(blockedLocalFiles: string[]): TrustGate {
  return {
    isAllowed() {
      return false;
    },
    onBlocked(entry) {
      blockedLocalFiles.push(entry.filePath);
    },
  };
}

async function createAnalyzer(opts: CliOptions): Promise<Analyzer> {
  const logsDirs = normalizeLogsDirs(opts);

  if (logsDirs.length === 0) {
    throw new Error('No log directories found. Run `aicoach dirs` or pass --logs-dir <path>.');
  }

  const projectRoot = path.resolve(getString(opts, 'project-root') ?? process.cwd());
  const showProgress = getBool(opts, 'verbose') && !getBool(opts, 'quiet');
  const blockedLocalFiles: string[] = [];

  // Local rules/metrics execute arbitrary logic, so they stay blocked unless
  // the user explicitly opts in — the CLI has no interactive approval UI.
  const trustGate = getBool(opts, 'allow-local-rules') ? undefined : buildBlockingTrustGate(blockedLocalFiles);

  await loadAllRuleLayersAsync(projectRoot, trustGate);
  loadAllMetricLayers(projectRoot, trustGate);

  if (blockedLocalFiles.length > 0 && !getBool(opts, 'quiet')) {
    console.error(`Local rules/metrics blocked for safety: ${blockedLocalFiles.length}`);
    console.error('Pass --allow-local-rules if you trust these files.');
  }

  const parsed = await parseAllLogsViaWorker(logsDirs, progress => {
    if (!showProgress) return;

    const pct = String(progress.pct).padStart(3, ' ');
    const detail = progress.detail ? ` ${progress.detail}` : '';
    process.stderr.write(`\r${pct}%${detail}`);
  });

  if (showProgress) {
    process.stderr.write('\n');
  }

  const analyzer = new Analyzer(parsed.sessions, parsed.editLocIndex, parsed.workspaces);

  if (!getBool(opts, 'no-warmup')) {
    await analyzer.warmUp((_phase: number, detail: string, pct: number) => {
      if (!showProgress) return;
      process.stderr.write(`\r${pct}% ${detail}`);
    });

    if (showProgress) {
      process.stderr.write('\n');
    }
  }

  return analyzer;
}

function writeOrPrint(content: string, outputPath?: string): void {
  const normalized = content.endsWith('\n') ? content : `${content}\n`;

  if (!outputPath) {
    process.stdout.write(normalized);
    return;
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, normalized, 'utf8');
  console.log(outputPath);
}

function writeReport(payload: ReportPayload, opts: CliOptions): void {
  const formats = normalizeReportFormats(getString(opts, 'format'));
  const outDir = getString(opts, 'out');

  const terminal = outDir ? stripAnsi(renderTerminalDashboard(payload)) : renderTerminalDashboard(payload);
  const markdown = renderProductMarkdown(payload);

  const contentByFormat: Record<ReportFormat, string> = {
    terminal,
    md: markdown,
    json: JSON.stringify(payload, null, 2),
    html: markdownToHtml(markdown),
  };

  if (!outDir && formats.length === 1) {
    writeOrPrint(contentByFormat[formats[0]]);
    return;
  }

  const targetDir = path.resolve(outDir ?? './reports');
  const extByFormat: Record<ReportFormat, string> = { terminal: 'txt', md: 'md', json: 'json', html: 'html' };

  for (const format of formats) {
    writeOrPrint(contentByFormat[format], path.join(targetDir, `aicoach-report.${extByFormat[format]}`));
  }
}

function commandDirs(opts: CliOptions): void {
  console.log(JSON.stringify({ logsDirs: normalizeLogsDirs(opts) }, null, 2));
}

async function commandSummary(opts: CliOptions): Promise<void> {
  const analyzer = await createAnalyzer(opts);
  const report = buildSummaryExportFromAnalyzer(analyzer, getFilter(opts));

  const format = getString(opts, 'format') ?? 'md';
  const outDir = getString(opts, 'out');

  if (outDir) {
    const filenames = getSummaryExportFilenames(report.generatedAt);
    const absOut = path.resolve(outDir);

    if (format === 'json' || format === 'both') {
      writeOrPrint(renderSummaryJson(report), path.join(absOut, filenames.json));
    }

    if (format === 'md' || format === 'both') {
      writeOrPrint(renderSummaryMarkdown(report), path.join(absOut, filenames.markdown));
    }

    return;
  }

  writeOrPrint(format === 'json' ? renderSummaryJson(report) : renderSummaryMarkdown(report));
}

async function commandReport(opts: CliOptions): Promise<void> {
  const analyzer = await createAnalyzer(opts);
  const filter = getFilter(opts);
  const top = getNumber(opts, 'top') ?? 8;

  const summaryExport = buildSummaryExportFromAnalyzer(analyzer, filter);
  const baseMarkdown = renderSummaryMarkdown(summaryExport);
  const patternsData = formatPatterns(analyzer, filter);
  const contextData = formatContextHealth(analyzer, filter);

  writeReport(buildReportPayload(baseMarkdown, patternsData, contextData, top), opts);
}

async function commandJson(opts: CliOptions): Promise<void> {
  const kind = opts._[1] ?? 'summary';
  const analyzer = await createAnalyzer(opts);
  const filter = getFilter(opts);

  const map: Record<string, unknown> = {
    summary: formatSummary(analyzer, filter),
    activity: formatActivity(analyzer, filter),
    credits: formatCredits(analyzer, filter),
    production: formatCodeProduction(analyzer, filter),
    flow: formatFlow(analyzer, filter),
    patterns: formatPatterns(analyzer, filter),
    insights: formatInsights(analyzer, filter),
    wellbeing: formatWellbeing(analyzer, filter),
    workflows: formatWorkflows(analyzer, filter),
    compare: formatHarnessComparison(analyzer, filter),
    context: formatContextHealth(analyzer, filter),
  };

  if (!(kind in map)) {
    throw new Error(`Invalid json kind: ${kind}`);
  }

  console.log(JSON.stringify(map[kind], null, 2));
}

async function commandSessions(opts: CliOptions): Promise<void> {
  const analyzer = await createAnalyzer(opts);

  const data = formatSessions(
    analyzer,
    {
      page: getNumber(opts, 'page') ?? 1,
      pageSize: getNumber(opts, 'page-size') ?? 20,
      search: getString(opts, 'search'),
    },
    getFilter(opts),
  );

  console.log(JSON.stringify(data, null, 2));
}

async function commandSession(opts: CliOptions): Promise<void> {
  const sessionId = getString(opts, 'session-id');

  if (!sessionId) {
    throw new Error('Usage: aicoach session --session-id <id>');
  }

  const analyzer = await createAnalyzer(opts);
  const data = formatSessions(analyzer, { sessionId }, getFilter(opts));

  console.log(JSON.stringify(data, null, 2));
}

async function commandObserve(opts: CliOptions): Promise<void> {
  const subcommand = opts._[1] ?? 'summary';

  if (subcommand !== 'summary') {
    throw new Error(`Invalid observe subcommand: ${subcommand}`);
  }

  opts.format = getString(opts, 'format') ?? 'md';
  return commandReport(opts);
}

async function commandMeasure(opts: CliOptions): Promise<void> {
  const subcommand = opts._[1] ?? 'output';

  if (subcommand !== 'output') {
    throw new Error(`Invalid measure subcommand: ${subcommand}`);
  }

  const analyzer = await createAnalyzer(opts);
  const report = buildSummaryExportFromAnalyzer(analyzer, getFilter(opts));
  const markdown = renderSummaryMarkdown(report);

  const totals = extractSection(markdown, '## Totals');
  const topLanguages = extractSection(markdown, '## Top Languages');

  console.log('# Code Output\n');
  console.log(totals || 'No totals found.');
  console.log('');
  console.log(topLanguages || 'No language output found.');
}

async function commandImprove(opts: CliOptions): Promise<void> {
  const subcommand = opts._[1] ?? 'anti-patterns';
  const analyzer = await createAnalyzer(opts);
  const filter = getFilter(opts);
  const top = getNumber(opts, 'top') ?? 8;

  if (subcommand === 'anti-patterns' || subcommand === 'patterns') {
    console.log(renderAntiPatternsMarkdown(formatPatterns(analyzer, filter), top));
    return;
  }

  if (subcommand === 'context-health' || subcommand === 'context') {
    console.log(renderContextHealthMarkdown(formatContextHealth(analyzer, filter)));
    return;
  }

  throw new Error(`Invalid improve subcommand: ${subcommand}`);
}

function routeDiagnosticsToStderr(quiet: boolean): void {
  // Core helpers (infoCore/debugCore) log via console.info/console.debug,
  // which write to stdout. The CLI reserves stdout for command output so it
  // stays pipeable; diagnostics go to stderr (or are dropped with --quiet).
  const sink = quiet ? () => undefined : (...args: unknown[]) => console.error(...args);
  console.info = sink;
  console.debug = sink;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const command = opts._[0] ?? 'help';

  routeDiagnosticsToStderr(getBool(opts, 'quiet'));

  if (command === 'help' || getBool(opts, 'help')) {
    console.log(HELP_TEXT);
    return;
  }

  if (command === 'dirs') return commandDirs(opts);
  if (command === 'summary') return commandSummary(opts);
  if (command === 'report') return commandReport(opts);
  if (command === 'json') return commandJson(opts);
  if (command === 'sessions') return commandSessions(opts);
  if (command === 'session') return commandSession(opts);
  if (command === 'observe') return commandObserve(opts);
  if (command === 'measure') return commandMeasure(opts);
  if (command === 'improve') return commandImprove(opts);

  throw new Error(`Invalid command: ${command}. Run \`aicoach help\`.`);
}

main().catch((error: unknown) => {
  console.error('');
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
