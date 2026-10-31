/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Labels, colors and explanations for the Prompt Cache tab. */

import type { CacheBreakCause, CacheCauseKey, CacheControl, CacheMissOrigin } from '../core/types';
import { COLORS, formatNum } from './shared';

export const GUIDE_URL = 'https://docs.github.com/en/copilot/tutorials/optimize-ai-usage#4-preserve-the-cache';

export const TOKEN_META = {
  cacheRead: { label: 'Read from cache', color: COLORS.green, help: 'Prompt tokens the model reused from its cache. They are billed at a small fraction of the input price.' },
  cacheWrite: { label: 'Written to cache', color: COLORS.orange, help: 'Prompt tokens sent and stored in the cache for the next call: new context, or context rebuilt after the cache broke.' },
  uncached: { label: 'Uncached', color: COLORS.muted, help: 'Prompt tokens neither read from nor written to the cache.' },
} as const;

export const CAUSE_META: Record<CacheCauseKey, { label: string; short: string; color: string; help: string; action: string }> = {
  'ttl-user': {
    label: 'Came back after the cache expired', short: 'Expired', color: COLORS.red,
    help: 'You sent a prompt after the previous call\u2019s cache lifetime had passed, so the cached context was gone and had to be sent again.',
    action: 'After a break, start a new session or run /compact first, so a short summary is rebuilt instead of the whole conversation.',
  },
  'ttl-agent': {
    label: 'Cache expired while the agent waited', short: 'Expired (wait)', color: COLORS.orange,
    help: 'The agent continued after a long-running tool or background agent outlasted the cache lifetime. Long waits sometimes can\u2019t be avoided; this shows what they cost.',
    action: 'Nothing you did. Expect a rebuild after waits longer than the cache lifetime.',
  },
  resume: {
    label: 'Resumed an earlier session', short: 'Resumed', color: COLORS.purple,
    help: 'The session was resumed, and its context had to be sent again. Resuming usually also refreshes parts of the system prompt.',
    action: 'When you don\u2019t need the earlier conversation, start a new session instead of resuming an old one.',
  },
  'model-switch': {
    label: 'Switched model', short: 'Model', color: COLORS.pink,
    help: 'A model can\u2019t reuse another model\u2019s cache, so the next call rebuilt the whole context.',
    action: 'Pick a model, or automatic model selection, when you start and keep it for the session. Run work that needs another model in a subagent.',
  },
  'model-auto': {
    label: 'Automatic model selection switched model', short: 'Auto model', color: COLORS.muted,
    help: 'Automatic model selection picked a different model, which can\u2019t reuse the previous model\u2019s cache.',
    action: 'Nothing to change: automatic model selection made this switch.',
  },
  'reasoning-effort': {
    label: 'Changed reasoning effort', short: 'Effort', color: COLORS.yellow,
    help: 'The reasoning effort changed mid-session, which invalidates the cache.',
    action: 'Set the reasoning effort before you start and leave it unchanged for the session.',
  },
  'tools-changed': {
    label: 'Tool set changed', short: 'Tools', color: COLORS.cyan,
    help: 'The tools sent to the model changed, for example when MCP servers were turned on or off or tools were loaded on demand. Tool definitions sit near the start of the prompt, so most of it was rebuilt.',
    action: 'Enable the tools and MCP servers you need before you start, and leave them unchanged for the session.',
  },
  'instructions-changed': {
    label: 'Instructions or memory changed', short: 'Instructions', color: COLORS.blue,
    help: 'Your instruction files or stored memories changed mid-session, so the system prompt and everything after it were rebuilt.',
    action: 'Edit instruction files between sessions when you can.',
  },
  'system-prompt': {
    label: 'System prompt updated by the harness', short: 'System', color: '#6e7681',
    help: 'Parts of the system prompt the harness maintains changed, such as workspace or environment context.',
    action: 'Nothing to change: the harness updates these parts.',
  },
  compaction: {
    label: 'Compaction', short: 'Compaction', color: COLORS.green,
    help: 'Compaction replaced the conversation with a summary, so the cache was rebuilt from the summary. This is expected and usually small.',
    action: 'Expected. Compacting at a natural breakpoint keeps the rebuilt summary small.',
  },
  'mode-change': {
    label: 'Switched mode', short: 'Mode', color: COLORS.purple,
    help: 'The session switched mode (for example plan or autopilot) just before the cache broke.',
    action: 'Where you can, pick the mode at the start of the session.',
  },
  unattributed: {
    label: 'No logged cause', short: 'Unknown', color: '#6e7681',
    help: 'The cache broke, but nothing logged around this call explains why.',
    action: 'Nothing to act on.',
  },
};

/** Lower-case names for the "also" list of a break. */
export const CAUSE_NAMES: Record<CacheBreakCause, string> = {
  compaction: 'compaction',
  'model-switch': 'model switch',
  'ttl-expired': 'cache expired',
  'reasoning-effort': 'reasoning effort changed',
  'tools-changed': 'tool set changed',
  'system-prompt': 'system prompt changed',
  'mode-change': 'mode switched',
  resume: 'session resumed',
};

export const CONTROL_META: Record<CacheControl, { label: string; help: string }> = {
  you: { label: 'You', help: 'You can avoid this cause.' },
  partly: { label: 'Partly', help: 'Partly in your hands, partly the harness or the work itself.' },
  harness: { label: 'Harness', help: 'The harness does this; there is nothing to change.' },
  unknown: { label: 'Unknown', help: 'No cause was logged.' },
};

export const ORIGIN_META: Record<CacheMissOrigin, { label: string; color: string; help: string }> = {
  growth: { label: 'New context', color: COLORS.blue, help: 'Tokens added since the previous call, such as your prompts, replies and tool results. Expected.' },
  rebuilt: { label: 'Rebuilt after a break', color: COLORS.red, help: 'Context the cache had held but had to be sent again after the cache broke. See the causes for why.' },
  subagents: { label: 'Subagents', color: COLORS.purple, help: 'Subagents build their own context, separate from the main agent\u2019s cache.' },
  compaction: { label: 'Compaction summaries', color: COLORS.yellow, help: 'Model calls that wrote compaction summaries.' },
  'cold-start': { label: 'Session start', color: COLORS.cyan, help: 'The first call of each session, when nothing is cached yet.' },
};

export function pctText(pct: number | null | undefined): string {
  if (pct == null) return '\u2014';
  return pct >= 10 || pct === 0 ? `${Math.round(pct)}%` : `${pct.toFixed(1)}%`;
}

/** "1 break", "12 breaks". */
export function countText(n: number, singular: string, plural = `${singular}s`): string {
  return `${formatNum(n)} ${n === 1 ? singular : plural}`;
}

export function durationText(seconds: number | null): string {
  if (seconds == null) return '\u2014';
  if (seconds < 90) return `${Math.round(seconds)} s`;
  if (seconds < 5_400) return `${Math.round(seconds / 60)} min`;
  if (seconds < 172_800) return `${Math.round(seconds / 3_600)} h`;
  return `${Math.round(seconds / 86_400)} d`;
}

export function shortHarness(harness: string): string {
  return harness.replace(/^GitHub /, '');
}
