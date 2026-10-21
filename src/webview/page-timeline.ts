/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Timeline page renderer -- shows the Gantt timeline view */

import { DateFilter } from '../core/types';
import { rpc, el, formatDate, formatTime } from './shared';
import { html, render } from './render';
import { consumeNavHint } from './app';

/* ── Gantt timeline types ── */
interface TlSession {
  sessionId: string;
  workspaceName: string;
  sessionName: string;
  firstActivity: number;
  lastActivity: number;
  requestCount: number;
  requests: TlRequest[];
}

interface TlRequest {
  timestamp: number;
  preview: string;
}

interface TlData {
  date: string;
  dayStart: number;
  sessions: TlSession[];
  sessionCount: number;
  maxConcurrent: number;
  prevDay: string | null;
  nextDay: string | null;
  activeDates: { date: string; count: number }[];
}

/* ── Sessions list types ── */
interface SessionItem {
  sessionId: string;
  workspaceName: string;
  requestCount: number;
  lastMessageDate: number | null;
  firstMessage: string;
}

interface SessionListData {
  total: number;
  pageSize: number;
  sessions: SessionItem[];
}

interface SessionDetail {
  workspaceName: string;
  creationDate: number | null;
  requestCount: number;
  location: string;
  requests: {
    timestamp: number | null;
    messageText: string;
    responseText: string;
    modelId: string;
    agentName: string;
    toolsUsed: string[];
  }[];
}

/* ── Lane colors for gantt ── */
const LANE_COLORS = [
  { bg: 'rgba(88,166,255,0.25)', border: '#58a6ff', dot: '#58a6ff' },
  { bg: 'rgba(63,185,80,0.25)', border: '#3fb950', dot: '#3fb950' },
  { bg: 'rgba(188,140,255,0.25)', border: '#bc8cff', dot: '#bc8cff' },
  { bg: 'rgba(210,153,34,0.25)', border: '#d29922', dot: '#d29922' },
  { bg: 'rgba(244,112,103,0.25)', border: '#f47067', dot: '#f47067' },
  { bg: 'rgba(218,119,86,0.25)', border: '#da7756', dot: '#da7756' },
  { bg: 'rgba(121,192,255,0.25)', border: '#79c0ff', dot: '#79c0ff' },
  { bg: 'rgba(247,120,186,0.25)', border: '#f778ba', dot: '#f778ba' },
];

/* ── Module-level state for list view ── */
let sessionsPage = 1;
let sessionsSearch = '';

