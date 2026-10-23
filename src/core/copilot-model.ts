/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The single language model source for every AI feature: GitHub Copilot's Auto
 * router. Copilot routes each request to a model that is enabled for the user's
 * plan and organization, so the extension never hard-codes model families that
 * go stale or are selectable-but-disabled (#91, #278).
 *
 * Select by `id`, not `family`: Auto reports the family of the model it routes
 * to, so `{ family: 'auto' }` never matches.
 */
export const COPILOT_AUTO_MODEL_SELECTOR = { vendor: 'copilot', id: 'auto' } as const;

/** Shown by VS Code in the one-time consent dialog for language model access. */
export const COPILOT_LM_JUSTIFICATION =
  'AI Engineer Coach uses GitHub Copilot to explain anti-pattern detections, review context files, and generate skills, rules, and quizzes when you ask.';

/**
 * Upper bound for one Copilot-backed webview request on the extension host,
 * including model selection and retries. The webview's timeout for these
 * requests (`LLM_METHODS` in `src/webview/shared.ts`) must outlast it with room
 * to deliver the reply, so the user always sees the answer or the error.
 */
export const COPILOT_REQUEST_BUDGET_MS = 120_000;
