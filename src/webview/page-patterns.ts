/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Patterns page renderer -- work hour heatmap + GitHub-style calendar */

import { DateFilter, CalendarActivityData, ProjectOverviewData, TurnBasis } from '../core/types';
import { rpc, createChart, formatNum, escapeHtml, el, COLORS, $$ } from './shared';
import { html, render, CanvasEl, VNode } from './render';
import { TurnBasisNote } from './turn-basis-note';

interface WlbData {
  score: number;
  weekdayReqs: number;
  weekendReqs: number;
  weekendRatio: number;
  maxStreak: number;
  maxBreak: number;
  weekdayHours: number[];
  weekendHours: number[];
  weeklyTrend: { labels: string[]; weekday: number[]; weekend: number[] };
}

interface HeatmapDataLocal {
  heatmap: number[][];
  focusHeatmap: number[][];
  turnBasis?: TurnBasis;
}

/* ── Flame color scale ────────────────────────────────────────────── */

/**
 * Maps a 0-1 intensity to a flame gradient:
 *   0.0 -> dark/empty
 *   0.5 -> orange
 *   1.0 -> bright yellow-white
 */
function flameColor(t: number): string {
  if (t <= 0) return 'rgba(30, 30, 30, 0.3)';
  const stops: [number, number, number][] = [
    [60, 20, 10],     // dark ember
    [140, 40, 10],    // deep red
    [200, 80, 10],    // orange-red
    [240, 150, 20],   // orange
    [255, 210, 60],   // warm yellow
    [255, 255, 160],  // bright
  ];
  const idx = Math.min(t, 1) * (stops.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.min(lo + 1, stops.length - 1);
  const f = idx - lo;
  const r = Math.round(stops[lo][0] + (stops[hi][0] - stops[lo][0]) * f);
  const g = Math.round(stops[lo][1] + (stops[hi][1] - stops[lo][1]) * f);
  const b = Math.round(stops[lo][2] + (stops[hi][2] - stops[lo][2]) * f);
  return `rgb(${r}, ${g}, ${b})`;
}

function calendarFlameColor(t: number): string {
  if (t <= 0) return 'var(--surface-2, #161b22)';
  if (t < 0.25) return '#6b2000';
  if (t < 0.5) return '#b33a00';
  if (t < 0.75) return '#e06010';
  return '#ffaa20';
}

const DAY_START = 7;
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Module-level view state — survives filter/harness changes.
let activeRangeDays = 0;
let activePatternTab: 'hours' | 'calendar' | 'projects' = 'hours';

export async function renderPatterns(container: HTMLElement, currentFilter: DateFilter): Promise<void> {

  function buildRangeFilter(): Record<string, unknown> {
    const f: Record<string, unknown> = { ...currentFilter };
    if (activeRangeDays > 0) {
      const d = new Date();
      d.setDate(d.getDate() - activeRangeDays);
      f.fromDate = d.toISOString().slice(0, 10);
    }
    return f;
  }

  render(html`
    <h1>Activity Patterns</h1>

    <div class="cons-range-bar" id="patternsRange">
      <button class=${`cons-range-btn${activeRangeDays === 7 ? ' active' : ''}`} data-range="7">Last 7 days</button>
      <button class=${`cons-range-btn${activeRangeDays === 28 ? ' active' : ''}`} data-range="28">Last 4 weeks</button>
      <button class=${`cons-range-btn${activeRangeDays === 90 ? ' active' : ''}`} data-range="90">Last 3 months</button>
      <button class=${`cons-range-btn${activeRangeDays === 180 ? ' active' : ''}`} data-range="180">Last 6 months</button>
      <button class=${`cons-range-btn${activeRangeDays === 0 ? ' active' : ''}`} data-range="0">All time</button>
    </div>

    <div class="pattern-tabs" id="patternTabs">
      <button class=${`pattern-tab${activePatternTab === 'hours' ? ' active' : ''}`} data-tab="hours">Work Hours</button>
      <button class=${`pattern-tab${activePatternTab === 'calendar' ? ' active' : ''}`} data-tab="calendar">Calendar</button>
      <button class=${`pattern-tab${activePatternTab === 'projects' ? ' active' : ''}`} data-tab="projects">Projects</button>
    </div>

    <div id="tabHours" class=${`pattern-tab-panel${activePatternTab === 'hours' ? ' active' : ''}`}></div>
    <div id="tabCalendar" class=${`pattern-tab-panel${activePatternTab === 'calendar' ? ' active' : ''}`}></div>
    <div id="tabProjects" class=${`pattern-tab-panel${activePatternTab === 'projects' ? ' active' : ''}`}></div>
  `, container);

  let calendarRendered = false;
  let projectsRendered = false;

  // Initial render — honour the persisted active tab
  if (activePatternTab === 'calendar') { calendarRendered = true; await renderCalendarTab(); }
  else if (activePatternTab === 'projects') { projectsRendered = true; await renderProjectsTab(); }
  else await renderHoursTab();

  async function renderHoursTab(): Promise<void> {
    const panel = container.querySelector<HTMLElement>('#tabHours')!;
    render(html`<div class="loading-spinner"></div>`, panel);

    const filter = buildRangeFilter();
    const [heatmap, wlb] = await Promise.all([
      rpc<HeatmapDataLocal>('getHeatmap', filter),
      rpc<WlbData | null>('getWorkLifeBalance', filter),
    ]);

    render(html`
      <div>
        <${TurnBasisNote} basis=${heatmap.turnBasis} />
        <div class="heatmap-container" id="heatmapGrid"></div>
        ${wlb ? html`
        <div class="two-col" style="margin-top:12px;">
          <div class="chart-wrap"><div class="chart-title">Hourly Activity <span class="info-icon" tabindex="0" role="button" aria-label="Hourly activity info">${'\u24d8'}<span class="info-popup">Compares the prompts you typed by hour of the day on weekdays vs. weekends. Helps identify your most productive coding hours.</span></span></div><${CanvasEl} id="wlbHoursChart" height=${220} /></div>
          <div class="chart-wrap"><div class="chart-title">Weekly Trend <span class="info-icon" tabindex="0" role="button" aria-label="Weekly trend info">${'\u24d8'}<span class="info-popup info-popup-right">Shows the prompts you typed each week, split by weekday and weekend. Useful for spotting changes in work cadence over time.</span></span></div><${CanvasEl} id="wlbWeeklyChart" height=${220} /></div>
        </div>` : null}
      </div>
    `, panel);

    renderWorkHoursHeatmap(heatmap);

    if (wlb) {
      const rotateHours = (arr: number[]) => [...arr.slice(DAY_START), ...arr.slice(0, DAY_START)];
      createChart('wlbHoursChart', 'bar', {
        labels: Array.from({ length: 24 }, (_, i) => `${(i + DAY_START) % 24}:00`),
        datasets: [
          { label: 'Weekday', data: rotateHours(wlb.weekdayHours), backgroundColor: COLORS.blue + '80', borderColor: COLORS.blue, borderWidth: 1 },
          { label: 'Weekend', data: rotateHours(wlb.weekendHours), backgroundColor: COLORS.red + '80', borderColor: COLORS.red, borderWidth: 1 },
        ],
      }, {
        plugins: { legend: { position: 'top' } },
        scales: { x: { ticks: { maxTicksLimit: 12 } }, y: { beginAtZero: true } },
      });

      // Build annotation strings for the weekly chart
      const statsAnnotation = `Weekday: ${formatNum(wlb.weekdayReqs)} | Weekend: ${formatNum(wlb.weekendReqs)} | Streak: ${wlb.maxStreak}d | Break: ${wlb.maxBreak}d`;

      createChart('wlbWeeklyChart', 'bar', {
        labels: wlb.weeklyTrend.labels,
        datasets: [
          { label: 'Weekday', data: wlb.weeklyTrend.weekday, backgroundColor: COLORS.blue, borderRadius: 2 },
          { label: 'Weekend', data: wlb.weeklyTrend.weekend, backgroundColor: COLORS.red, borderRadius: 2 },
        ],
      }, {
        plugins: {
          legend: { position: 'top' },
          title: {
            display: true,
            text: statsAnnotation,
            color: 'var(--text-muted, #8b949e)',
            font: { size: 11, weight: 'normal' as const },
            padding: { bottom: 4 },
          },
        },
        scales: { x: { stacked: true, ticks: { maxTicksLimit: 10 } }, y: { stacked: true, beginAtZero: true } },
      });
    }
  }

  async function renderCalendarTab(): Promise<void> {
    const panel = container.querySelector<HTMLElement>('#tabCalendar')!;
    render(html`<div class="loading-spinner"></div>`, panel);

    const filter = buildRangeFilter();
    const [calendar, heatmap] = await Promise.all([
      rpc<CalendarActivityData>('getCalendarActivity', filter),
      rpc<HeatmapDataLocal>('getHeatmap', filter),
    ]);

    render(html`
      <${TurnBasisNote} basis=${calendar.turnBasis} />
      <div class="calendar-heatmap-container" id="calendarGrid"></div>
    `, panel);
    renderCalendarHeatmap(calendar, heatmap.focusHeatmap);
  }

  async function renderProjectsTab(): Promise<void> {
    const panel = container.querySelector<HTMLElement>('#tabProjects')!;
    render(html`<div class="loading-spinner"></div>`, panel);

    const filter = buildRangeFilter();
    const overview = await rpc<ProjectOverviewData>('getProjectOverview', filter);
    renderProjectOverview(panel, overview);
  }

  /* ── Tab switching ────────────────────────────────────────────── */
  const tabs = container.querySelectorAll<HTMLButtonElement>('.pattern-tab');
  const panels = container.querySelectorAll<HTMLElement>('.pattern-tab-panel');

  for (const tab of tabs) {
    tab.addEventListener('click', () => {
      void (async () => {
        for (const t of tabs) t.classList.remove('active');
        for (const p of panels) p.classList.remove('active');
        tab.classList.add('active');
        const target = tab.dataset.tab as typeof activePatternTab | undefined;
        const panel = container.querySelector<HTMLElement>(`#tab${capitalize(target ?? 'hours')}`);
        if (!panel) return;
        panel.classList.add('active');
        if (target) activePatternTab = target;

        if (target === 'calendar' && !calendarRendered) {
          calendarRendered = true;
          await renderCalendarTab();
        }
        if (target === 'projects' && !projectsRendered) {
          projectsRendered = true;
          await renderProjectsTab();
        }
      })();
    });
  }

  /* ── Date range switching ─────────────────────────────────────── */
  container.querySelector('#patternsRange')!.addEventListener('click', (e) => {
    void (async () => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('.cons-range-btn');
      if (!btn) return;
      for (const t of $$('#patternsRange .cons-range-btn')) t.classList.remove('active');
      btn.classList.add('active');
      activeRangeDays = Number(btn.dataset.range);
      calendarRendered = false;
      projectsRendered = false;
      if (activePatternTab === 'hours') await renderHoursTab();
      else if (activePatternTab === 'calendar') { calendarRendered = true; await renderCalendarTab(); }
      else if (activePatternTab === 'projects') { projectsRendered = true; await renderProjectsTab(); }
    })();
  });
}

