/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Achievement System -- Roadmap-style achievement page for AI Engineers */

import { DateFilter, DailyActivity } from '../core/types';
import { rpc, rpcAllSettled, formatNum, COLORS, vscode, PROGRESS_ALMOST, PROGRESS_STARTED } from './shared';
import { html, render, LoadingScreen, type ComponentChildren } from './render';
import { SVG } from './svg-icons';

/* ── Types ────────────────────────────────────────────────────────── */

type Tier = 'bronze' | 'silver' | 'gold' | 'diamond';

interface Achievement {
  id: string;
  title: string;
  description: string;
  icon: ComponentChildren;
  category: 'volume' | 'consistency' | 'diversity' | 'humor' | 'mastery';
  tier: Tier;
  xp: number;
  evaluate: (stats: AchievementStats) => { progress: number; label: string; unlocked: boolean };
}

interface AchievementStats {
  totalRequests: number;
  totalAiLoc: number;
  totalSessions: number;
  totalDays: number;
  maxStreak: number;
  uniqueLanguages: number;
  uniqueModels: number;
  uniqueTools: number;
  weekendRequests: number;
  lateNightRequests: number;
  avgSessionRequests: number;
  totalUserLoc: number;
  cancelRate: number;
  topLanguage: string;
  oldTechCount: number;
  hourlyPeak: number;
  /** Historical daily data for date estimation */
  dailyLabels: string[];
  dailyCumulativeLoc: number[];
  dailyCumulativeReqs: number[];
  dailyCumulativeSessions: number[];
}

interface AchievementState {
  unlockDates: Record<string, number>;
}

function getAchState(): AchievementState {
  const s = vscode.getState() as Record<string, unknown> | null;
  const as = (s?.achievementState ?? {}) as Partial<AchievementState>;
  return { unlockDates: as.unlockDates ?? {} };
}

function saveAchState(state: AchievementState): void {
  const s = (vscode.getState() as Record<string, unknown>) ?? {};
  vscode.setState({ ...s, achievementState: state });
}

/* ── Constants ────────────────────────────────────────────────────── */

const LINUX_KERNEL_LOC = 27_800_000;

const TIER_LABELS: Record<Tier, string> = {
  bronze: 'Bronze', silver: 'Silver', gold: 'Gold', diamond: 'Diamond',
};
const TIER_COLORS: Record<Tier, string> = {
  bronze: '#cd7f32', silver: '#8b949e', gold: '#d29922', diamond: '#58a6ff',
};
const CATEGORY_LABELS: Record<string, string> = {
  volume: 'Volume', consistency: 'Consistency', diversity: 'Diversity',
  humor: 'Fun & Quirky', mastery: 'Mastery',
};
const CATEGORY_ICONS: Record<string, ComponentChildren> = {
  volume: SVG.layers, consistency: SVG.repeat, diversity: SVG.compass,
  humor: SVG.confetti, mastery: SVG.shieldCheck,
};

/* ── Achievement Helpers ──────────────────────────────────────────── */

function thresholdEval(
  field: keyof AchievementStats,
  target: number,
  labelFn: (value: number, target: number) => string,
): Achievement['evaluate'] {
  return (s) => {
    const value = s[field] as number;
    const pct = Math.min(100, (value / target) * 100);
    return { progress: pct, label: labelFn(value, target), unlocked: pct >= 100 };
  };
}

/* ── Achievement Definitions ─────────────────────────────────────── */

