/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* GitHub Copilot model access for the dashboard: model selection, the
 * availability probe used to gate AI features, timeouts, and classification of
 * failures that retrying cannot fix. */

import * as vscode from 'vscode';
import { COPILOT_AUTO_MODEL_SELECTOR } from '../core/copilot-model';
import { runtimeDebug } from '../core/runtime-debug';

/** `selectChatModels` activates the Copilot provider; bound it so a stalled
 *  activation surfaces as an error instead of a hang. */
const MODEL_SELECT_TIMEOUT_MS = 15_000;

export const COPILOT_UNAVAILABLE_MESSAGE =
  "GitHub Copilot isn't available. Sign in to GitHub Copilot in VS Code to use AI features.";
export const LLM_OUT_OF_TIME_MESSAGE = 'GitHub Copilot did not respond in time. Try again.';

/** Failures that a retry cannot fix, keyed by `LanguageModelError.code`. */
const PERMANENT_LM_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  NoPermissions: "AI Engineer Coach isn't allowed to use GitHub Copilot. Run 'Chat: Manage Language Model Access' to allow it, then try again.",
  Blocked: 'GitHub Copilot blocked the request (rate limit or quota). Try again later.',
  NotFound: "GitHub Copilot's Auto model is no longer available. Reload the window and try again.",
};

/** Rejection raised by {@link withTimeout}. Timeouts are never retried: a hung
 *  provider or an unanswered consent dialog will not recover on a second try. */
class LlmTimeoutError extends Error {}

/** Race a promise against a timeout. Rejects with `message` on timeout. */
export function withTimeout<T>(p: PromiseLike<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new LlmTimeoutError(message)), ms);
    Promise.resolve(p).then(v => { clearTimeout(t); resolve(v); }, e => {
      clearTimeout(t);
      reject(e instanceof Error ? e : new Error(String(e)));
    });
  });
}

/**
 * Pick GitHub Copilot's Auto model, the only model source the extension uses.
 * Throws an actionable error when Copilot is unavailable (signed out, disabled)
 * or the provider does not load within `budgetMs` (capped at 15s), so a
 * caller's overall request budget also bounds model selection.
 */
export async function selectModel(budgetMs = MODEL_SELECT_TIMEOUT_MS): Promise<vscode.LanguageModelChat> {
  if (budgetMs <= 0) throw new LlmTimeoutError(LLM_OUT_OF_TIME_MESSAGE);
  const models = await withTimeout(
    vscode.lm.selectChatModels(COPILOT_AUTO_MODEL_SELECTOR),
    Math.min(MODEL_SELECT_TIMEOUT_MS, budgetMs),
    'Timed out waiting for GitHub Copilot to load. Try again in a moment.',
  );
  const model = models[0];
  if (!model) {
    runtimeDebug('panel-llm', 'model-unavailable', 'selector=copilot/auto');
    throw new Error(COPILOT_UNAVAILABLE_MESSAGE);
  }
  runtimeDebug('panel-llm', 'model-selected', `vendor=${model.vendor} id=${model.id} family=${model.family}`);
  return model;
}

/**
 * Whether GitHub Copilot's Auto model is available, used to gate AI features.
 * Only a definitive empty selection reports `false`. A slow or failing probe
 * reports `true` so features are not hidden by a transient stall; requests
 * then fail fast with an actionable message instead.
 */
export async function isCopilotModelAvailable(timeoutMs: number): Promise<boolean> {
  try {
    const models = await withTimeout(
      vscode.lm.selectChatModels(COPILOT_AUTO_MODEL_SELECTOR),
      timeoutMs,
      'GitHub Copilot model probe timed out',
    );
    return models.length > 0;
  } catch (err) {
    runtimeDebug('panel-llm', 'probe-inconclusive', err instanceof Error ? err.message : String(err));
    return true;
  }
}

/** Actionable message for a failure that retrying cannot fix, or `undefined` when a retry may help. */
export function permanentFailureMessage(err: unknown): string | undefined {
  if (err instanceof LlmTimeoutError) return err.message;
  if (err instanceof vscode.LanguageModelError) return PERMANENT_LM_ERROR_MESSAGES[err.code];
  return undefined;
}
