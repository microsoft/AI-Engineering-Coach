/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Rule editor modal for the Anti-Patterns page -- form + source + AI generate + live test. */

import { DateFilter } from '../core/types';
import { rpc } from './shared';
import { html, render, type ComponentChildren } from './render';
import { DSL_CHEATSHEET } from './dsl-cheatsheet';

const RULE_EDITOR_SYSTEM_PROMPT = `You are an expert at writing detection rules for the AI Engineer Coach VS Code extension.
Rules are markdown files with YAML frontmatter and a Detection Logic block using a custom DSL.

${DSL_CHEATSHEET}

Output ONLY the raw markdown rule. No code fences around the whole output. No explanation.`;

export function parseThresholdsFromMarkdown(md: string): Record<string, number> {
  const result: Record<string, number> = {};
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
  return md.replace(/(thresholds:\n)((?:\s{2,}\S.*\n?)*)/, (_full, head: string, body: string) => {
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

function formToMarkdown(c: HTMLElement): string {
  const val = (id: string) => (c.querySelector(`#${id}`) as HTMLInputElement | HTMLTextAreaElement)?.value?.trim() || '';
  const thresholds = val('rf-thresholds').split('\n').filter(l => l.includes(':')).map(l => '  ' + l.trim()).join('\n');
  const tags = val('rf-tags').split(',').map(t => t.trim()).filter(Boolean);
  const patternsRaw = val('rf-patterns');
  const fileTypesRaw = val('rf-filetypes');
  const extraFm = val('rf-extra-fm');
  return `---
id: ${val('rf-id') || 'my-custom-rule'}
name: ${val('rf-name') || 'My Custom Rule'}
group: ${val('rf-group')}
severity: ${val('rf-severity')}
scope: ${val('rf-scope')}
version: ${val('rf-version') || '1'}
tags: [${tags.join(', ')}]
${thresholds ? `thresholds:\n${thresholds}` : 'thresholds: {}'}
${patternsRaw ? `patterns:\n${patternsRaw}` : ''}${fileTypesRaw ? `\nfileTypes:\n${fileTypesRaw}` : ''}${extraFm ? `\n${extraFm}` : ''}
---

# Description
${val('rf-description') || 'Describe what this rule detects.'}

# When Triggered
${val('rf-when-triggered') || '{{count}} occurrences detected ({{pct}} of requests).'}

# How to Improve
${val('rf-how-to-improve') || 'Explain how to fix this anti-pattern.'}

# Examples
${val('rf-examples') || '"{{message}}..."'}

# Detection Logic
\`\`\`detect
${val('rf-detect') || 'scan: requests\nmatch: messageLength > 0\naggregate: count\ncheck: count >= 1'}
\`\`\`
`;
}

function markdownToForm(c: HTMLElement, md: string): void {
  const set = (id: string, v: string) => {
    const el = c.querySelector(`#${id}`) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    if (el) el.value = v;
  };
  const fmMatch = md.match(/^---\n([\s\S]*?)\n---/);
  if (fmMatch) {
    const fm = fmMatch[1];
    const field = (key: string) => {
      const m = fm.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
      return m ? m[1].trim() : '';
    };
    set('rf-id', field('id'));
    set('rf-name', field('name'));
    set('rf-group', field('group'));
    set('rf-severity', field('severity'));
    set('rf-scope', field('scope'));
    set('rf-version', field('version') || '1');
    const tagsMatch = field('tags');
    const tags = tagsMatch.replaceAll(/^\[|\]$/g, '').split(',').map(t => t.trim()).filter(Boolean);
    set('rf-tags', tags.join(', '));
    const threshMatch = fm.match(/thresholds:\n((?:\s{2,}\S.*\n?)*)/);
    if (threshMatch) {
      set('rf-thresholds', threshMatch[1].replaceAll(/^ {2}/gm, '').trim());
    } else {
      set('rf-thresholds', '');
    }
    const patternsMatch = fm.match(/patterns:\n((?:\s{2,}\S.*\n?)*)/);
    set('rf-patterns', patternsMatch ? patternsMatch[1].trim().replaceAll(/^/gm, '  ') : '');
    const fileTypesMatch = fm.match(/fileTypes:\n((?:\s{2,}\S.*\n?)*)/);
    set('rf-filetypes', fileTypesMatch ? fileTypesMatch[1].trim().replaceAll(/^/gm, '  ') : '');
    const extraFmParts: string[] = [];
    const reqIdeMatch = fm.match(/^requiresIdeContext:\s*(.+)$/m);
    if (reqIdeMatch) extraFmParts.push(`requiresIdeContext: ${reqIdeMatch[1].trim()}`);
    const extendsMatch = fm.match(/^extends:\s*(.+)$/m);
    if (extendsMatch) extraFmParts.push(`extends: ${extendsMatch[1].trim()}`);
    set('rf-extra-fm', extraFmParts.join('\n'));
  }
  const section = (heading: string) => {
    const re = new RegExp(`# ${heading}\\n([\\s\\S]*?)(?=\\n# |$)`);
    const m = md.match(re);
    return m ? m[1].trim() : '';
  };
  set('rf-description', section('Description'));
  set('rf-when-triggered', section('When Triggered'));
  set('rf-how-to-improve', section('How to Improve'));
  const exSection = section('Examples');
  const exClean = exSection.replaceAll(/```detect[\s\S]*?```/g, '').trim();
  set('rf-examples', exClean);
  const detectMatch = md.match(/```detect\n([\s\S]*?)```/);
  set('rf-detect', detectMatch ? detectMatch[1].trim() : '');
}

export function openRuleEditor(container: HTMLElement, existingRuleId: string | null, markdown?: string): void {
  const modal = container.querySelector<HTMLElement>('#rule-editor-modal')!;
  const title = container.querySelector<HTMLElement>('#rule-editor-modal-title')!;
  modal.dataset.ruleId = existingRuleId || '';
  title.textContent = existingRuleId ? 'Edit Rule' : 'New Rule';

  const fields = ['rf-id', 'rf-name', 'rf-tags', 'rf-description', 'rf-when-triggered',
    'rf-how-to-improve', 'rf-examples', 'rf-thresholds', 'rf-detect',
    'rf-patterns', 'rf-filetypes', 'rf-extra-fm'];
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
    (container.querySelector('#rule-editor-raw') as HTMLTextAreaElement).value = markdown;
  } else if (existingRuleId) {
    rpc<{ source: string }>('getRuleSource', { ruleId: existingRuleId }).then(res => {
      // Drop a late response if the editor has since been opened for another rule.
      if (modal.dataset.ruleId !== existingRuleId) return;
      markdownToForm(container, res.source);
      (container.querySelector('#rule-editor-raw') as HTMLTextAreaElement).value = res.source;
    }).catch(() => {});
  } else {
    (container.querySelector('#rule-editor-raw') as HTMLTextAreaElement).value = '';
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
    (container.querySelector('#rule-editor-raw') as HTMLTextAreaElement).value = formToMarkdown(container);
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
      (container.querySelector('#rule-editor-raw') as HTMLTextAreaElement).value = md;
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