const ACHIEVEMENTS: Achievement[] = [
  // Volume
  {
    id: 'linux-kernel-1x', title: 'Kernel Hacker', icon: SVG.penguin,
    tier: 'gold', xp: 50, category: 'volume',
    description: `Generated one Linux kernel worth of AI code (${formatNum(LINUX_KERNEL_LOC)} LoC)`,
    evaluate: thresholdEval('totalAiLoc', LINUX_KERNEL_LOC, (v, t) => `${formatNum(v)} / ${formatNum(t)} LoC`),
  },
  {
    id: 'linux-kernel-5x', title: 'Linus v2', icon: SVG.fire,
    tier: 'diamond', xp: 100, category: 'volume',
    description: 'Generated 5x Linux kernels worth of AI code',
    evaluate: thresholdEval('totalAiLoc', LINUX_KERNEL_LOC * 5, (v) => `${(v / LINUX_KERNEL_LOC).toFixed(1)}x kernels`),
  },
  {
    id: 'thousand-sessions', title: 'Session Marathoner', icon: SVG.runner,
    tier: 'silver', xp: 25, category: 'volume',
    description: 'Started 1,000 coding agent sessions',
    evaluate: thresholdEval('totalSessions', 1000, (v) => `${formatNum(v)} / 1,000`),
  },
  {
    id: 'ten-k-requests', title: '10K Club', icon: SVG.chat,
    tier: 'bronze', xp: 15, category: 'volume',
    description: 'Sent 10,000 requests to AI agents',
    evaluate: thresholdEval('totalRequests', 10_000, (v) => `${formatNum(v)} / 10K`),
  },
  {
    id: 'hundred-k-requests', title: 'The Machine', icon: SVG.robot,
    tier: 'gold', xp: 50, category: 'volume',
    description: 'Sent 100,000 requests to AI agents',
    evaluate: thresholdEval('totalRequests', 100_000, (v) => `${formatNum(v)} / 100K`),
  },

  // Consistency
  {
    id: 'streak-7', title: 'Week Warrior', icon: SVG.flexBicep,
    tier: 'bronze', xp: 10, category: 'consistency',
    description: '7-day coding streak with AI',
    evaluate: thresholdEval('maxStreak', 7, (v) => `${v} / 7 days`),
  },
  {
    id: 'streak-30', title: 'Monthly Machine', icon: SVG.fire,
    tier: 'silver', xp: 30, category: 'consistency',
    description: '30-day coding streak with AI',
    evaluate: thresholdEval('maxStreak', 30, (v) => `${v} / 30 days`),
  },
  {
    id: 'streak-100', title: 'Centurion', icon: SVG.crown,
    tier: 'diamond', xp: 75, category: 'consistency',
    description: '100-day coding streak with AI',
    evaluate: thresholdEval('maxStreak', 100, (v) => `${v} / 100 days`),
  },

  // Diversity
  {
    id: 'polyglot', title: 'Polyglot', icon: SVG.globe,
    tier: 'silver', xp: 25, category: 'diversity',
    description: 'Used AI with 10+ programming languages',
    evaluate: thresholdEval('uniqueLanguages', 10, (v) => `${v} / 10 languages`),
  },
  {
    id: 'model-explorer', title: 'Model Explorer', icon: SVG.microscope,
    tier: 'silver', xp: 20, category: 'diversity',
    description: 'Used 5+ different AI models',
    evaluate: thresholdEval('uniqueModels', 5, (v) => `${v} / 5 models`),
  },

  // Mastery
  {
    id: 'tool-master', title: 'Toolsmith', icon: SVG.wrench,
    tier: 'gold', xp: 40, category: 'mastery',
    description: 'Used 20+ different AI tools',
    evaluate: thresholdEval('uniqueTools', 20, (v) => `${v} / 20 tools`),
  },
  {
    id: 'patient-one', title: 'The Patient One', icon: SVG.meditation,
    tier: 'gold', xp: 40, category: 'mastery',
    description: 'Cancel rate below 5% over 1000+ requests',
    evaluate: (s) => {
      if (s.totalRequests < 1000) return { progress: Math.min(100, (s.totalRequests / 1000) * 100), label: `${formatNum(s.totalRequests)}/1K needed`, unlocked: false };
      const pct = s.cancelRate < 5 ? 100 : Math.max(0, 100 - (s.cancelRate - 5) * 20);
      return { progress: pct, label: `${s.cancelRate.toFixed(1)}% cancel rate`, unlocked: s.cancelRate < 5 };
    },
  },
  {
    id: 'pair-programmer', title: 'True Pair Programmer', icon: SVG.handshake,
    tier: 'silver', xp: 25, category: 'mastery',
    description: 'Average 20+ requests per session',
    evaluate: thresholdEval('avgSessionRequests', 20, (v) => `${v.toFixed(1)} avg reqs/session`),
  },

  // Humor / Fun
  {
    id: 'dinosaur', title: 'Digital Dinosaur', icon: SVG.dinosaur,
    tier: 'silver', xp: 20, category: 'humor',
    description: 'Used AI with legacy tech (COBOL, Fortran, jQuery...)',
    evaluate: (s) => {
      const pct = s.oldTechCount > 0 ? 100 : 0;
      return { progress: pct, label: s.oldTechCount > 0 ? `${s.oldTechCount} legacy sessions` : 'No legacy tech', unlocked: pct >= 100 };
    },
  },
  {
    id: 'night-owl', title: 'Night Owl', icon: SVG.owl,
    tier: 'bronze', xp: 15, category: 'humor',
    description: '500+ requests between midnight and 5am',
    evaluate: thresholdEval('lateNightRequests', 500, (v) => `${v} / 500`),
  },
  {
    id: 'weekend-warrior', title: 'Weekend Warrior', icon: SVG.beach,
    tier: 'bronze', xp: 15, category: 'humor',
    description: '1,000+ requests on weekends',
    evaluate: thresholdEval('weekendRequests', 1000, (v) => `${formatNum(v)} / 1,000`),
  },
  {
    id: 'speed-demon', title: 'Speed Demon', icon: SVG.bolt,
    tier: 'silver', xp: 20, category: 'humor',
    description: 'Peak hour with 50+ requests',
    evaluate: thresholdEval('hourlyPeak', 50, (v) => `${v} / 50 peak/hr`),
  },
];

