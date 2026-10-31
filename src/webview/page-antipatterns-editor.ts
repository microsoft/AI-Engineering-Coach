/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Rule editor modal for the Anti-Patterns page -- form + source + AI generate + live test. */

import { DateFilter } from '../core/types';
import { rpc } from './shared';
import { html, render, type ComponentChildren } from './render';
import { DSL_CHEATSHEET } from './dsl-cheatsheet';
import { mergeRuleMarkdown, normalizeLineEndings, readRuleFields, type RuleFormField, type RuleFormFields } from './rule-form-markdown';

const RULE_EDITOR_SYSTEM_PROMPT = `You are an expert at writing detection rules for the AI Engineer Coach VS Code extension.
Rules are markdown files with YAML frontmatter and a Detection Logic block using a custom DSL.

${DSL_CHEATSHEET}

Output ONLY the raw markdown rule. No code fences around the whole output. No explanation.`;

export function parseThresholdsFromMarkdown(markdown: string): Record<string, number> {
  const result: Record<string, number> = {};
  const md = normalizeLineEndings(markdown);
  const fmMatch = md.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return result;
  const threshMatch = fmMatch[1].match(/thresholds:\n((?:\s{2,}\S.*\n?)*)/);
  if (!threshMatch) return result;
  for (const line of threshMatch[1].split('\n')) {
    const m = line.match(/^\s+(\w+):\s*([-\d.]+)\s*$/);
    if (m) {
      const n = Number.parseFloat(m[2]);
      if (!Number.isNaN(n)) result[m[1]] = n;
    }
  }
  return result;
}

export function applyThresholdOverrides(md: string, overrides: Record<string, number>): string {
  return normalizeLineEndings(md).replace(/(thresholds:\n)((?:\s{2,}\S.*\n?)*)/, (_full, head: string, body: string) => {
    const newBody = body.replaceAll(/^(\s+)(\w+):[ \t]*([-\d.]+)[ \t]*$/gm, (line, indent: string, key: string, _val: string) => {
      if (overrides[key] !== undefined) {
        const v = overrides[key];
        const formatted = Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000);
        return `${indent}${key}: ${formatted}`;
      }
      return line;
    });
    return head + newBody;
  });
}

function sliderRange(value: number): { min: number; max: number; step: number } {
  if (value >= 0 && value <= 1) return { min: 0, max: 1, step: 0.01 };
  if (value <= 24 && Number.isInteger(value)) return { min: 0, max: 48, step: 1 };
  if (Number.isInteger(value)) return { min: 0, max: Math.max(100, value * 3), step: 1 };
  return { min: 0, max: Math.max(10, value * 3), step: value / 100 };
}

function buildThresholdSliders(thresholds: Record<string, number>, overrides: Record<string, number>): ComponentChildren {
  const keys = Object.keys(thresholds);
  if (keys.length === 0) return null;
  const rows = keys.map(k => {
    const current = overrides[k] !== undefined ? overrides[k] : thresholds[k];
    const { min, max, step } = sliderRange(thresholds[k]);
    const displayVal = Number.isInteger(step) ? String(current) : current.toString();
    return html`
      <div class="rule-threshold-slider-row">
        <label class="rule-threshold-slider-label" title=${k}>${k}</label>
        <input type="range" class="rule-threshold-slider"
          data-key=${k}
          min=${min} max=${max} step=${step} value=${current} />
        <span class="rule-threshold-slider-value" data-threshold-value=${k}>${displayVal}</span>
      </div>`;
  });
  return html`<div class="rule-test-sliders"><div class="rule-test-sliders-title">Tune thresholds (live)</div>${rows}</div>`;
}

type FieldInput = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

const FIELD_INPUTS: Record<RuleFormField, string> = {
  id: 'rf-id',
  name: 'rf-name',
  group: 'rf-group',
  severity: 'rf-severity',
  scope: 'rf-scope',
  version: 'rf-version',
  tags: 'rf-tags',
  thresholds: 'rf-thresholds',
  description: 'rf-description',
  whenTriggered: 'rf-when-triggered',
  howToImprove: 'rf-how-to-improve',
  examples: 'rf-examples',
  detect: 'rf-detect',
};
const FORM_FIELDS = Object.keys(FIELD_INPUTS) as RuleFormField[];

