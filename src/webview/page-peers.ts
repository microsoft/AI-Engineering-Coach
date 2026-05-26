/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Share Card -- Generate a personalized stats image to share with peers */

import { DateFilter } from '../core/types';
import { rpc, formatNum } from './shared';
import { html, render, LoadingScreen } from './render';
import { SVG } from './svg-icons';

const REPO_URL = 'https://github.com/microsoft/AI-Engineering-Coach';

/* ── Share Context ─────────────────────────────────────────────────── */

interface ShareContext {
  totalSessions: number;
  totalRequests: number;
  currentStreak: number;
  bestStreak: number;
  flowScore: number;
  antiPatternCount: number;
  topLanguages: string[];
  activeDays: number;
  totalLoc: number;
}

/* ── Social Share URLs ────────────────────────────────────────────── */

function getShareText(data: ShareContext): string {
  return `My AI coding stats: ${formatNum(data.totalLoc)} lines of code, ${data.currentStreak}-day streak, Flow Score ${data.flowScore}. Track yours with AI Engineer Coach 👇\n\n${REPO_URL}`;
}

function getTwitterShareUrl(data: ShareContext): string {
  const text = getShareText(data);
  return `https://x.com/intent/tweet?text=${encodeURIComponent(text)}`;
}

function getLinkedInShareUrl(data: ShareContext): string {
  const text = `My AI coding stats:\n🔥 ${data.currentStreak}-day streak\n💻 ${formatNum(data.totalLoc)} AI lines of code\n⚡ Flow Score ${data.flowScore}\n\nTrack yours → ${REPO_URL}\n\n#AI #CodingStats #GitHub #Copilot`;
  return `https://www.linkedin.com/feed/?shareActive=true&text=${encodeURIComponent(text)}`;
}

function getRedditShareUrl(data: ShareContext): string {
  const title = `My AI coding stats: ${formatNum(data.totalLoc)} lines, ${data.currentStreak}-day streak (AI Engineer Coach)`;
  return `https://www.reddit.com/submit?url=${encodeURIComponent(REPO_URL)}&title=${encodeURIComponent(title)}`;
}

function getHNShareUrl(): string {
  return `https://news.ycombinator.com/submitlink?u=${encodeURIComponent(REPO_URL)}&t=${encodeURIComponent('AI Engineer Coach - Local analytics for AI coding sessions')}`;
}

/* ── Canvas Card Renderer ─────────────────────────────────────────── */

interface CardData {
  totalLoc: number;
  totalSessions: number;
  totalRequests: number;
  currentStreak: number;
  bestStreak: number;
  flowScore: number;
  topLanguages: string[];
  activeDays: number;
  firstDay: string;
  antiPatternCount: number;
  dailyQuality: { labels: string[]; values: number[] };
}

