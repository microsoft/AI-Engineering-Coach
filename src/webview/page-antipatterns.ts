/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Anti-Patterns page -- merged view with health scores, findings, and rule configuration. */

import { DateFilter, PracticeGroup, PRACTICE_GROUPS } from '../core/types';
import type { RuleSource } from '../core/types/rule-types';
import { rpc, el, COLORS, scoreColor, scoreLabel } from './shared';
import { html, render, type ComponentChildren, ScoreRing, PctBadge } from './render';
import { consumeNavHint } from './app';
import { renderCoverageHeatmap } from './page-antipatterns-heatmap';
import { openRuleEditor, wireRuleEditorModal } from './page-antipatterns-editor';
import { renderDslReferenceContent } from './page-dsl-reference';
import { llmAvailable } from './capabilities';

/* ── Interfaces ── */

interface ApOccurrence {
  timestamp: number;
  workspace: string;
  sessionId: string;
  message: string;
  model: string;
  kind?: 'workspace' | 'session' | 'request';
  stats?: Record<string, number>;
}

interface ApPattern {
  id: string;
  name: string;
  severity: string;
  group: PracticeGroup;
  occurrences: number;
  description: string;
  suggestion: string;
  examples: string[];
  details: ApOccurrence[];
  weeklyHist: { labels: string[]; counts: number[] };
}

interface GroupScore {
  group: PracticeGroup;
  score: number;
  wowPct: number;
  momPct: number;
  topIssue: string | null;
  improvements: string[];
  patternCount: number;
}

interface ApData {
  patterns: ApPattern[];
  totalOccurrences: number;
  groupScores: GroupScore[];
  weeklyScores: { labels: string[]; series: { group: PracticeGroup; scores: number[] }[] };
}

interface RulePreview {
  ruleId: string;
  ruleName: string;
  triggered: boolean;
  occurrences: number;
  total: number;
  pct: number;
  severity: string;
  group: PracticeGroup;
  previewDescription: string;
  previewExamples: string[];
}

interface RuleLayerInfo {
  layer: 'built-in' | 'personal' | 'project';
  directory: string;
  exists: boolean;
  ruleCount: number;
}

interface RuleDetail {
  id: string;
  name: string;
  group: PracticeGroup;
  severity: string;
  scope: string;
  requiresIdeContext: boolean;
  description: string;
  descriptionTemplate: string;
  suggestionTemplate: string;
  exampleTemplate: string;
  thresholds: Record<string, number>;
  tags: string[];
  source: RuleSource;
  sourceFilePath: string;
  version: number;
  rawSource: string;
}

interface RuleEditorData {
  rules: RuleDetail[];
  previews: RulePreview[];
  layers: RuleLayerInfo[];
  dateHistograms?: Record<string, { labels: string[]; counts: number[] }>;
  pending?: Array<{ filePath: string; layer: 'personal' | 'project'; kind: 'rule' | 'metric' }>;
}

const GROUP_COLORS: Record<PracticeGroup, string> = {
  'prompt-quality': COLORS.blue,
  'session-hygiene': COLORS.cyan,
  'code-review': COLORS.purple,
  'tool-mastery': COLORS.green,
  'context-management': COLORS.orange,
};

const GROUP_DESCS: Record<PracticeGroup, string> = {
  'prompt-quality': 'How effectively you write prompts, provide context, and structure tasks for AI.',
  'session-hygiene': 'How well you manage session length, pacing, and work-life balance.',
  'code-review': 'How carefully you review, validate, and sandbox AI-generated output.',
  'tool-mastery': 'How broadly you use AI features, models, and editor capabilities.',
  'context-management': 'How well you manage context window size, avoid bloat, and handle compaction.',
};

const SEVERITY_LABELS: Record<string, { icon: string; color: string; label: string }> = {
  high: { icon: '!', color: 'var(--red)', label: 'High' },
  medium: { icon: '~', color: 'var(--yellow)', label: 'Medium' },
  low: { icon: '-', color: 'var(--text-muted)', label: 'Low' },
};

const SOURCE_STYLES: Record<RuleSource, { icon: string; color: string; label: string }> = {
  'built-in': { icon: 'B', color: 'var(--text-muted)', label: 'Built-in' },
  'personal': { icon: 'P', color: COLORS.blue, label: 'Personal' },
  'project':  { icon: 'W', color: COLORS.green, label: 'Project' },
};

/* ── Helpers ── */

function toEventListener<E extends Event>(handler: (event: E) => Promise<void>): EventListener {
  return (event: Event) => {
    void handler(event as E);
  };
}

