/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Tests for the CLI helpers: argument parsing, payload extraction, and renderers. */

import { describe, it, expect } from 'vitest';
import { getFilter, normalizeReportFormats, parseArgs } from './args';
import { buildNextActions, extractBulletMap, extractBullets, extractSection } from './report-payload';
import { escapeHtml, markdownToHtml } from './render-html';
import { stripAnsi } from './render-terminal';

describe('parseArgs', () => {
  it('collects positionals, boolean flags, and space/equals values', () => {
    const opts = parseArgs(['report', '--quiet', '--format', 'md', '--top=5']);

    expect(opts._).toEqual(['report']);
    expect(opts['quiet']).toBe(true);
    expect(opts['format']).toBe('md');
    expect(opts['top']).toBe('5');
  });

  it('accumulates repeated --logs-dir flags into an array', () => {
    const opts = parseArgs(['dirs', '--logs-dir', '/a', '--logs-dir=/b']);

    expect(opts['logs-dir']).toEqual(['/a', '/b']);
  });
});

describe('getFilter', () => {
  it('returns undefined when no filter flags are present', () => {
    expect(getFilter(parseArgs(['report']))).toBeUndefined();
  });

  it('maps from/to/workspace/harness flags onto a DateFilter', () => {
    const filter = getFilter(parseArgs(['report', '--from', '2026-06-01', '--harness', 'OpenCode']));

    expect(filter).toEqual({ fromDate: '2026-06-01', harness: 'OpenCode' });
  });
});

describe('normalizeReportFormats', () => {
  it('defaults to terminal and expands both/all aliases', () => {
    expect(normalizeReportFormats(undefined)).toEqual(['terminal']);
    expect(normalizeReportFormats('both')).toEqual(['md', 'json']);
    expect(normalizeReportFormats('all')).toEqual(['terminal', 'md', 'json', 'html']);
  });

  it('rejects unknown formats', () => {
    expect(() => normalizeReportFormats('pdf')).toThrow(/Invalid format/);
  });
});

const SAMPLE_MARKDOWN = [
  '## Totals',
  '- Sessions: 10',
  '- Requests: 42',
  '',
  '## Top Languages',
  '- typescript: 100 AI LoC',
  '- python: 50 AI LoC',
  '',
  '## Flow',
  '- Overall flow score: 61',
].join('\n');

describe('markdown extraction helpers', () => {
  it('extracts a section up to the next heading', () => {
    const section = extractSection(SAMPLE_MARKDOWN, '## Totals');

    expect(section).toContain('- Sessions: 10');
    expect(section).not.toContain('typescript');
  });

  it('returns an empty string for a missing section', () => {
    expect(extractSection(SAMPLE_MARKDOWN, '## Missing')).toBe('');
  });

  it('parses bullet maps and bullet lists', () => {
    expect(extractBulletMap(SAMPLE_MARKDOWN, '## Totals')).toEqual({ Sessions: '10', Requests: '42' });
    expect(extractBullets(SAMPLE_MARKDOWN, '## Top Languages')).toEqual([
      'typescript: 100 AI LoC',
      'python: 50 AI LoC',
    ]);
  });
});

describe('buildNextActions', () => {
  it('prioritizes the first high-severity suggestion and deduplicates', () => {
    const actions = buildNextActions({
      topAntiPatterns: [
        { name: 'A', severity: 'medium', group: 'g', occurrences: 5, suggestion: 'Medium tip' },
        { name: 'B', severity: 'high', group: 'g', occurrences: 3, suggestion: 'High tip' },
      ],
      contextHealth: {
        missingSignals: [{ label: 'Hooks', detail: 'No hooks configured' }],
        workspaceSummary: [{ workspace: 'w', suggestions: ['High tip'] }],
      },
    });

    expect(actions[0]).toBe('High tip');
    expect(actions).toContain('Fix: Hooks. No hooks configured');
    expect(actions.filter(a => a === 'High tip')).toHaveLength(1);
  });
});

describe('markdownToHtml', () => {
  it('escapes HTML in every rendered construct', () => {
    const html = markdownToHtml('# <script>\n- "quoted" & <b>\n1. it\'s');

    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&quot;quoted&quot; &amp; &lt;b&gt;');
    expect(html).toContain('it&#39;s');
  });

  it('renders headings, lists, and ordered lists', () => {
    const html = markdownToHtml('## Section\n- item\n\n1. first');

    expect(html).toContain('<h2>Section</h2>');
    expect(html).toContain('<ul>\n<li>item</li>\n</ul>');
    expect(html).toContain('<ol>\n<li>first</li>\n</ol>');
  });
});

describe('escapeHtml', () => {
  it('escapes all five sensitive characters', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });
});

describe('stripAnsi', () => {
  it('removes color codes but keeps text', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m plain')).toBe('red plain');
  });
});