function drawShareCard(canvas: HTMLCanvasElement, data: CardData): void {
  const W = 600;
  const H = 280;
  canvas.width = W * 2;
  canvas.height = H * 2;
  canvas.style.width = `${W}px`;
  canvas.style.height = `${H}px`;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(2, 2);

  // Background
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#0d1117');
  bg.addColorStop(1, '#161b22');
  ctx.fillStyle = bg;
  roundRect(ctx, 0, 0, W, H, 16);
  ctx.fill();

  // Border
  ctx.strokeStyle = '#30363d';
  ctx.lineWidth = 1;
  roundRect(ctx, 0.5, 0.5, W - 1, H - 1, 16);
  ctx.stroke();

  // Accent bar
  const accent = ctx.createLinearGradient(0, 0, W, 0);
  accent.addColorStop(0, '#58a6ff');
  accent.addColorStop(0.5, '#3fb950');
  accent.addColorStop(1, '#bc8cff');
  ctx.fillStyle = accent;
  ctx.fillRect(24, 0, W - 48, 4);

  // Title
  ctx.fillStyle = '#e6edf3';
  ctx.font = 'bold 20px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.fillText('Agentic Engineering Stats', 28, 36);

  // Streak badge (if >= 7 days)
  if (data.currentStreak >= 7) {
    const titleW = ctx.measureText('Agentic Engineering Stats').width;
    const streakText = `\u{1F525} ${data.currentStreak}d`;
    const streakColor = data.currentStreak >= 100 ? '#ff4500' : data.currentStreak >= 30 ? '#f85149' : '#d29922';
    ctx.fillStyle = streakColor + '20';
    const stw = ctx.measureText(streakText).width + 12;
    roundRect(ctx, 28 + titleW + 10, 22, stw, 20, 10);
    ctx.fill();
    ctx.fillStyle = streakColor;
    ctx.font = 'bold 12px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillText(streakText, 28 + titleW + 16, 36);
  }

  // Subtitle
  ctx.fillStyle = '#8b949e';
  ctx.font = '12px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.fillText(`Since ${data.firstDay} \u00b7 ${data.activeDays} active days`, 28, 56);

  // Stats grid — 2 rows x 3 cols (no duplicate streak)
  const stats = [
    { label: 'AI Lines of Code', value: formatNum(data.totalLoc), color: '#3fb950' },
    { label: 'Sessions', value: formatNum(data.totalSessions), color: '#e6edf3' },
    { label: 'Flow Score', value: String(data.flowScore), color: '#58a6ff' },
    { label: 'Requests', value: formatNum(data.totalRequests), color: '#bc8cff' },
    { label: 'Best Streak', value: `${data.bestStreak}d`, color: '#d29922' },
    { label: 'Active Days', value: String(data.activeDays), color: '#8b949e' },
  ];

  const colW = (W - 56) / 3;
  const rowH = 56;
  const startY = 72;

  for (const [i, s] of stats.entries()) {
    const col = i % 3;
    const row = Math.floor(i / 3);
    const x = 28 + col * colW;
    const y = startY + row * rowH;

    ctx.fillStyle = s.color;
    ctx.font = 'bold 26px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillText(s.value, x, y + 22);

    ctx.fillStyle = '#8b949e';
    ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillText(s.label, x, y + 38);
  }

  // Languages
  const langY = startY + 2 * rowH + 8;
  ctx.fillStyle = '#8b949e';
  ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.fillText('Top Languages', 28, langY + 14);

  let pillX = 126;
  const langColors = ['#58a6ff', '#3fb950', '#d29922', '#bc8cff', '#f85149'];
  for (const [i, lang] of data.topLanguages.slice(0, 5).entries()) {
    const tw = ctx.measureText(lang).width + 14;
    ctx.fillStyle = langColors[i % langColors.length] + '22';
    roundRect(ctx, pillX, langY + 2, tw, 20, 10);
    ctx.fill();
    ctx.fillStyle = langColors[i % langColors.length];
    ctx.font = 'bold 10px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillText(lang, pillX + 7, langY + 15);
    pillX += tw + 5;
  }

  // Footer
  ctx.fillStyle = '#484f58';
  ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.fillText('ai-engineer-coach', 28, H - 14);

  const dateStr = new Date().toISOString().slice(0, 10);
  const dateW = ctx.measureText(dateStr).width;
  ctx.fillText(dateStr, W - 28 - dateW, H - 14);

  // Repo URL centered
  ctx.fillStyle = '#58a6ff';
  ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
  const repoShort = 'github.com/microsoft/AI-Engineering-Coach';
  const repoW = ctx.measureText(repoShort).width;
  ctx.fillText(repoShort, (W - repoW) / 2, H - 14);
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/* ── Current Streak (Fixed) ───────────────────────────────────────── */

function computeCurrentStreak(labels: string[], values: number[]): number {
  if (labels.length === 0 || values.length === 0) return 0;

  const toUtcDay = (label: string): number => {
    const [year, month, day] = label.split('-').map(Number);
    return Date.UTC(year, month - 1, day);
  };

  const today = new Date();
  const todayUtcDay = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const lastActivityUtcDay = toUtcDay(labels[labels.length - 1]);
  const gapFromToday = Math.round((todayUtcDay - lastActivityUtcDay) / 86400000);
  if (gapFromToday > 1) return 0;

  // Walk backwards from today, only count consecutive CALENDAR days with activity
  let streak = 0;
  for (let i = labels.length - 1; i >= 0; i--) {
    if (values[i] <= 0) break;
    // Check calendar day consecutiveness
    if (i < labels.length - 1) {
      const curr = toUtcDay(labels[i]);
      const next = toUtcDay(labels[i + 1]);
      const gap = Math.round((next - curr) / 86400000);
      if (gap !== 1) break;
    }
    streak++;
  }
  return streak;
}

/* ── Main Render ──────────────────────────────────────────────────── */

export async function renderShareCard(container: HTMLElement, filter: DateFilter): Promise<void> {
  render(html`<${LoadingScreen} message="Generating share card..." />`, container);

  const [stats, production, balance, flowState, codeByLang, dailyActivity, antiPatterns] = await Promise.all([
    rpc<{ totalSessions: number; totalRequests: number }>('getStats', filter as Record<string, unknown>),
    rpc<{ summary: { totalAiLoc: number } }>('getCodeProduction', filter as Record<string, unknown>),
    rpc<{ maxStreak: number } | null>('getWorkLifeBalance', filter as Record<string, unknown>),
    rpc<{ overallFlowScore: number }>('getFlowState', filter as Record<string, unknown>),
    rpc<{ byLanguage: { labels: string[] } }>('getCodeProduction', filter as Record<string, unknown>),
    rpc<{ labels: string[]; values: number[] }>('getDailyActivity', filter as Record<string, unknown>),
    rpc<{ patterns: { id: string }[] }>('getAntiPatterns', filter as Record<string, unknown>),
  ]);

  // Fixed: compute current streak using calendar-day consecutiveness
  const currentStreak = computeCurrentStreak(dailyActivity.labels, dailyActivity.values);
  const bestStreak = balance?.maxStreak ?? 0;

  const activeDays = dailyActivity.values.filter(v => v > 0).length;
  const firstDay = dailyActivity.labels[0] ?? 'Unknown';
  const antiPatternCount = antiPatterns?.patterns?.length ?? 0;

  // Deduplicate languages (e.g., "py" and "python")
  const langDedup = deduplicateLanguages(codeByLang.byLanguage.labels);

  const cardData: CardData = {
    totalLoc: production.summary.totalAiLoc,
    totalSessions: stats.totalSessions,
    totalRequests: stats.totalRequests,
    currentStreak,
    bestStreak: Math.max(bestStreak, currentStreak),
    flowScore: flowState.overallFlowScore,
    topLanguages: langDedup.slice(0, 5),
    activeDays,
    firstDay,
    antiPatternCount,
    dailyQuality: { labels: [], values: [] },
  };

  const shareCtx: ShareContext = {
    ...cardData,
    antiPatternCount,
  };

  render(html`
    <div class="share-page">
      <div class="share-card-wrap">
        <canvas id="share-card-canvas"></canvas>
      </div>

      <div class="share-actions">
        <button class="btn btn-primary" id="share-download-btn">${SVG.share} Download PNG</button>
        <button class="btn btn-secondary" id="share-copy-btn">${SVG.clipboard} Copy</button>
        <button class="btn btn-secondary" id="share-export-summary-btn">${SVG.share} Export Summary</button>
      </div>

      <div class="share-social">
        <button class="btn-social btn-social-x" id="share-x">𝕏 Post</button>
        <button class="btn-social btn-social-linkedin" id="share-linkedin">in LinkedIn</button>
        <button class="btn-social btn-social-reddit" id="share-reddit">Reddit</button>
        <button class="btn-social btn-social-hn" id="share-hn">Y Hacker News</button>
      </div>

      <div class="share-hint" id="share-toast" style="display:none"></div>
    </div>
  `, container);

  // Draw the card
  const canvas = document.getElementById('share-card-canvas') as HTMLCanvasElement;
  drawShareCard(canvas, cardData);

  // Download handler
  document.getElementById('share-download-btn')?.addEventListener('click', () => {
    if (!canvas) return;
    const link = document.createElement('a');
    link.download = `agentic-engineering-stats-${new Date().toISOString().slice(0, 10)}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
    showToast('Downloaded! Now share it.');
  });

  // Copy to clipboard handler
  document.getElementById('share-copy-btn')?.addEventListener('click', () => {
    void (async () => {
      if (!canvas) return;
      try {
        const blob = await new Promise<Blob>((resolve) => {
          canvas.toBlob(b => resolve(b!), 'image/png');
        });
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        showToast('Copied! Paste it anywhere.');
      } catch {
        showToast('Copy failed — try downloading instead');
      }
    })();
  });

  document.getElementById('share-export-summary-btn')?.addEventListener('click', () => {
    void (async () => {
      try {
        const result = await rpc<{ ok: boolean; cancelled?: boolean }>('exportSummary', { filter });
        if (result.cancelled) return;
        showToast(result.ok ? 'Summary exported.' : 'Export cancelled.');
      } catch {
        showToast('Export failed.');
      }
    })();
  });

  // Social share handlers — use rpc to open externally (window.open doesn't work in webviews)
  const openUrl = (url: string) => {
    void rpc('openExternal', { url }).catch(() => {
      showToast('Unable to open link right now.');
    });
  };
  document.getElementById('share-x')?.addEventListener('click', () => openUrl(getTwitterShareUrl(shareCtx)));
  document.getElementById('share-linkedin')?.addEventListener('click', () => {
    // Copy image to clipboard first so user can paste it in LinkedIn
    void (async () => {
      try {
        const blob = await new Promise<Blob>((resolve) => {
          canvas.toBlob(b => resolve(b!), 'image/png');
        });
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        showToast('Image copied! Paste it in your LinkedIn post.');
      } catch { /* ignore clipboard errors */ }
      openUrl(getLinkedInShareUrl(shareCtx));
    })();
  });
  document.getElementById('share-reddit')?.addEventListener('click', () => openUrl(getRedditShareUrl(shareCtx)));
  document.getElementById('share-hn')?.addEventListener('click', () => openUrl(getHNShareUrl()));
}

/* ── Language Deduplication ────────────────────────────────────────── */

function deduplicateLanguages(langs: string[]): string[] {
  const aliases: Record<string, string> = {
    py: 'python',
    ts: 'typescript',
    js: 'javascript',
    rb: 'ruby',
    rs: 'rust',
    cs: 'csharp',
    sh: 'shell',
    bash: 'shell',
    zsh: 'shell',
    yml: 'yaml',
  };
  const seen = new Set<string>();
  const result: string[] = [];
  for (const lang of langs) {
    const normalized = aliases[lang.toLowerCase()] ?? lang.toLowerCase();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(lang);
    }
  }
  return result;
}

function showToast(msg: string): void {
  const el = document.getElementById('share-toast');
  if (!el) return;
  el.textContent = msg;
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 2500);
}
