/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * @vitest-environment jsdom
 *
 * The Rule Editor form on the Anti-Patterns page's own markup: built-in rules fill it the same with LF or CRLF
 * line endings, the form writes back only what was edited, and Test Rule and Save Rule send the whole rule.
 * Test Rule runs through the real testRuleLive handler on fixture sessions.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Analyzer } from '../core/analyzer';
import type { ParseResult } from '../core/cache';
import { parseRuleExtensions } from '../core/metric-engine';
import { createRequest, createSession } from '../core/parser-shared';
import { parseRule } from '../core/rule-parser';
import type { SessionRequest } from '../core/types';
import { renderAntiPatterns } from './page-antipatterns';
import { formToMarkdown, markdownToForm, openRuleEditor } from './page-antipatterns-editor';
import { getRpcHandler } from './panel-rpc';
import { readRuleFields } from './rule-form-markdown';

const mocks = vi.hoisted(() => {
  (globalThis as { acquireVsCodeApi?: () => unknown }).acquireVsCodeApi = () => ({
    postMessage: () => {}, getState: () => null, setState: () => {},
  });
  return { rpc: vi.fn() };
});
vi.mock('./shared', async importOriginal => ({ ...await importOriginal<typeof import('./shared')>(), rpc: mocks.rpc }));
vi.mock('./app', () => ({ consumeNavHint: () => null }));

const RULES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'core', 'rules');
const toLf = (md: string) => md.replaceAll('\r\n', '\n');
const toCrlf = (md: string) => toLf(md).replaceAll('\n', '\r\n');
const BUILT_IN_RULES = readdirSync(RULES_DIR).filter(file => file.endsWith('.md')).sort()
  .map(file => ({ id: file.slice(0, -'.md'.length), lf: toLf(readFileSync(path.join(RULES_DIR, file), 'utf-8')) }));
const builtIn = (id: string) => BUILT_IN_RULES.find(rule => rule.id === id)!.lf;

const FIELD_INPUTS = {
  id: 'rf-id', name: 'rf-name', group: 'rf-group', severity: 'rf-severity', scope: 'rf-scope', version: 'rf-version',
  tags: 'rf-tags', thresholds: 'rf-thresholds', description: 'rf-description', whenTriggered: 'rf-when-triggered',
  howToImprove: 'rf-how-to-improve', examples: 'rf-examples', detect: 'rf-detect',
};

type FieldInput = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
const input = (page: HTMLElement, id: string) => page.querySelector<FieldInput>(`#${id}`)!;
const formValues = (page: HTMLElement) =>
  Object.fromEntries(Object.entries(FIELD_INPUTS).map(([field, id]) => [field, input(page, id).value.trim()]));

/** What the rule parser reads from markdown, without the raw source and with LF line endings. */
function parsedRule(md: string): unknown {
  const rule = parseRule(md);
  expect(rule).not.toBeNull();
  const { rawSource: _rawSource, ...rest } = rule!;
  return JSON.parse(JSON.stringify(rest).replaceAll(String.raw`\r\n`, String.raw`\n`));
}

/** The `# Tests` section, from its heading to the next heading or the end. */
function testsSection(md: string): string {
  return /^# Tests\n[\s\S]*?(?=^#+\s|(?![\s\S]))/m.exec(toLf(md))?.[0] ?? '';
}

/* One VS Code session with 40 requests: 30 ran terminal commands on the host, 10 attached a file. */
const AT = Date.parse('2026-09-30T12:00:00Z');
const TERMINAL = [{ toolId: 'run_in_terminal', confirmationType: 0, isTerminal: true, commandLine: 'npm test' }];
// testRuleLive passes request rows as they are; devcontainerStats matches them to sessions by sessionId.
const requests: SessionRequest[] = Array.from({ length: 40 }, (_, index) => Object.assign(createRequest({
  requestId: `r${index}`, timestamp: AT + index * 60_000, messageText: 'Run the tests and fix what fails', responseText: 'Done.',
  toolConfirmations: index < 30 ? TERMINAL : [], referencedFiles: index % 4 === 0 ? ['src/app.ts'] : [],
}), { sessionId: 'host' }));
const sessions = [createSession({ sessionId: 'host', workspaceId: 'ws', workspaceName: 'Project', harness: 'Local Agent', requests })];
const analyzer = new Analyzer(sessions, new Map());
const parsed: ParseResult = { sessions, workspaces: new Map(), editLocIndex: new Map(), sessionSourceIndex: new Map() };