/* ── Work Hours Heatmap (flame-colored) ───────────────────────────── */

function renderWorkHoursHeatmap(heatmap: HeatmapDataLocal): void {
  const grid = document.getElementById('heatmapGrid')!;
  const maxVal = Math.max(1, ...heatmap.heatmap.flat());
  const maxFocus = Math.max(1, ...heatmap.focusHeatmap.flat());

  const headerRow = el('div', 'heatmap-row header');
  headerRow.appendChild(el('div', 'heatmap-label', ''));
  for (let i = 0; i < 24; i++) {
    const h = (i + DAY_START) % 24;
    headerRow.appendChild(el('div', 'heatmap-header', `${h}`));
  }
  grid.appendChild(headerRow);

  for (let d = 0; d < 7; d++) {
    const row = el('div', 'heatmap-row');
    row.appendChild(el('div', 'heatmap-label', DAY_NAMES[d]));
    for (let i = 0; i < 24; i++) {
      const h = (i + DAY_START) % 24;
      const v = heatmap.heatmap[d][h];
      const focus = heatmap.focusHeatmap[d][h];
      const reqIntensity = v / maxVal;
      const focusIntensity = focus / maxFocus;
      const combined = reqIntensity * 0.5 + focusIntensity * 0.5;
      const cell = el('div', 'heatmap-cell');
      cell.style.backgroundColor = flameColor(combined);
      cell.style.color = combined > 0.55 ? '#000' : '#fff';
      cell.title = `${DAY_NAMES[d]} ${h}:00 — ${v} prompts, ${focus}% focus`;
      cell.textContent = v > 0 ? String(v) : '';
      row.appendChild(cell);
    }
    grid.appendChild(row);
  }

  const legend = el('div', 'heatmap-flame-legend');
  render(html`
    <span style="color:var(--text-muted);font-size:11px;">Less focus</span>
    <div class="flame-legend-bar"></div>
    <span style="color:var(--text-muted);font-size:11px;">Deep focus</span>
  `, legend);
  grid.appendChild(legend);
}

