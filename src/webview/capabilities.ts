/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Host capability detection.
 *
 * The dashboard runs in two hosts: the VS Code extension (full local agent, can
 * call the language model) and the Copilot app canvas (read-only data view, no
 * model access). Features that need the language model are gated on `llm`. In
 * VS Code, `llm` tracks whether GitHub Copilot's Auto model is usable and the
 * host pushes updates when that changes (e.g. after signing in to Copilot).
 *
 * Pages always render their AI controls marked `llm-only` (or `llm-fallback`
 * for the unavailable variant); the `llm-unavailable` class on the root element
 * shows or hides them through CSS. A capability change therefore never rebuilds
 * the page, so open editors, drafts, and loaded results survive it. */

import type { HostCapabilities } from '../core/types/rpc-types';
import { rpc } from './shared';

export type { HostCapabilities };

let caps: HostCapabilities = { host: 'vscode', llm: true };
let pushListenerInstalled = false;

function applyCapabilities(value: Partial<HostCapabilities>): void {
  caps = { host: value.host === 'canvas' ? 'canvas' : 'vscode', llm: value.llm !== false };
  document.documentElement.classList.toggle('llm-unavailable', !caps.llm);
}

function installPushListener(): void {
  if (pushListenerInstalled) return;
  pushListenerInstalled = true;
  window.addEventListener('message', (ev: MessageEvent) => {
    const data: unknown = ev.data;
    if (typeof data !== 'object' || data === null) return;
    const msg = data as Record<string, unknown>;
    if (msg.type !== 'capabilities') return;
    applyCapabilities({ host: msg.host === 'canvas' ? 'canvas' : 'vscode', llm: msg.llm !== false });
  });
}

export async function loadCapabilities(): Promise<void> {
  installPushListener();
  try {
    const result = await rpc<Partial<HostCapabilities>>('getCapabilities');
    if (result && typeof result === 'object') applyCapabilities(result);
  } catch {
    /* keep the default full-capability profile */
  }
}

export function capabilities(): HostCapabilities {
  return caps;
}

export function llmAvailable(): boolean {
  return caps.llm;
}

/** Short note shown next to greyed-out, language-model-dependent features. */
export function llmUnavailableNote(): string {
  return caps.host === 'canvas'
    ? 'Open in VS Code with the local Copilot agent to use this.'
    : 'Sign in to GitHub Copilot in VS Code to use this.';
}