function getDatasetValue(element: HTMLElement, key: string): string | null {
  const value = element.dataset[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function severityIcon(sev: string): ComponentChildren {
  if (sev === 'high') return html`<span class="sev-icon sev-high" title="High impact">!</span>`;
  if (sev === 'medium') return html`<span class="sev-icon sev-medium" title="Medium impact">~</span>`;
  return html`<span class="sev-icon sev-low" title="Low impact">-</span>`;
}

function severityBadge(sev: string): ComponentChildren {
  const s = SEVERITY_LABELS[sev] || SEVERITY_LABELS.low;
  return html`<span class="rule-severity-badge" style="--sev-color:${s.color}" title="${s.label} severity">${s.icon} ${s.label}</span>`;
}

function sourceBadge(source: RuleSource): ComponentChildren {
  const s = SOURCE_STYLES[source] || SOURCE_STYLES['built-in'];
  return html`<span class="rule-source-badge" style="--src-color:${s.color}" title="${s.label} rule">${s.label}</span>`;
}

function statPill(label: string, value: string | number, color?: string): ComponentChildren {
  return html`<span class="rule-stat-pill" style=${color ? `color:${color}` : undefined}><span class="rule-stat-value">${value}</span><span class="rule-stat-label">${label}</span></span>`;
}

function sparklineSvg(scores: number[], color: string): ComponentChildren {
  const MAX_WEEKS = 8;
  const pts = scores.slice(-MAX_WEEKS);
  if (pts.length < 2) return null;
  const w = 120, h = 32, pad = 2;
  const dataMin = Math.min(...pts);
  const dataMax = Math.max(...pts);
  const range = dataMax - dataMin;
  const yPad = Math.max(5, range * 0.2);
  const minV = Math.max(0, dataMin - yPad);
  const maxV = Math.min(100, dataMax + yPad);
  const span = maxV - minV || 1;
  const stepX = (w - pad * 2) / (pts.length - 1);
  const coords = pts.map((v, i) => {
    const x = pad + i * stepX;
    const y = pad + (1 - (v - minV) / span) * (h - pad * 2);
    return `${x},${y}`;
  });
  const last = pts[pts.length - 1];
  const lastX = pad + (pts.length - 1) * stepX;
  const lastY = pad + (1 - (last - minV) / span) * (h - pad * 2);
  return html`<svg class="sparkline" width=${w} height=${h} viewBox=${'0 0 ' + w + ' ' + h}>
    <polyline points=${coords.join(' ')} fill="none" stroke=${color} stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx=${lastX} cy=${lastY} r="2.5" fill=${color}/>
  </svg>`;
}

function miniHistogramSvg(counts: number[], labels: string[], color: string): ComponentChildren {
  if (counts.length === 0) return null;
  const max = Math.max(...counts, 1);
  const w = 140, h = 36, pad = 2;
  const barW = Math.max(4, (w - pad * 2 - (counts.length - 1)) / counts.length);
  const gap = 1;
  const bars = counts.map((count, i) => {
    const barH = Math.max(1, (count / max) * (h - pad * 2 - 10));
    const x = pad + i * (barW + gap);
    const y = h - pad - barH;
    const opacity = count > 0 ? 0.85 : 0.15;
    return html`<rect x=${x} y=${y} width=${barW} height=${barH} rx="1" fill=${color} opacity=${opacity}><title>${(labels[i] || '') + ': ' + count}</title></rect>`;
  });
  return html`<svg class="mini-histogram" width=${w} height=${h} viewBox=${'0 0 ' + w + ' ' + h}>${bars}</svg>`;
}

function thresholdRow(key: string, value: number, ruleId: string): ComponentChildren {
  return html`<div class="rule-threshold-row">
    <label class="rule-threshold-label">${key}</label>
    <input type="number" class="rule-threshold-input" data-rule=${ruleId} data-key=${key} value=${value} step="any" />
  </div>`;
}

/* ── Module-level view state ── */
let activeRangeDays = 0;

function buildRangeFilter(f: DateFilter): Record<string, unknown> {
  const filter: Record<string, unknown> = { ...f };
  if (activeRangeDays > 0) {
    const d = new Date();
    d.setDate(d.getDate() - activeRangeDays);
    filter.fromDate = d.toISOString().slice(0, 10);
  }
  return filter;
}

/* ── Main render ── */

export async function renderAntiPatterns(container: HTMLElement, currentFilter: DateFilter): Promise<void> {
  const filter = buildRangeFilter(currentFilter);
  const [apData, ruleData] = await Promise.all([
    rpc<ApData>('getAntiPatterns', filter),
    rpc<RuleEditorData>('getRuleEditor', filter),
  ]);

  const patterns = apData.patterns || [];
  const scores = apData.groupScores || [];
  const rules = ruleData.rules || [];
  const previews = ruleData.previews || [];
  const layers = ruleData.layers || [];
  const pending = ruleData.pending || [];
  const previewMap = new Map(previews.map(p => [p.ruleId, p]));
  const dateHistograms = ruleData.dateHistograms || {};

  const grouped = new Map<PracticeGroup, ApPattern[]>();
  for (const p of patterns) {
    if (!grouped.has(p.group)) grouped.set(p.group, []);
    grouped.get(p.group)!.push(p);
  }

  const triggeredRules = previews.filter(p => p.triggered).length;

  render(html`<div>
    <div class="ap-page-header">
      <h1>Anti-Patterns</h1>
      <p class="ap-page-intro">Review health scores across practice groups, drill into individual findings, and manage the rules that detect them. Switch to the <strong>Rules</strong> tab to browse, create, or edit detection rules using the built-in DSL.</p>
    </div>

    <div class="cons-range-bar" id="antiPatternsRange">
      <button class=${`cons-range-btn${activeRangeDays === 7 ? ' active' : ''}`} data-range="7">Last 7 days</button>
      <button class=${`cons-range-btn${activeRangeDays === 28 ? ' active' : ''}`} data-range="28">Last 4 weeks</button>
      <button class=${`cons-range-btn${activeRangeDays === 90 ? ' active' : ''}`} data-range="90">Last 3 months</button>
      <button class=${`cons-range-btn${activeRangeDays === 180 ? ' active' : ''}`} data-range="180">Last 6 months</button>
      <button class=${`cons-range-btn${activeRangeDays === 0 ? ' active' : ''}`} data-range="0">All time</button>
    </div>

    <div class="ap-tab-bar">
      <button class="ap-tab active" data-tab="antipatterns">Anti-Patterns <span class="ap-tab-badge">${patterns.length}</span></button>
      <button class="ap-tab" data-tab="rules">Rules <span class="ap-tab-badge">${rules.length}</span></button>
    </div>

    <!-- Tab: Anti-Patterns -->
    <div class="ap-tab-content" id="tab-antipatterns">
      <div class="ap-score-grid">
        ${scores.map(g => {
          const color = scoreColor(g.score);
          const name = PRACTICE_GROUPS[g.group];
          const series = apData.weeklyScores?.series.find(s => s.group === g.group);
          const spark = series ? sparklineSvg(series.scores, GROUP_COLORS[g.group]) : null;
          return html`
            <div class="ap-score-card" data-group="${g.group}">
              <div class="ap-score-card-top">
                <${ScoreRing} score=${g.score} color=${color} size=${64} />
                <div>
                  <div class="ap-score-card-name">${name}</div>
                  <div class="ap-score-card-label" style="color:${color}">${scoreLabel(g.score, 'antipatterns')}</div>
                  <div class="ap-score-deltas">
                    <${PctBadge} pct=${g.wowPct} label="WoW" /><${PctBadge} pct=${g.momPct} label="MoM" />
                  </div>
                </div>
              </div>
              ${spark ? html`<div class="ap-sparkline-row">${spark}</div>` : null}
              ${g.improvements.length > 0
                ? html`<div class="ap-score-tip ap-improvements">${g.improvements.map(i => html`<span>${i}</span>`)}</div>`
                : g.topIssue
                  ? html`<div class="ap-score-tip">${g.topIssue}</div>`
                  : html`<div class="ap-score-tip muted">No issues detected</div>`}
            </div>`;
        })}
      </div>
      <div id="apDetails" style="margin-top: 1.5rem;"></div>
    </div>

    <!-- Tab: Rules -->
    <div class="ap-tab-content" id="tab-rules" style="display:none;">
      <div class="ap-rules-header" id="ap-rules-header">
        <div class="ap-rules-title-row">
          <div class="ap-rules-stats">
          ${statPill('Total', rules.length)}${statPill('Triggered', triggeredRules, triggeredRules > 0 ? 'var(--yellow)' : 'var(--green)')}
          </div>
        </div>
        <div class="ap-rules-actions">
          <button class="rule-btn rule-btn-secondary" id="rule-dsl-ref-btn" title="DSL field, function & parser reference">DSL Reference</button>
          <button class="rule-btn rule-btn-secondary" id="rule-coverage-btn" title="Rule x workspace coverage heatmap">Coverage</button>
          <button class="rule-btn rule-btn-secondary" id="rule-help-btn" title="How rule layers work">? Help</button>
          <button class="rule-btn rule-btn-primary" id="rule-new-btn" title="Create a new custom rule">+ New Rule</button>
        </div>
      </div>

      <div class="rule-search-bar" id="rule-search-bar">
        <input type="text" class="rule-search-input" id="rule-search" placeholder="Search rules by name, group, or tag..." />
        <label class="rule-filter-chip" title="Show only personal + project rules">
          <input type="checkbox" id="rule-filter-local" />
          Local only
        </label>
      </div>

      ${pending.length > 0 ? html`
      <div class="rule-pending-banner" id="rule-pending-banner">
        <div class="rule-pending-text">
          <strong>${pending.length}</strong> local rule file${pending.length === 1 ? '' : 's'} blocked pending approval.
          These files are present on disk but haven't been approved to run.
          <ul class="rule-pending-list">
            ${pending.slice(0, 5).map(p => html`<li><code>[${p.layer}/${p.kind}]</code> ${p.filePath}</li>`)}
            ${pending.length > 5 ? html`<li class="muted">+${pending.length - 5} more</li>` : null}
          </ul>
        </div>
        <button class="rule-btn rule-btn-primary" id="rule-review-pending-btn">Review & Approve</button>
      </div>` : null}

      <div class="rule-list" id="rule-list">
        ${renderGroupedRuleCards(rules, previewMap, dateHistograms)}
      </div>

      <!-- Detail panel (hidden by default) -->
      <div class="rule-detail-panel" id="rule-detail-panel" style="display:none;">
        <div class="rule-detail-header">
          <button class="rule-btn rule-btn-back" id="rule-back-btn">${'\u2190'} Back</button>
          <div class="rule-detail-actions">
            <button class="rule-btn rule-btn-secondary" id="rule-edit-source-btn">Edit Source</button>
          </div>
        </div>
        <div id="rule-detail-content"></div>
      </div>
    </div>

    <!-- Unified Rule Editor modal -->
    <div class="rule-source-modal" id="rule-editor-modal" style="display:none;">
      <div class="rule-editor-modal-content">
        <div class="rule-editor-modal-header">
          <h3 id="rule-editor-modal-title">New Rule</h3>
          <div class="rule-editor-modal-tabs">
            <button class="rule-editor-tab active" data-editor-tab="form">Form</button>
            <button class="rule-editor-tab" data-editor-tab="source">Source</button>
          </div>
          <button class="rule-btn rule-btn-secondary" id="rule-editor-close">${'\u00D7'}</button>
        </div>

        <!-- AI Assist bar -->
        <div class="rule-ai-bar">
          <input type="text" class="rule-ai-input" id="rule-ai-input"
            placeholder="Describe the anti-pattern to detect... AI will fill the form" />
          <button class="rule-btn rule-btn-ai" id="rule-ai-generate">Generate</button>
          <button class="rule-btn rule-btn-secondary rule-ai-prompt-info" id="rule-ai-prompt-info" title="View the prompt sent to AI">?</button>
        </div>
        <div class="rule-ai-status" id="rule-ai-status" style="display:none;"></div>

        <!-- Form view -->
        <div class="rule-editor-body" id="rule-editor-form" data-editor-panel="form">
          <div class="rule-form-row rule-form-row-2">
            <div class="rule-form-field">
              <label>Rule ID</label>
              <input type="text" id="rf-id" placeholder="my-custom-rule" spellcheck="false" />
            </div>
            <div class="rule-form-field">
              <label>Name</label>
              <input type="text" id="rf-name" placeholder="My Custom Rule" />
            </div>
          </div>
          <div class="rule-form-row rule-form-row-4">
            <div class="rule-form-field">
              <label>Group</label>
              <select id="rf-group">
                <option value="prompt-quality">Prompt Quality</option>
                <option value="session-hygiene">Session Hygiene</option>
                <option value="code-review">Code Review</option>
                <option value="tool-mastery">Tool Mastery</option>
                <option value="context-management">Context Management</option>
              </select>
            </div>
            <div class="rule-form-field">
              <label>Severity</label>
              <select id="rf-severity">
                <option value="low">Low</option>
                <option value="medium" selected>Medium</option>
                <option value="high">High</option>
              </select>
            </div>
            <div class="rule-form-field">
              <label>Scope</label>
              <select id="rf-scope">
                <option value="requests">Requests</option>
                <option value="sessions">Sessions</option>
              </select>
            </div>
            <div class="rule-form-field">
              <label>Version</label>
              <input type="number" id="rf-version" value="1" min="1" />
            </div>
          </div>
          <div class="rule-form-field">
            <label>Tags <span class="muted">(comma-separated)</span></label>
            <input type="text" id="rf-tags" placeholder="custom, prompt, quality" />
          </div>
          <div class="rule-form-field">
            <label>Description</label>
            <textarea id="rf-description" rows="2" placeholder="What this rule detects."></textarea>
          </div>
          <div class="rule-form-field">
            <label>When Triggered <span class="muted">${'(use {{count}}, {{total}}, {{pct}}, {{extra.key}})'}</span></label>
            <textarea id="rf-when-triggered" rows="2" placeholder="${'{{count}} occurrences detected out of {{total}} ({{pct}}).'}"></textarea>
          </div>
          <div class="rule-form-field">
            <label>How to Improve</label>
            <textarea id="rf-how-to-improve" rows="2" placeholder="Actionable advice for the user."></textarea>
          </div>
          <div class="rule-form-field">
            <label>Examples Template</label>
            <input type="text" id="rf-examples" placeholder=${"\"{{message}}...\""} />
          </div>
          <div class="rule-form-field">
            <label>Thresholds <span class="muted">(key: value, one per line)</span></label>
            <textarea id="rf-thresholds" rows="2" placeholder="myThreshold: 0.5" class="rule-mono"></textarea>
          </div>
          <div class="rule-form-field">
            <label>Detection Logic <span class="muted">(DSL)</span></label>
            <textarea id="rf-detect" rows="8" class="rule-mono" spellcheck="false" placeholder=${"scan: requests\nmatch: messageLength > 0\naggregate: count\ncheck: count >= thresholds.myThreshold\nexamples: \"{{messageText | truncate:60}}\""}></textarea>
          </div>
          <textarea id="rf-patterns" style="display:none"></textarea>
          <textarea id="rf-filetypes" style="display:none"></textarea>
          <textarea id="rf-extra-fm" style="display:none"></textarea>
        </div>

        <!-- Source view -->
        <div class="rule-editor-body" id="rule-editor-source" data-editor-panel="source" style="display:none;">
          <textarea class="rule-source-editor rule-source-full" id="rule-editor-raw" spellcheck="false"></textarea>
        </div>

        <!-- Test results area -->
        <div class="rule-test-results" id="rule-test-results" style="display:none;"></div>

        <div class="rule-editor-footer">
          <button class="rule-btn rule-btn-secondary" id="rule-editor-cancel">Cancel</button>
          <button class="rule-btn rule-btn-test" id="rule-editor-test">Test Rule</button>
          <button class="rule-btn rule-btn-primary" id="rule-editor-save">Save Rule</button>
        </div>
      </div>
    </div>

    <!-- AI Prompt viewer modal -->
    <div class="rule-source-modal" id="rule-ai-prompt-modal" style="display:none;">
      <div class="rule-source-modal-content">
        <div class="rule-source-modal-header">
          <h3>AI System Prompt</h3>
          <button class="rule-btn rule-btn-secondary" id="rule-ai-prompt-close">${'\u00D7'}</button>
        </div>
        <pre class="rule-ai-prompt-view" id="rule-ai-prompt-view"></pre>
      </div>
    </div>

    <!-- DSL Reference modal -->
    <div class="rule-source-modal" id="rule-dsl-ref-modal" style="display:none;">
      <div class="rule-source-modal-content rule-dsl-ref-content">
        <div class="rule-source-modal-header">
          <h3>DSL Reference</h3>
          <button class="rule-btn rule-btn-secondary" id="rule-dsl-ref-close">${'\u00D7'}</button>
        </div>
        <div class="rule-dsl-ref-body" id="rule-dsl-ref-body">
          <div class="loading-spinner"></div>
        </div>
      </div>
    </div>

    <!-- Coverage heatmap modal -->
    <div class="rule-source-modal" id="rule-coverage-modal" style="display:none;">
      <div class="rule-source-modal-content rule-coverage-content">
        <div class="rule-source-modal-header">
          <h3>Rule Coverage Heatmap</h3>
          <button class="rule-btn rule-btn-secondary" id="rule-coverage-close">${'\u00D7'}</button>
        </div>
        <div class="rule-coverage-body" id="rule-coverage-body">
          <div class="rule-coverage-loading">Loading...</div>
        </div>
      </div>
    </div>

    <!-- Help modal -->
    <div class="rule-source-modal" id="rule-help-modal" style="display:none;">
      <div class="rule-source-modal-content rule-help-content">
        <div class="rule-source-modal-header">
          <h3>Rule Layers</h3>
          <button class="rule-btn rule-btn-secondary" id="rule-help-close">${'\u00D7'}</button>
        </div>
        <div class="rule-help-body">
          <p>Rules are loaded from three layers. Higher layers override lower ones when rule IDs match.</p>
          <div class="rule-help-layers">
            <div class="rule-help-layer">
              <div class="rule-help-layer-header">
                <span class="rule-source-badge" style="--src-color:${COLORS.green}">Project</span>
                <span class="rule-help-precedence">Highest priority</span>
              </div>
              <p>Workspace-specific rules. Shared with your team via version control.</p>
              <code class="rule-help-path">${'<workspace>/.ai-engineer-coach/rules/*.md'}</code>
              ${renderLayerStatus(layers, 'project')}
            </div>
            <div class="rule-help-layer">
              <div class="rule-help-layer-header">
                <span class="rule-source-badge" style="--src-color:${COLORS.blue}">Personal</span>
                <span class="rule-help-precedence">Medium priority</span>
              </div>
              <p>Your personal rules. Applied across all workspaces on this machine.</p>
              <code class="rule-help-path">~/.ai-engineer-coach/rules/*.md</code>
              ${renderLayerStatus(layers, 'personal')}
            </div>
            <div class="rule-help-layer">
              <div class="rule-help-layer-header">
                <span class="rule-source-badge" style="--src-color:var(--text-muted)">Built-in</span>
                <span class="rule-help-precedence">Lowest priority</span>
              </div>
              <p>Default rules shipped with the extension. Always available.</p>
              ${renderLayerStatus(layers, 'built-in')}
            </div>
          </div>
          <div class="rule-help-howto">
            <h4>Creating a custom rule</h4>
            <p>Create a <code>.md</code> file in any rule directory above. The filename (without extension) becomes the rule ID.</p>
            <p>To override a built-in rule, create a file with the same name (e.g. <code>lazy-prompting.md</code>) in your personal or project rules directory.</p>
          </div>
        </div>
      </div>
    </div>
  </div>`, container);

  // Render findings
  renderFindings(container, scores, grouped, apData);

  // Wire tab switching
  wireTabBar(container);

  // Wire date range filter
  container.querySelector('#antiPatternsRange')?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-range]');
    const range = btn?.dataset.range;
    if (!btn || !range) return;
    activeRangeDays = Number(range);
    void renderAntiPatterns(container, currentFilter);
  });

  // Wire up rules section
  wireRulesSection(container, rules, previewMap, filter);
}