/** What the form was loaded from: the rule markdown, and the form's values then. */
const loadedRules = new WeakMap<HTMLElement, { markdown: string; fields: RuleFormFields }>();

function readForm(c: HTMLElement): RuleFormFields {
  const fields = {} as RuleFormFields;
  for (const field of FORM_FIELDS) fields[field] = c.querySelector<FieldInput>(`#${FIELD_INPUTS[field]}`)?.value.trim() ?? '';
  return fields;
}

/** Fills the form from rule markdown, and keeps that markdown as the Source text that formToMarkdown edits. */
export function markdownToForm(c: HTMLElement, markdown: string): void {
  const fields = readRuleFields(markdown);
  for (const field of FORM_FIELDS) {
    const input = c.querySelector<FieldInput>(`#${FIELD_INPUTS[field]}`);
    const value = fields[field];
    if (input && value !== undefined) input.value = value;
  }
  loadedRules.set(c, { markdown, fields: readForm(c) });
  const source = c.querySelector<HTMLTextAreaElement>('#rule-editor-raw');
  if (source) source.value = markdown;
}

/**
 * Builds rule markdown from the form. A new rule gets the whole template; a loaded rule gets the fields changed
 * since it was loaded written into its Source text (or, without a Source view, into the markdown it was loaded
 * from), so everything the form doesn't show is kept.
 */
export function formToMarkdown(c: HTMLElement): string {
  const loaded = loadedRules.get(c);
  const source = c.querySelector<HTMLTextAreaElement>('#rule-editor-raw')?.value ?? loaded?.markdown ?? '';
  const base = source.trim() ? source : '';
  const fields = readForm(c);
  const changed = FORM_FIELDS.filter(field => !base || fields[field] !== loaded?.fields[field]);
  return mergeRuleMarkdown(base, fields, new Set(changed));
}

export function openRuleEditor(container: HTMLElement, existingRuleId: string | null, markdown?: string): void {
  const modal = container.querySelector<HTMLElement>('#rule-editor-modal')!;
  const title = container.querySelector<HTMLElement>('#rule-editor-modal-title')!;
  modal.dataset.ruleId = existingRuleId || '';
  title.textContent = existingRuleId ? 'Edit Rule' : 'New Rule';

  const fields = ['rf-id', 'rf-name', 'rf-tags', 'rf-description', 'rf-when-triggered',
    'rf-how-to-improve', 'rf-examples', 'rf-thresholds', 'rf-detect', 'rule-editor-raw'];
  for (const id of fields) {
    const el = container.querySelector(`#${id}`) as HTMLInputElement | HTMLTextAreaElement;
    if (el) el.value = '';
  }
  (container.querySelector('#rf-group') as HTMLSelectElement).value = 'prompt-quality';
  (container.querySelector('#rf-severity') as HTMLSelectElement).value = 'medium';
  (container.querySelector('#rf-scope') as HTMLSelectElement).value = 'requests';
  (container.querySelector('#rf-version') as HTMLInputElement).value = '1';
  (container.querySelector('#rule-ai-input') as HTMLInputElement).value = '';
  container.querySelector<HTMLElement>('#rule-ai-status')!.style.display = 'none';
  const testResults = container.querySelector<HTMLElement>('#rule-test-results');
  if (testResults) { testResults.style.display = 'none'; render(null, testResults); }

  if (markdown) {
    markdownToForm(container, markdown);
  } else if (existingRuleId) {
    rpc<{ source: string }>('getRuleSource', { ruleId: existingRuleId }).then(res => {
      markdownToForm(container, res.source);
    }).catch(() => {});
  }

  switchEditorTab(container, 'form');
  modal.style.display = 'flex';
}

