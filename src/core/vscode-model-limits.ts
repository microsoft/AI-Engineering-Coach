/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Context limits of the models VS Code chat requests were sent to. VS Code logs the selected model
 * (`inputState.selectedModel`) with its prompt-token limit rather than a limit per request: the configured
 * context size (`modelConfiguration.contextSize`), else that setting's default, else the model's maximum input
 * tokens. A session file is a log of patches, so each request takes the limit selected when it was added. VS Code can
 * save a request just before the model change it was sent with, so a selection logged before the next request also
 * counts; a model selected only after later requests doesn't. Only model ids and numbers are kept. */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/** Auto picks a model for each request, so the limit logged for Auto isn't the one a request ran with. */
function isAutoModel(identifier: string): boolean {
  return /(?:^|\/)auto$/i.test(identifier);
}

/** The prompt-token limit VS Code applies for a selected model; `null` for Auto or when none is logged. */
export function selectedModelLimit(selected: unknown): { identifier: string; limit: number } | null {
  if (!isRecord(selected) || typeof selected.identifier !== 'string' || !selected.identifier) return null;
  if (isAutoModel(selected.identifier)) return null;
  const metadata = isRecord(selected.metadata) ? selected.metadata : {};
  const configuration = isRecord(selected.modelConfiguration) ? selected.modelConfiguration : {};
  const schema = isRecord(metadata.configurationSchema) && isRecord(metadata.configurationSchema.properties)
    ? metadata.configurationSchema.properties
    : {};
  const setting = isRecord(schema.contextSize) ? schema.contextSize : {};
  const configured = positive(configuration.contextSize) ?? positive(setting.default);
  const maxInput = positive(metadata.maxInputTokens);
  const limit = configured != null && maxInput != null ? Math.min(configured, maxInput) : configured ?? maxInput;
  return limit == null ? null : { identifier: selected.identifier, limit: Math.round(limit) };
}

/** A model a request may have been sent with, and that model's limit. */
interface Candidate { modelId: string; limit: number }

/** What is known about a request's model when it was added, best first. */
interface RequestCandidates {
  /** The selection when the request was added, if the request has no model id yet or matches it. */
  current: Candidate | null;
  /** Selections logged after the request but before the next request was added: VS Code can save a request just
   *  before the model change it was sent with. */
  following: Candidate[];
  /** The last limit logged for the request's model before it was added, when another model was selected. */
  earlier: Candidate | null;
}

/** Collects the limits while a session file is replayed, then answers for the requests of the final state. */
export class SelectedModelLimits {
  private readonly byModel = new Map<string, number>();
  private readonly byRequest = new Map<string, RequestCandidates>();
  /** Requests added since the previous request, which can still take a following selection. */
  private open: RequestCandidates[] = [];
  private current: Candidate | null = null;

  /** The session's `inputState` after it changed. */
  select(selected: unknown): void {
    const limit = selectedModelLimit(selected);
    this.current = limit ? { modelId: limit.identifier, limit: limit.limit } : null;
    if (!this.current) return;
    this.byModel.set(this.current.modelId, this.current.limit);
    for (const request of this.open) {
      const last = request.following.at(-1);
      if (!last || last.modelId !== this.current.modelId || last.limit !== this.current.limit) request.following.push(this.current);
    }
  }

  /** Requests added to the session: each new one is matched with what is known about its model now. */
  stamp(requests: unknown): void {
    if (!Array.isArray(requests)) return;
    let added = false;
    for (const request of requests) {
      if (!isRecord(request) || typeof request.requestId !== 'string' || this.byRequest.has(request.requestId)) continue;
      if (!added) {
        this.open = [];
        added = true;
      }
      const modelId = typeof request.modelId === 'string' && request.modelId ? request.modelId : null;
      const onCurrent = this.current && (modelId === null || modelId === this.current.modelId) ? this.current : null;
      const known = !onCurrent && modelId !== null ? this.byModel.get(modelId) : undefined;
      const candidates: RequestCandidates = {
        current: onCurrent,
        following: [],
        earlier: known != null && modelId !== null ? { modelId, limit: known } : null,
      };
      this.byRequest.set(request.requestId, candidates);
      this.open.push(candidates);
    }
  }

  /** A request's limit, from the selections around the time it was added to the session; `null` for Auto, an
   *  unknown model, or a model only selected later. */
  limitFor(requestId: unknown, modelId: unknown): number | null {
    if (typeof modelId !== 'string' || !modelId || isAutoModel(modelId)) return null;
    const candidates = typeof requestId === 'string' ? this.byRequest.get(requestId) : undefined;
    if (!candidates) return null;
    const match = [candidates.current, ...candidates.following, candidates.earlier].find(c => c?.modelId === modelId);
    return match ? match.limit : null;
  }
}