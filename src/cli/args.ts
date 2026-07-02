/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* CLI argument parsing and shared option helpers. */

import { DateFilter } from '../core/types';

export type CliOptions = Record<string, string | boolean | string[]> & {
  _: string[];
};

export type ReportFormat = 'terminal' | 'md' | 'json' | 'html';

export function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { _: [] };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (!arg.startsWith('--')) {
      opts._.push(arg);
      continue;
    }

    const eq = arg.indexOf('=');
    const key = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
    const inlineValue = eq >= 0 ? arg.slice(eq + 1) : undefined;

    let value: string | boolean = true;

    if (inlineValue !== undefined) {
      value = inlineValue;
    } else if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
      value = argv[i + 1];
      i++;
    }

    // --logs-dir may repeat; collect every occurrence.
    if (key === 'logs-dir') {
      const current = opts[key];
      opts[key] = Array.isArray(current) ? [...current, String(value)] : [String(value)];
    } else {
      opts[key] = value;
    }
  }

  return opts;
}

export function getString(opts: CliOptions, key: string): string | undefined {
  const value = opts[key];
  return typeof value === 'string' ? value : undefined;
}

export function getBool(opts: CliOptions, key: string): boolean {
  return opts[key] === true || opts[key] === 'true';
}

export function getNumber(opts: CliOptions, key: string): number | undefined {
  const value = getString(opts, key);
  if (!value) return undefined;

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function getFilter(opts: CliOptions): DateFilter | undefined {
  const filter: DateFilter = {};

  const fromDate = getString(opts, 'from');
  const toDate = getString(opts, 'to');
  const workspaceId = getString(opts, 'workspace');
  const harness = getString(opts, 'harness');

  if (fromDate) filter.fromDate = fromDate;
  if (toDate) filter.toDate = toDate;
  if (workspaceId) filter.workspaceId = workspaceId;
  if (harness) filter.harness = harness;

  return Object.keys(filter).length > 0 ? filter : undefined;
}

export function normalizeReportFormats(format: string | undefined): ReportFormat[] {
  if (!format || format === 'terminal') return ['terminal'];
  if (format === 'md') return ['md'];
  if (format === 'json') return ['json'];
  if (format === 'html') return ['html'];
  if (format === 'both') return ['md', 'json'];
  if (format === 'all') return ['terminal', 'md', 'json', 'html'];

  throw new Error(`Invalid format: ${format}`);
}

export const HELP_TEXT = `
AI Engineer Coach CLI

Main usage:
  aicoach report [--format terminal|md|json|html|both|all] [--out ./reports]
  aicoach dirs

Product areas:
  aicoach observe summary
  aicoach measure output
  aicoach improve anti-patterns [--top 5]
  aicoach improve context-health

Technical commands:
  aicoach summary [--format md|json|both] [--out ./reports]
  aicoach json <summary|activity|patterns|flow|insights|workflows|context|production|credits|wellbeing|compare>
  aicoach sessions [--page 1] [--page-size 20] [--search term]
  aicoach session --session-id <id>

Filters:
  --from YYYY-MM-DD
  --to YYYY-MM-DD
  --workspace <id-or-name>
  --harness <name>            e.g. Claude, Codex, OpenCode, "VS Code"

Options:
  --logs-dir <path>        May repeat
  --project-root <path>    Default: current directory
  --out <dir>              Write report files to a directory
  --format terminal|md|json|html|both|all
  --top <n>                Number of items in rankings
  --allow-local-rules      Admit local rules/metrics files
  --no-warmup              Skip the analyzer warm-up
  --quiet                  Reduce stderr logging
  --verbose                Show parsing/warm-up progress

Examples:
  aicoach report
  aicoach report --format all --out ./reports
  aicoach improve anti-patterns --top 5
  aicoach measure output --from 2026-06-01
  aicoach sessions --harness OpenCode
`;