export async function renderTimeline(container: HTMLElement, currentFilter: DateFilter): Promise<void> {
  render(html`
    <h1>Timeline</h1>
    <div id="timeline-tab-content"></div>
  `, container);

  async function renderGanttTab(dateStr?: string): Promise<void> {
    const target = document.getElementById('timeline-tab-content')!;
    render(html`<div class="loading-spinner"></div>`, target);

    const tl = await rpc<TlData>('getDayTimeline', { date: dateStr, filter: currentFilter });

    const totalReqs = tl.sessions.reduce((s: number, sess: TlSession) => s + sess.requestCount, 0);
    const activeDateLabel = new Date(tl.date + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

    render(html`
      <span id="timelineActiveDate" class="timeline-active-date">${activeDateLabel}</span>
      <div class="timeline-strip-wrap" id="timelineStripWrap"><div id="timelineStrip" class="timeline-strip"></div></div>
      <div class="timeline-stats" id="timelineStats">
        <span>${tl.sessionCount} sessions</span>
        <span>${totalReqs} requests</span>
        <span>Max concurrent: ${tl.maxConcurrent}</span>
      </div>
      <div class="timeline-lanes" id="timelineLanes"></div>
      <div id="timelineDetail"></div>
    `, target);

    const lanes = document.getElementById('timelineLanes')!;
    const detailEl = document.getElementById('timelineDetail')!;

    // ── Scrollable day strip ──
    if (tl.activeDates && tl.activeDates.length > 0) {
      const strip = document.getElementById('timelineStrip')!;
      strip.textContent = ''; // Clear previous days on re-render
      const maxCount = Math.max(...tl.activeDates.map(d => d.count), 1);
      const todayStr = new Date().toISOString().slice(0, 10);
      let activeCard: HTMLElement | null = null;

      const rangeLabel = el('div', 'strip-range-label');
      const firstDate = tl.activeDates[0].date;
      const lastDate = tl.activeDates[tl.activeDates.length - 1].date;
      rangeLabel.textContent = `${firstDate} → ${lastDate} (${tl.activeDates.length} days)`;
      strip.before(rangeLabel);

      for (const d of tl.activeDates) {
        const card = el('div', 'strip-day');
        card.dataset.date = d.date;
        if (d.date === tl.date) { card.classList.add('active'); activeCard = card; }
        if (d.date === todayStr) card.classList.add('today');

        const barH = Math.max(4, (d.count / maxCount) * 48);
        const bar = el('div', 'strip-bar');
        bar.style.height = barH + 'px';
        card.title = `${d.date} — ${d.count} requests`;
        card.appendChild(bar);

        card.addEventListener('mouseenter', () => {
          const hoverLabel = new Date(d.date + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
          const dateEl = document.getElementById('timelineActiveDate');
          if (dateEl) dateEl.textContent = hoverLabel;
        });
        card.addEventListener('mouseleave', () => {
          const dateEl = document.getElementById('timelineActiveDate');
          const activeEl = strip.querySelector<HTMLElement>('.strip-day.active');
          const activeDate = activeEl?.dataset.date;
          if (dateEl && activeDate) {
            dateEl.textContent = new Date(activeDate + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
          }
        });

        card.addEventListener('click', () => {
          void renderDayDetail(tl, d.date, currentFilter, lanes, detailEl);
          for (const c of strip.querySelectorAll('.strip-day.active')) c.classList.remove('active');
          card.classList.add('active');
          const dateEl = document.getElementById('timelineActiveDate');
          if (dateEl) dateEl.textContent = new Date(d.date + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
        });

        strip.appendChild(card);
      }

      strip.addEventListener('wheel', (e: WheelEvent) => {
        const delta = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
        if (delta === 0) return;
        e.preventDefault();
        strip.scrollLeft += delta * 3;
      }, { passive: false });

      const wrap = document.getElementById('timelineStripWrap')!;
      function updateScrollFades(): void {
        wrap.classList.toggle('can-scroll-left', strip.scrollLeft > 4);
        wrap.classList.toggle('can-scroll-right', strip.scrollLeft < strip.scrollWidth - strip.clientWidth - 4);
      }
      strip.addEventListener('scroll', updateScrollFades, { passive: true });

      requestAnimationFrame(() => {
        if (activeCard) {
          const cardCenter = activeCard.offsetLeft + activeCard.offsetWidth / 2;
          strip.scrollLeft = cardCenter - strip.clientWidth / 2;
        } else {
          strip.scrollLeft = strip.scrollWidth;
        }
        updateScrollFades();
      });
    }

    if (tl.sessions.length === 0) {
      render(html`<p class="muted">No sessions on this day.</p>`, lanes);
    } else {
      renderLanes(tl, lanes, detailEl);
    }
  }

  async function _renderListTab(): Promise<void> {
    const target = document.getElementById('timeline-tab-content')!;
    render(html`<div class="loading-spinner"></div>`, target);

    const list = await rpc<SessionListData>('getSessions', { page: sessionsPage, pageSize: 25, filter: currentFilter, search: sessionsSearch || undefined });

    render(html`
      <div class="sessions-toolbar">
        <div class="sessions-search-wrap">
          <input type="text" id="sessionSearch" placeholder="Search sessions..." value=${sessionsSearch} />
        </div>
        <span class="muted">${list.total} sessions</span>
      </div>
      <div class="sessions-layout">
        <div class="sessions-list-panel">
          <div id="sessionList"></div>
          <div class="pagination" id="pagination"></div>
        </div>
        <div class="sessions-detail-panel" id="sessionDetail">
          <div class="sessions-empty-detail">
            <p class="muted">Select a session to view details</p>
          </div>
        </div>
      </div>
    `, target);

    const searchInput = document.getElementById('sessionSearch') as HTMLInputElement;
    let searchTimeout: ReturnType<typeof setTimeout> | null = null;
    searchInput.addEventListener('input', () => {
      if (searchTimeout) clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => {
        sessionsSearch = searchInput.value.trim();
        sessionsPage = 1;
        void _renderListTab();
      }, 300);
    });

    const listEl = document.getElementById('sessionList')!;

    for (const s of list.sessions) {
      const item = el('div', 'session-item');
      item.dataset.id = s.sessionId;
      render(html`
        <div class="session-header">
          <span class="session-ws">${s.workspaceName}</span>
          <span class="session-count">${s.requestCount} msgs</span>
        </div>
        <div class="session-date">${formatDate(s.lastMessageDate)}</div>
        <div class="session-preview">${s.firstMessage ? s.firstMessage : html`<em>empty</em>`}</div>
      `, item);
      item.addEventListener('click', () => {
        for (const i of document.querySelectorAll<HTMLElement>('.session-item')) i.classList.remove('active');
        item.classList.add('active');
        void showSessionDetail(s.sessionId);
      });
      listEl.appendChild(item);
    }

    const totalPages = Math.ceil(list.total / list.pageSize);
    const pag = document.getElementById('pagination')!;
    if (totalPages > 1) {
      if (sessionsPage > 1) {
        const prev = el('button', 'page-btn', '&larr; Prev');
        prev.addEventListener('click', () => { sessionsPage--; void _renderListTab(); });
        pag.appendChild(prev);
      }
      pag.appendChild(el('span', 'page-info', `Page ${sessionsPage} of ${totalPages}`));
      if (sessionsPage < totalPages) {
        const next = el('button', 'page-btn', 'Next &rarr;');
        next.addEventListener('click', () => { sessionsPage++; void _renderListTab(); });
        pag.appendChild(next);
      }
    }
  }

  // Initial render
  const hint = consumeNavHint();
  await renderGanttTab(hint && /^\d{4}-\d{2}-\d{2}$/.test(hint) ? hint : undefined);
}

/* ── Gantt helpers ── */

async function renderDayDetail(
  _currentTl: TlData, date: string,
  filter: DateFilter,
  lanes: HTMLElement, detailEl: HTMLElement,
): Promise<void> {
  const tl = await rpc<TlData>('getDayTimeline', { date, filter });

  const totalReqs = tl.sessions.reduce((s: number, sess: TlSession) => s + sess.requestCount, 0);
  const statsEl = document.getElementById('timelineStats');
  if (statsEl) {
    render(html`
      <span>${tl.sessionCount} sessions</span>
      <span>${totalReqs} requests</span>
      <span>Max concurrent: ${tl.maxConcurrent}</span>
    `, statsEl);
  }

  render(null, lanes);
  render(null, detailEl);
  if (tl.sessions.length === 0) {
    render(html`<p class="muted">No sessions on this day.</p>`, lanes);
    return;
  }
  renderLanes(tl, lanes, detailEl);
}

function renderLanes(tl: TlData, lanes: HTMLElement, detailEl: HTMLElement): void {
  lanes.textContent = ''; // Clear previous lanes on re-render
  let rangeStart = 0, rangeEnd = 24;
  if (tl.sessions.length > 0) {
    const firstTs = Math.min(...tl.sessions.map(s => s.firstActivity));
    const lastTs = Math.max(...tl.sessions.map(s => s.lastActivity));
    rangeStart = Math.max(0, Math.floor(new Date(firstTs).getHours()) - 1);
    rangeEnd = Math.min(24, Math.ceil(new Date(lastTs).getHours()) + 2);
    if (rangeEnd - rangeStart < 4) { rangeStart = Math.max(0, rangeStart - 2); rangeEnd = Math.min(24, rangeEnd + 2); }
  }

  const rangeStartMs = tl.dayStart + rangeStart * 3600000;
  const rangeEndMs = tl.dayStart + rangeEnd * 3600000;
  const rangeDuration = rangeEndMs - rangeStartMs;

  const wsColorMap = new Map<string, number>();
  let colorIdx = 0;
  for (const s of tl.sessions) {
    if (!wsColorMap.has(s.workspaceName)) {
      wsColorMap.set(s.workspaceName, colorIdx % LANE_COLORS.length);
      colorIdx++;
    }
  }

  for (const s of tl.sessions) {
    const ci = wsColorMap.get(s.workspaceName) || 0;
    const color = LANE_COLORS[ci];

    const lane = el('div', 'timeline-lane');

    const label = el('div', 'timeline-lane-label');
    render(html`<span class="lane-ws">${s.workspaceName}</span><span class="lane-meta">${s.requestCount} req</span>`, label);
    lane.appendChild(label);

    const track = el('div', 'timeline-lane-track');

    const leftPct = Math.max(0, ((s.firstActivity - rangeStartMs) / rangeDuration * 100));
    const rightPct = Math.min(100, ((s.lastActivity - rangeStartMs) / rangeDuration * 100));
    const widthPct = Math.max(0.5, rightPct - leftPct);
    const bar = el('div', 'timeline-bar');
    bar.style.left = leftPct.toFixed(2) + '%';
    bar.style.width = widthPct.toFixed(2) + '%';
    bar.style.background = color.bg;
    bar.style.border = `1px solid ${color.border}`;
    bar.title = `${s.workspaceName}: ${s.requestCount} requests\n${formatTime(s.firstActivity)} - ${formatTime(s.lastActivity)}`;
    track.appendChild(bar);

    for (const r of s.requests) {
      const dot = el('div', 'timeline-dot');
      const dotPct = ((r.timestamp - rangeStartMs) / rangeDuration * 100);
      dot.style.left = dotPct.toFixed(2) + '%';
      dot.style.background = color.dot;
      dot.title = `${formatTime(r.timestamp)}: ${r.preview}`;
      track.appendChild(dot);
    }

    lane.appendChild(track);

    lane.addEventListener('click', () => {
      for (const l of document.querySelectorAll('.timeline-lane')) (l as HTMLElement).style.removeProperty('border-color');
      lane.style.borderColor = color.border;

      render(html`<div class="timeline-detail">
        <h3>${s.workspaceName} \u2014 ${s.sessionName}</h3>
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;">
          ${formatTime(s.firstActivity)} - ${formatTime(s.lastActivity)} | ${s.requestCount} requests
        </div>
        <div class="timeline-detail-requests">
          ${s.requests.map(r => html`<div class="timeline-detail-req">
            <span class="timeline-detail-time">${formatTime(r.timestamp)}</span>
            <span class="timeline-detail-msg">${r.preview}</span>
          </div>`)}
        </div>
      </div>`, detailEl);
      detailEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });

    lanes.appendChild(lane);
  }

  const axis = el('div', 'timeline-axis');
  for (let h = rangeStart; h <= rangeEnd; h++) {
    const tick = el('span', 'timeline-tick');
    tick.style.left = ((h - rangeStart) / (rangeEnd - rangeStart) * 100) + '%';
    tick.textContent = `${h}:00`;
    axis.appendChild(tick);
  }
  lanes.appendChild(axis);
}

/* ── Session detail helper ── */

async function showSessionDetail(sessionId: string): Promise<void> {
  const detail = document.getElementById('sessionDetail')!;
  render(html`<div class="sessions-empty-detail"><div class="loading-spinner"></div></div>`, detail);
  const session = await rpc<SessionDetail | null>('getSessionDetail', { sessionId });
  if (!session) { render(html`<p>Session not found</p>`, detail); return; }

  render(html`<div class="session-detail-inner">
    <div class="session-detail-header">
      <h2>${session.workspaceName}</h2>
      <span class="muted">${formatDate(session.creationDate)} \u00b7 ${session.requestCount} messages \u00b7 ${session.location}</span>
    </div>
    <div class="message-thread">
      ${session.requests.map(r => {
        const ts = r.timestamp ? formatTime(r.timestamp) : '';
        const meta: string[] = [];
        if (r.modelId) meta.push(r.modelId);
        if (r.agentName) meta.push(r.agentName);
        if (r.toolsUsed.length) meta.push('Tools: ' + r.toolsUsed.join(', '));
        return html`
          <div class="msg user-msg">
            <div class="msg-meta">${ts}${meta.length ? ' \u00b7 ' + meta.join(' \u00b7 ') : ''}</div>
            <div class="msg-text">${r.messageText.substring(0, 800)}${r.messageText.length > 800 ? '...' : ''}</div>
          </div>
          ${r.responseText && html`
          <div class="msg ai-msg">
            <div class="msg-text">${r.responseText.substring(0, 800)}${r.responseText.length > 800 ? '...' : ''}</div>
          </div>`}
        `;
      })}
    </div>
  </div>`, detail);
}
