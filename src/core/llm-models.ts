/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscodeType from 'vscode';
import { runtimeDebug } from './runtime-debug';

/**
 * Central language-model selection for every AI feature in the extension
 * (dashboard panels, chat helpers and the rule compiler).
 *
 * The user's preferred model is read from a single source of truth — the
 * `aiEngineerCoach.preferredModel` setting — with an in-memory override that is
 * applied immediately when the model is changed at runtime (e.g. via the
 * dashboard picker). Leaving the setting empty means "auto": iterate every
 * available model, skipping any that return an empty response.
 *
 * This module has no static dependency on the `vscode` module (only a
 * type-only import, which is erased at compile time) so its pure helpers can be
 * unit-tested in a plain Node context — `require('vscode')` simply throws there
 * and `getVscode()` returns undefined.
 */

const CONFIG_SECTION = 'aiEngineerCoach';
const CONFIG_KEY = 'preferredModel';

/**
 * Generic capability tiers for Auto mode, strongest first. Matched as
 * case-insensitive prefixes against a model's family, so new point releases
 * (e.g. a future `claude-opus-4.9` or `gpt-5.6`) are picked up automatically
 * without edits. Within the same tier the higher version number wins
 * (see {@link scoreFamily}).
 *
 * This ordering is a vendor-neutral "prefer a more capable general-purpose
 * model" heuristic only. It deliberately does NOT encode any assumption about
 * which models a particular Copilot plan or organization has enabled — a model
 * that is disabled simply returns an empty response and {@link listCandidateModels}
 * transparently falls through to the next candidate.
 */
const LLM_TIER_PREFIXES = [
  'claude-opus',
  'gpt-5',
  'claude-sonnet',
  'gemini-3',
  'gpt-4o',
  'gpt-4',
  'gemini-2',
  'claude-haiku',
];

/**
 * Families that are not general-purpose chat models and so should never lead in
 * Auto mode (still selectable manually). These are utility/helper models, not a
 * judgement about any organization's enabled set. They sink below the tiers but
 * stay available as a last resort.
 */
const LLM_NON_CHAT_PREFIXES = ['copilot-utility'];

/**
 * Score a family for Auto ordering: lower is better. Tier index dominates; a
 * higher version number breaks ties within a tier (so `claude-opus-4.8` beats
 * `claude-opus-4.6`). Non-chat helper models are pushed past every tier.
 *
 * Exported for unit testing — it is a pure function of the family string.
 */
export function scoreFamily(family: string): number {
  const f = family.toLowerCase();
  const versionPenalty = (): number => {
    // Largest version number in the family => smallest penalty, in (0, 1].
    const nums = f.match(/\d+(?:\.\d+)?/g)?.map(Number) ?? [];
    const v = nums.length > 0 ? Math.max(...nums) : 0;
    return 1 / (1 + v); // higher version => smaller penalty
  };
  if (LLM_NON_CHAT_PREFIXES.some(p => f.startsWith(p))) {
    return 1000; // helper models last, but still ahead of nothing
  }
  const tier = LLM_TIER_PREFIXES.findIndex(p => f.startsWith(p));
  if (tier === -1) return 500 + versionPenalty(); // unknown family, mid-pack
  return tier * 10 + versionPenalty();
}

/**
 * Order models by Auto preference (strongest capability first) and, when a
 * preferred id/family is supplied, float the matching model to the very front.
 *
 * Exported as a pure helper for unit testing; {@link listCandidateModels} wires
 * it to the live `vscode.lm` model list.
 */
export function orderModelsByPreference<T extends { id: string; family: string }>(
  models: readonly T[],
  preferred?: string,
): T[] {
  const ordered = [...models].sort((a, b) => scoreFamily(a.family) - scoreFamily(b.family));
  if (preferred) {
    const i = ordered.findIndex(m => m.id === preferred || m.family === preferred);
    if (i > 0) {
      const [chosen] = ordered.splice(i, 1);
      ordered.unshift(chosen);
    }
  }
  return ordered;
}

/**
 * De-duplicate models by id. Copilot can return the exact same model multiple
 * times (identical id) when more than one provider/session is registered;
 * collapsing by id shows each model once while keeping distinct ids that happen
 * to share a family (e.g. an `auto` entry vs the concrete model it resolves to).
 *
 * Exported as a pure helper for unit testing.
 */
export function dedupeModelsById<T extends { id: string }>(models: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const m of models) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  return out;
}

/** Applied immediately when the user changes model at runtime; also persisted. */
let runtimeOverride: string | undefined;

function getVscode(): typeof vscodeType | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('vscode') as typeof vscodeType;
  } catch {
    return undefined;
  }
}

export interface AvailableModel {
  id: string;
  name: string;
  family: string;
  vendor: string;
}

/**
 * The preferred model id or family: the in-memory runtime override first, then
 * the `aiEngineerCoach.preferredModel` setting. Returns undefined for "auto".
 */
export function getPreferredModelId(): string | undefined {
  if (runtimeOverride && runtimeOverride.trim().length > 0) return runtimeOverride.trim();
  const vscode = getVscode();
  const v = vscode?.workspace.getConfiguration(CONFIG_SECTION).get<string>(CONFIG_KEY);
  return v && v.trim().length > 0 ? v.trim() : undefined;
}

/**
 * Set the preferred model. Updates the in-memory override (so it takes effect
 * for the next request without waiting for the settings write) and persists it
 * to the user setting so the choice applies to every AI feature and survives a
 * reload. Pass undefined/'' to restore auto-pick.
 */
export async function setPreferredModelId(id: string | undefined): Promise<void> {
  runtimeOverride = id && id.trim().length > 0 ? id.trim() : undefined;
  const vscode = getVscode();
  if (vscode) {
    try {
      await vscode.workspace
        .getConfiguration(CONFIG_SECTION)
        .update(CONFIG_KEY, runtimeOverride ?? '', vscode.ConfigurationTarget.Global);
    } catch {
      /* persisting to settings is best-effort; the runtime override still applies */
    }
  }
  runtimeDebug('llm', 'preferred-model-set', `id=${runtimeOverride ?? '(auto)'}`);
}

/** List the Copilot chat models currently available to the extension (de-duplicated). */
export async function listAvailableModels(): Promise<AvailableModel[]> {
  const vscode = getVscode();
  if (!vscode?.lm) return [];
  const all = await vscode.lm.selectChatModels({});
  return dedupeModelsById(all.map(m => ({ id: m.id, name: m.name, family: m.family, vendor: m.vendor })));
}

/**
 * Enumerate available Copilot chat models, ordered with the explicitly chosen
 * model (if any) first, then by capability tier. Some Copilot plans/orgs
 * disable specific models — a disabled model can still be *selected* but then
 * returns an empty response, so callers iterate this list and fall through to
 * the next candidate rather than relying on a single pick.
 */
export async function listCandidateModels(): Promise<vscodeType.LanguageModelChat[]> {
  const vscode = getVscode();
  if (!vscode?.lm) {
    throw new Error('No language model API available. Make sure GitHub Copilot is installed and signed in.');
  }
  const all = await vscode.lm.selectChatModels({});
  if (all.length === 0) {
    throw new Error('No language model available. Make sure GitHub Copilot is installed and signed in.');
  }
  const preferred = getPreferredModelId();
  const ordered = orderModelsByPreference(all, preferred);
  runtimeDebug('llm', 'models-available',
    `preferred=${preferred ?? '(auto)'} count=${ordered.length} ` +
    `models=${ordered.map(m => `${m.id}(${m.family})`).join(',')}`);
  return ordered;
}
