/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FullConfig } from '@playwright/test';
import { e2ePort, harnessUrl } from './harness-url';

// Everything the specs load from the server. Each served copy must match this checkout byte for
// byte, so a server from another checkout fails the run instead of being tested.
const SERVED_FILES = ['tests/e2e/harness.html', 'dist/webview/app.js', 'dist/webview/styles.css'];

const digest = (data: Uint8Array) => createHash('sha256').update(data).digest('hex').slice(0, 12);

async function localDigest(root: string, file: string): Promise<string> {
  try {
    return digest(await readFile(path.join(root, file)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`${file} is missing. Run npm run build before the e2e tests.`);
    throw error;
  }
}

async function servedDigest(file: string): Promise<string> {
  try {
    const response = await fetch(harnessUrl(file));
    return response.ok ? digest(new Uint8Array(await response.arrayBuffer())) : `HTTP ${response.status}`;
  } catch (error) {
    return `unreachable (${String((error as { cause?: unknown }).cause ?? error)})`;
  }
}

export default async function verifyServedBuild(config: FullConfig): Promise<void> {
  const configDir = path.dirname(config.configFile ?? path.join(process.cwd(), 'playwright.config.ts'));
  const root = path.resolve(configDir, config.webServer?.cwd ?? '.');
  const mismatches: string[] = [];
  for (const file of SERVED_FILES) {
    const [local, served] = await Promise.all([localDigest(root, file), servedDigest(file)]);
    if (served !== local) mismatches.push(`  ${file}: served ${served}, local ${local}`);
  }
  if (mismatches.length) {
    throw new Error([
      `The server on port ${e2ePort()} is not serving this checkout (${root}):`,
      ...mismatches,
      'Another checkout is probably serving that port. Stop it, or pick a free port with E2E_PORT=<port>.',
    ].join('\n'));
  }
}
