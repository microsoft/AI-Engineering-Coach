/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const DEFAULT_PORT = 3999;

/** Port the browser suite serves the repository on: E2E_PORT, or 3999 when unset. */
export function e2ePort(value = process.env.E2E_PORT): number {
  const text = value?.trim() ?? '';
  if (!text) return DEFAULT_PORT;
  const port = Number(text);
  if (!/^\d+$/.test(text) || port < 1 || port > 65_535) {
    throw new Error(`E2E_PORT must be a TCP port from 1 to 65535, got "${value}".`);
  }
  return port;
}

/**
 * Absolute URL of a repository path on the e2e server, for example
 * harnessUrl('tests/e2e/harness?page=curiosity'). Uses 127.0.0.1, the only address the server
 * binds, so `localhost` cannot resolve to another process listening on ::1.
 */
export function harnessUrl(path = 'tests/e2e/harness.html'): string {
  return new URL(path, `http://127.0.0.1:${e2ePort()}/`).href;
}