const LEGACY_TECH = new Set([
  'cobol', 'fortran', 'perl', 'basic', 'vb6', 'visualbasic', 'pascal', 'delphi',
  'assembly', 'asm', 'ada', 'mumps', 'rpg', 'clipper', 'foxpro', 'tcl', 'awk',
]);
const LEGACY_KEYWORDS = ['jquery', 'backbone', 'knockout', 'extjs', 'prototype.js', 'mootools', 'coffeescript'];

/* ── Helpers ──────────────────────────────────────────────────────── */

function formatDate(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86400000);
  if (diffDays === 0) return 'today';
  if (diffDays === 1) return 'yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
}

/** Estimate when an achievement was unlocked by walking cumulative daily data. */
function estimateUnlockDate(id: string, stats: AchievementStats): number | null {
  const locThresholds: Record<string, number> = {
    'linux-kernel-1x': LINUX_KERNEL_LOC,
    'linux-kernel-5x': LINUX_KERNEL_LOC * 5,
  };
  const requestThresholds: Record<string, number> = {
    'ten-k-requests': 10000,
    'hundred-k-requests': 100000,
  };
  const sessionThresholds: Record<string, number> = {
    'thousand-sessions': 1000,
  };
  const streakThresholds: Record<string, number> = {
    'streak-7': 7,
    'streak-30': 30,
    'streak-100': 100,
  };
  const gradualAchievements = new Set([
    'polyglot', 'model-explorer', 'tool-master',
    'night-owl', 'weekend-warrior', 'speed-demon',
    'patient-one', 'pair-programmer', 'dinosaur',
  ]);

  if (id in locThresholds) return findThresholdDate(stats.dailyLabels, stats.dailyCumulativeLoc, locThresholds[id]);
  if (id in requestThresholds) return findThresholdDate(stats.dailyLabels, stats.dailyCumulativeReqs, requestThresholds[id]);
  if (id in sessionThresholds) return findThresholdDate(stats.dailyLabels, stats.dailyCumulativeSessions, sessionThresholds[id]);
  if (id in streakThresholds) return findStreakDate(stats.dailyLabels, streakThresholds[id]);
  if (!gradualAchievements.has(id) || stats.dailyLabels.length === 0) return null;
  const idx = Math.floor(stats.dailyLabels.length * 0.75);
  return new Date(stats.dailyLabels[Math.min(idx, stats.dailyLabels.length - 1)] + 'T12:00:00').getTime();
}

