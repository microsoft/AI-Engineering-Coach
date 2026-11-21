/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// cspell:ignore describedby

import { BarElement, PointElement, type ActiveElement, type Chart, type ChartEvent, type Scale, type TooltipModel } from 'chart.js';
import type { DateFilter, Session } from '../core/types';
import type { CuriosityData, CuriosityFilter, CuriositySession, InvestigationSource } from '../core/types/curiosity-types';
import { activityCount, inquiryCount, type CuriosityActivity } from '../core/curiosity-activity';
import { toDateStr } from '../core/helpers';
import { rpc, withErrorBoundary, createChart, destroyChartById } from './shared';
import { html, render, PctBadge, type ComponentChildren } from './render';
import { SVG } from './svg-icons';
import { menuIcon, sourceIcon } from './curiosity-icons';
import { ACTIVITIES, activityBuckets, activityInterval, comparisonPeriods, elapsedLabel, explorationShare, percentageChange, summaryCounts,
  type ActivityBucket, type ActivityInterval } from './curiosity-charts';

let rangeDays = 28;
let language = '';
let measure: ChartMeasure = 'inquiry';
let renderVersion = 0;
let resizePage: (() => void) | undefined;
let navigationKey: ((event: KeyboardEvent) => void) | undefined;
let previewPointerMove: ((event: MouseEvent) => void) | undefined;
let pageClick: ((event: MouseEvent) => void) | undefined;
let resizeFrame = 0;
window.addEventListener('resize', () => {
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => resizePage?.());
});
document.addEventListener('keydown', event => navigationKey?.(event));
document.addEventListener('mousemove', event => previewPointerMove?.(event));
document.addEventListener('click', event => pageClick?.(event), true);

const count = (value: number) => value.toLocaleString();
const percent = (value: number, total: number) => total ? `${(value / total * 100).toLocaleString(undefined, { maximumFractionDigits: 1 })}%` : '--';
const color = (id: CuriosityActivity) => `var(--curiosity-${id})`;
const RANGES = [
  { days: 7, label: 'Last 7 days' }, { days: 28, label: 'Last 4 weeks' },
  { days: 90, label: 'Last 3 months' }, { days: 180, label: 'Last 6 months' }, { days: 0, label: 'All time' },
];
type ChartMeasure = 'inquiry' | 'turns';
type CountComparison = ReturnType<typeof comparisonPeriods>[number] & { recent: CuriosityData; prior: CuriosityData };
type HoverAnchor = Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>;
interface HoverPreview {
  title: string; sessions: CuriositySession[]; anchor: HoverAnchor; icon?: ComponentChildren; detail?: string; trigger?: HTMLElement;
}
const SOURCES: { id: InvestigationSource; label: string; description: string }[] = [
  { id: 'web', label: 'Web sources', description: 'Web search and fetch tools, including research during Task execution turns.' },
  { id: 'repository', label: 'Repository reads', description: 'Recorded file reads and code search, including investigation during Task execution turns.' },
  { id: 'delegated', label: 'Investigation agents', description: 'Explicit research or explore roles. A role does not establish which sources an agent used.' },
];
const sessionKey = (session: CuriositySession) => JSON.stringify([session.harness, session.workspace, session.sessionId]);
const uniqueSessions = (sessions: CuriositySession[]) => [...new Map(sessions.map(session =>
  [sessionKey(session), session])).values()];
const bucketSessions = (bucket: ActivityBucket) => uniqueSessions(ACTIVITIES.flatMap(activity => bucket.sessions[activity.id]));
const activityIcon = (id: CuriosityActivity) => html`<i class="curiosity-activity-mark" style=${{ background: color(id) }}></i>`;
const shareIcon = () => html`<i class="curiosity-share-mark" aria-hidden="true"></i>`;
const shareDetail = (bucket: ActivityBucket) => `${percent(inquiryCount(bucket.counts), activityCount(bucket.counts))} Explore / ${percent(bucket.counts.action, activityCount(bucket.counts))} Task execution; ${count(inquiryCount(bucket.counts))} Explore + ${count(bucket.counts.action)} Task execution turns`;

