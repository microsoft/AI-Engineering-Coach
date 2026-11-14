/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * @vitest-environment jsdom
 *
 * The Anti-Patterns page's rule detail and Rule Editor on the page's own markup, with each call to the extension
 * answered when, and in the order, a test chooses. Every control keeps one handler however often a detail opens or
 * the page renders again, and an answer for an editor that was closed or reopened since is dropped, so Save always
 * writes the rule whose source the form shows.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseRule } from '../core/rule-parser';
import { renderAntiPatterns } from './page-antipatterns';
import { openRuleEditor } from './page-antipatterns-editor';
import { html, render } from './render';

const mocks = vi.hoisted(() => {
  (globalThis as { acquireVsCodeApi?: () => unknown }).acquireVsCodeApi = () => ({
    postMessage: () => {}, getState: () => null, setState: () => {},
  });
  return { rpc: vi.fn() };
});
vi.mock('./shared', async importOriginal => ({ ...await importOriginal<typeof import('./shared')>(), rpc: mocks.rpc }));
vi.mock('./app', () => ({ consumeNavHint: () => null }));

const RULES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'core', 'rules');
const A = 'lazy-prompting';
const B = 'no-devcontainer';
const C = 'frustration-signals';
const SOURCES: Record<string, string> = Object.fromEntries([A, B, C]
  .map(id => [id, readFileSync(path.join(RULES_DIR, `${id}.md`), 'utf-8').replaceAll('\r\n', '\n')]));

/** A rule as the Rules tab lists it. */
function listed(id: string): Record<string, unknown> {
  const rule = parseRule(SOURCES[id])!;
  return {
    id, name: rule.name, group: rule.group, severity: rule.severity, scope: rule.scope,
    requiresIdeContext: rule.requiresIdeContext, description: rule.description,
    descriptionTemplate: rule.descriptionTemplate, suggestionTemplate: rule.suggestionTemplate,
    exampleTemplate: rule.exampleTemplate, thresholds: rule.thresholds, tags: rule.tags ?? [],
    source: 'built-in', sourceFilePath: '', version: rule.version ?? 1, rawSource: SOURCES[id],
  };
}

const PAGE_DATA: Record<string, unknown> = {
  getAntiPatterns: { patterns: [], totalOccurrences: 0, groupScores: [], weeklyScores: { labels: [], series: [] } },
  getRuleEditor: { rules: [A, B, C].map(listed), previews: [], layers: [], pending: [] },
};
const TRIGGERED = {
  ok: true, triggered: true, occurrences: 4, total: 5, pct: '80%', severity: 'medium',
  description: 'Triggered for the rule that was tested.', suggestion: '', examples: [],
};

/** Calls the page made that the test hasn't answered yet. */
interface HeldCall { method: string; params: Record<string, unknown>; resolve: (value: unknown) => void; reject: (error: Error) => void }
let held: HeldCall[] = [];