function findStreakDate(labels: string[], target: number): number | null {
  if (labels.length === 0) return null;
  let streak = 1;
  for (let i = 1; i < labels.length; i++) {
    const prev = new Date(labels[i - 1]);
    const curr = new Date(labels[i]);
    const diffDays = Math.round((curr.getTime() - prev.getTime()) / 86400000);
    if (diffDays === 1) {
      streak++;
      if (streak >= target) {
        return new Date(labels[i] + 'T12:00:00').getTime();
      }
    } else {
      streak = 1;
    }
  }
  return null;
}

function findThresholdDate(labels: string[], cumulative: number[], threshold: number): number | null {
  for (let i = 0; i < cumulative.length; i++) {
    if (cumulative[i] >= threshold) {
      return new Date(labels[i] + 'T12:00:00').getTime();
    }
  }
  return null;
}

type EvaluatedAchievement = Achievement & {
  result: { progress: number; label: string; unlocked: boolean };
  unlockedAt: number | null;
};

function buildDailyCumulative(labels: string[], loc: number[], reqs: number[], sessions: number[]): Pick<AchievementStats, 'dailyLabels' | 'dailyCumulativeLoc' | 'dailyCumulativeReqs' | 'dailyCumulativeSessions'> {
  const dailyCumulativeLoc: number[] = [];
  const dailyCumulativeReqs: number[] = [];
  const dailyCumulativeSessions: number[] = [];
  let cumLoc = 0;
  let cumReqs = 0;
  let cumSess = 0;
  for (let i = 0; i < labels.length; i++) {
    cumLoc += loc[i] ?? 0;
    cumReqs += reqs[i] ?? 0;
    cumSess += sessions[i] ?? 0;
    dailyCumulativeLoc.push(cumLoc);
    dailyCumulativeReqs.push(cumReqs);
    dailyCumulativeSessions.push(cumSess);
  }
  return { dailyLabels: labels, dailyCumulativeLoc, dailyCumulativeReqs, dailyCumulativeSessions };
}

function evaluateAchievements(stats: AchievementStats): { evaluated: EvaluatedAchievement[]; unlocked: EvaluatedAchievement[]; locked: EvaluatedAchievement[] } {
  const achState = getAchState();
  const now = Date.now();
  const evaluated: EvaluatedAchievement[] = ACHIEVEMENTS.map(ach => {
    const result = ach.evaluate(stats);
    if (result.unlocked && !achState.unlockDates[ach.id]) {
      achState.unlockDates[ach.id] = estimateUnlockDate(ach.id, stats) ?? now;
    }
    return { ...ach, result, unlockedAt: achState.unlockDates[ach.id] ?? null };
  });
  saveAchState(achState);
  return {
    evaluated,
    unlocked: evaluated.filter(a => a.result.unlocked),
    locked: evaluated.filter(a => !a.result.unlocked).sort((a, b) => b.result.progress - a.result.progress),
  };
}

