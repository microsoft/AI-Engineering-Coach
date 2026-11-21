/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Data Explorer page: browse SessionRequest/Session fields, see distributions, run ad-hoc filters. */

import { DateFilter } from '../core/types';
import { rpc, COLORS } from './shared';
import { html, render } from './render';

interface ExplorerField {
  name: string;
  type: string;
  description: string;
  scope: 'request' | 'session' | 'both';
  fillRate: number;
}

interface ExplorerFieldsResult {
  fields: ExplorerField[];
  requestCount: number;
  sessionCount: number;
}

interface ExplorerStats {
  min: number;
  max: number;
  avg: number;
  p25: number;
  p50: number;
  p75: number;
}

interface ExplorerHistogramBin {
  label: string;
  count: number;
}

interface ExplorerTopValue {
  value: string;
  count: number;
  pct: number;
}

interface ExplorerDetailResult {
  error?: string;
  field: { name: string; type: string; description: string };
  stats?: ExplorerStats | null;
  histogram?: ExplorerHistogramBin[];
  trueCount?: number;
  falseCount?: number;
  trueRate?: number;
  topValues?: ExplorerTopValue[];
  uniqueCount?: number;
  avgLength?: number;
  emptyRate?: number;
}

export async function renderDataExplorer(content: HTMLElement, filter: DateFilter): Promise<void> {
  const data = await rpc<ExplorerFieldsResult>('getDataExplorerFields', filter as Record<string, unknown>);

  const fields = data.fields ?? [];
  const reqFields = fields.filter(f => f.scope === 'request');
  // `both` fields (harness) are logged per session; rules can also read them on request rows.
  const sessionFields = fields.filter(f => f.scope !== 'request');

  render(html`
    <div class="explorer-header">
      <h2>Data Explorer</h2>
      <p class="explorer-subtitle">${data.requestCount.toLocaleString()} requests, ${data.sessionCount.toLocaleString()} sessions</p>
    </div>

    <div class="explorer-search">
      <input type="text" id="explorer-filter" placeholder="Filter fields..." />
    </div>

    <div class="explorer-layout">
      <div class="explorer-sidebar" id="explorer-field-list">
        <h3>Request Fields (${reqFields.length})</h3>
        ${reqFields.map(f => html`<${FieldItem} field=${f} />`)}
        <h3>Session Fields (${sessionFields.length})</h3>
        ${sessionFields.map(f => html`<${FieldItem} field=${f} />`)}
      </div>
      <div class="explorer-detail" id="explorer-detail">
        <div class="explorer-empty">Select a field to explore its distribution</div>
      </div>
    </div>
  `, content);

  // Wire up field clicks
  for (const el of content.querySelectorAll<HTMLElement>('.explorer-field-item')) {
    el.addEventListener('click', () => {
      for (const item of content.querySelectorAll<HTMLElement>('.explorer-field-item')) item.classList.remove('active');
      el.classList.add('active');
      const fieldName = el.dataset.field || '';
      void showFieldDetail(fieldName, filter, content);
    });
  }

  // Wire up search filter
  const filterInput = content.querySelector('#explorer-filter') as HTMLInputElement;
  if (filterInput) {
    filterInput.addEventListener('input', () => {
      const query = filterInput.value.toLowerCase();
      for (const el of content.querySelectorAll('.explorer-field-item')) {
        const name = ((el as HTMLElement).dataset.field || '').toLowerCase();
        const desc = (el.querySelector('.field-desc') as HTMLElement)?.textContent?.toLowerCase() || '';
        (el as HTMLElement).style.display = (name.includes(query) || desc.includes(query)) ? '' : 'none';
      }
    });
  }
}

function FieldItem({ field: f }: { field: ExplorerField }) {
  const fillColor = f.fillRate > 80 ? COLORS.green : f.fillRate > 40 ? COLORS.yellow : COLORS.red;
  return html`
    <div class="explorer-field-item" data-field=${f.name}>
      <div class="field-name">${f.name}</div>
      <div class="field-desc">${f.description}</div>
      <div class="field-meta">
        <span class="field-type">${f.type}</span>
        <span class="field-fill" style=${'color:' + fillColor}>${f.fillRate}% filled</span>
      </div>
    </div>
  `;
}

async function showFieldDetail(fieldName: string, filter: DateFilter, content: HTMLElement): Promise<void> {
  const detail = content.querySelector<HTMLElement>('#explorer-detail');
  if (!detail) return;
  render(html`<div class="loading-spinner"></div>`, detail);

  const data = await rpc<ExplorerDetailResult>('getDataExplorer', { field: fieldName, filter });
  if (data.error) {
    render(html`<div class="error-msg">${data.error}</div>`, detail);
    return;
  }

  const field = data.field;
  const stats = data.stats ?? null;
  const histogram = data.histogram;
  const topValues = data.topValues;

  render(html`
    <h3>${field.name}</h3>
    <p class="field-type-label">${field.type} \u2014 ${field.description}</p>

    ${stats && html`
      <div class="explorer-stats-grid">
        <${MiniStat} label="Min" value=${stats.min} />
        <${MiniStat} label="Max" value=${stats.max} />
        <${MiniStat} label="Avg" value=${stats.avg} />
        <${MiniStat} label="P25" value=${stats.p25} />
        <${MiniStat} label="P50" value=${stats.p50} />
        <${MiniStat} label="P75" value=${stats.p75} />
      </div>
    `}

    ${histogram && histogram.length > 0 && html`
      <div class="explorer-histogram">
        ${histogram.map(bin => {
          const maxCount = Math.max(...histogram.map(b => b.count));
          const pct = maxCount > 0 ? (bin.count / maxCount * 100) : 0;
          return html`
            <div class="histogram-bar-row">
              <span class="histogram-label">${bin.label}</span>
              <div class="histogram-bar" style=${'width:' + pct + '%;background:' + COLORS.blue}></div>
              <span class="histogram-count">${bin.count}</span>
            </div>
          `;
        })}
      </div>
    `}

    ${data.trueCount !== undefined && html`
      <div class="explorer-stats-grid">
        <${MiniStat} label="True" value=${data.trueCount} />
        <${MiniStat} label="False" value=${data.falseCount ?? 0} />
        <${MiniStat} label="True Rate" value=${(data.trueRate ?? 0) + '%'} />
      </div>
    `}

    ${topValues && topValues.length > 0 && html`
      <h4>Top Values (${data.uniqueCount} unique)</h4>
      <table class="explorer-table">
        <thead><tr><th>Value</th><th>Count</th><th>%</th></tr></thead>
        <tbody>
          ${topValues.map(tv => html`<tr><td>${tv.value}</td><td>${tv.count}</td><td>${tv.pct}%</td></tr>`)}
        </tbody>
      </table>
    `}

    ${data.avgLength !== undefined && html`
      <div class="explorer-stats-grid">
        <${MiniStat} label="Avg Length" value=${data.avgLength} />
        <${MiniStat} label="Empty" value=${(data.emptyRate ?? 0) + '%'} />
      </div>
    `}

    <div class="explorer-actions">
      <button class="btn-secondary" data-action="playground" data-field=${fieldName}
        onClick=${() => document.querySelector<HTMLElement>('[data-page="rule-playground"]')?.click()}>
        Open in Playground
      </button>
    </div>
  `, detail);
}

function MiniStat({ label, value }: { label: string; value: string | number }) {
  const display = typeof value === 'number' ? value.toLocaleString() : value;
  return html`<div class="stat-card"><div class="stat-value">${display}</div><div class="stat-label">${label}</div></div>`;
}