/* ── GitHub-style calendar heatmap ────────────────────────────────── */

function renderCalendarHeatmap(calendar: CalendarActivityData, _focusHeatmap: number[][]): void {
  const grid = document.getElementById('calendarGrid')!;
  if (!grid || calendar.days.length === 0) {
    if (grid) render(html`<p style="color:var(--text-muted);padding:16px;">No activity data available.</p>`, grid);
    return;
  }

  const dayMap = new Map(calendar.days.map(d => [d.date, d]));

  const firstDate = new Date(calendar.days[0].date + 'T00:00:00');
  const lastDate = new Date(calendar.days[calendar.days.length - 1].date + 'T00:00:00');

  // Pad to full weeks
  const startDate = new Date(firstDate);
  startDate.setDate(startDate.getDate() - startDate.getDay());
  const endDate = new Date(lastDate);
  endDate.setDate(endDate.getDate() + (6 - endDate.getDay()));

  const allDates: Date[] = [];
  const cursor = new Date(startDate);
  while (cursor <= endDate) {
    allDates.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }

  const totalWeeks = Math.ceil(allDates.length / 7);
  const maxReqs = calendar.maxRequests;

  const cellSize = 13;
  const cellGap = 3;
  const labelWidth = 30;
  const monthLabelHeight = 18;
  const svgWidth = labelWidth + totalWeeks * (cellSize + cellGap);
  const svgHeight = monthLabelHeight + 7 * (cellSize + cellGap);

  let svgHtml = `<svg width="${svgWidth}" height="${svgHeight}" style="display:block;">`;

  // Day-of-week labels
  const shortDays = ['', 'Mon', '', 'Wed', '', 'Fri', ''];
  for (let d = 0; d < 7; d++) {
    if (shortDays[d]) {
      svgHtml += `<text x="0" y="${monthLabelHeight + d * (cellSize + cellGap) + cellSize - 2}" fill="var(--text-muted)" font-size="10" font-family="inherit">${shortDays[d]}</text>`;
    }
  }

  // Month labels
  let lastMonthLabel = -1;
  for (let w = 0; w < totalWeeks; w++) {
    const weekStart = allDates[w * 7];
    const month = weekStart.getMonth();
    if (month !== lastMonthLabel) {
      lastMonthLabel = month;
      const x = labelWidth + w * (cellSize + cellGap);
      svgHtml += `<text x="${x}" y="12" fill="var(--text-muted)" font-size="10" font-family="inherit">${MONTH_NAMES[month]}</text>`;
    }
  }

  // Cells
  for (let i = 0; i < allDates.length; i++) {
    const date = allDates[i];
    const week = Math.floor(i / 7);
    const dow = i % 7;
    const dateStr = toDateStrLocal(date);
    const dayData = dayMap.get(dateStr);
    const x = labelWidth + week * (cellSize + cellGap);
    const y = monthLabelHeight + dow * (cellSize + cellGap);

    let intensity = 0;
    let title = `${dateStr}: no activity`;

    if (dayData) {
      const reqIntensity = maxReqs > 0 ? dayData.requests / maxReqs : 0;
      intensity = reqIntensity * 0.6 + (dayData.focusScore / 100) * 0.4;
      title = `${dateStr}: ${dayData.requests} prompts, ${dayData.focusScore}% focus`;
    }

    const color = calendarFlameColor(intensity);
    svgHtml += `<rect x="${x}" y="${y}" width="${cellSize}" height="${cellSize}" rx="2" ry="2" fill="${color}" data-date="${dateStr}"><title>${escapeHtml(title)}</title></rect>`;
  }

  svgHtml += '</svg>';

  render(html`
    <div>
      <div dangerouslySetInnerHTML=${{ __html: svgHtml }}></div>
      <div class="calendar-legend">
        <span style="color:var(--text-muted);font-size:11px;">Less</span>
        <span class="cal-legend-cell" style="background:var(--surface-2, #161b22);"></span>
        <span class="cal-legend-cell" style="background:#6b2000;"></span>
        <span class="cal-legend-cell" style="background:#b33a00;"></span>
        <span class="cal-legend-cell" style="background:#e06010;"></span>
        <span class="cal-legend-cell" style="background:#ffaa20;"></span>
        <span style="color:var(--text-muted);font-size:11px;">More</span>
      </div>
    </div>
  `, grid);
}