function renderAchievementPage(
  container: HTMLElement,
  achievementStats: AchievementStats,
  evaluated: EvaluatedAchievement[],
  unlocked: EvaluatedAchievement[],
  locked: EvaluatedAchievement[],
): void {
  const totalXP = unlocked.reduce((sum, a) => sum + a.xp, 0);
  const maxXP = evaluated.reduce((sum, a) => sum + a.xp, 0);
  const kernelCount = achievementStats.totalAiLoc / LINUX_KERNEL_LOC;
  const completePct = (unlocked.length / evaluated.length * 100);
  const recentUnlock = unlocked.length > 0
    ? [...unlocked].sort((a, b) => (b.unlockedAt ?? 0) - (a.unlockedAt ?? 0))[0]
    : null;
  const tierCounts: Record<Tier, { unlocked: number; total: number }> = {
    bronze: { unlocked: 0, total: 0 }, silver: { unlocked: 0, total: 0 },
    gold: { unlocked: 0, total: 0 }, diamond: { unlocked: 0, total: 0 },
  };
  for (const a of evaluated) {
    tierCounts[a.tier].total++;
    if (a.result.unlocked) tierCounts[a.tier].unlocked++;
  }
  const categories: (keyof typeof CATEGORY_LABELS)[] = ['volume', 'consistency', 'diversity', 'mastery', 'humor'];
  const roadmapSections = categories.map(cat => {
    const catAchs = evaluated.filter(a => a.category === cat);
    const catUnlocked = catAchs.filter(a => a.result.unlocked).length;
    return { cat, label: CATEGORY_LABELS[cat], icon: CATEGORY_ICONS[cat], achievements: catAchs, unlocked: catUnlocked, total: catAchs.length };
  });

  render(html`
    <div class="ach-page">
      <div class="ach-hero">
        <div class="ach-hero-left">
          <div class="ach-hero-icon">${SVG.trophy}</div>
          <div class="ach-hero-info">
            <h2 class="ach-hero-title">AI Engineer Roadmap</h2>
            <p class="ach-hero-sub">Your journey to mastering AI-assisted development</p>
          </div>
        </div>
        <div class="ach-hero-score">
          <div class="ach-hero-gs-value">${totalXP}</div>
          <div class="ach-hero-gs-label">/ ${maxXP} XP</div>
        </div>
      </div>
      <div class="ach-xp-bar">
        <div class="ach-xp-fill" style=${'width:' + completePct.toFixed(1) + '%'}></div>
        <div class="ach-xp-text">
          <span>${unlocked.length} / ${evaluated.length} Unlocked</span>
          <span>${completePct.toFixed(0)}%</span>
        </div>
      </div>
      <div class="ach-stat-row">
        <div class="ach-stat-tile"><div class="ach-stat-icon">${SVG.penguin}</div><div class="ach-stat-val">${kernelCount.toFixed(2)}x</div><div class="ach-stat-lbl">Linux Kernels</div></div>
        <div class="ach-stat-tile"><div class="ach-stat-icon">${SVG.code}</div><div class="ach-stat-val">${formatNum(achievementStats.totalAiLoc)}</div><div class="ach-stat-lbl">AI Lines of Code</div></div>
        <div class="ach-stat-tile"><div class="ach-stat-icon">${SVG.calendar}</div><div class="ach-stat-val">${achievementStats.maxStreak}d</div><div class="ach-stat-lbl">Longest Streak</div></div>
        <div class="ach-stat-tile"><div class="ach-stat-icon">${SVG.zap}</div><div class="ach-stat-val">${achievementStats.hourlyPeak}</div><div class="ach-stat-lbl">Peak Reqs/Hr</div></div>
      </div>
      <div class="ach-rarity-row">
        ${(['bronze', 'silver', 'gold', 'diamond'] as Tier[]).map(t => html`
          <div class="ach-rarity-chip" style=${'--rarity-color:' + TIER_COLORS[t]}>
            <span class="ach-rarity-dot"></span>
            <span class="ach-rarity-name">${TIER_LABELS[t]}</span>
            <span class="ach-rarity-count">${tierCounts[t].unlocked}/${tierCounts[t].total}</span>
          </div>`)}
      </div>
      ${recentUnlock && html`
      <div class="ach-showcase">
        <div class="ach-showcase-badge">Latest Unlock</div>
        <div class="ach-showcase-inner">
          <div class="ach-showcase-icon" style=${'--rarity-color:' + TIER_COLORS[recentUnlock.tier]}>${recentUnlock.icon}</div>
          <div class="ach-showcase-info">
            <div class="ach-showcase-top">
              <span class="ach-showcase-title">${recentUnlock.title}</span>
              <span class="ach-rarity-tag" style=${'--rarity-color:' + TIER_COLORS[recentUnlock.tier]}>${TIER_LABELS[recentUnlock.tier]}</span>
              <span class="ach-gs-tag">${recentUnlock.xp} XP</span>
            </div>
            <div class="ach-showcase-desc">${recentUnlock.description}</div>
            <div class="ach-showcase-date">${SVG.clock} Unlocked ${recentUnlock.unlockedAt ? formatDate(recentUnlock.unlockedAt) : 'just now'}</div>
          </div>
          <button class="ach-share-btn" data-ach-id=${recentUnlock.id} title="Share">${SVG.share}</button>
        </div>
      </div>`}
      <div class="ach-roadmap" id="ach-roadmap">
        ${roadmapSections.map((section, si) => html`
          <div class="ach-roadmap-section">
            <div class="ach-roadmap-header">
              <div class="ach-roadmap-header-left">
                <span class="ach-roadmap-icon">${section.icon}</span>
                <h3 class="ach-roadmap-title">${section.label}</h3>
              </div>
              <span class="ach-roadmap-count">${section.unlocked}/${section.total}</span>
            </div>
            <div class="ach-roadmap-track">
              ${section.achievements.map((ach, ai) => {
                const tierColor = TIER_COLORS[ach.tier];
                const done = ach.result.unlocked;
                const isLast = ai === section.achievements.length - 1;
                return html`
                <div class=${'ach-roadmap-node' + (done ? ' ach-node-done' : '')} data-category=${ach.category}>
                  ${!isLast && html`<div class="ach-roadmap-connector" style=${'--progress-pct:' + (done ? 100 : ach.result.progress) + '%'}></div>`}
                  <div class="ach-roadmap-dot" style=${'--tier-color:' + tierColor}>${ach.icon}</div>
                  <div class="ach-roadmap-info">
                    <div class="ach-roadmap-info-top">
                      <span class="ach-roadmap-name">${ach.title}</span>
                      <span class="ach-tier-tag" style=${'--tier-color:' + tierColor}>${TIER_LABELS[ach.tier]}</span>
                      <span class="ach-xp-tag">${ach.xp} XP</span>
                    </div>
                    <div class="ach-roadmap-desc">${ach.description}</div>
                    <div class="ach-roadmap-bar-wrap">
                      <div class="ach-roadmap-bar">
                        <div class="ach-roadmap-bar-fill" style=${'width:' + ach.result.progress + '%;background:' + (done ? COLORS.green : ach.result.progress >= PROGRESS_ALMOST ? COLORS.yellow : ach.result.progress >= PROGRESS_STARTED ? COLORS.blue : 'var(--border)')}></div>
                      </div>
                      <span class="ach-roadmap-bar-label">${ach.result.label}</span>
                    </div>
                    ${done && ach.unlockedAt && html`<div class="ach-roadmap-date">${SVG.clock} ${formatDate(ach.unlockedAt)}</div>`}
                  </div>
                  ${done ? html`<button class="ach-share-btn" data-ach-id=${ach.id} title="Copy to clipboard">${SVG.share}</button>` : html`<div class="ach-roadmap-lock">${SVG.lock}</div>`}
                </div>`;
              })}
            </div>
          </div>
          ${si < roadmapSections.length - 1 && html`<div class="ach-roadmap-divider"></div>`}`)}
      </div>
      <div class="ach-tabs" id="ach-tabs">
        <button class="ach-tab ach-tab-active" data-cat="all">All (${evaluated.length})</button>
        ${categories.map(cat => {
          const catAll = evaluated.filter(a => a.category === cat);
          const catUnlocked = catAll.filter(a => a.result.unlocked);
          return html`<button class="ach-tab" data-cat=${cat}>${CATEGORY_ICONS[cat]} ${CATEGORY_LABELS[cat]} (${catUnlocked.length}/${catAll.length})</button>`;
        })}
      </div>
      <div class="ach-list" id="ach-list">${renderAchList(unlocked, locked)}</div>
    </div>
  `, container);
}