function switchEditorTab(container: HTMLElement, tab: 'form' | 'source'): void {
  const tabs = container.querySelectorAll<HTMLElement>('.rule-editor-tab');
  for (const t of tabs) t.classList.toggle('active', t.dataset.editorTab === tab);
  const formPanel = container.querySelector<HTMLElement>('#rule-editor-form')!;
  const sourcePanel = container.querySelector<HTMLElement>('#rule-editor-source')!;
  if (tab === 'form') {
    formPanel.style.display = '';
    sourcePanel.style.display = 'none';
  } else {
    markdownToForm(container, formToMarkdown(container));
    formPanel.style.display = 'none';
    sourcePanel.style.display = '';
  }
}

/**
 * Wire the rule editor modal's event handlers. `onSaved` is invoked after a
 * successful save so the caller can re-render the parent view.
 */
export function wireRuleEditorModal(
  container: HTMLElement,
  currentFilter: DateFilter,
  onSaved: () => Promise<void> | void,
): void {
  const modal = container.querySelector<HTMLElement>('#rule-editor-modal')!;

  container.querySelector('#rule-editor-close')?.addEventListener('click', () => { modal.style.display = 'none'; });
  container.querySelector('#rule-editor-cancel')?.addEventListener('click', () => { modal.style.display = 'none'; });

  for (const tab of container.querySelectorAll('.rule-editor-tab')) {
    tab.addEventListener('click', () => {
      const t = (tab as HTMLElement).dataset.editorTab as 'form' | 'source';
      if (t === 'form') {
        const raw = (container.querySelector('#rule-editor-raw') as HTMLTextAreaElement).value;
        if (raw.trim()) markdownToForm(container, raw);
      }
      switchEditorTab(container, t);
    });
  }

  container.querySelector('#rule-editor-save')?.addEventListener('click', () => {
    void (async () => {
      const activeTab = container.querySelector('.rule-editor-tab.active') as HTMLElement;
      let markdown: string;
      if (activeTab?.dataset.editorTab === 'source') {
        markdown = (container.querySelector('#rule-editor-raw') as HTMLTextAreaElement).value;
      } else {
        markdown = formToMarkdown(container);
      }
      if (!markdown.trim()) return;
      const ruleId = modal.dataset.ruleId || undefined;
      try {
        await rpc<{ ok: boolean }>('saveRule', { markdown, ruleId });
        modal.style.display = 'none';
        await onSaved();
      } catch (err: unknown) {
        alert('Failed to save: ' + (err instanceof Error ? err.message : String(err)));
      }
    })();
  });

  const runTest = async (overrides?: Record<string, number>) => {
    const activeTab = container.querySelector('.rule-editor-tab.active') as HTMLElement;
    let markdown: string;
    if (activeTab?.dataset.editorTab === 'source') {
      markdown = (container.querySelector('#rule-editor-raw') as HTMLTextAreaElement).value;
    } else {
      markdown = formToMarkdown(container);
    }
    if (!markdown.trim()) return;

    if (overrides && Object.keys(overrides).length > 0) {
      markdown = applyThresholdOverrides(markdown, overrides);
    }

    const testBtn = container.querySelector('#rule-editor-test') as HTMLButtonElement;
    const resultsDiv = container.querySelector<HTMLElement>('#rule-test-results')!;
    testBtn.disabled = true;
    testBtn.textContent = 'Testing...';
    resultsDiv.style.display = '';

    const existingSliders = resultsDiv.querySelector('.rule-test-sliders')?.outerHTML || '';
    if (!existingSliders) {
      resultsDiv.className = 'rule-test-results rule-test-loading';
      resultsDiv.textContent = 'Running rule against your data...';
    }

    try {
      const result = await rpc<{
        ok: boolean; triggered: boolean; occurrences: number; total: number;
        pct: string; severity: string; description: string; suggestion: string;
        examples: string[]; error?: string;
      }>('testRuleLive', { markdown, filter: currentFilter as Record<string, unknown> });

      const thresholds = parseThresholdsFromMarkdown(markdown);
      const slidersVNode = buildThresholdSliders(thresholds, overrides || {});

      let bodyVNode: ComponentChildren;
      let className: string;
      if (!result.ok) {
        className = 'rule-test-results rule-test-error';
        bodyVNode = html`<strong>Error:</strong> ${result.error || 'Unknown error'}`;
      } else if (result.triggered) {
        className = 'rule-test-results rule-test-triggered';
        bodyVNode = html`
          <div class="rule-test-header"><strong>TRIGGERED</strong> \u2014 ${result.pct} (${result.occurrences} / ${result.total})</div>
          <div class="rule-test-desc">${result.description}</div>
          ${result.examples.length > 0 ? html`<details class="rule-test-examples"><summary>${result.examples.length} example(s)</summary><ul>${result.examples.map(ex => html`<li>${ex}</li>`)}</ul></details>` : null}
        `;
      } else {
        className = 'rule-test-results rule-test-clean';
        bodyVNode = html`<div class="rule-test-header"><strong>CLEAN</strong> \u2014 Rule did not trigger (${result.occurrences} / ${result.total})</div>`;
      }
      resultsDiv.className = className;
      render(html`${slidersVNode}<div class="rule-test-body">${bodyVNode}</div>`, resultsDiv);

      for (const slider of resultsDiv.querySelectorAll<HTMLInputElement>('.rule-threshold-slider')) {
        const valSpan = resultsDiv.querySelector<HTMLElement>(`[data-threshold-value="${slider.dataset.key}"]`);
        slider.addEventListener('input', () => {
          if (valSpan) valSpan.textContent = slider.value;
        });
        slider.addEventListener('change', () => {
          const key = slider.dataset.key;
          if (!key) return;
          const next: Record<string, number> = { ...(overrides || {}) };
          next[key] = Number.parseFloat(slider.value);
          void runTest(next);
        });
      }
    } catch (err: unknown) {
      resultsDiv.className = 'rule-test-results rule-test-error';
      render(html`<strong>Error:</strong> ${err instanceof Error ? err.message : String(err)}`, resultsDiv);
    } finally {
      testBtn.disabled = false;
      testBtn.textContent = 'Test Rule';
    }
  };

  container.querySelector('#rule-editor-test')?.addEventListener('click', () => {
    void runTest();
  });

  const aiBtn = container.querySelector('#rule-ai-generate') as HTMLButtonElement;
  const aiInput = container.querySelector('#rule-ai-input') as HTMLInputElement;
  const aiStatus = container.querySelector<HTMLElement>('#rule-ai-status')!;

  const doGenerate = async () => {
    const prompt = aiInput.value.trim();
    if (!prompt) return;
    aiBtn.disabled = true;
    aiBtn.textContent = 'Generating...';
    aiStatus.style.display = '';
    aiStatus.className = 'rule-ai-status rule-ai-status-loading';
    aiStatus.textContent = 'AI is generating your rule...';
    try {
      const result = await rpc<{ markdown: string }>('generateRule', { prompt });
      const md = result.markdown;
      markdownToForm(container, md);
      const idField = container.querySelector('#rf-id') as HTMLInputElement;
      if (!idField.value) {
        idField.value = prompt.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-').replaceAll(/^-|-$/g, '').substring(0, 40);
      }
      aiStatus.className = 'rule-ai-status rule-ai-status-ok';
      aiStatus.textContent = 'Rule generated. Review and edit the fields below, then save.';
      switchEditorTab(container, 'form');
    } catch (err: unknown) {
      aiStatus.className = 'rule-ai-status rule-ai-status-error';
      aiStatus.textContent = 'Failed: ' + (err instanceof Error ? err.message : String(err));
    } finally {
      aiBtn.disabled = false;
      aiBtn.textContent = 'Generate';
    }
  };
  aiBtn?.addEventListener('click', () => {
    void doGenerate();
  });
  aiInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void doGenerate();
    }
  });

  container.querySelector('#rule-ai-prompt-info')?.addEventListener('click', () => {
    const promptModal = container.querySelector<HTMLElement>('#rule-ai-prompt-modal')!;
    const view = container.querySelector('#rule-ai-prompt-view')!;
    view.textContent = RULE_EDITOR_SYSTEM_PROMPT;
    promptModal.style.display = 'flex';
  });
  container.querySelector('#rule-ai-prompt-close')?.addEventListener('click', () => {
    container.querySelector<HTMLElement>('#rule-ai-prompt-modal')!.style.display = 'none';
  });
}