interface TestRuleResult { ok: boolean; triggered: boolean; occurrences: number; total: number }
const testRuleLive = async (markdown: string) =>
  await getRpcHandler('testRuleLive')!(analyzer, parsed, { markdown, filter: {} }) as TestRuleResult;

const PAGE_DATA: Record<string, unknown> = {
  getAntiPatterns: { patterns: [], totalOccurrences: 0, groupScores: [], weeklyScores: { labels: [], series: [] } },
  getRuleEditor: { rules: [], previews: [], layers: [], pending: [] },
};
let ruleSource = '';
let generatedDraft = '';

function route(method: string, params?: Record<string, unknown>): Promise<unknown> {
  if (method in PAGE_DATA) return Promise.resolve(PAGE_DATA[method]);
  if (method === 'getRuleSource') return Promise.resolve({ source: ruleSource });
  if (method === 'generateRule') return Promise.resolve({ markdown: generatedDraft });
  if (method === 'saveRule') return Promise.resolve({ ok: true });
  return Promise.resolve(getRpcHandler(method)?.(analyzer, parsed, params ?? {}));
}

async function renderPage(): Promise<HTMLElement> {
  const page = document.createElement('div');
  document.body.replaceChildren(page);
  await renderAntiPatterns(page, {});
  return page;
}

/** The markdown the editor sent with its last call of `method`. */
function sentMarkdown(method: string): string {
  const calls = mocks.rpc.mock.calls.filter(([name]) => name === method);
  expect(calls.length, method).toBeGreaterThan(0);
  return (calls[calls.length - 1][1] as { markdown: string }).markdown;
}

async function openRule(page: HTMLElement, id: string, source: string): Promise<void> {
  ruleSource = source;
  openRuleEditor(page, id);
  await vi.waitFor(() => expect(input(page, 'rf-id').value).toBe(id));
}

/** Opens a new rule and fills it with Generate, which returns `draft`. */
async function generateDraft(draft: string): Promise<HTMLElement> {
  generatedDraft = draft;
  const page = await renderPage();
  openRuleEditor(page, null);
  input(page, 'rule-ai-input').value = 'Short prompts without context';
  page.querySelector<HTMLButtonElement>('#rule-ai-generate')!.click();
  await vi.waitFor(() => expect(page.querySelector('#rule-ai-status')!.textContent).toContain('Rule generated'));
  return page;
}

beforeEach(() => {
  mocks.rpc.mockReset().mockImplementation(route);
});

describe('Rule Editor form with every built-in rule', () => {
  let page: HTMLElement;
  beforeAll(async () => {
    mocks.rpc.mockImplementation(route);
    page = await renderPage();
  });

  it.each(BUILT_IN_RULES)('fills the form from $id the same way with CRLF line endings as with LF', ({ id, lf }) => {
    markdownToForm(page, lf);
    const values = formValues(page);
    expect(values).toMatchObject({ id, scope: readRuleFields(lf).scope });
    expect(values.detect).toContain('scan:');
    markdownToForm(page, toCrlf(lf));
    expect(formValues(page)).toEqual(values);
  });

  it.each(BUILT_IN_RULES)('keeps $id as it was when nothing is edited', ({ lf }) => {
    for (const source of [lf, toCrlf(lf)]) {
      markdownToForm(page, source);
      const markdown = formToMarkdown(page);
      expect(markdown).toBe(lf);
      expect(parsedRule(markdown)).toEqual(parsedRule(source));
      expect(parseRuleExtensions(markdown)).toEqual(parseRuleExtensions(lf));
      expect(testsSection(markdown)).toBe(testsSection(lf));
    }
  });

  it.each(BUILT_IN_RULES)('writes an edited name into $id and keeps the rest', ({ lf }) => {
    for (const source of [lf, toCrlf(lf)]) {
      markdownToForm(page, source);
      const name = input(page, 'rf-name');
      name.value = `${name.value} (edited)`;
      expect(formToMarkdown(page)).toBe(lf.replace(/^name: (.*)$/m, (_line, value: string) => `name: ${value.trim()} (edited)`));
    }
  });

  it.each(BUILT_IN_RULES)('shows every field of $id as it is in the rule', ({ lf }) => {
    markdownToForm(page, toCrlf(lf));
    expect(formValues(page)).toEqual(readRuleFields(lf));
  });
});

