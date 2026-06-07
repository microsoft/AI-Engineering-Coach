/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * Playwright global setup for the authless webview UI suite.
 *
 * Regenerates synthetic fixtures, runs the REAL parser + analyzer, asserts the
 * analytics are well-formed, and writes the precomputed RPC responses the
 * harness serves. Throws (failing the whole run) if any pipeline assertion
 * fails, so a broken parser/analyzer is caught before the UI tests run.
 */

import * as fs from 'fs';
import * as path from 'path';
import { generateFixtures } from './lib/generate-fixtures';
import { buildPipeline, assertPipeline, buildRpcFixtures } from './lib/build-rpc-fixtures';

export default function globalSetup(): void {
  const artifacts = path.resolve(__dirname, '.artifacts');
  const home = path.join(artifacts, 'home');
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(artifacts, { recursive: true });

  const summary = generateFixtures({ home });
  const pipeline = buildPipeline(home);
  const results = assertPipeline(pipeline);
  const failed = results.filter(r => !r.ok);
  if (failed.length > 0) {
    const detail = failed.map(r => `  - ${r.label}${r.detail ? ' (' + r.detail + ')' : ''}`).join('\n');
    throw new Error(`Authless pipeline assertions failed:\n${detail}`);
  }

  const rpc = buildRpcFixtures(pipeline);
  fs.writeFileSync(path.join(artifacts, 'rpc-fixtures.json'), JSON.stringify(rpc), 'utf-8');
  fs.writeFileSync(path.join(artifacts, 'summary.json'), JSON.stringify(summary, null, 2), 'utf-8');

  // eslint-disable-next-line no-console
  console.log(`[vm] fixtures: ${summary.totalSessions} sessions, ${pipeline.result.workspaces.size} workspaces; ${Object.keys(rpc).length} RPC methods precomputed`);
}
