/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Context limits of the models VS Code chat requests were sent to. VS Code logs the selected model
 * (`inputState.selectedModel`) with its prompt-token limit rather than a limit per request: the configured
 * context size (`modelConfiguration.contextSize`), else that setting's default, else the model's maximum input
 * tokens. A session file is a log of patches, so each request takes the limit selected when it was added.
 * Only model ids and numbers are kept. */

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

/** Collects the limits while a session file is replayed, then answers for the requests of the final state. */
export class SelectedModelLimits {
  private readonly byModel = new Map<string, number>();
  private readonly byRequest = new Map<string, { modelId: string; limit: number }>();
  private current: { identifier: string; limit: number } | null = null;

  /** The session's `inputState.selectedModel` after it changed. */
  select(selected: unknown): void {
    this.current = selectedModelLimit(selected);
    if (this.current) this.byModel.set(this.current.identifier, this.current.limit);
  }

  /** Requests added to the session: each new one takes the limit of its model as selected now. */
  stamp(requests: unknown): void {
    if (!Array.isArray(requests)) return;
    for (const request of requests) {
      if (!isRecord(request) || typeof request.requestId !== 'string' || this.byRequest.has(request.requestId)) continue;
      const modelId = typeof request.modelId === 'string' && request.modelId ? request.modelId : this.current?.identifier;
      if (!modelId) continue;
      const limit = this.current && modelId === this.current.identifier ? this.current.limit : this.byModel.get(modelId);
      if (limit != null) this.byRequest.set(request.requestId, { modelId, limit });
    }
  }

  /** A request's limit: the one stamped when it was added to the session, else the latest limit of its model.
   *  `null` for Auto or an unknown model. */
  limitFor(requestId: unknown, modelId: unknown): number | null {
    if (typeof modelId !== 'string' || !modelId || isAutoModel(modelId)) return null;
    const stamped = typeof requestId === 'string' ? this.byRequest.get(requestId) : undefined;
    if (stamped && stamped.modelId === modelId) return stamped.limit;
    return this.byModel.get(modelId) ?? null;
  }
}