function drawBalance(
  target: HTMLElement, buckets: ActivityBucket[], measure: ChartMeasure, interval: ActivityInterval,
  select: (bucket: ActivityBucket) => void, preview: (value?: HoverPreview) => void,
): void {
  const style = getComputedStyle(target);
  const textColor = style.getPropertyValue('--text').trim();
  const shareColor = style.getPropertyValue('--curiosity-share').trim();
  const activities = ACTIVITIES.filter(activity => measure !== 'inquiry' || activity.id !== 'action');
  const format = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric',
    year: buckets[0]?.from.slice(0, 4) !== buckets.at(-1)?.to.slice(0, 4) ? 'numeric' : undefined });
  const axisFormat = interval === 'monthly' ? new Intl.DateTimeFormat(undefined, { month: 'short',
    year: buckets[0]?.from.slice(0, 4) !== buckets.at(-1)?.to.slice(0, 4) ? 'numeric' : undefined }) : format;
  createChart('curiosityBalance', 'bar', {
    labels: buckets.map(bucket => bucket.from),
    datasets: [
      ...activities.map(({ id, label }) => ({
        label, data: buckets.map(bucket => bucket.counts[id]), yAxisID: 'y', stack: 'activity', order: 1,
        backgroundColor: style.getPropertyValue(`--curiosity-${id}`).trim(), borderWidth: 0, borderRadius: 3,
      })),
      { type: 'line', label: 'Explore share', data: buckets.map(bucket => explorationShare(bucket.counts)),
        yAxisID: 'share', order: 0, borderColor: shareColor, backgroundColor: shareColor, borderWidth: 2,
        pointRadius: 2, pointHoverRadius: 4, pointHitRadius: 10, fill: false, spanGaps: true,
        cubicInterpolationMode: 'monotone' },
    ],
  }, {
    animation: false, color: textColor,
    layout: { padding: { top: 8, right: 8 } },
    onClick: (_event: ChartEvent, elements: ActiveElement[]) => { if (elements[0]) select(buckets[elements[0].index]); },
    scales: {
      x: { stacked: true, offset: true, grid: { display: false },
        afterBuildTicks: (axis: Scale) => { if (axis.ticks.length) axis.ticks[0].major = axis.ticks.at(-1)!.major = true; },
        ticks: { color: textColor, maxTicksLimit: 7, maxRotation: 0, major: { enabled: true },
          callback: (value: number) => axisFormat.format(new Date(`${buckets[value].from}T00:00:00`)) } },
      y: { stacked: true, beginAtZero: true,
        grid: { color: style.getPropertyValue('--border').trim() },
        ticks: { color: textColor, precision: 0, callback: (value: number) => count(value) } },
      share: { position: 'right', min: 0, max: 100, stacked: false,
        grid: { drawOnChartArea: false },
        ticks: { color: textColor, stepSize: 50, callback: (value: number) => `${value}%` } },
    },
    plugins: {
      legend: { display: false },
      tooltip: { enabled: false, external: ({ chart, tooltip }: { chart: Chart; tooltip: TooltipModel<'bar' | 'line'> }) => {
        const item = tooltip.dataPoints?.[0];
        chart.canvas.style.cursor = tooltip.opacity && item ? 'pointer' : '';
        if (!tooltip.opacity || !item) { preview(); return; }
        const bucket = buckets[item.dataIndex];
        const bounds = chart.canvas.getBoundingClientRect();
        const scaleX = bounds.width / chart.width;
        const scaleY = bounds.height / chart.height;
        const date = (value: string) => format.format(new Date(`${value}T00:00:00`));
        const period = bucket.from === bucket.to ? date(bucket.from) : `${date(bucket.from)} - ${date(bucket.to)}`;
        if (item.element instanceof PointElement) {
          const { x, y } = item.element.getProps(['x', 'y'], true);
          if (x === null || y === null) { preview(); return; }
          preview({ title: 'Explore share', sessions: bucketSessions(bucket), icon: shareIcon(),
            trigger: chart.canvas,
            detail: `${period}: ${shareDetail(bucket)}`,
            anchor: { left: bounds.left + (x - 4) * scaleX, right: bounds.left + (x + 4) * scaleX,
              top: bounds.top + (y - 4) * scaleY, bottom: bounds.top + (y + 4) * scaleY } });
          return;
        }
        if (!(item.element instanceof BarElement)) { preview(); return; }
        const activity = activities[item.datasetIndex];
        const { x, y } = item.element;
        const { base, width } = item.element.getProps(['base', 'width'], true);
        preview({ title: activity.label, sessions: bucket.sessions[activity.id], icon: activityIcon(activity.id),
          detail: period, trigger: chart.canvas,
          anchor: { left: bounds.left + (x - width / 2) * scaleX,
            right: bounds.left + (x + width / 2) * scaleX,
            top: bounds.top + Math.min(y, base) * scaleY,
            bottom: bounds.top + Math.max(y, base) * scaleY } });
      } },
    },
  });
}