beforeEach(() => {
  held = [];
  vi.stubGlobal('alert', vi.fn());
  mocks.rpc.mockReset().mockImplementation((method: string, params?: Record<string, unknown>) => method in PAGE_DATA
    ? Promise.resolve(PAGE_DATA[method])
    : new Promise((resolve, reject) => held.push({ method, params: params ?? {}, resolve, reject })));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** Lets the page handle every answer given so far. */
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

/** The parameters of every call the page made to `method`, answered or not, in order. */
const calls = (method: string) => mocks.rpc.mock.calls
  .filter(([name]) => name === method)
  .map(([, params]) => params as Record<string, unknown>);

function takeHeld(method: string, match: Record<string, unknown>): HeldCall {
  const index = held.findIndex(call => call.method === method
    && Object.entries(match).every(([key, value]) => call.params[key] === value));
  expect(index, `an unanswered ${method} call`).toBeGreaterThanOrEqual(0);
  return held.splice(index, 1)[0];
}

/** Answers the earliest unanswered call to `method` whose parameters include `match`. */
async function answer(method: string, value: unknown, match: Record<string, unknown> = {}): Promise<void> {
  takeHeld(method, match).resolve(value);
  await settle();
}

/** Fails the earliest unanswered call to `method` whose parameters include `match`. */
async function fail(method: string, error: Error, match: Record<string, unknown> = {}): Promise<void> {
  takeHeld(method, match).reject(error);
  await settle();
}

async function renderPage(): Promise<HTMLElement> {
  const page = document.createElement('div');
  document.body.replaceChildren(page);
  await renderAntiPatterns(page, {});
  return page;
}

const el = <T extends HTMLElement = HTMLElement>(page: HTMLElement, selector: string) => page.querySelector<T>(selector)!;
const click = (page: HTMLElement, selector: string) => el(page, selector).click();
const showDetail = (page: HTMLElement, id: string) => click(page, `.rule-card[data-rule-id="${id}"]`);
const formId = (page: HTMLElement) => el<HTMLInputElement>(page, '#rf-id').value;
const shownSource = (page: HTMLElement) => el<HTMLTextAreaElement>(page, '#rule-editor-raw').value;
const button = (page: HTMLElement, id: string) => el<HTMLButtonElement>(page, `#${id}`);

/** Opens the shown rule's editor with Edit Source and lets its source load. */
async function editShownRule(page: HTMLElement, id: string): Promise<void> {
  click(page, '#rule-edit-source-btn');
  await answer('getRuleSource', { source: SOURCES[id] }, { ruleId: id });
  expect(formId(page)).toBe(id);
}

describe('Rule detail', () => {
  it.each([1, 3, 5])('opens one editor, for the rule shown, after %i detail opens', async opens => {
    const page = await renderPage();
    const opened = Array.from({ length: opens }, (_, index) => [A, B, C][index % 3]);
    for (const [index, id] of opened.entries()) {
      if (index > 0) click(page, '#rule-back-btn');
      showDetail(page, id);
    }
    const shown = opened[opened.length - 1];

    click(page, '#rule-edit-source-btn');
    expect(calls('getRuleSource')).toEqual([{ ruleId: shown }]);
    await answer('getRuleSource', { source: SOURCES[shown] });
    expect(formId(page)).toBe(shown);
  });

  it('changes only the shown rule\'s threshold after other rules were shown', async () => {
    const page = await renderPage();
    showDetail(page, A);
    click(page, '#rule-back-btn');
    showDetail(page, B);

    const threshold = el<HTMLInputElement>(page, '.rule-threshold-input');
    expect(threshold.dataset).toMatchObject({ rule: B, key: 'minTerminalReqs' });
    threshold.value = '25';
    threshold.dispatchEvent(new Event('change'));
    await settle();
    expect(calls('updateRuleThreshold')).toEqual([{ ruleId: B, key: 'minTerminalReqs', value: 25 }]);
  });

  it('shows a threshold change\'s preview only in its own rule\'s detail', async () => {
    const page = await renderPage();
    showDetail(page, A);
    const threshold = el<HTMLInputElement>(page, '.rule-threshold-input');
    threshold.value = '40';
    threshold.dispatchEvent(new Event('change'));
    await answer('updateRuleThreshold', { ok: true }, { ruleId: A });
    click(page, '#rule-back-btn');
    showDetail(page, B);

    const stats = el(page, '.rule-preview-stats').textContent;
    await answer('getRulePreview', { ruleId: A, triggered: true, occurrences: 99, total: 100, pct: 99 }, { ruleId: A });
    expect(el(page, '.rule-preview-stats').textContent).toBe(stats);
  });
});

describe('Rule Editor source answering after another rule was opened', () => {
  it('shows and saves the rule opened last when an earlier rule\'s source answers after it', async () => {
    const page = await renderPage();
    showDetail(page, A);
    click(page, '#rule-edit-source-btn');
    click(page, '#rule-editor-cancel');
    click(page, '#rule-back-btn');
    showDetail(page, B);
    click(page, '#rule-edit-source-btn');

    await answer('getRuleSource', { source: SOURCES[B] }, { ruleId: B });
    await answer('getRuleSource', { source: SOURCES[A] }, { ruleId: A });
    expect(formId(page)).toBe(B);
    expect(shownSource(page)).toBe(SOURCES[B]);

    click(page, '#rule-editor-save');
    await settle();
    expect(calls('saveRule')).toEqual([{ markdown: SOURCES[B], ruleId: B }]);
  });

  it('drops a rule\'s source that answers after the editor was opened for another rule', async () => {
    const page = await renderPage();
    openRuleEditor(page, A);
    openRuleEditor(page, B);

    await answer('getRuleSource', { source: SOURCES[A] }, { ruleId: A });
    expect(formId(page)).toBe('');
    expect(button(page, 'rule-editor-save').disabled).toBe(true);

    await answer('getRuleSource', { source: SOURCES[B] }, { ruleId: B });
    expect(formId(page)).toBe(B);
    click(page, '#rule-editor-save');
    await settle();
    expect(calls('saveRule')).toEqual([{ markdown: SOURCES[B], ruleId: B }]);
  });

  it('keeps the rule opened last when the earlier rule\'s source answers after its own, without closing the editor', async () => {
    const page = await renderPage();
    openRuleEditor(page, A);
    openRuleEditor(page, B);

    await answer('getRuleSource', { source: SOURCES[B] }, { ruleId: B });
    await answer('getRuleSource', { source: SOURCES[A] }, { ruleId: A });
    expect(el(page, '#rule-editor-modal').dataset.ruleId).toBe(B);
    expect(formId(page)).toBe(B);
    expect(shownSource(page)).toBe(SOURCES[B]);
    click(page, '#rule-editor-save');
    await settle();
    expect(calls('saveRule')).toEqual([{ markdown: SOURCES[B], ruleId: B }]);
  });
});

describe('Rule Editor source answering after the editor closed', () => {
  it('drops the source', async () => {
    const page = await renderPage();
    showDetail(page, A);
    click(page, '#rule-edit-source-btn');
    click(page, '#rule-editor-cancel');

    await answer('getRuleSource', { source: SOURCES[A] });
    expect(formId(page)).toBe('');
    expect(shownSource(page)).toBe('');
  });

  it('saves a new rule opened since, not the rule whose source answered', async () => {
    const page = await renderPage();
    showDetail(page, A);
    click(page, '#rule-edit-source-btn');
    click(page, '#rule-editor-cancel');
    click(page, '#rule-back-btn');
    click(page, '#rule-new-btn');

    await answer('getRuleSource', { source: SOURCES[A] });
    expect(formId(page)).toBe('');
    el<HTMLInputElement>(page, '#rf-id').value = 'short-prompts';
    click(page, '#rule-editor-save');
    await settle();
    const [save] = calls('saveRule');
    expect(save.ruleId).toBeUndefined();
    expect(parseRule(String(save.markdown))).toMatchObject({ id: 'short-prompts', name: 'My Custom Rule' });
  });
});

/** Checks that Save and Test are disabled, and that even enabled neither sends anything or raises an alert. */
async function expectSaveAndTestRefused(page: HTMLElement): Promise<void> {
  const save = button(page, 'rule-editor-save');
  const test = button(page, 'rule-editor-test');
  expect([save.disabled, test.disabled]).toEqual([true, true]);
  save.disabled = false;
  test.disabled = false;
  save.click();
  test.click();
  await settle();
  save.disabled = true;
  test.disabled = true;
  expect(calls('saveRule')).toEqual([]);
  expect(calls('testRuleLive')).toEqual([]);
  expect(alert).not.toHaveBeenCalled();
}

describe('Rule Editor Save and Test without the rule\'s source', () => {
  it('won\'t save or test a rule before its source loads', async () => {
    const page = await renderPage();
    showDetail(page, A);
    click(page, '#rule-edit-source-btn');
    await expectSaveAndTestRefused(page);
    expect(el(page, '#rule-test-results').style.display).toBe('none');

    await answer('getRuleSource', { source: SOURCES[A] });
    expect([button(page, 'rule-editor-save').disabled, button(page, 'rule-editor-test').disabled]).toEqual([false, false]);
    click(page, '#rule-editor-test');
    await settle();
    expect(calls('testRuleLive').map(params => params.markdown)).toEqual([SOURCES[A]]);
  });

  it('says why it won\'t save or test a rule whose source didn\'t load', async () => {
    const page = await renderPage();
    showDetail(page, A);
    click(page, '#rule-edit-source-btn');
    await fail('getRuleSource', new Error('Rule not found'));

    const results = el(page, '#rule-test-results');
    expect(results.className).toBe('rule-test-results rule-test-error');
    expect(results.style.display).toBe('');
    expect(results.textContent).toContain('Rule not found');
    await expectSaveAndTestRefused(page);
  });

  it('says why it won\'t save or test a rule the extension has no source for', async () => {
    const page = await renderPage();
    showDetail(page, A);
    click(page, '#rule-edit-source-btn');
    await answer('getRuleSource', { source: '' });

    const results = el(page, '#rule-test-results');
    expect(results.className).toBe('rule-test-results rule-test-error');
    expect(results.style.display).toBe('');
    expect(results.textContent).toContain(`No rule "${A}" was found.`);
    expect(formId(page)).toBe('');
    await expectSaveAndTestRefused(page);
  });
});

describe('Rule Editor Save answering late', () => {
  it('leaves an editor opened during the save open, as it was', async () => {
    const page = await renderPage();
    showDetail(page, A);
    await editShownRule(page, A);
    click(page, '#rule-editor-save');
    click(page, '#rule-editor-cancel');
    click(page, '#rule-back-btn');
    showDetail(page, B);
    await editShownRule(page, B);
    el<HTMLInputElement>(page, '#rf-version').value = '2';

    await answer('saveRule', { ok: true }, { ruleId: A });
    expect(calls('getRuleEditor')).toHaveLength(2);
    expect(el(page, '#rule-editor-modal').style.display).toBe('flex');
    expect(formId(page)).toBe(B);
    expect(el<HTMLInputElement>(page, '#rf-version').value).toBe('2');
  });

  it('doesn\'t report a failed save when the save answers after another page was shown', async () => {
    const page = await renderPage();
    showDetail(page, A);
    await editShownRule(page, A);
    click(page, '#rule-editor-save');
    // What the dashboard does when another page is shown.
    render(null, page);
    page.textContent = '';
    render(html`<h1>Dashboard</h1>`, page);

    await answer('saveRule', { ok: true }, { ruleId: A });
    expect(alert).not.toHaveBeenCalled();
  });
});

describe('Rule Editor Generate', () => {
  it('drops a generated rule that answers after the editor was opened for another rule', async () => {
    const page = await renderPage();
    click(page, '#rule-new-btn');
    el<HTMLInputElement>(page, '#rule-ai-input').value = 'Short prompts without context';
    click(page, '#rule-ai-generate');
    expect(calls('generateRule')).toHaveLength(1);
    click(page, '#rule-editor-cancel');
    showDetail(page, B);
    await editShownRule(page, B);
    expect(button(page, 'rule-ai-generate')).toMatchObject({ disabled: false, textContent: 'Generate' });

    await answer('generateRule', { markdown: SOURCES[A] });
    expect(formId(page)).toBe(B);
    expect(shownSource(page)).toBe(SOURCES[B]);
    expect(el(page, '#rule-ai-status').style.display).toBe('none');
    expect(button(page, 'rule-ai-generate')).toMatchObject({ disabled: false, textContent: 'Generate' });

    click(page, '#rule-editor-save');
    await settle();
    expect(calls('saveRule')).toEqual([{ markdown: SOURCES[B], ruleId: B }]);
  });
});

describe('Rule Editor Test Rule answering late', () => {
  it('drops test results that answer after the editor was opened for another rule', async () => {
    const page = await renderPage();
    showDetail(page, A);
    await editShownRule(page, A);
    click(page, '#rule-editor-test');
    expect(calls('testRuleLive')).toHaveLength(1);
    click(page, '#rule-editor-cancel');
    click(page, '#rule-back-btn');
    showDetail(page, B);
    click(page, '#rule-edit-source-btn');
    expect(button(page, 'rule-editor-test')).toMatchObject({ disabled: true, textContent: 'Test Rule' });
    await answer('getRuleSource', { source: SOURCES[B] }, { ruleId: B });

    await answer('testRuleLive', { ...TRIGGERED, description: 'Lazy prompting triggered.' });
    const results = el(page, '#rule-test-results');
    expect(results.style.display).toBe('none');
    expect(results.textContent).not.toContain('Lazy prompting triggered.');
    expect(button(page, 'rule-editor-test')).toMatchObject({ disabled: false, textContent: 'Test Rule' });

    click(page, '#rule-editor-test');
    expect(calls('testRuleLive').map(params => params.markdown)).toEqual([SOURCES[A], SOURCES[B]]);
    await answer('testRuleLive', { ...TRIGGERED, description: 'No devcontainer triggered.' });
    expect(results.textContent).toContain('No devcontainer triggered.');
    expect([...results.querySelectorAll<HTMLInputElement>('.rule-threshold-slider')].map(slider => slider.dataset.key))
      .toEqual(['minTerminalReqs', 'terminalRate']);
  });
});

describe('Rule Editor threshold sliders', () => {
  it('runs one test per slider change, with the changes before it', async () => {
    const page = await renderPage();
    showDetail(page, B);
    await editShownRule(page, B);
    click(page, '#rule-editor-test');
    await answer('testRuleLive', TRIGGERED);
    const sliders = () => page.querySelectorAll<HTMLInputElement>('.rule-threshold-slider');
    expect([...sliders()].map(slider => slider.dataset.key)).toEqual(['minTerminalReqs', 'terminalRate']);

    const slide = async (index: number, value: string) => {
      const slider = sliders()[index];
      slider.value = value;
      slider.dispatchEvent(new Event('change'));
      await settle();
    };
    await slide(0, '25');
    expect(calls('testRuleLive')).toHaveLength(2);
    await answer('testRuleLive', TRIGGERED);
    await slide(0, '30');
    expect(calls('testRuleLive')).toHaveLength(3);
    await answer('testRuleLive', TRIGGERED);
    await slide(1, '0.5');
    expect(calls('testRuleLive')).toHaveLength(4);

    const markdown = String(calls('testRuleLive')[3].markdown);
    expect(markdown).toMatch(/^ {2}minTerminalReqs: 30$/m);
    expect(markdown).toMatch(/^ {2}terminalRate: 0\.5$/m);
  });
});

describe('Anti-Patterns page rendered again by a save', () => {
  it('runs each control once', async () => {
    const page = await renderPage();
    showDetail(page, A);
    await editShownRule(page, A);
    click(page, '#rule-editor-save');
    await answer('saveRule', { ok: true });
    expect(calls('getRuleEditor')).toHaveLength(2);

    click(page, '#rule-back-btn');
    showDetail(page, B);
    click(page, '#rule-edit-source-btn');
    expect(calls('getRuleSource')).toEqual([{ ruleId: A }, { ruleId: B }]);
    await answer('getRuleSource', { source: SOURCES[B] });

    click(page, '#rule-editor-test');
    expect(calls('testRuleLive')).toHaveLength(1);
    await answer('testRuleLive', TRIGGERED);
    el<HTMLInputElement>(page, '#rule-ai-input').value = 'Short prompts without context';
    click(page, '#rule-ai-generate');
    expect(calls('generateRule')).toHaveLength(1);
    await answer('generateRule', { markdown: SOURCES[B] });
    click(page, '#rule-editor-save');
    expect(calls('saveRule')).toHaveLength(2);
  });
});

describe('What the page shows after a save', () => {
  it.each([1, 3])('one section per practice group after %i saves', async saves => {
    const page = await renderPage();
    showDetail(page, A);
    for (let save = 0; save < saves; save++) await saveShownRule(page, A);
    expect([...page.querySelectorAll('#apDetails .ap-group-name')].map(name => name.textContent))
      .toEqual(['Prompt Quality', 'Session Hygiene', 'Code Review', 'Tool Mastery']);
  });

  it('the saved rule, in the detail that was open', async () => {
    const page = await renderPage();
    showDetail(page, A);
    await saveShownRule(page, A, [{ ...listed(A), description: 'The saved description.' }, listed(B)]);
    expect(el(page, '#rule-detail-panel').style.display).toBe('');
    expect(el(page, '.rule-detail-desc').textContent).toBe('The saved description.');
  });

  it('the rule list, when the rule whose detail was open is gone', async () => {
    const page = await renderPage();
    showDetail(page, A);
    await saveShownRule(page, A, [listed(B)]);
    expect(el(page, '#rule-detail-panel').style.display).toBe('none');
    expect(el(page, '#rule-list').style.display).toBe('');
  });
});

async function saveShownRule(page: HTMLElement, id: string, rules?: Record<string, unknown>[]): Promise<void> {
  await editShownRule(page, id);
  const listing = mocks.rpc.getMockImplementation()!;
  if (rules) mocks.rpc.mockImplementation((method: string, params?: Record<string, unknown>) => method === 'getRuleEditor'
    ? Promise.resolve({ ...PAGE_DATA.getRuleEditor as object, rules })
    : listing(method, params) as Promise<unknown>);
  click(page, '#rule-editor-save');
  await answer('saveRule', { ok: true });
}
