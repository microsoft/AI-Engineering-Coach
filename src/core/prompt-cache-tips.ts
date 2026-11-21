/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Prompt-cache coaching, mapped to the "Preserve the cache" section of GitHub's guide. Tips fire only for
 * causes you can change, with enough data, and quote the cache lifetimes your logs show rather than the
 * guide's general figures. Harness-driven causes are explained in the tab, not coached. */

import type { CacheAttribution, CacheCauseKey, CacheCauseSummary, CacheCost } from './types';
import { CACHE_TIP_MIN_BREAKS, CACHE_TIP_MIN_MAIN_CALLS, CACHE_TIP_MIN_REBUILT_PCT } from './constants';

const GUIDE = 'GitHub\u2019s \u201cPreserve the cache\u201d guidance (docs.github.com/en/copilot/tutorials/optimize-ai-usage)';
const MISS_COST_TIP_PCT = 25;

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return n >= 1_000 ? `${Math.round(n / 1_000)}K` : String(Math.round(n));
}

function formatTtl(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600} hour${seconds === 3600 ? '' : 's'}`;
  return seconds % 60 === 0 ? `${seconds / 60} minutes` : `${seconds} seconds`;
}

function times(n: number): string {
  return n === 1 ? 'once' : `${n} times`;
}

/** "5 minutes for claude-opus-5.5 and 30 minutes for gpt-6.1-sol", from the logged lifetimes. */
export function describeLifetimes(attribution: CacheAttribution): string | null {
  const byTtl = new Map<number, string[]>();
  for (const entry of attribution.idle.ttlByModel) {
    const models = byTtl.get(entry.ttlSeconds) ?? [];
    if (models.length < 3) models.push(entry.model);
    byTtl.set(entry.ttlSeconds, models);
  }
  if (byTtl.size === 0) return null;
  return [...byTtl]
    .sort((a, b) => a[0] - b[0])
    .map(([ttl, models]) => `${formatTtl(ttl)} for ${models.join(', ')}`)
    .join(' and ');
}

function share(cause: CacheCauseSummary): string {
  const cost = cause.costPct == null ? '' : `, about ${Math.round(cause.costPct)}% of your input cost`;
  return `${Math.round(cause.pctOfRebuilt)}% of rebuilt tokens${cost}`;
}

type TipBuilder = (cause: CacheCauseSummary, attribution: CacheAttribution) => string;

const TIPS: Partial<Record<CacheCauseKey, TipBuilder>> = {
  'ttl-user': (cause, attribution) => {
    const lifetimes = describeLifetimes(attribution);
    const ttl = lifetimes ? ` ${attribution.label} logged a cache lifetime of ${lifetimes}.` : '';
    return `${cause.breaks} times you came back after the prompt cache had expired, and ${formatTokens(cause.rebuiltTokens)} tokens of context were rebuilt (${share(cause)}).${ttl} After a break, start a new session or run /compact before you continue, so a short summary is rebuilt instead of the whole conversation. See ${GUIDE}.`;
  },
  'ttl-agent': cause => `${cause.breaks} cache expiries happened while the agent waited on long-running tools or background agents (${share(cause)}). When the agent continued, it rebuilt the context it had cached. This is the cost of long waits, not something you did.`,
  resume: cause => `Resuming earlier sessions rebuilt their context ${times(cause.breaks)} (${share(cause)}). When you don't need the earlier conversation, start a new session instead of resuming an old one. See ${GUIDE}.`,
  'model-switch': cause => `Switching models mid-session broke the cache ${times(cause.breaks)} (${share(cause)}): a model can't reuse another model's cache. Pick a model, or automatic model selection, when you start and keep it for the session; run work that needs a different model in a subagent. See ${GUIDE}.`,
  'reasoning-effort': cause => `Changing the reasoning effort mid-session broke the cache ${times(cause.breaks)} (${share(cause)}). Set it before you start and leave it unchanged for the session. See ${GUIDE}.`,
  'tools-changed': cause => `The set of tools sent to the model changed mid-session ${times(cause.breaks)} (${share(cause)}), for example when MCP servers were turned on or off. Enable the tools and MCP servers you need before you start, and leave them unchanged for the session. See ${GUIDE}.`,
  'instructions-changed': cause => `Your instruction files or memories changed mid-session ${times(cause.breaks)} (${share(cause)}), so the system prompt and everything after it were rebuilt. Edit instruction files between sessions when you can.`,
};

function qualifies(cause: CacheCauseSummary): boolean {
  return cause.breaks >= CACHE_TIP_MIN_BREAKS && cause.pctOfRebuilt >= CACHE_TIP_MIN_REBUILT_PCT;
}

/** Coaching tips for the Prompt Cache tab, most rebuilt tokens first. */
export function promptCacheTips(attribution: CacheAttribution | null, cost: CacheCost | null): string[] {
  if (!attribution || attribution.mainCalls < CACHE_TIP_MIN_MAIN_CALLS) return [];
  const tips: string[] = [];
  const missPct = attribution.misses > 0 && cost ? cost.missCostPct : null;
  if (missPct != null && missPct >= MISS_COST_TIP_PCT) {
    const rebuilt = attribution.origins.find(origin => origin.origin === 'rebuilt');
    const rebuiltCost = rebuilt?.costPct == null ? '' : ` Context rebuilt after cache breaks alone is about ${Math.round(rebuilt.costPct)}%.`;
    tips.push(`Prompt tokens that missed the cache cost about ${Math.round(missPct)}% of your ${attribution.label} input cost, because cache reads are billed at a small fraction of the input price while cache writes and uncached tokens are not.${rebuiltCost} The causes below show which of those you can avoid.`);
  }
  for (const cause of attribution.causes) {
    const build = TIPS[cause.key];
    if (build && qualifies(cause)) tips.push(build(cause, attribution));
  }
  return tips;
}