/* ── Tab switching ── */

function wireTabBar(container: HTMLElement): void {
  const tabs = container.querySelectorAll<HTMLElement>('.ap-tab');
  const panels = container.querySelectorAll<HTMLElement>('.ap-tab-content');

  for (const tab of tabs) {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      for (const t of tabs) t.classList.remove('active');
      tab.classList.add('active');
      for (const p of panels) {
        p.style.display = p.id === `tab-${target}` ? '' : 'none';
      }
    });
  }
}

/* ── Findings per group ── */

function renderFindings(
  container: HTMLElement,
  scores: GroupScore[],
  grouped: Map<PracticeGroup, ApPattern[]>,
  _apData: ApData,
): void {
  const detailsContainer = container.querySelector('#apDetails')!;
  const allGroupKeys: PracticeGroup[] = ['prompt-quality', 'session-hygiene', 'code-review', 'tool-mastery'];

  for (const groupKey of allGroupKeys) {
    const gs = scores.find(s => s.group === groupKey);
    const groupPatterns = grouped.get(groupKey) || [];
    const groupName = PRACTICE_GROUPS[groupKey];
    const groupColor = GROUP_COLORS[groupKey];
    const groupDesc = GROUP_DESCS[groupKey];
    const score = gs?.score ?? 100;
    const summaryColor = scoreColor(score);

    const section = el('details', 'ap-group-details');
    render(html`
      <summary class="ap-group-summary">
        <div class="ap-group-summary-left">
          <span class="ap-group-dot" style="background:${groupColor}"></span>
          <span class="ap-group-name">${groupName}</span>
          <span class="ap-group-score" style="color:${summaryColor}">${score}/100</span>
        </div>
        <div class="ap-group-summary-right">
          <span class="muted">${groupPatterns.length} finding${groupPatterns.length !== 1 ? 's' : ''}</span>
          <span class="ap-expand-hint">${'\u25BE'}</span>
        </div>
      </summary>
      <p class="ap-group-desc">${groupDesc}</p>
    `, section);

    if (groupPatterns.length === 0) {
      const good = el('div', 'ap-group-clean');
      good.textContent = 'All checks passing -- no anti-patterns detected.';
      section.appendChild(good);
    } else {
      if (gs && gs.improvements.length > 0) {
        const banner = el('div', 'ap-improvements-banner');
        render(html`<span>${gs.improvements.map(i => html`<div class="ap-improvement-item">${i}</div>`)}</span>`, banner);
        section.appendChild(banner);
      }

      for (const p of groupPatterns) {
        const card = el('div', 'ap-finding');
        render(html`<span>
          <div class="ap-finding-header">
            ${severityIcon(p.severity)}
            <span class="ap-finding-name">${p.name}</span>
          </div>
          <div class="ap-finding-body">
            <div class="ap-finding-section ap-finding-problem">
              <span class="ap-finding-label">Problem</span>
              <span>${p.description}</span>
            </div>
            <div class="ap-finding-section ap-finding-action">
              <span class="ap-finding-label">Action</span>
              <span>${p.suggestion}</span>
            </div>
            ${renderOccurrencePanel(p)}
          </div>
        </span>`, card);
        section.appendChild(card);
      }
    }
    detailsContainer.appendChild(section);
  }

  const hint = consumeNavHint();
  if (hint) {
    const allDetails = detailsContainer.querySelectorAll<HTMLDetailsElement>('.ap-group-details');
    const groupIndex = allGroupKeys.indexOf(hint as PracticeGroup);
    if (groupIndex >= 0 && allDetails[groupIndex]) {
      allDetails[groupIndex].open = true;
      setTimeout(() => allDetails[groupIndex].scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
    }
  }

  // Wire AI "Why?" explainer buttons (delegated)
  wireExplainButtons(container, _apData);
}

async function explainOccurrence(
  button: HTMLButtonElement,
  filter?: DateFilter,
): Promise<void> {
  const ruleId = getDatasetValue(button, 'ruleId');
  const sessionId = getDatasetValue(button, 'sessionId');
  if (!ruleId || !sessionId) return;

  const row = button.closest<HTMLElement>('.occ-session-row');
  const resultDiv = row?.querySelector<HTMLElement>('.occ-explain-result');
  if (!resultDiv) return;

  if (resultDiv.style.display === '' && resultDiv.dataset.loaded === 'true') {
    resultDiv.style.display = 'none';
    return;
  }

  button.disabled = true;
  button.textContent = 'Thinking...';
  resultDiv.style.display = '';
  resultDiv.className = 'occ-explain-result occ-explain-loading';
  resultDiv.textContent = 'Asking AI for an explanation...';

  try {
    const request: { ruleId: string; sessionId: string; filter?: Record<string, unknown> } = {
      ruleId,
      sessionId,
    };
    if (filter) {
      request.filter = filter as Record<string, unknown>;
    }
    const res = await rpc<{ ok: boolean; explanation: string; error?: string }>('explainOccurrence', request);
    if (res.ok) {
      resultDiv.className = 'occ-explain-result occ-explain-ok';
      const lines = res.explanation.split('\n');
      render(html`<span>${lines.map((line, i) => html`<span>${line}${i < lines.length - 1 ? html`<br/>` : null}</span>`)}</span>`, resultDiv);
      resultDiv.dataset.loaded = 'true';
    } else {
      resultDiv.className = 'occ-explain-result occ-explain-error';
      resultDiv.textContent = res.error || 'Failed to get explanation.';
    }
  } catch (err: unknown) {
    resultDiv.className = 'occ-explain-result occ-explain-error';
    resultDiv.textContent = err instanceof Error ? err.message : String(err);
  } finally {
    button.disabled = false;
    button.textContent = 'Why?';
  }
}

function wireExplainButtons(container: HTMLElement, _apData: ApData): void {
  // Delegated click handler — works for both findings view and rule detail view
  const handleExplainClick = async (e: Event): Promise<void> => {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;

    const button = target.closest<HTMLButtonElement>('.occ-explain-btn');
    if (!button) return;
    e.preventDefault();
    e.stopPropagation();
    await explainOccurrence(button);
  };

  const handler = toEventListener(handleExplainClick);
  // Remove any previously attached handler to avoid duplicates on re-render
  const key = '__explainHandler';
  const prev = (container as unknown as Record<string, EventListener | undefined>)[key];
  if (prev) container.removeEventListener('click', prev);
  container.addEventListener('click', handler);
  (container as unknown as Record<string, EventListener | undefined>)[key] = handler;
}

/* ── Occurrence detail panel ── */

function formatOccDate(ts: number): string {
  if (ts <= 0) return '';
  const d = new Date(ts);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatOccTime(ts: number): string {
  if (ts <= 0) return '';
  const d = new Date(ts);
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function occHistogramSvg(hist: { labels: string[]; counts: number[] }, color: string): ComponentChildren {
  const { labels, counts } = hist;
  if (counts.length === 0) return null;
  const max = Math.max(...counts, 1);
  const w = 240, h = 48, pad = 2;
  const barW = Math.max(6, (w - pad * 2 - (counts.length - 1) * 2) / counts.length);
  const gap = 2;
  const bars: ComponentChildren[] = [];
  for (let i = 0; i < counts.length; i++) {
    const count = counts[i];
    const barH = Math.max(1, (count / max) * (h - pad * 2 - 12));
    const x = pad + i * (barW + gap);
    const y = h - pad - barH - 10;
    const opacity = count > 0 ? 0.9 : 0.15;
    const shortLabel = labels[i]?.replace(/^\d{4}-W/, 'W') || '';
    bars.push(html`<rect x=${x} y=${y} width=${barW} height=${barH} rx="2" fill=${color} opacity=${opacity}><title>${shortLabel + ': ' + count}</title></rect>`);
    if (i === 0 || i === counts.length - 1 || (counts.length > 4 && i === Math.floor(counts.length / 2))) {
      bars.push(html`<text x=${x + barW / 2} y=${h - 1} text-anchor="middle" fill="var(--text-muted)" font-size="7" font-family="var(--vscode-font-family, sans-serif)">${shortLabel}</text>`);
    }
  }
  return html`<svg class="occ-histogram" width=${w} height=${h} viewBox=${'0 0 ' + w + ' ' + h}>${bars}</svg>`;
}

function renderExamplesBlock(examples: string[]): ComponentChildren {
  if (examples.length === 0) return null;
  return html`
    <details class="ap-examples">
      <summary>${examples.length} example${examples.length !== 1 ? 's' : ''}</summary>
      <ul>${examples.map(ex => html`<li>${ex}</li>`)}</ul>
    </details>`;
}

function renderOccurrencePanel(p: ApPattern): ComponentChildren {
  const details = p.details || [];
  const hist = p.weeklyHist;
  const hasHist = hist && hist.counts.length > 0;

  // Fallback to examples view when no rich details or histogram available
  if (details.length === 0 && !hasHist) {
    return renderExamplesBlock(p.examples);
  }

  const color = GROUP_COLORS[p.group] || COLORS.blue;
  const histVNode = hasHist ? occHistogramSvg(hist, color) : null;

  // Detect workspace-level occurrences
  const isWorkspaceLevel = details.length > 0 && details[0].kind === 'workspace';

  if (isWorkspaceLevel) {
    return renderWorkspaceOccurrences(p, details, histVNode, color);
  }

  return renderSessionOccurrences(p, details, histVNode);
}

function renderWorkspaceOccurrences(
  p: ApPattern, details: ApOccurrence[], histVNode: ComponentChildren, color: string,
): ComponentChildren {
  const hasFlaggedMetric = details.some(d => d.stats?.isLow !== undefined || d.stats?.ratio !== undefined);
  const flagged = hasFlaggedMetric
    ? details.filter(d => d.stats?.isLow || (d.stats?.ratio !== undefined && d.stats.ratio < 0.05))
    : details; // When no flagged/healthy distinction, treat all as flagged
  const healthy = hasFlaggedMetric
    ? details.filter(d => !flagged.includes(d))
    : [];
  const displayFlagged = flagged.slice(0, 30);
  const displayHealthy = healthy.slice(0, 10);

  function wsBar(d: ApOccurrence): ComponentChildren {
    const s = d.stats || {};
    // Find the main metric pair to visualize
    const codeLoc = s.codeLoc ?? s.code ?? 0;
    const mdLoc = s.mdLoc ?? s.md ?? 0;
    const total = codeLoc + mdLoc;
    const pct = total > 0 ? Math.round((mdLoc / total) * 100) : 0;
    const truncName = d.workspace.length > 35 ? d.workspace.substring(0, 33) + '...' : d.workspace;
    const statsLabel = total > 0
      ? `${fmtK(codeLoc)} code, ${fmtK(mdLoc)} md (${pct}%)`
      : Object.entries(s).filter(([k]) => k !== 'isLow' && k !== 'ratio').map(([k, v]) => `${k}: ${fmtK(v)}`).join(', ');
    const isFlagged = hasFlaggedMetric ? (pct < 5 && total > 0) : true;

    return html`
      <div class="occ-ws-row ${isFlagged ? 'occ-ws-flagged' : ''}">
        <div class="occ-ws-header">
          <span class="occ-ws-name">${truncName}</span>
          <span class="occ-ws-stats">${statsLabel}</span>
        </div>
        ${d.message ? html`<div class="occ-ws-message">${d.message}</div>` : null}
        ${total > 0 ? html`<div class="occ-ws-bar"><div class="occ-ws-bar-fill" style=${'width:' + Math.max(pct, 1) + '%;background:' + color}></div></div>` : null}
      </div>`;
  }

  const totalWs = details.length;
  const moreCount = flagged.length - displayFlagged.length + healthy.length - displayHealthy.length;

  return html`
    <details class="ap-occurrences">
      <summary class="ap-occ-summary">
        <span>${p.occurrences} workspace${p.occurrences !== 1 ? 's' : ''} affected out of ${totalWs}</span>
        ${histVNode}
      </summary>
      <div class="ap-occ-body">
        <div class="occ-ws-list">
          ${displayFlagged.map(wsBar)}
          ${displayHealthy.length > 0 ? html`<div class="occ-ws-divider">Healthy workspaces</div>${displayHealthy.map(wsBar)}` : null}
          ${moreCount > 0 ? html`<div class="occ-session-more">+ ${moreCount} more workspaces</div>` : null}
        </div>
        ${renderExamplesBlock(p.examples)}
      </div>
    </details>`;
}

function fmtK(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}

function renderSessionOccurrences(
  p: ApPattern, details: ApOccurrence[], histVNode: ComponentChildren,
): ComponentChildren {
  // Group details by session to show unique sessions
  const sessionMap = new Map<string, { workspace: string; count: number; firstTs: number; lastTs: number; messages: string[] }>();
  for (const d of details) {
    const key = d.sessionId || d.workspace || 'unknown';
    if (!sessionMap.has(key)) {
      sessionMap.set(key, { workspace: d.workspace, count: 0, firstTs: d.timestamp, lastTs: d.timestamp, messages: [] });
    }
    const entry = sessionMap.get(key)!;
    entry.count++;
    if (d.timestamp > 0) {
      if (d.timestamp < entry.firstTs || entry.firstTs <= 0) entry.firstTs = d.timestamp;
      if (d.timestamp > entry.lastTs) entry.lastTs = d.timestamp;
    }
    if (d.message && entry.messages.length < 3) entry.messages.push(d.message);
  }

  // Sort sessions by most recent first
  const sessionEntries = [...sessionMap.entries()].sort((a, b) => b[1].lastTs - a[1].lastTs);
  const displayCount = Math.min(sessionEntries.length, 15);
  const totalSessions = sessionEntries.length;

  const sessionItems = sessionEntries.slice(0, displayCount).map(([sid, info]) => {
    const dateStr = formatOccDate(info.lastTs);
    const timeStr = formatOccTime(info.lastTs);
    const truncWs = info.workspace.length > 30 ? info.workspace.substring(0, 28) + '...' : info.workspace;
    return html`
      <div class="occ-session-row" title=${sid}>
        <div class="occ-session-meta">
          <span class="occ-session-ws">${truncWs}</span>
          <span class="occ-session-date">${dateStr} ${timeStr}</span>
          <span class="occ-session-count">${info.count}x</span>
          ${llmAvailable() ? html`<button class="occ-explain-btn" data-rule-id=${p.id} data-session-id=${sid} title="Ask AI why this session triggered the rule">Why?</button>` : null}
        </div>
        ${info.messages.length > 0 ? html`<div class="occ-msg-preview">${info.messages.map(m => html`<span>${m.length > 80 ? m.substring(0, 78) + '...' : m}</span>`)}</div>` : null}
        <div class="occ-explain-result" data-session-id=${sid} style="display:none;"></div>
      </div>`;
  });

  return html`
    <details class="ap-occurrences">
      <summary class="ap-occ-summary">
        <span>${p.occurrences} occurrence${p.occurrences !== 1 ? 's' : ''} across ${totalSessions} session${totalSessions !== 1 ? 's' : ''}</span>
        ${histVNode}
      </summary>
      <div class="ap-occ-body">
        <div class="occ-session-list">
          ${sessionItems}
          ${totalSessions > displayCount ? html`<div class="occ-session-more">+ ${totalSessions - displayCount} more sessions</div>` : null}
        </div>
        ${renderExamplesBlock(p.examples)}
      </div>
    </details>`;
}

/* ── Rule card rendering ── */

function renderGroupedRuleCards(
  rules: RuleDetail[],
  previewMap: Map<string, RulePreview>,
  dateHistograms: Record<string, { labels: string[]; counts: number[] }>,
): ComponentChildren {
  const groups: PracticeGroup[] = ['prompt-quality', 'session-hygiene', 'code-review', 'tool-mastery', 'context-management'];
  const byGroup = new Map<PracticeGroup, RuleDetail[]>();
  for (const r of rules) {
    if (!byGroup.has(r.group)) byGroup.set(r.group, []);
    byGroup.get(r.group)!.push(r);
  }

  return html`${groups.map(group => {
    const groupRules = byGroup.get(group);
    if (!groupRules || groupRules.length === 0) return null;
    const groupName = PRACTICE_GROUPS[group];
    const groupColor = GROUP_COLORS[group];
    const triggeredCount = groupRules.filter(r => previewMap.get(r.id)?.triggered).length;

    return html`
      <div class="rule-group-section" data-group=${group}>
        <div class="rule-group-header">
          <span class="rule-group-dot" style="background:${groupColor}"></span>
          <span class="rule-group-name">${groupName}</span>
          <span class="rule-group-count">${groupRules.length} rules</span>
          ${triggeredCount > 0 ? html`<span class="rule-group-triggered">${triggeredCount} triggered</span>` : null}
        </div>
        <div class="rule-cards">
          ${groupRules.map(r => renderRuleCard(r, previewMap.get(r.id), dateHistograms[r.id], groupColor))}
        </div>
      </div>
    `;
  })}`;
}

function renderRuleCard(
  rule: RuleDetail,
  preview: RulePreview | undefined,
  histogram: { labels: string[]; counts: number[] } | undefined,
  groupColor: string,
): ComponentChildren {
  const triggered = preview?.triggered ?? false;
  const occurrences = preview?.occurrences ?? 0;
  const total = preview?.total ?? 0;
  const pct = preview?.pct ?? 0;
  const statusClass = triggered ? 'rule-card-triggered' : 'rule-card-clean';
  const histSvg = histogram ? miniHistogramSvg(histogram.counts, histogram.labels, triggered ? COLORS.yellow : groupColor) : null;

  return html`
    <div class="rule-card ${statusClass}" data-rule-id=${rule.id} data-tags=${rule.tags.join(',')} data-name=${rule.name.toLowerCase()} data-source=${rule.source}>
      <div class="rule-card-top">
        <div class="rule-card-name-row">
          <span class="rule-card-name">${rule.name}</span>
          ${severityBadge(rule.severity)}
          ${sourceBadge(rule.source)}
        </div>
        <div class="rule-card-desc">${rule.description}</div>
      </div>
      <div class="rule-card-bottom">
        <div class="rule-card-stats">
          <div class="rule-card-stat">
            <span class="rule-card-stat-value ${triggered ? 'stat-warn' : 'stat-ok'}">${occurrences}</span>
            <span class="rule-card-stat-label">flagged</span>
          </div>
          <div class="rule-card-stat">
            <span class="rule-card-stat-value">${total}</span>
            <span class="rule-card-stat-label">total</span>
          </div>
          <div class="rule-card-stat">
            <span class="rule-card-stat-value ${triggered ? 'stat-warn' : 'stat-ok'}">${pct}%</span>
            <span class="rule-card-stat-label">rate</span>
          </div>
        </div>
        ${histSvg ? html`<div class="rule-card-histogram" title="Weekly trend">${histSvg}</div>` : null}
      </div>
    </div>
  `;
}

/* ── Wire up rules section interactions ── */

function wireRulesSection(
  container: HTMLElement,
  rules: RuleDetail[],
  previewMap: Map<string, RulePreview>,
  currentFilter: DateFilter,
): void {
  // Search + local-only filter
  const searchInput = container.querySelector<HTMLInputElement>('#rule-search');
  const localOnly = container.querySelector<HTMLInputElement>('#rule-filter-local');
  const applyFilters = (): void => {
    const query = (searchInput?.value || '').toLowerCase();
    const localOnlyActive = !!localOnly?.checked;
    const cards = container.querySelectorAll<HTMLElement>('.rule-card');
    const sections = container.querySelectorAll<HTMLElement>('.rule-group-section');
    for (const card of cards) {
      const name = getDatasetValue(card, 'name') || '';
      const tags = getDatasetValue(card, 'tags') || '';
      const ruleId = getDatasetValue(card, 'ruleId') || '';
      const source = getDatasetValue(card, 'source') || '';
      const matchesQuery = !query || name.includes(query) || tags.includes(query) || ruleId.includes(query);
      const matchesLocal = !localOnlyActive || source === 'personal' || source === 'project';
      card.style.display = (matchesQuery && matchesLocal) ? '' : 'none';
    }
    for (const section of sections) {
      const visible = section.querySelectorAll('.rule-card:not([style*="display: none"])');
      section.style.display = visible.length > 0 ? '' : 'none';
    }
  };
  searchInput?.addEventListener('input', applyFilters);
  localOnly?.addEventListener('change', applyFilters);

  // Review pending local rules banner
  container.querySelector('#rule-review-pending-btn')?.addEventListener('click', toEventListener(async () => {
    await rpc<{ ok: boolean }>('reviewLocalRules');
    // The command itself reloads the dashboard; no follow-up render needed here.
  }));

  // Rule card click -> detail
  container.querySelector('#rule-list')?.addEventListener('click', (e) => {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;

    const card = target.closest<HTMLElement>('.rule-card');
    if (!card) return;
    const ruleId = getDatasetValue(card, 'ruleId');
    if (ruleId) showRuleDetail(container, ruleId, rules, previewMap, currentFilter);
  });

  // Back button
  container.querySelector('#rule-back-btn')?.addEventListener('click', () => {
    container.querySelector<HTMLElement>('#rule-list')!.style.display = '';
    container.querySelector<HTMLElement>('#rule-detail-panel')!.style.display = 'none';
    container.querySelector<HTMLElement>('#rule-search-bar')!.style.display = '';
    container.querySelector<HTMLElement>('#ap-rules-header')!.style.display = '';
  });

  // Unified Rule Editor
  wireRuleEditorModal(container, currentFilter, () => renderAntiPatterns(container, currentFilter));

  // New rule button -> open editor in create mode
  container.querySelector('#rule-new-btn')?.addEventListener('click', () => {
    openRuleEditor(container, null);
  });

  // Help
  container.querySelector('#rule-help-btn')?.addEventListener('click', () => {
    container.querySelector<HTMLElement>('#rule-help-modal')!.style.display = 'flex';
  });
  container.querySelector('#rule-help-close')?.addEventListener('click', () => {
    container.querySelector<HTMLElement>('#rule-help-modal')!.style.display = 'none';
  });

  // DSL Reference modal
  let dslRefLoaded = false;
  container.querySelector('#rule-dsl-ref-btn')?.addEventListener('click', toEventListener(async () => {
    const modal = container.querySelector<HTMLElement>('#rule-dsl-ref-modal')!;
    modal.style.display = 'flex';
    if (!dslRefLoaded) {
      dslRefLoaded = true;
      const body = container.querySelector<HTMLElement>('#rule-dsl-ref-body')!;
      try {
        await renderDslReferenceContent(body);
      } catch {
        render(html`<p style="color:var(--text-muted);padding:16px;">Failed to load DSL reference. Please close and try again.</p>`, body);
        dslRefLoaded = false;
      }
    }
  }));
  container.querySelector('#rule-dsl-ref-close')?.addEventListener('click', () => {
    container.querySelector<HTMLElement>('#rule-dsl-ref-modal')!.style.display = 'none';
  });

  // Coverage heatmap
  container.querySelector('#rule-coverage-btn')?.addEventListener('click', () => {
    const modal = container.querySelector<HTMLElement>('#rule-coverage-modal')!;
    modal.style.display = 'flex';
    void renderCoverageHeatmap(container, currentFilter);
  });
  container.querySelector('#rule-coverage-close')?.addEventListener('click', () => {
    container.querySelector<HTMLElement>('#rule-coverage-modal')!.style.display = 'none';
  });
}

/* ── Rule detail view ── */

function renderRulePreviewStats(preview: RulePreview | undefined): ComponentChildren {
  const flaggedColor = preview?.triggered ? 'var(--yellow)' : 'var(--green)';
  return html`${statPill('Flagged', preview?.occurrences ?? 0, flaggedColor)}${statPill('Total', preview?.total ?? 0)}${statPill('Rate', `${preview?.pct ?? 0}%`, flaggedColor)}${statPill('Status', preview?.triggered ? 'TRIGGERED' : 'CLEAN', flaggedColor)}`;
}

function renderRuleDetailContent(rule: RuleDetail, preview: RulePreview | undefined, ruleId: string): ComponentChildren {
  const thresholdEntries = Object.entries(rule.thresholds);

  return html`<div>
    <div class="rule-detail-top">
      <div class="rule-detail-name-row">
        <h2>${rule.name}</h2>
        ${severityBadge(rule.severity)}
        ${sourceBadge(rule.source)}
      </div>
      <p class="rule-detail-desc">${rule.description}</p>
      <div class="rule-detail-meta">
        <span>ID: <code>${rule.id}</code></span>
        <span>Scope: <code>${rule.scope}</code></span>
        <span>Version: ${rule.version}</span>
        ${rule.sourceFilePath ? html`<span>File: <code>${rule.sourceFilePath}</code></span>` : null}
      </div>
    </div>

    <div class="rule-detail-sections">
      <div class="rule-detail-section">
        <h3>Current Data Preview</h3>
        <div class="rule-preview-stats">${renderRulePreviewStats(preview)}</div>
        ${preview?.previewDescription ? html`<div class="rule-preview-desc">${preview.previewDescription}</div>` : null}
        ${preview && preview.previewExamples.length > 0 ? html`
          <details class="rule-preview-examples">
            <summary>${preview.previewExamples.length} example(s)</summary>
            <ul>${preview.previewExamples.map(ex => html`<li>${ex}</li>`)}</ul>
          </details>
        ` : null}
      </div>

      ${thresholdEntries.length > 0 ? html`
        <div class="rule-detail-section">
          <h3>Thresholds</h3>
          <p class="rule-threshold-hint">Adjust these values to tune when this rule triggers.</p>
          <div class="rule-thresholds">
            ${thresholdEntries.map(([key, value]) => thresholdRow(key, value, ruleId))}
          </div>
        </div>
      ` : null}

      <div class="rule-detail-section">
        <h3>When Triggered</h3>
        <div class="rule-template-block">${rule.descriptionTemplate}</div>
      </div>

      <div class="rule-detail-section">
        <h3>How to Improve</h3>
        <div class="rule-template-block">${rule.suggestionTemplate}</div>
      </div>

      ${rule.tags.length > 0 ? html`
        <div class="rule-detail-section">
          <h3>Tags</h3>
          <div class="rule-card-tags">${rule.tags.map(tag => html`<span class="rule-tag">${tag}</span>`)}</div>
        </div>
      ` : null}
    </div>
  </div>`;
}

function wireRuleThresholdInputs(content: HTMLElement, ruleId: string, currentFilter: DateFilter): void {
  for (const input of content.querySelectorAll<HTMLInputElement>('.rule-threshold-input')) {
    input.addEventListener('change', toEventListener(async (e: Event) => {
      const target = e.target;
      if (!(target instanceof HTMLInputElement)) return;

      const key = getDatasetValue(target, 'key');
      const value = Number.parseFloat(target.value);
      if (!key || Number.isNaN(value)) return;

      try {
        await rpc<{ ok: boolean }>('updateRuleThreshold', { ruleId, key, value });
        const preview = await rpc<RulePreview>('getRulePreview', { ruleId, ...(currentFilter as Record<string, unknown>) });
        const stats = content.querySelector<HTMLElement>('.rule-preview-stats');
        if (stats) {
          render(renderRulePreviewStats(preview), stats);
        }
      } catch {
        /* ignore */
      }
    }));
  }
}

function wireRuleDetailExplainButtons(content: HTMLElement, currentFilter: DateFilter): void {
  for (const button of content.querySelectorAll<HTMLButtonElement>('.occ-explain-btn')) {
    button.addEventListener('click', toEventListener(async (event: Event) => {
      event.stopPropagation();
      await explainOccurrence(button, currentFilter);
    }));
  }
}

function showRuleDetail(
  container: HTMLElement,
  ruleId: string,
  rules: RuleDetail[],
  previewMap: Map<string, RulePreview>,
  currentFilter: DateFilter,
): void {
  const rule = rules.find(r => r.id === ruleId);
  if (!rule) return;

  const preview = previewMap.get(ruleId);
  container.querySelector<HTMLElement>('#rule-list')!.style.display = 'none';
  container.querySelector<HTMLElement>('#rule-search-bar')!.style.display = 'none';
  container.querySelector<HTMLElement>('#ap-rules-header')!.style.display = 'none';

  const panel = container.querySelector<HTMLElement>('#rule-detail-panel')!;
  panel.style.display = '';

  const content = container.querySelector<HTMLElement>('#rule-detail-content')!;
  render(renderRuleDetailContent(rule, preview, ruleId), content);

  wireRuleThresholdInputs(content, ruleId, currentFilter);

  container.querySelector('#rule-edit-source-btn')?.addEventListener('click', () => {
    openRuleEditor(container, ruleId);
  });

  wireRuleDetailExplainButtons(content, currentFilter);
}

function renderLayerStatus(layers: RuleLayerInfo[], layerName: string): ComponentChildren {
  const info = layers.find(l => l.layer === layerName);
  if (!info) return html`<span class="rule-help-status rule-help-na">Not applicable</span>`;
  if (!info.exists) return html`<span class="rule-help-status rule-help-missing">Directory not found</span>`;
  return html`<span class="rule-help-status rule-help-ok">${info.ruleCount} rule${info.ruleCount !== 1 ? 's' : ''} loaded</span>`;
}
