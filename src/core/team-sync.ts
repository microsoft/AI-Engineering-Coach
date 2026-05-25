/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { TeamModeSettings, TeamModeSyncResult } from './types';
import { normalizeTeamModeSettings } from './team-mode';
import type { TeamModeSnapshot } from './types/team-mode-types';

export interface TeamModeHttpResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export interface TeamModeTransport {
  post(url: string, body: string, headers: Record<string, string>): Promise<TeamModeHttpResponse>;
}

export function createFetchTeamModeTransport(fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)): TeamModeTransport {
  return {
    async post(url: string, body: string, headers: Record<string, string>): Promise<TeamModeHttpResponse> {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers,
        body,
      });
      return {
        ok: response.ok,
        status: response.status,
        text: async () => response.text(),
      };
    },
  };
}

export function fingerprintTeamModeSnapshot(snapshot: TeamModeSnapshot): string {
  return JSON.stringify(snapshot);
}

function createSkippedResult(): TeamModeSyncResult {
  return {
    ok: true,
    uploaded: false,
    queued: false,
    skipped: true,
  };
}

function createQueuedResult(error?: string): TeamModeSyncResult {
  return {
    ok: false,
    uploaded: false,
    queued: true,
    skipped: false,
    error,
  };
}

function createUploadedResult(): TeamModeSyncResult {
  return {
    ok: true,
    uploaded: true,
    queued: false,
    skipped: false,
  };
}

export class TeamModeSyncClient {
  private readonly queue: TeamModeSnapshot[] = [];
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private flushing = false;

  constructor(
    private readonly transport: TeamModeTransport,
    private readonly getSettings: () => TeamModeSettings,
    private readonly retryDelayMs = 5_000,
  ) {}

  pendingCount(): number {
    return this.queue.length;
  }

  async enqueue(snapshot: TeamModeSnapshot): Promise<TeamModeSyncResult> {
    const settings = normalizeTeamModeSettings(this.getSettings());
    if (!settings.enabled || !settings.serverUrl || !settings.developerId) return createSkippedResult();

    this.queue.push(snapshot);
    const result = await this.flushPending();
    if (this.queue.length > 0) this.scheduleRetry();
    return result;
  }

  async flushPending(): Promise<TeamModeSyncResult> {
    const settings = normalizeTeamModeSettings(this.getSettings());
    if (!settings.enabled || !settings.serverUrl || !settings.developerId) {
      this.queue.length = 0;
      return createSkippedResult();
    }

    if (this.flushing) {
      return this.queue.length > 0 ? createQueuedResult() : createUploadedResult();
    }

    this.flushing = true;
    try {
      while (this.queue.length > 0) {
        const snapshot = this.queue[0];
        const response = await this.transport.post(settings.serverUrl, JSON.stringify(snapshot), {
          'content-type': 'application/json',
          'x-team-developer-id': settings.developerId,
          'x-team-mode-version': String(snapshot.schemaVersion),
        });

        if (!response.ok) {
          const detail = await safeReadBody(response);
          this.scheduleRetry();
          return createQueuedResult(formatError(response.status, detail));
        }

        this.queue.shift();
      }

      this.clearRetryTimer();
      return createUploadedResult();
    } catch (error) {
      this.scheduleRetry();
      return createQueuedResult(error instanceof Error ? error.message : String(error));
    } finally {
      this.flushing = false;
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.queue.length === 0) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.flushPending();
    }, this.retryDelayMs);
  }

  private clearRetryTimer(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
  }
}

async function safeReadBody(response: TeamModeHttpResponse): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function formatError(status: number, detail: string): string {
  return detail ? `HTTP ${status}: ${detail}` : `HTTP ${status}`;
}