/* ── Project Overview ─────────────────────────────────────────────── */

const LANG_COLORS: Record<string, string> = {
  typescript: '#3178c6', javascript: '#f1e05a', python: '#3572a5', rust: '#dea584',
  go: '#00add8', java: '#b07219', 'c#': '#178600', 'c++': '#f34b7d', c: '#555555',
  swift: '#f05138', kotlin: '#a97bff', ruby: '#701516', php: '#4f5d95',
  html: '#e34c26', css: '#563d7c', scss: '#c6538c', vue: '#41b883', svelte: '#ff3e00',
  shell: '#89e051', sql: '#e38c00', dart: '#00b4ab', scala: '#c22d40',
  markdown: '#083fa1', json: '#292929', yaml: '#cb171e', toml: '#9c4221',
  terraform: '#5c4ee5', bicep: '#519aba', docker: '#384d54', lua: '#000080', r: '#198ce7',
};

function langTag(lang: string): VNode {
  const color = LANG_COLORS[lang] || '#6e7681';
  return html`<span class="lang-tag" style="background:${color}20;color:${color};border:1px solid ${color}40;">${lang}</span>` as VNode;
}

function renderProjectOverview(panel: HTMLElement, overview: ProjectOverviewData): void {
  const note = html`<${TurnBasisNote} basis=${overview.turnBasis} detail="Lines of code, languages and hot files include every turn." />`;
  if (overview.projects.length === 0) {
    render(html`${note}<p style="color:var(--text-muted);padding:16px;">No project data available.</p>`, panel);
    return;
  }

  const maxHours = Math.max(1, ...overview.projects.map(p => p.estimatedHours));

  render(html`
    ${note}
    <div class="project-overview-list">
      ${overview.projects.map(proj => {
        const barWidth = Math.round((proj.estimatedHours / maxHours) * 100);
        return html`
          <div class="project-card" data-ws-id=${proj.workspaceId}>
            <div class="proj-header">
              <div class="proj-name">${proj.workspaceName}</div>
              <div class="proj-meta">
                <span class="proj-hours">${proj.estimatedHours}h</span>
                <span class="proj-requests">${formatNum(proj.totalRequests)} prompts</span>
                ${proj.estimatedLoc > 0 ? html`<span class="proj-loc">${formatNum(proj.estimatedLoc)} LoC</span>` : null}
                ${proj.gitPath ? html`<span class="proj-git" title=${proj.gitPath}>\uD83D\uDCC1 ${proj.gitPath.split('/').slice(-2).join('/')}</span>` : null}
              </div>
            </div>
            <div class="proj-bar-track">
              <div class="proj-bar-fill" style="width:${barWidth}%;"></div>
            </div>
            <div class="proj-tags">
              ${proj.languages.map(l => langTag(l))}
              <span class="proj-time-tag">${proj.timePattern}</span>
            </div>
            ${proj.topFiles.length > 0 ? html`<div class="proj-top-files"><span class="proj-label">Hot files:</span> ${proj.topFiles.map((f, i) => html`${i > 0 ? ', ' : ''}<code>${f}</code>`)}</div>` : null}
            <button class="proj-explore-btn" data-ws-id=${proj.workspaceId} data-ws-name=${proj.workspaceName}>Explore more</button>
            <div class="proj-explore-detail" id="explore-${proj.workspaceId}" style="display:none;"></div>
          </div>
        `;
      })}
    </div>
  `, panel);

  // Explore more click handlers
  for (const btn of panel.querySelectorAll<HTMLButtonElement>('.proj-explore-btn')) {
    btn.addEventListener('click', () => {
      const wsId = btn.dataset.wsId!;
      const wsName = btn.dataset.wsName!;
      const detail = panel.querySelector<HTMLElement>(`#explore-${CSS.escape(wsId)}`)!;
      if (detail.style.display === 'none') {
        detail.style.display = 'block';
        btn.textContent = 'Collapse';
        renderExploreDetail(detail, wsId, wsName, overview);
      } else {
        detail.style.display = 'none';
        btn.textContent = 'Explore more';
      }
    });
  }
}