/* ── Render ───────────────────────────────────────────────────────── */

async function getAchievementConsumption(filter: DateFilter): Promise<{ modelTotals: Record<string, number> }> {
  try {
    return await rpc<{ modelTotals: Record<string, number> }>('getConsumption', filter as Record<string, unknown>);
  } catch (error) {
    if (error instanceof Error && error.message === 'Token reporting is temporarily disabled') {
      return { modelTotals: {} };
    }
    throw error;
  }
}

export async function renderAchievements(container: HTMLElement, filter: DateFilter): Promise<void> {
  render(html`<${LoadingScreen} message="Computing achievements..." />`, container);

  const [stats, production, balance, antiPatterns, hourly] = await rpcAllSettled([
    rpc<{ totalSessions: number; totalRequests: number; totalWorkspaces: number }>('getStats',  filter as Record<string, unknown>),
    rpc<{ summary: { totalAiLoc: number; totalUserLoc: number } }>('getCodeProduction',  filter as Record<string, unknown>),
    rpc<{ maxStreak: number; weekendReqs: number; timeDistribution: { lateNight: number } } | null>('getWorkLifeBalance',  filter as Record<string, unknown>),
    rpc<{ totalOccurrences: number }>('getAntiPatterns',  filter as Record<string, unknown>),
    rpc<{ hours: number[] }>('getHourlyDistribution',  filter as Record<string, unknown>),
  ] as const, [
    { totalSessions: 0, totalRequests: 0, totalWorkspaces: 0 },
    { summary: { totalAiLoc: 0, totalUserLoc: 0 } },
    null,
    { totalOccurrences: 0 },
    { hours: [] },
  ] as const);

  const sessions = await rpc<{ total: number; sessions: { sessionId: string; requestCount: number; firstMessage: string }[] }>('getSessions', { page: 1, pageSize: 100, filter: filter as Record<string, unknown> });
  const dailyActivity = await rpc<DailyActivity>('getDailyActivity',  filter as Record<string, unknown>);
  const allSessions = await rpc<{ total: number }>('getSessions', { page: 1, pageSize: 1, filter: filter as Record<string, unknown> });
  const codeByLang = await rpc<{ byLanguage: { labels: string[] } }>('getCodeProduction',  filter as Record<string, unknown>);
  const consumption = await getAchievementConsumption(filter);
  const workflows = await rpc<{ clusters: { id: string }[] }>('getWorkflowOptimization',  filter as Record<string, unknown>);

  const avgReqsPerSession = allSessions.total > 0 ? stats.totalRequests / allSessions.total : 0;
  const cancelRate = antiPatterns.totalOccurrences > 0 ? (antiPatterns.totalOccurrences / stats.totalRequests) * 100 : 0;

  const languages = codeByLang.byLanguage.labels.map(l => l.toLowerCase());
  let oldTechCount = 0;
  for (const lang of languages) {
    if (LEGACY_TECH.has(lang)) oldTechCount++;
  }
  for (const sess of sessions.sessions) {
    const msg = sess.firstMessage?.toLowerCase() ?? '';
    for (const kw of LEGACY_KEYWORDS) {
      if (msg.includes(kw)) {
        oldTechCount++;
        break;
      }
    }
  }

  const achievementStats: AchievementStats = {
    totalRequests: stats.totalRequests,
    totalAiLoc: production.summary.totalAiLoc,
    totalSessions: allSessions.total,
    totalDays: dailyActivity.labels.length,
    maxStreak: balance?.maxStreak ?? 0,
    uniqueLanguages: codeByLang.byLanguage.labels.length,
    uniqueModels: Object.keys(consumption.modelTotals).length,
    uniqueTools: workflows.clusters.length,
    weekendRequests: balance?.weekendReqs ?? 0,
    lateNightRequests: balance?.timeDistribution.lateNight ?? 0,
    avgSessionRequests: avgReqsPerSession,
    totalUserLoc: production.summary.totalUserLoc,
    cancelRate,
    topLanguage: codeByLang.byLanguage.labels[0] ?? 'Unknown',
    oldTechCount,
    hourlyPeak: Math.max(...(hourly.hours ?? [0])),
    ...buildDailyCumulative(dailyActivity.labels, dailyActivity.loc, dailyActivity.values, dailyActivity.sessions),
  };

  const { evaluated, unlocked, locked } = evaluateAchievements(achievementStats);
  renderAchievementPage(container, achievementStats, evaluated, unlocked, locked);

  // Wire tab switching
  const tabs = container.querySelectorAll<HTMLButtonElement>('.ach-tab');
  const list = container.querySelector('#ach-list')!;
  for (const tab of tabs) {
    tab.addEventListener('click', () => {
      for (const t of tabs) t.classList.remove('ach-tab-active');
      tab.classList.add('ach-tab-active');
      const cat = tab.dataset.cat;
      const filtered = cat === 'all' ? evaluated : evaluated.filter(a => a.category === cat);
      const fUnlocked = filtered.filter(a => a.result.unlocked);
      const fLocked = filtered.filter(a => !a.result.unlocked).sort((a, b) => b.result.progress - a.result.progress);
      render(renderAchList(fUnlocked, fLocked), list as HTMLElement);
      wireShareButtons(container);
    });
  }

  wireShareButtons(container);
}