describe('Rule Editor form', () => {
  let page: HTMLElement;
  beforeAll(async () => {
    mocks.rpc.mockImplementation(route);
    page = await renderPage();
  });

  it.each(['context-engineering-gaps', 'no-devcontainer'])('selects Both for %s', id => {
    markdownToForm(page, toCrlf(builtIn(id)));
    const scope = page.querySelector<HTMLSelectElement>('#rf-scope')!;
    expect(scope.value).toBe('both');
    expect(scope.selectedOptions[0]?.textContent).toBe('Both');
  });

  it('selects Both for a quoted scope, and keeps the quotes', () => {
    const lf = builtIn('no-devcontainer').replace('scope: both', 'scope: "both"');
    markdownToForm(page, toCrlf(lf));
    expect(page.querySelector<HTMLSelectElement>('#rf-scope')!.value).toBe('both');
    expect(formToMarkdown(page)).toBe(lf);
  });

  it('leaves out the fields a rule doesn\'t have', () => {
    const lf = builtIn('lazy-prompting').replace(/^scope: .*\n/m, '').replace(/^# Examples\n[\s\S]*?\n(?=# )/m, '');
    markdownToForm(page, toCrlf(lf));
    expect(formToMarkdown(page)).toBe(lf);
  });

  it('round-trips a rule in a form without the Source view', () => {
    const form = document.createElement('div');
    form.append(page.querySelector('#rule-editor-form')!.cloneNode(true));
    const lf = builtIn('frustration-signals');
    markdownToForm(form, toCrlf(lf));
    expect(formToMarkdown(form)).toBe(lf);
  });

  it('keeps the line breaks of multi-line examples that are edited', () => {
    const lf = builtIn('no-plan-mode');
    markdownToForm(page, toCrlf(lf));
    const examples = input(page, 'rf-examples');
    expect(examples.value.split('\n')).toHaveLength(3);
    examples.value += '\nUse plan mode for refactors';
    expect(parseRule(formToMarkdown(page))?.exampleTemplate).toBe(`${parseRule(lf)!.exampleTemplate}\nUse plan mode for refactors`);
  });
});

describe('Rule Editor Test Rule', () => {
  it.each(['context-engineering-gaps', 'no-devcontainer'])('runs %s from the form as the rule runs directly', async id => {
    const source = toCrlf(builtIn(id));
    const page = await renderPage();
    await openRule(page, id, source);
    expect(page.querySelector<HTMLSelectElement>('#rf-scope')!.value).toBe('both');

    page.querySelector<HTMLButtonElement>('#rule-editor-test')!.click();
    const results = page.querySelector<HTMLElement>('#rule-test-results')!;
    await vi.waitFor(() => expect(results.textContent).toMatch(/TRIGGERED|CLEAN|Error/));

    const markdown = sentMarkdown('testRuleLive');
    expect(markdown).toMatch(/^scope: both$/m);
    expect(markdown).toBe(toLf(source));
    const direct = await testRuleLive(source);
    expect(direct).toMatchObject({ ok: true, triggered: true });
    expect(await testRuleLive(markdown)).toEqual(direct);
    expect(results.textContent).toContain(`TRIGGERED`);
    expect(results.textContent).toContain(`(${direct.occurrences} / ${direct.total})`);
  });

  it('runs the thresholds edited in the form', async () => {
    const page = await renderPage();
    await openRule(page, 'no-devcontainer', toCrlf(builtIn('no-devcontainer')));
    const thresholds = input(page, 'rf-thresholds');
    thresholds.value = thresholds.value.replace(/minTerminalReqs: \d+/, 'minTerminalReqs: 31');

    page.querySelector<HTMLButtonElement>('#rule-editor-test')!.click();
    await vi.waitFor(() => expect(page.querySelector('#rule-test-results')!.textContent).toContain('CLEAN'));
    const markdown = sentMarkdown('testRuleLive');
    expect(markdown).toMatch(/^ {2}minTerminalReqs: 31$/m);
    expect(markdown).toMatch(/^scope: both$/m);
    expect(markdown).toMatch(/^requiresIdeContext: true$/m);
    expect(await testRuleLive(markdown)).toMatchObject({ ok: true, triggered: false, occurrences: 30 });
  });

  it('tests a rule whose detection logic is a # Filter section', async () => {
    const md = ['---', 'id: filter-rule', 'name: Filter rule', 'group: prompt-quality', 'severity: low', 'scope: requests', '---', '', '# Filter', 'messageLength > 0', ''].join('\n');
    const page = await renderPage();
    await openRule(page, 'filter-rule', md);

    page.querySelector<HTMLButtonElement>('#rule-editor-test')!.click();
    await vi.waitFor(() => sentMarkdown('testRuleLive'));
    expect(sentMarkdown('testRuleLive')).toBe(md);
  });
});

describe('Rule Editor Save Rule', () => {
  it('saves the edits made in the form with the rest of the rule', async () => {
    const lf = builtIn('lazy-prompting').replace(/^scope: .*$/m, 'scope: both');
    const page = await renderPage();
    await openRule(page, 'lazy-prompting', toCrlf(lf));
    input(page, 'rf-description').value = 'Short prompts without context.';

    page.querySelector<HTMLButtonElement>('#rule-editor-save')!.click();
    await vi.waitFor(() => sentMarkdown('saveRule'));
    const markdown = sentMarkdown('saveRule');
    expect(markdown).toBe(lf.replace(/^# Description\n.*$/m, '# Description\nShort prompts without context.'));
    expect(testsSection(markdown)).not.toBe('');
    expect(parseRule(markdown)).toMatchObject({ scope: 'both', tests: parseRule(lf)!.tests });
  });

  it('saves the Source tab\'s edits and the form\'s edits together', async () => {
    const lf = builtIn('lazy-prompting');
    const page = await renderPage();
    await openRule(page, 'lazy-prompting', toCrlf(lf));
    input(page, 'rf-name').value = 'Lazy prompts';
    page.querySelector<HTMLElement>('.rule-editor-tab[data-editor-tab="source"]')!.click();

    const source = page.querySelector<HTMLTextAreaElement>('#rule-editor-raw')!;
    expect(source.value).toBe(lf.replace(/^name: .*$/m, 'name: Lazy prompts'));
    source.value = source.value.replace(/^severity: .*$/m, 'severity: high');
    page.querySelector<HTMLElement>('.rule-editor-tab[data-editor-tab="form"]')!.click();
    expect(formValues(page)).toMatchObject({ name: 'Lazy prompts', severity: 'high' });

    page.querySelector<HTMLButtonElement>('#rule-editor-save')!.click();
    await vi.waitFor(() => sentMarkdown('saveRule'));
    expect(sentMarkdown('saveRule')).toBe(lf.replace(/^name: .*$/m, 'name: Lazy prompts').replace(/^severity: .*$/m, 'severity: high'));
  });
});

describe('Rule Editor new rules', () => {
  it('saves a new rule from the template', async () => {
    const page = await renderPage();
    openRuleEditor(page, null);
    input(page, 'rf-id').value = 'short-prompts';
    input(page, 'rf-scope').value = 'both';

    page.querySelector<HTMLButtonElement>('#rule-editor-save')!.click();
    await vi.waitFor(() => sentMarkdown('saveRule'));
    expect(parseRule(sentMarkdown('saveRule'))).toMatchObject({
      id: 'short-prompts', name: 'My Custom Rule', group: 'prompt-quality', severity: 'medium', scope: 'both',
      description: 'Describe what this rule detects.',
    });
  });

  it('saves a generated draft without front matter as a rule with the form\'s front matter', async () => {
    const page = await generateDraft([
      '# Description', 'Short prompts without context.', '',
      '# Detection Logic', '```detect', 'scan: requests', 'match: messageLength < 30', 'aggregate: count', 'check: count >= 5', '```', '',
    ].join('\n'));
    expect(input(page, 'rf-id').value).toBe('short-prompts-without-context');

    page.querySelector<HTMLButtonElement>('#rule-editor-save')!.click();
    await vi.waitFor(() => sentMarkdown('saveRule'));
    const markdown = sentMarkdown('saveRule');
    expect(markdown.endsWith(`---\n${generatedDraft}`)).toBe(true);
    expect(parseRule(markdown)).toMatchObject({
      id: 'short-prompts-without-context', name: 'My Custom Rule', group: 'prompt-quality', severity: 'medium', scope: 'requests',
      description: 'Short prompts without context.',
    });
  });
});

describe('Rule Editor drafts without detection logic', () => {
  it('won\'t test or save a generated draft without detection logic', async () => {
    const alert = vi.fn();
    vi.stubGlobal('alert', alert);
    try {
      const page = await generateDraft('# Description\nShort prompts without context.\n');
      page.querySelector<HTMLButtonElement>('#rule-editor-test')!.click();
      await vi.waitFor(() => expect(page.querySelector('#rule-test-results')!.textContent).toContain('no detection logic'));
      page.querySelector<HTMLButtonElement>('#rule-editor-save')!.click();
      expect(String(alert.mock.calls[0]?.[0])).toContain('no detection logic');
      const methods = mocks.rpc.mock.calls.map(([method]) => String(method));
      expect(methods).not.toContain('testRuleLive');
      expect(methods).not.toContain('saveRule');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