function renderExploreDetail(container: HTMLElement, wsId: string, wsName: string, overview: ProjectOverviewData): void {
  const proj = overview.projects.find(p => p.workspaceId === wsId);
  if (!proj) { render(html`<p>No data</p>`, container); return; }

  render(html`
    <div>
      <div class="explore-section">
        <h4>Tech Stack</h4>
        <div class="explore-lang-list">
          ${proj.languages.length > 0
            ? proj.languages.map(lang => html`<div class="explore-lang-row">${langTag(lang)}</div>`)
            : html`<span style="color:var(--text-muted)">No language data</span>`}
        </div>
      </div>
      <div class="explore-section">
        <h4>Activity Summary</h4>
        <table class="data-table compact">
          <tbody>
            <tr><td>Estimated Hours</td><td><strong>${proj.estimatedHours}h</strong></td></tr>
            <tr><td>Prompts You Typed</td><td><strong>${formatNum(proj.totalRequests)}</strong></td></tr>
            <tr><td>Estimated LoC</td><td><strong>${formatNum(proj.estimatedLoc)}</strong></td></tr>
            <tr><td>Work Pattern</td><td><strong>${proj.timePattern}</strong></td></tr>
            ${proj.gitPath ? html`<tr><td>Path</td><td><code style="font-size:11px;">${proj.gitPath}</code></td></tr>` : null}
          </tbody>
        </table>
      </div>
      ${proj.topFiles.length > 0 ? html`
      <div class="explore-section">
        <h4>Busiest Copilot Files</h4>
        <ol class="explore-file-list">
          ${proj.topFiles.map(f => html`<li><code>${f}</code></li>`)}
        </ol>
      </div>` : null}
    </div>
  `, container);
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function toDateStrLocal(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