function wireShareButtons(container: HTMLElement): void {
  for (const btn of container.querySelectorAll<HTMLButtonElement>('.ach-share-btn')) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const achId = btn.dataset.achId;
      const ach = ACHIEVEMENTS.find(a => a.id === achId);
      if (!ach) return;
      const text = `I unlocked "${ach.title}" in AI Engineer Coach! ${ach.description}`;
      void navigator.clipboard.writeText(text).then(() => {
        render(html`${SVG.checkCircle}`, btn);
        btn.classList.add('ach-share-copied');
        setTimeout(() => { render(html`${SVG.share}`, btn); btn.classList.remove('ach-share-copied'); }, 2000);
      });
    });
  }
}

function renderAchList(unlocked: EvaluatedAchievement[], locked: EvaluatedAchievement[]) {
  return html`
    ${unlocked.map(a => achievementRow(a, true))}
    ${locked.length > 0 && html`<div class="ach-locked-divider"><span class="ach-locked-label">${SVG.lock} Locked (${locked.length})</span></div>`}
    ${locked.map(a => achievementRow(a, false))}
  `;
}

function achievementRow(ach: EvaluatedAchievement, unlocked: boolean) {
  const tierColor = TIER_COLORS[ach.tier];
  const pColor = unlocked ? COLORS.green : ach.result.progress >= PROGRESS_ALMOST ? COLORS.yellow : ach.result.progress >= PROGRESS_STARTED ? COLORS.blue : 'var(--border)';

  return html`
    <div class=${'ach-row ' + (unlocked ? 'ach-row-unlocked' : 'ach-row-locked')} data-category=${ach.category}>
      <div class=${'ach-row-icon' + (unlocked ? '' : ' ach-row-icon-dim')} style=${'--rarity-color:' + tierColor}>
        ${ach.icon}
      </div>
      <div class="ach-row-body">
        <div class="ach-row-top">
          <span class="ach-row-title">${ach.title}</span>
          <span class="ach-rarity-tag" style=${'--rarity-color:' + tierColor}>${TIER_LABELS[ach.tier]}</span>
          <span class="ach-gs-tag">${ach.xp} XP</span>
        </div>
        <div class="ach-row-desc">${ach.description}</div>
        <div class="ach-row-progress">
          <div class="ach-row-bar">
            <div class="ach-row-bar-fill" style=${'width:' + ach.result.progress + '%;background:' + pColor}></div>
          </div>
          <span class="ach-row-bar-label">${ach.result.label}</span>
        </div>
        ${unlocked && ach.unlockedAt && html`<div class="ach-row-date">${SVG.clock} ${formatDate(ach.unlockedAt)}</div>`}
      </div>
      ${unlocked ? html`<button class="ach-share-btn" data-ach-id=${ach.id} title="Copy to clipboard">${SVG.share}</button>` : html`<div class="ach-row-lock">${SVG.lock}</div>`}
    </div>`;
}
