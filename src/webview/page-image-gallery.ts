/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Coding Moments -- image gallery with lazy-loaded images and story reels */

import type { DateFilter } from '../core/types';
import type { ImageGalleryData, ImageMoment, ImageStory } from '../core/analyzer-images';
import { rpc } from './shared';
import { html, render, type ComponentChildren } from './render';



/* ── Smart scoring ──────────────────────────────────────────── */

/** Score a story for interestingness */
function scoreStory(s: ImageStory, now: number): number {
  let score = 0;
  score += Math.min(s.totalImages * 5, 35);
  score += Math.min(s.moments.length * 3, 20);
  if (s.totalAiLoc > 100) score += 20;
  else if (s.totalAiLoc > 20) score += 10;
  if (s.moments.length > 0) {
    const ageDays = (now - s.moments[0].timestamp) / 86_400_000;
    if (ageDays < 3) score += 35;
    else if (ageDays < 7) score += 25;
    else if (ageDays < 14) score += 12;
  }
  if (s.editedFiles.length > 5) score += 10;
  if (s.moments.length >= 3 && s.totalImages >= 5) score += 15;
  return score;
}

function pickTopStories(stories: ImageStory[], n: number): ImageStory[] {
  const now = Date.now();
  return [...stories]
    .filter(s => s.moments.length >= 2)
    .map(s => ({ story: s, score: scoreStory(s, now) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .map(x => x.story);
}

/**
 * Rank moments: prefer sessions where user iterated (multiple image moments),
 * then recency, then productivity signals.
 */
function rankMomentsForGallery(moments: ImageMoment[]): ImageMoment[] {
  const now = Date.now();
  const bySession = new Map<string, ImageMoment[]>();
  for (const m of moments) {
    const list = bySession.get(m.sessionId) || [];
    list.push(m);
    bySession.set(m.sessionId, list);
  }

  const scored: { moment: ImageMoment; score: number }[] = [];
  for (const [, sessionMoments] of bySession) {
    const sz = sessionMoments.length;
    for (const m of sessionMoments) {
      let score = 0;
      if (sz >= 5) score += 30;
      else if (sz >= 3) score += 20;
      else if (sz >= 2) score += 10;
      const ageDays = (now - m.timestamp) / 86_400_000;
      if (ageDays < 3) score += 25;
      else if (ageDays < 7) score += 18;
      else if (ageDays < 14) score += 10;
      else if (ageDays < 30) score += 5;
      if (m.aiLoc > 50) score += 10;
      else if (m.aiLoc > 0) score += 3;
      if (m.promptExcerpt && m.promptExcerpt.length > 30) score += 3;
      scored.push({ moment: m, score });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map(x => x.moment);
}

/* ── Time-range filter ───────────────────────────────────────── */

export interface ImageTimeRange {
  /** Window length in days; 0 means "All time" (no lower bound). */
  days: number;
  label: string;
}

/** Range options shown in the toolbar. Mirrors the Output tab pattern. */
export const IMAGE_TIME_RANGES: ImageTimeRange[] = [
  { days: 7, label: 'Last 7 days' },
  { days: 28, label: 'Last 4 weeks' },
  { days: 90, label: 'Last 3 months' },
  { days: 180, label: 'Last 6 months' },
  { days: 0, label: 'All time' },
];

/** Lower-bound timestamp (ms) for a range. 0 days ("All time") returns 0. */
export function rangeStartTimestamp(days: number, now: number = Date.now()): number {
  return days <= 0 ? 0 : now - days * 86_400_000;
}

/** Keep only moments captured within the selected range. */
export function filterMomentsByRange<T extends { timestamp: number }>(
  moments: T[],
  days: number,
  now: number = Date.now(),
): T[] {
  const start = rangeStartTimestamp(days, now);
  return start === 0 ? moments : moments.filter(m => m.timestamp >= start);
}

// Selected range in days (0 = all time). Module-level so the choice persists
// across re-renders and navigation for the lifetime of the session.
let activeRangeDays = 0;

/* ── Render entry ────────────────────────────────────────────── */

const PAGE_SIZE = 30;
const IMAGE_PREFETCH_BATCH_SIZE = 8;

export async function renderImageGallery(container: HTMLElement, currentFilter: DateFilter): Promise<void> {
  renderImageGalleryLoading(container, 'Finding coding moments...', 0, 0);
  const data = await rpc<ImageGalleryData>('getImageGallery', currentFilter as Record<string, unknown>);

  if (!data || data.moments.length === 0) {
    render(html`
      <div class="page-empty">
        <div class="page-empty-icon"><svg width="48" height="48" viewBox="0 0 16 16" fill="none"><rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" stroke-width="1" opacity="0.4"/><circle cx="5.5" cy="6.5" r="1.2" stroke="currentColor" stroke-width="0.8" opacity="0.4"/><path d="M2 11l3-3 2 2 4-4 3 3" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" opacity="0.4"/></svg></div>
        <h2>No Coding Moments Yet</h2>
        <p class="text-muted">Start using screenshots and images in your AI coding sessions to see them here.</p>
      </div>`, container);
    return;
  }


  let galleryFilter = 'all';
  let storyPlayerStory: ImageStory | null = null;
  let storyPlayerFrame = 0;
  let storyTimerId: ReturnType<typeof setTimeout> | undefined;
  let visibleCount = PAGE_SIZE;

  const imageCache = new Map<string, string[]>();
  const noImageSet = new Set<string>();
  const confirmedImageSet = new Set<string>();
  const workspacesWithImages = new Set<string>();
  let isDiscoveringImages = false;

  async function loadImages(sessionId: string, requestId: string): Promise<string[]> {
    if (imageCache.has(requestId)) return imageCache.get(requestId)!;
    try {
      const result = await rpc<{ images: string[] }>('getSessionImages', { sessionId, requestId });
      const images = result?.images || [];
      imageCache.set(requestId, images);
      if (images.length === 0) noImageSet.add(requestId);
      else confirmedImageSet.add(requestId);
      return images;
    } catch {
      imageCache.set(requestId, []);
      noImageSet.add(requestId);
      return [];
    }
  }

  async function loadAndRender(el: HTMLElement, sessionId: string, requestId: string): Promise<void> {
    const images = await loadImages(sessionId, requestId);
    if (el.classList.contains('img-loaded')) return;
    el.classList.add('img-loaded');
    if (images.length > 0) {
      const img = document.createElement('img');
      img.src = images[0];
      img.className = 'img-card-img';
      img.alt = 'Screenshot';
      el.textContent = '';
      el.appendChild(img);
    }
  }

  const rankedMoments = rankMomentsForGallery(data.moments);
  const storyBySession = new Map<string, ImageStory>();
  for (const s of data.stories) storyBySession.set(s.sessionId, s);

  /** Returns stories filtered to only include moments with confirmed images */
  function getConfirmedStories(): ImageStory[] {
    const start = rangeStartTimestamp(activeRangeDays);
    return pickTopStories(data.stories, 8)
      .map(s => {
        const moments = s.moments.filter(
          m => confirmedImageSet.has(m.id) && (start === 0 || m.timestamp >= start),
        );
        return { ...s, moments, totalImages: moments.length };
      })
      .filter(s => s.moments.length >= 2)
      .slice(0, 5);
  }

  /** Moments within the active time range (workspace filter not applied). */
  let cachedRangeDays: number | null = null;
  let cachedInRange: ImageMoment[] = rankedMoments;
  function timeFilteredMoments(): ImageMoment[] {
    if (cachedRangeDays === activeRangeDays) return cachedInRange;
    cachedRangeDays = activeRangeDays;
    cachedInRange = filterMomentsByRange(rankedMoments, activeRangeDays);
    return cachedInRange;
  }

  function getFilterBase(): ImageMoment[] {
    const base = timeFilteredMoments();
    return galleryFilter === 'all'
      ? base
      : base.filter(m => m.workspace === galleryFilter);
  }

  function hasUndiscoveredImages(base: ImageMoment[]): boolean {
    return base.some(m => !confirmedImageSet.has(m.id) && !noImageSet.has(m.id));
  }

  async function discoverImagesUntil(targetCount: number, showInitialLoading = false): Promise<void> {
    if (isDiscoveringImages) return;
    isDiscoveringImages = true;
    try {
      const base = getFilterBase();
      let checked = base.filter(m => confirmedImageSet.has(m.id) || noImageSet.has(m.id)).length;
      let confirmed = base.filter(m => confirmedImageSet.has(m.id)).length;
      let cursor = 0;

      while (confirmed < targetCount) {
        const batch: ImageMoment[] = [];
        while (cursor < base.length && batch.length < IMAGE_PREFETCH_BATCH_SIZE) {
          const moment = base[cursor++];
          if (!moment || confirmedImageSet.has(moment.id) || noImageSet.has(moment.id)) continue;
          batch.push(moment);
        }

        if (batch.length === 0) break;
        if (showInitialLoading) renderImageGalleryLoading(container, 'Loading screenshots...', checked, base.length);
        await Promise.all(batch.map(m => loadImages(m.sessionId, m.id)));
        checked += batch.length;
        confirmed = base.filter(m => confirmedImageSet.has(m.id)).length;
      }
    }
    finally {
      for (const m of rankedMoments) {
        if (confirmedImageSet.has(m.id)) workspacesWithImages.add(m.workspace);
      }
      isDiscoveringImages = false;
    }
  }

  function getFiltered(): ImageMoment[] {
    return getFilterBase().filter(m => confirmedImageSet.has(m.id)).slice(0, visibleCount);
  }

  function canLoadMore(): boolean {
    const base = getFilterBase();
    const confirmedCount = base.filter(m => confirmedImageSet.has(m.id)).length;
    return confirmedCount > visibleCount || hasUndiscoveredImages(base);
  }

  function renderRangeBar(): ComponentChildren {
    const count = getFilterBase().length;
    return html`
      <div class="cons-range-bar img-range-bar" id="img-range">
        ${IMAGE_TIME_RANGES.map(r => html`
          <button class=${`cons-range-btn${activeRangeDays === r.days ? ' active' : ''}`}
                  onClick=${() => {
                    if (activeRangeDays === r.days) return;
                    activeRangeDays = r.days;
                    visibleCount = PAGE_SIZE;
                    void loadMoreAndRender(true);
                  }}>${r.label}</button>`)}
        <span class="img-range-count">${count} ${count === 1 ? 'moment' : 'moments'}</span>
      </div>`;
  }

  function rerenderPage(): void {
    const filtered = getFiltered();
    const inRange = timeFilteredMoments();
    const workspaces = [...new Set(inRange.map(m => m.workspace))];

    render(html`
      <div class="img-gallery-page">
        ${renderHeader(data)}
        ${renderRangeBar()}
        ${renderStoryReels(getConfirmedStories(), (s: ImageStory) => { openStoryPlayer(s); })}
        ${renderWorkspaceFilter(workspaces, galleryFilter, inRange, workspacesWithImages, (f: string) => { galleryFilter = f; visibleCount = PAGE_SIZE; void loadMoreAndRender(true); })}
        <div class="img-grid" id="img-grid">
          ${filtered.map(m => renderMomentCard(m, (mm: ImageMoment) => {
            const story = storyBySession.get(mm.sessionId);
            if (story) {
              const filtered = { ...story, moments: story.moments.filter(x => confirmedImageSet.has(x.id)) };
              if (filtered.moments.length >= 2) openStoryPlayer(filtered);
            }
          }))}
        </div>
        ${inRange.length === 0 ? html`
          <div class="page-empty">
            <h2>No Coding Moments In This Range</h2>
            <p class="text-muted">No screenshots were captured in the selected time range. Try a wider range.</p>
          </div>`
        : filtered.length === 0 && !canLoadMore() ? html`
          <div class="page-empty">
            <h2>No Loadable Images Found</h2>
            <p class="text-muted">These sessions referenced images, but the raw screenshots could not be loaded.</p>
          </div>` : null}
        ${canLoadMore()
          ? html`<div class="img-load-more" id="img-sentinel"><div class="loading-spinner" style="margin:20px auto;"></div></div>`
          : null}
        ${storyPlayerStory ? renderStoryPlayer(storyPlayerStory, storyPlayerFrame) : null}
      </div>`, container);

    setupLazyImages(container, loadImages, noImageSet, workspacesWithImages, rankedMoments);

    // Story player: eagerly load current frame
    if (storyPlayerStory) {
      const visual = container.querySelector<HTMLElement>('.img-story-player-visual.img-lazy:not(.img-loaded)');
      if (visual) {
        const sid = visual.dataset.sessionId || '';
        const rid = visual.dataset.requestId || '';
        if (sid && rid) void loadAndRender(visual, sid, rid);
      }
    }

    setupInfiniteScroll();
  }

  let scrollObserver: IntersectionObserver | null = null;

  function setupInfiniteScroll(): void {
    if (scrollObserver) scrollObserver.disconnect();
    const sentinel = container.querySelector('#img-sentinel');
    if (!sentinel) return;
    scrollObserver = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting && canLoadMore()) {
        visibleCount += PAGE_SIZE;
        void loadMoreAndRender();
      }
    }, { rootMargin: '300px' });
    scrollObserver.observe(sentinel);
  }

  async function loadMoreAndRender(showLoading = false): Promise<void> {
    if (showLoading) renderImageGalleryLoading(container, 'Loading screenshots...', 0, getFilterBase().length);
    await discoverImagesUntil(visibleCount, showLoading);
    rerenderPage();
  }

  function openStoryPlayer(story: ImageStory): void {
    storyPlayerStory = story;
    storyPlayerFrame = 0;
    rerenderPage();
    startStoryTimer();
  }

  function closeStoryPlayer(): void {
    if (storyTimerId) clearTimeout(storyTimerId);
    storyPlayerStory = null;
    storyPlayerFrame = 0;
    rerenderPage();
  }

  function advanceStoryFrame(delta: number): void {
    if (!storyPlayerStory) return;
    const next = storyPlayerFrame + delta;
    if (next < 0 || next >= storyPlayerStory.moments.length) {
      closeStoryPlayer();
      return;
    }
    storyPlayerFrame = next;
    if (storyTimerId) clearTimeout(storyTimerId);
    rerenderPage();
    startStoryTimer();
  }

  function startStoryTimer(): void {
    if (storyTimerId) clearTimeout(storyTimerId);
    storyTimerId = setTimeout(() => advanceStoryFrame(1), 5000);
  }

  function renderStoryPlayer(story: ImageStory, frameIdx: number): ComponentChildren {
    const moment = story.moments[frameIdx];
    if (!moment) return null;
    const hue = hashToHue(story.sessionId);

    return html`
      <div class="img-story-overlay" onClick=${(e: MouseEvent) => {
        if ((e.target as HTMLElement).classList.contains('img-story-overlay')) closeStoryPlayer();
      }}>
        <div class="img-story-player">
          <div class="img-story-progress">
            ${story.moments.map((_m, i) => html`
              <div class=${`img-story-progress-bar ${i < frameIdx ? 'done' : ''} ${i === frameIdx ? 'active' : ''}`}>
                <div class="img-story-progress-fill"></div>
              </div>
            `)}
          </div>
          <div class="img-story-player-header">
            <div class="img-story-player-avatar" style=${`background: linear-gradient(135deg, hsl(${hue}, 50%, 35%), hsl(${hue + 40}, 40%, 25%));`}></div>
            <div class="img-story-player-info">
              <span class="img-story-player-name">${shortWorkspace(story.workspace)}</span>
              <span class="img-story-player-time">${formatDate(moment.timestamp)}</span>
            </div>
            <button class="img-story-player-close" onClick=${() => closeStoryPlayer()}>\u00D7</button>
          </div>
          <div class="img-story-player-visual img-lazy" key=${moment.id} data-session-id=${moment.sessionId} data-request-id=${moment.id}
               style=${`background: linear-gradient(135deg, hsl(${hue}, 40%, 12%), hsl(${hue + 30}, 30%, 8%));`}>
            <div class="img-lazy-placeholder">
              <span class="img-lazy-spinner"></span>
            </div>
          </div>
          <div class="img-story-tap-prev" onClick=${() => advanceStoryFrame(-1)}></div>
          <div class="img-story-tap-next" onClick=${() => advanceStoryFrame(1)}></div>
          <div class="img-story-player-caption">
            <span class="img-story-player-caption-text">${moment.promptExcerpt || ''}</span>
          </div>
        </div>
      </div>`;
  }

  await discoverImagesUntil(PAGE_SIZE, true);
  rerenderPage();
}

function renderImageGalleryLoading(container: HTMLElement, label: string, checked: number, total: number): void {
  const pct = total > 0 ? Math.min(100, Math.round((checked / total) * 100)) : 0;
  render(html`
    <div class="img-gallery-page">
      <div class="img-loading-screen">
        <div class="loading-spinner"></div>
        <h2>${label}</h2>
        <p class="text-muted">Preparing screenshots for the gallery.</p>
        ${total > 0 ? html`
          <div class="progress-bar-track img-loading-progress">
            <div class="progress-bar-fill" style=${`width:${pct}%`}></div>
          </div>
          <div class="img-loading-count">${checked} / ${total} checked</div>
        ` : null}
      </div>
    </div>`, container);
}

/* ── Header ──────────────────────────────────────────────────── */

function renderHeader(_data: ImageGalleryData): ComponentChildren {
  return html`
    <div class="img-header">
      <h1>\uD83D\uDC95 Coding Moments</h1>
      <p class="img-header-slogan">Relive the screenshots that shaped your code</p>
    </div>`;
}



/* ── Story Reels ─────────────────────────────────────────────── */

function renderStoryReels(
  stories: ImageStory[],
  playStory: (s: ImageStory) => void,
): ComponentChildren {
  if (stories.length === 0) return null;
  return html`
    <div class="img-story-reels">
      ${stories.map(s => {
        const hue = hashToHue(s.sessionId);
        return html`
          <button class="img-reel-circle"
                  onClick=${() => playStory(s)}
                  title=${`${shortWorkspace(s.workspace)} - ${s.totalImages} images`}>
            <div class="img-reel-ring" style=${`--ring-hue: ${hue};`}>
              <div class="img-reel-avatar" style=${`background: linear-gradient(135deg, hsl(${hue}, 50%, 30%), hsl(${hue + 40}, 40%, 20%));`}>
                <span class="img-reel-count">${s.totalImages}</span>
              </div>
            </div>
            <span class="img-reel-label">${shortWorkspace(s.workspace)}</span>
          </button>`;
      })}
    </div>`;
}

/* ── Workspace filter ─────────────────────────────────────────── */

function renderWorkspaceFilter(
  workspaces: string[], filter: string, allMoments: ImageMoment[],
  confirmedWorkspaces: Set<string>,
  setFilter: (f: string) => void,
): ComponentChildren {
  const shown = confirmedWorkspaces.size > 0
    ? workspaces.filter(ws => confirmedWorkspaces.has(ws))
    : workspaces;
  if (shown.length <= 1) return null;
  return html`
    <div class="img-ws-filter">
      <button class=${`img-ws-pill ${filter === 'all' ? 'active' : ''}`}
              onClick=${() => setFilter('all')}>
        All <span class="img-ws-pill-count">${allMoments.length}</span>
      </button>
      ${shown.map(ws => {
        const count = allMoments.filter(m => m.workspace === ws).length;
        const hue = hashToHue(ws);
        return html`
          <button class=${`img-ws-pill ${filter === ws ? 'active' : ''}`}
                  onClick=${() => setFilter(ws)}>
            <span class="img-ws-pill-dot" style=${`background: hsl(${hue}, 55%, 50%);`}></span>
            ${shortWorkspace(ws)} <span class="img-ws-pill-count">${count}</span>
          </button>`;
      })}
    </div>`;
}

/* ── Gallery Cards ───────────────────────────────────────────── */

function renderMomentCard(m: ImageMoment, onClick: (m: ImageMoment) => void): ComponentChildren {
  const hue = hashToHue(m.id);
  return html`
    <div class="img-card" data-request-id=${m.id} tabindex="0"
         onClick=${() => onClick(m)}
         onKeyDown=${(e: KeyboardEvent) => { if (e.key === 'Enter') onClick(m); }}>
      <div class="img-card-visual img-lazy" data-session-id=${m.sessionId} data-request-id=${m.id}>
        <div class="img-lazy-placeholder" style=${`background: linear-gradient(135deg, hsl(${hue}, 55%, 18%) 0%, hsl(${hue + 40}, 45%, 12%) 100%);`}>
          <span class="img-lazy-spinner"></span>
        </div>
      </div>
      <div class="img-card-overlay">
        <span class="img-card-overlay-ws">${shortWorkspace(m.workspace)}</span>
      </div>
    </div>`;
}

/* ── Lazy image loading ─────────────────────────────────────── */

function setupLazyImages(
  container: HTMLElement,
  loadImages: (sessionId: string, requestId: string) => Promise<string[]>,
  noImageSet: Set<string>,
  workspacesWithImages: Set<string>,
  allMoments: ImageMoment[],
): void {
  const lazyEls = container.querySelectorAll('.img-lazy:not(.img-loaded)');
  if (lazyEls.length === 0) return;

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const el = entry.target as HTMLElement;
      observer.unobserve(el);
      const sessionId = el.dataset.sessionId || '';
      const requestId = el.dataset.requestId || '';
      if (!sessionId || !requestId) return;
      void loadImages(sessionId, requestId).then(images => {
        el.classList.add('img-loaded');
        if (images.length > 0) {
          const img = document.createElement('img');
          img.src = images[0];
          img.className = 'img-card-img';
          img.alt = 'Screenshot';
          img.loading = 'lazy';
          el.textContent = '';
          el.appendChild(img);
          const m = allMoments.find(mm => mm.id === requestId);
          if (m) workspacesWithImages.add(m.workspace);
        } else {
          noImageSet.add(requestId);
          const card = el.closest('.img-card');
          if (card) (card as HTMLElement).style.display = 'none';
        }
      });
    }
  }, { rootMargin: '400px' });

  for (const el of lazyEls) observer.observe(el);
}

/* ── Helpers ─────────────────────────────────────────────────── */

function shortWorkspace(ws: string): string {
  if (!ws) return 'Unknown';
  const parts = ws.replaceAll('\\', '/').split('/');
  return parts[parts.length - 1] || ws;
}

function formatDate(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const month = d.toLocaleString('en-US', { month: 'short' });
  const day = d.getDate();
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  return `${month} ${day}, ${time}`;
}

function hashToHue(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 360;
}
