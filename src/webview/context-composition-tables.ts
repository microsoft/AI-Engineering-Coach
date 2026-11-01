/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* "Show the chart as a table" for the Context Composition charts: every value their tooltips show,
 * readable from the keyboard and by screen readers. */

import type { CompositionTrendSeries, ContextCategory, SessionCompositionDetail, SessionContextDetail } from '../core/types';
import { html, ComponentChildren } from './render';

/** The charts' own formatting, so each table reads like the tooltips it stands in for. */
export interface ChartTableFormat {
  pct: (value: number) => string;
  count: (n: number, noun: string) => string;
  category: (category: ContextCategory) => string;
}

/** A collapsed "Show the chart as a table" disclosure for the chart above it, laid out like the session timeline's:
 *  a focusable, labelled scroll region around a captioned table. */
function chartTable(caption: string, columns: string[], rows: ComponentChildren[]): ComponentChildren {
  return html`<details class="ctx-comp-table">
    <summary>Show the chart as a table</summary>
    <div class="ctx-comp-table-scroll" role="region" tabindex="0" aria-label=${caption}>
      <table>
        <caption>${caption}</caption>
        <thead><tr>${columns.map(column => html`<th scope="col">${column}</th>`)}</tr></thead>
        <tbody>${rows.length > 0 ? rows : html`<tr><td class="ctx-comp-table-note" colspan=${columns.length}>No values recorded in this range.</td></tr>`}</tbody>
      </table>
    </div>
  </details>`;
}

/** The weekly chart's values: a row per week and drawn harness. `nouns` names what each harness's samples are. */
export function trendTable(weeks: string[], series: CompositionTrendSeries[], nouns: Map<string, string>, format: ChartTableFormat): ComponentChildren {
  const rows = weeks.flatMap((week, i) => series.flatMap(s => {
    const tools = s.toolDefinitions[i];
    if (tools == null) return [];
    const system = s.systemInstructions[i];
    return [html`<tr>
      <th scope="row">${week}</th>
      <th scope="row">${s.harness}</th>
      <td>${format.pct(tools)}</td>
      <td>${system == null ? '\u2014' : format.pct(system)}</td>
      <td>${format.count(s.samples[i], nouns.get(s.harness) ?? 'request')}</td>
      <td>${s.weighting[i] === 'requests' ? 'Equal weight' : 'Prompt tokens'}</td>
    </tr>`];
  }));
  return chartTable('Weekly tool-definition share per harness', ['Week of', 'Harness', 'Tool definitions', 'System instructions', 'Based on', 'Weighting'], rows);
}

/** The per-request chart's values for the `categories` it draws: a row per request, numbered like the chart. */
export function perRequestTable(s: SessionContextDetail, detail: SessionCompositionDetail, categories: ContextCategory[], format: ChartTableFormat): ComponentChildren {
  const rows = detail.perRequest.map((entry, i) => html`<tr>
    <th scope="row">Request ${i + 1}</th>
    <td class="ctx-comp-table-text">${s.requestQueries[i] ?? ''}</td>
    ${entry == null
      ? html`<td class="ctx-comp-table-note" colspan=${categories.length}>No composition recorded</td>`
      : categories.map(category => {
        const share = entry[category];
        return html`<td>${share == null ? '\u2014' : format.pct(share)}</td>`;
      })}
  </tr>`);
  return chartTable('Prompt composition per request', ['Request', 'Prompt', ...categories.map(format.category)], rows);
}
