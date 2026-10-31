/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Shows the host's update state in the build stamp footer: "v0.4.0 available" with Update…,
 * "Updating…", or "v0.4.0 installed" with Reload. The webview only asks the host to act; the
 * host confirms natively before installing and decides what to install. The canvas host
 * always reports `none`, so nothing appears there. */

import type { UpdateStatus } from '../core/types/rpc-types';
import { setBuildInfoStatus } from './build-info-footer';
import { rpc } from './shared';

let listening = false;

const VERSION = /^\d+\.\d+\.\d+$/;

/** Accepts only the shapes the host sends; anything else hides the status. */
export function parseUpdateStatus(value: unknown): UpdateStatus {
  if (typeof value !== 'object' || value === null) return { state: 'none' };
  const status = value as Record<string, unknown>;
  const latest = typeof status.latest === 'string' && VERSION.test(status.latest) ? status.latest : undefined;
  switch (status.state) {
    case 'available':
      if (!latest || typeof status.current !== 'string' || typeof status.publishedAt !== 'string') return { state: 'none' };
      return { state: 'available', current: status.current, latest, publishedAt: status.publishedAt, canInstall: status.canInstall === true };
    case 'updating':
      return latest ? { state: 'updating', latest } : { state: 'none' };
    case 'installed':
      return latest ? { state: 'installed', latest } : { state: 'none' };
    default:
      return { state: 'none' };
  }
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString();
}

function requestFromHost(method: 'promptUpdate' | 'reloadAfterUpdate'): void {
  void rpc(method).catch(() => { /* the host shows its own errors */ });
}

export function renderUpdateStatus(status: UpdateStatus): void {
  switch (status.state) {
    case 'available': {
      const published = formatDate(status.publishedAt);
      setBuildInfoStatus({
        text: `v${status.latest} available`,
        title: `You have v${status.current}.${published ? ` v${status.latest} was published on ${published}.` : ''}`,
        actionLabel: 'Update…',
        onAction: () => requestFromHost('promptUpdate'),
      });
      return;
    }
    case 'updating':
      setBuildInfoStatus({ text: `Updating to v${status.latest}…` });
      return;
    case 'installed':
      setBuildInfoStatus({
        text: `v${status.latest} installed`,
        title: 'Reload the window to start using the new version.',
        actionLabel: 'Reload',
        onAction: () => requestFromHost('reloadAfterUpdate'),
      });
      return;
    default:
      setBuildInfoStatus(null);
  }
}

/** Shows the current state and follows the host's `updateStatus` pushes. */
export async function initUpdateStatus(): Promise<void> {
  if (!listening) {
    listening = true;
    window.addEventListener('message', (event: MessageEvent) => {
      const data: unknown = event.data;
      if (typeof data !== 'object' || data === null) return;
      const message = data as Record<string, unknown>;
      if (message.type === 'updateStatus') renderUpdateStatus(parseUpdateStatus(message.status));
    });
  }
  try {
    renderUpdateStatus(parseUpdateStatus(await rpc<unknown>('getUpdateStatus')));
  } catch {
    // Keep the slot hidden if the host doesn't answer.
  }
}