export async function renderCuriosity(container: HTMLElement, currentFilter: DateFilter): Promise<void> {
  const version = ++renderVersion;
  destroyChartById('curiosityBalance');
  const filter: CuriosityFilter = { ...currentFilter, ...(language ? { language } : {}) };
  const toDate = filter.toDate ?? toDateStr(Date.now());
  if (rangeDays) {
    const date = new Date(`${toDate}T12:00:00`);
    date.setDate(date.getDate() - rangeDays + 1);
    const from = toDateStr(date.getTime());
    if (!filter.fromDate || from > filter.fromDate) filter.fromDate = from;
  }
  const reload = () => withErrorBoundary('Curiosity', container, () => renderCuriosity(container, currentFilter));
  render(html`<div id="curiosity-results" class="curiosity-page" role="status">Loading recorded activity...</div>`, container);
  const target = container.querySelector<HTMLElement>('#curiosity-results')!;
  const current = () => target.isConnected && target.id === 'curiosity-results' && version === renderVersion;
  const data = await rpc<CuriosityData>('getCuriosity', { ...filter });
  if (!current()) return;
  let comparisons: CountComparison[];
  try {
    comparisons = await Promise.all(comparisonPeriods(toDate).map(async period => {
      const [recent, previous] = await Promise.all([
        rpc<CuriosityData>('getCuriosity', { ...filter, ...period.current }),
        rpc<CuriosityData>('getCuriosity', { ...filter, ...period.previous }),
      ]);
      return { ...period, recent, prior: previous };
    }));
  } catch (failure) {
    if (!current()) return;
    throw failure;
  }
  if (!current()) return;
  const followups = new Map([...data.chains.examples].reverse()
    .map(chain => [sessionKey(chain.session), chain]));
  const followupSessions = data.chains.examples.map(chain => chain.session);
  const days = filter.fromDate ? Math.max(1, (Date.parse(toDate) - Date.parse(filter.fromDate)) / 86_400_000 + 1) : data.daily.length;
  const interval = activityInterval(days);
  let aboutOpen = false;
  let navigationOpen = false;
  let languagePage = 0;
  let panel: 'chart' | 'sessions' = 'chart';
  let chartPeriod = -1;
  let sessionPage = 0;
  let sessionTitle = '';
  let sessionDescription = '';
  let sessions: CuriositySession[] = [];
  let selectedPeriod: ActivityBucket | undefined;
  let loading = false;
  let error = '';
  let requestVersion = 0;
  let chartFrame = 0;
  let preview: HoverPreview | undefined;
  let previewDismissed = false;
  let pointer = { x: 0, y: 0 };
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  let expandedPrompt = '';
  let promptVersion = 0;
  let promptLoading = false;
  let promptError = '';
  let prompt: { text: string; truncated: boolean } | undefined;
  let restoringPreviewFocus = false;
  previewPointerMove = event => {
    if (!current()) return;
    if (event.clientX !== pointer.x || event.clientY !== pointer.y) previewDismissed = false;
    pointer = { x: event.clientX, y: event.clientY };
  };
  pageClick = event => {
    if (!current() || !(event.target instanceof Node)) return;
    if (aboutOpen && !target.querySelector('#curiosity-about')?.contains(event.target)) {
      aboutOpen = false; show(false);
    }
    if (preview && !target.querySelector('#curiosity-hover')?.contains(event.target)) hidePreview();
  };

  function keepPreview() { clearTimeout(closeTimer); }
  function resetPrompt() {
    ++promptVersion; expandedPrompt = ''; promptLoading = false; promptError = ''; prompt = undefined;
  }
  function hidePreview(restoreFocus = false) {
    keepPreview();
    if (preview) {
      const trigger = preview.trigger;
      const focused = target.querySelector('#curiosity-hover')?.contains(document.activeElement);
      preview = undefined;
      if (expandedPrompt.startsWith('hover:')) resetPrompt();
      show(false);
      if (restoreFocus && focused && trigger?.isConnected) {
        restoringPreviewFocus = true; trigger.focus(); restoringPreviewFocus = false;
      }
    }
  }
  function closePreview() {
    keepPreview();
    closeTimer = setTimeout(() => {
      if (!expandedPrompt.startsWith('hover:') && !target.querySelector('#curiosity-hover')?.matches(':hover, :focus-within')) hidePreview();
    }, 120);
  }
  function blurPreview(event: FocusEvent) {
    if (event.relatedTarget instanceof Node && target.querySelector('#curiosity-hover')?.contains(event.relatedTarget)) return;
    closePreview();
  }
  function openPreview(value?: HoverPreview) {
    if (!current() || previewDismissed) return;
    if (expandedPrompt.startsWith('hover:')) { keepPreview(); return; }
    if (!value) { closePreview(); return; }
    keepPreview(); preview = { ...value, sessions: uniqueSessions(value.sessions).slice(0, 5) }; show(false);
  }
  function focusPreview(event: KeyboardEvent) {
    if (event.key !== 'ArrowDown' || !preview) return;
    const toggle = target.querySelector<HTMLButtonElement>('#curiosity-hover .curiosity-prompt-toggle');
    if (toggle) { event.preventDefault(); toggle.focus(); }
  }
  async function togglePrompt(session: CuriositySession, host: 'hover' | 'sessions', retry = false) {
    const key = `${host}:${JSON.stringify([sessionKey(session), session.requestId])}`;
    if (expandedPrompt === key && !retry) { resetPrompt(); show(false); return; }
    resetPrompt();
    const token = promptVersion;
    expandedPrompt = key; promptLoading = true; keepPreview(); show(false);
    try {
      const detail = await rpc<Session | null>('getSessionDetail', { sessionId: session.sessionId });
      if (!current() || token !== promptVersion) return;
      if (!detail || detail.sessionId !== session.sessionId || detail.harness !== session.harness
        || detail.workspaceId !== session.workspaceId) throw new Error('The sampled session is unavailable.');
      const matches = detail.requests.filter(request => request.requestId === session.requestId && request.timestamp === session.timestamp);
      if (matches.length !== 1 || !matches[0].messageText) throw new Error('The sampled prompt is unavailable.');
      const request = matches[0];
      prompt = { text: request.messageText, truncated: request.messageText.length < request.messageLength };
    } catch (failure) {
      if (!current() || token !== promptVersion) return;
      promptError = failure instanceof Error ? failure.message : String(failure);
    }
    promptLoading = false; show(false);
  }
  function promptReader(session: CuriositySession, host: 'hover' | 'sessions') {
    if (!session.promptTruncated) return html`<span class="curiosity-prompt-preview">${session.promptPreview || 'Recorded prompt'}</span>`;
    const expanded = expandedPrompt === `${host}:${JSON.stringify([sessionKey(session), session.requestId])}`;
    return html`<div class="curiosity-prompt-disclosure">
      <button class="curiosity-prompt-preview curiosity-prompt-toggle" type="button" aria-expanded=${expanded} aria-controls="curiosity-prompt-reader"
        title=${expanded ? 'Collapse recorded prompt' : 'Read recorded prompt'}
        onClick=${() => { void togglePrompt(session, host); }}>${session.promptPreview || 'Recorded prompt'}...</button>
      ${expanded ? html`<div id="curiosity-prompt-reader" class="curiosity-prompt-reader" role="region" aria-label="Recorded prompt">
        ${promptLoading ? html`<p role="status">Loading prompt...</p>` : promptError
          ? html`<p role="alert">Cannot read prompt: ${promptError}
            <button class="curiosity-text-button" onClick=${() => { void togglePrompt(session, host, true); }}>Retry</button></p>`
          : prompt ? html`${prompt.truncated ? html`<p class="curiosity-caption">Only a truncated stored preview is available.</p>` : null}
            <div class="curiosity-prompt-text" tabindex="0" aria-label="Prompt text">${prompt.text}</div>` : null}
      </div>` : null}
    </div>`;
  }
  function closeNavigation() {
    navigationOpen = false; show(false);
    target.querySelector<HTMLButtonElement>('.curiosity-nav-toggle')?.focus();
  }
  navigationKey = event => {
    if (!current()) return;
    if (event.key === 'Escape') {
      if (navigationOpen) closeNavigation();
      else if (preview) { previewDismissed = true; hidePreview(true); }
      else if (expandedPrompt) {
        const toggle = target.querySelector<HTMLButtonElement>('.curiosity-prompt-toggle[aria-expanded="true"]');
        resetPrompt(); show(false); toggle?.focus();
      } else if (aboutOpen) {
        aboutOpen = false; show(false); target.querySelector<HTMLButtonElement>('#curiosity-about button')?.focus();
      }
      return;
    }
    if (!navigationOpen || event.key !== 'Tab') return;
    const controls = [...document.querySelectorAll<HTMLElement>('#sidebar a, #sidebar button:not(:disabled), #sidebar input, #sidebar select')];
    const index = controls.indexOf(document.activeElement as HTMLElement);
    if ((event.shiftKey && index <= 0) || (!event.shiftKey && index === controls.length - 1)) {
      event.preventDefault(); controls[event.shiftKey ? controls.length - 1 : 0]?.focus();
    }
  };
  function hover(title: string, names: CuriositySession[], icon?: ComponentChildren, anchorGroup?: string) {
    const open = (event: Event) => {
      if (restoringPreviewFocus) return;
      if (event.type === 'focus' || event instanceof MouseEvent
        && (event.clientX !== pointer.x || event.clientY !== pointer.y)) previewDismissed = false;
      if (event.currentTarget instanceof Element) {
        const anchor = (anchorGroup ? event.currentTarget.closest(anchorGroup) : event.currentTarget) ?? event.currentTarget;
        openPreview({ title, sessions: names, icon, anchor: anchor.getBoundingClientRect(),
          trigger: event.currentTarget instanceof HTMLElement ? event.currentTarget : undefined });
      }
    };
    return { onMouseEnter: open, onMouseLeave: closePreview, onFocus: open, onBlur: blurPreview,
      onKeyDown: focusPreview, 'aria-describedby': 'curiosity-hover', 'aria-haspopup': 'dialog' };
  }
  function inspectSessions(title: string, names: CuriositySession[], description: string) {
    ++requestVersion; resetPrompt(); keepPreview(); preview = undefined; selectedPeriod = undefined; loading = false; error = '';
    sessionTitle = title; sessionDescription = description; sessions = uniqueSessions(names); sessionPage = 0; panel = 'sessions'; show();
  }
  async function inspectPeriod(bucket: ActivityBucket) {
    const token = ++requestVersion;
    resetPrompt();
    sessionTitle = `${bucket.from} to ${bucket.to}`;
    sessionDescription = 'Recent sessions in this period.';
    selectedPeriod = bucket; panel = 'sessions'; sessions = []; sessionPage = 0; loading = true; error = ''; preview = undefined;
    show();
    try {
      const scoped = await rpc<CuriosityData>('getCuriosity', { ...filter, fromDate: bucket.from, toDate: bucket.to });
      if (!current() || token !== requestVersion) return;
      sessions = uniqueSessions(activityBuckets(scoped.daily, 'daily').flatMap(bucketSessions));
    } catch (failure) {
      if (!current() || token !== requestVersion) return;
      error = failure instanceof Error ? failure.message : String(failure);
    }
    loading = false; show();
  }
  function pages(total: number, page: number, size: number, update: (page: number) => void, name: string) {
    return html`<div class="curiosity-pagination" aria-label=${`${name} pages`}>
      <button aria-label=${`Previous ${name.toLowerCase()}`} disabled=${page === 0} onClick=${() => update(page - 1)}>Previous</button>
      <span>${total ? `${page * size + 1}-${Math.min(total, (page + 1) * size)} of ${total}` : '0 recorded'}</span>
      <button aria-label=${`Next ${name.toLowerCase()}`} disabled=${(page + 1) * size >= total} onClick=${() => update(page + 1)}>Next</button>
    </div>`;
  }
  function trends(key: keyof ReturnType<typeof summaryCounts>) {
    return html`<dd class="ap-score-deltas curiosity-summary-trends" aria-label="Count trends">${comparisons.map(period => {
      const recent = summaryCounts(period.recent)[key];
      const prior = summaryCounts(period.prior)[key];
      const change = period.prior.coverage.human ? percentageChange(recent, prior) : null;
      const note = !period.prior.coverage.human ? 'No prior recorded activity. '
        : prior === 0 && recent > 0 ? 'No percentage change from a zero count. ' : '';
      const title = `${period.label}: ${count(recent)} (${period.current.fromDate} to ${period.current.toDate}) compared with ${count(prior)} (${period.previous.fromDate} to ${period.previous.toDate}). ${note}Recorded counts, not learning scores.`;
      return change !== null ? html`<${PctBadge} pct=${change} label=${period.label} title=${title} />`
        : html`<span class="trend-badge trend-stable" title=${title}>${period.prior.coverage.human ? 'New' : '--'} ${period.label}</span>`;
    })}</dd>`;
  }
  function contextTags(session: CuriositySession) {
    return session.context?.length ? html`<div class="curiosity-context" aria-label="Recorded session context">
      ${session.context.map(tag => html`<span class="curiosity-context-tag" title=${`${tag.kind === 'web' ? 'Source host' : 'Repository path'} recorded in ${count(tag.turns)} selected ${tag.turns === 1 ? 'turn' : 'turns'}. Session context, not a learning topic.`}>
        <span class="curiosity-context-icon" aria-hidden="true">${sourceIcon(tag.kind)}</span>
        <span class="curiosity-context-label">${tag.label}</span><b>${count(tag.turns)}</b>
      </span>`)}
    </div>` : null;
  }
  function chartKey(event: KeyboardEvent, buckets: ActivityBucket[]) {
    focusPreview(event);
    const available = buckets.filter(bucket => activityCount(bucket.counts));
    if (!available.length || !['ArrowLeft', 'ArrowRight', 'Enter', ' '].includes(event.key)) return;
    event.preventDefault(); previewDismissed = false;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      chartPeriod = chartPeriod < 0 ? event.key === 'ArrowLeft' ? available.length - 1 : 0
        : (chartPeriod + (event.key === 'ArrowLeft' ? -1 : 1) + available.length) % available.length;
      const bucket = available[chartPeriod];
      openPreview({ title: 'Recorded period', detail: `${bucket.from} to ${bucket.to}: ${shareDetail(bucket)}`, sessions: bucketSessions(bucket),
        icon: SVG.calendar, trigger: event.currentTarget as HTMLCanvasElement, anchor: (event.currentTarget as HTMLCanvasElement).getBoundingClientRect() });
    } else void inspectPeriod(available[chartPeriod < 0 ? available.length - 1 : chartPeriod]);
  }
  function show(redraw = true): void {
    if (!current()) return;
    if (redraw) {
      cancelAnimationFrame(chartFrame);
      preview = undefined; resetPrompt(); keepPreview(); destroyChartById('curiosityBalance');
    }
    const buckets = activityBuckets(data.daily, interval);
    const languageSize = target.clientWidth <= 760 || target.clientHeight < 650 ? 2 : 8;
    const sessionSize = target.clientWidth < 480 || target.clientHeight < 650 ? 1 : 3;
    languagePage = Math.min(languagePage, Math.max(0, Math.ceil(data.languages.length / languageSize) - 1));
    const inquiries = inquiryCount(data.counts);
    render(html`<div id="curiosity-results" class="curiosity-page"><div class=${`curiosity-frame ${navigationOpen ? 'curiosity-nav-open' : ''}`}>
      <header class="curiosity-toolbar">
        <div class="curiosity-title-group"><div class="curiosity-title"><button class="curiosity-nav-toggle" aria-label="Toggle navigation" aria-expanded=${navigationOpen}
          onClick=${() => {
            navigationOpen = !navigationOpen; show(false);
            if (navigationOpen) document.querySelector<HTMLAnchorElement>('#sidebar a')?.focus();
          }}>${menuIcon}</button><h1>Curiosity</h1></div>
          <div id="curiosity-about">
            <button class="curiosity-text-button" aria-expanded=${aboutOpen} aria-controls="curiosity-about-panel"
              onClick=${() => { aboutOpen = !aboutOpen; show(false); }}>What does Curiosity show?</button>
            ${aboutOpen ? html`<div id="curiosity-about-panel" class="curiosity-about-panel">
              <p>Notice how you balance asking AI to carry out tasks with asking questions to understand what you're building.
                Seeking explanations and checking your understanding can help you stay involved in the work, review decisions, and spot mistakes.</p>
              <p>Curiosity shows recorded conversation activity, not a learning score. Task execution can involve thoughtful work too,
                and a low Explore share does not prove disengagement or lost understanding.</p>
            </div>` : null}
          </div>
        </div>
        <a class="curiosity-text-button" href="#" data-page="anti-patterns" data-nav-hint="prompt-quality"
          title="Open Curiosity findings under Prompt Quality using the dashboard filters, not this page's local date and language selections."
          >Curiosity checks</a>
      </header>
      <div class="cons-range-bar curiosity-range" role="group" aria-label="Date range">${RANGES.map(range => html`
        <button class=${`cons-range-btn${rangeDays === range.days ? ' active' : ''}`} aria-pressed=${rangeDays === range.days}
          data-range=${range.days} onClick=${() => { rangeDays = range.days; reload(); }}>${range.label}</button>`)}</div>
      <dl class="curiosity-summary" aria-label="Activity balance">
        <div title=${`${count(data.sessionCounts.mixed)} inquiry sessions also included Task execution turns; ${count(data.sessionCounts.inquiry - data.sessionCounts.mixed)} were inquiry-only.`}>
          <dt>Sessions with inquiry</dt><dd><strong>${count(data.sessionCounts.inquiry)}</strong>
          <span>/ ${count(data.sessionCounts.human)} <b>${percent(data.sessionCounts.inquiry, data.sessionCounts.human)}</b></span></dd>${trends('sessions')}</div>
        <div><dt>Recorded inquiries</dt><dd><strong>${count(inquiries)}</strong><span>${percent(inquiries, data.coverage.classified)} of classified turns</span></dd>${trends('inquiries')}</div>
        <div><dt>Follow-up sequences</dt><dd><strong tabindex="0" aria-label="Preview follow-up sequences"
          ...${hover('Follow-up sequences', followupSessions, SVG.chat)}>${count(data.chains.total)}</strong>
          <span>${count(data.chains.sustained)} with 3+ turns</span></dd>${trends('followups')}</div>
      </dl>
      <div class="curiosity-overview">
        <section class="curiosity-trend" aria-label="Activity over time">
          ${panel === 'chart' ? html`
            <div class="curiosity-heading"><h2>${measure === 'inquiry' ? 'Exploration over time' : 'Explore and Task execution over time'}</h2>
              <div class="curiosity-switch" aria-label="Chart measure">${(['inquiry', 'turns'] as const).map(value => html`
                <button aria-pressed=${measure === value} onClick=${() => { measure = value; chartPeriod = -1; show(); }}>
                  ${value === 'inquiry' ? 'Explore' : 'All turns'}</button>`)}</div></div>
            ${data.coverage.classified ? html`<div class="curiosity-chart"><canvas id="curiosityBalance" role="img" tabindex="0" aria-describedby="curiosity-hover"
              onKeyDown=${(event: KeyboardEvent) => chartKey(event, buckets)} onBlur=${blurPreview}
              aria-label=${`${interval === 'daily' ? 'Daily' : interval === 'weekly' ? 'Weekly' : 'Monthly'} ${measure === 'inquiry' ? 'Explore turns' : 'Explore and Task execution turns'} with Explore share on a 0 to 100 percent scale`}></canvas></div>`
              : html`<div class="curiosity-empty"><h3>No classified activity in this range</h3><p>Recorded sources remain visible.</p></div>`}
            <div class="curiosity-legend">${ACTIVITIES.map(activity => html`<span ...${hover(activity.label, data.evidence[activity.id], activityIcon(activity.id))} tabindex="0">
              ${activityIcon(activity.id)}${activity.label}<b>${count(data.counts[activity.id])}</b></span>`)}
              <span class="curiosity-share-legend" tabindex="0"
                title="Explore share = all inquiry turns / (all inquiry + Task execution turns). Unclassified turns are excluded. This is activity, not proof of learning."
                ...${hover('Explore share', ACTIVITIES.flatMap(activity => data.evidence[activity.id]), shareIcon())}>
                ${shareIcon()}Explore share<b>${percent(inquiries, activityCount(data.counts))}</b>
              </span></div>
          ` : html`<div class="curiosity-heading"><h2>${sessionTitle}</h2>
              <button class="curiosity-text-button" onClick=${() => { ++requestVersion; panel = 'chart'; selectedPeriod = undefined; show(); }}>Back to chart</button></div>
              <p class="curiosity-caption">${sessionDescription}</p>
              ${loading ? html`<p role="status">Loading sampled prompts...</p>` : error ? html`<p role="alert">Cannot load sessions: ${error}
                <button onClick=${() => { if (selectedPeriod) void inspectPeriod(selectedPeriod); }}>Retry</button></p>` : sessions.length
                  ? html`<ul class="curiosity-session-list">${sessions.slice(sessionPage * sessionSize, (sessionPage + 1) * sessionSize).map(session => html`
                    <li key=${`${session.harness}:${session.sessionId}`}>${promptReader(session, 'sessions')}
                      <small>${session.workspace} / ${session.harness} / ${session.date}</small>${contextTags(session)}
                      <a class="curiosity-text-button" href="#" data-page="timeline" data-nav-hint=${session.date}
                        title=${session.name}>Open in Timeline</a></li>`)}</ul>
                    ${pages(sessions.length, sessionPage, sessionSize, value => { sessionPage = value; show(); }, 'Sessions')}`
                  : html`<p class="curiosity-empty">No sampled prompts recorded in this selection.</p>`}
          `}
        </section>
        <section class="curiosity-investigation" aria-label="Recorded investigation sources"><div class="curiosity-heading"><h2>How your answers were grounded</h2>
          <span class="curiosity-caption">Includes Task execution turns</span></div>
          <div class="curiosity-research">${SOURCES.map(source => {
            const row = data.research[source.id];
            return html`<button ...${hover(source.label, row.sessionSamples, sourceIcon(source.id))} onClick=${() => inspectSessions(source.label, row.sessionSamples,
              `${source.description} ${count(row.turns)} recorded turns; ${count(row.withinAction)} during Task execution turns. Sources overlap.`)}>
              ${sourceIcon(source.id)}<span class="curiosity-research-label" data-short=${source.id === 'web' ? 'Web' : source.id === 'repository' ? 'Repository' : 'Agents'}>${source.label}</span>
              <strong>${count(row.sessions)}<small> sessions</small></strong>
              <span class="curiosity-research-detail">${percent(row.sessions, data.sessionCounts.human)} of sessions</span>
              <span class="curiosity-research-track" aria-hidden="true"><i style=${{ width: `${data.sessionCounts.human ? row.sessions / data.sessionCounts.human * 100 : 0}%`,
                background: source.id === 'delegated' ? 'var(--accent-orange)' : color(source.id) }}></i></span>
            </button>`;
          })}</div>
        </section>
        <section class="curiosity-languages" aria-label="Programming language context"><div class="curiosity-heading"><h2>Language context</h2>
          ${language ? html`<button class="curiosity-text-button" onClick=${() => { language = ''; reload(); }}>Clear</button>` : null}</div>
          <p class="curiosity-caption">Files touched in each session</p>
          ${data.languages.length ? html`<ul class="curiosity-language-list">${data.languages.slice(languagePage * languageSize, (languagePage + 1) * languageSize).map(row => html`
            <li><button aria-pressed=${language === row.language} ...${hover(row.language, row.sessionSamples)}
              onClick=${() => { language = language === row.language ? '' : row.language; reload(); }}>
              <span class="curiosity-language-name">${row.language}</span>
              <b>${percent(row.inquirySessions, row.sessions)}</b><span class="curiosity-language-bar" aria-hidden="true">
                ${ACTIVITIES.filter(activity => activity.id !== 'action').map(activity => html`<i style=${{
                  width: `${inquiryCount(row.counts) ? row.counts[activity.id] / inquiryCount(row.counts) * 100 : 0}%`, background: color(activity.id) }}></i>`)}
              </span><small>${count(row.inquirySessions)} of ${count(row.sessions)} sessions with inquiry</small>
            </button></li>`)}</ul>${pages(data.languages.length, languagePage, languageSize, value => { languagePage = value; show(); }, 'Languages')}`
            : html`<p class="curiosity-empty">No source-language paths recorded.</p>`}
        </section>
      </div>
      <aside id="curiosity-hover" role="dialog" aria-label=${preview?.title ?? 'Activity preview'} class="curiosity-hover" hidden=${!preview}
        onMouseEnter=${keepPreview} onMouseLeave=${closePreview} onFocusIn=${keepPreview} onFocusOut=${closePreview}>
        ${preview ? html`<div class="curiosity-hover-heading"><span class="curiosity-hover-icon" aria-hidden="true">${preview.icon ?? SVG.chat}</span>
          <div><h3>${preview.title}</h3><p>${preview.detail ?? 'Recent sessions'}</p></div></div>
          ${preview.sessions.length ? html`<ul>${preview.sessions.map(session => {
            const followup = followups.get(sessionKey(session));
            return html`<li key=${sessionKey(session)}>
            <span class="curiosity-hover-session-icon" aria-hidden="true">${SVG.chat}</span>
            <div>${promptReader(session, 'hover')}<small>${session.workspace}</small>${contextTags(session)}</div>
            ${followup?.elapsedMs !== undefined ? html`<small class="curiosity-hover-duration"
              title="First question to last recorded response in the latest sampled follow-up. Includes response time and pauses, not active learning time."
              >${elapsedLabel(followup.elapsedMs)} elapsed / ${count(followup.exchanges)} inquiry turns</small>` : null}
          </li>`;
          })}</ul>` : html`<p class="curiosity-hover-empty">No recent sessions recorded.</p>`}` : null}
      </aside>
      ${navigationOpen ? html`<button class="curiosity-nav-shade" aria-label="Close navigation" onClick=${closeNavigation}></button>` : null}
    </div></div>`, container);
    if (preview) {
      const overlay = target.querySelector<HTMLElement>('#curiosity-hover')!;
      const bounds = overlay.getBoundingClientRect();
      const anchor = preview.anchor;
      const right = anchor.right + 16;
      const left = right + bounds.width <= window.innerWidth - 12 ? right
        : anchor.left - bounds.width - 16 >= 12 ? anchor.left - bounds.width - 16
          : Math.max(12, window.innerWidth - bounds.width - 12);
      const below = anchor.bottom + 10;
      const above = anchor.top - bounds.height - 10;
      const beside = left >= anchor.right || left + bounds.width <= anchor.left;
      if (!expandedPrompt.startsWith('hover:') && preview.sessions.length > 1 && (bounds.height > window.innerHeight - 24
        || !beside && below + bounds.height > window.innerHeight - 12 && above < 12)) {
        preview = { ...preview, sessions: preview.sessions.slice(0, -1) };
        show(false); return;
      }
      overlay.style.left = `${left}px`;
      overlay.style.top = `${Math.max(12, Math.min(below + bounds.height <= window.innerHeight - 12
        ? below : above, window.innerHeight - bounds.height - 12))}px`;
    }
    if (redraw && panel === 'chart' && data.coverage.classified) chartFrame = requestAnimationFrame(() => {
      if (current() && panel === 'chart') drawBalance(target, buckets, measure, interval, bucket => { void inspectPeriod(bucket); }, openPreview);
    });
  }
  resizePage = () => { if (current()) show(); };
  show();
}
