/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * Authless pipeline verifier (CLI).
 *
 *   npx tsx tests/vm/lib/run-pipeline.ts
 *
 * 1. Generates synthetic fixtures into tests/vm/.artifacts/home
 * 2. Runs the real parser + analyzer over them
 * 3. Asserts the analytics are well-formed
 * 4. Writes tests/vm/.artifacts/rpc-fixtures.json (consumed by the webview harness)
 *
 * Exits non-zero on any failed assertion. No login or network required.
 */

import * as fs from 'fs';
import * as path from 'path';
import { generateFixtures } from './generate-fixtures';
import { buildPipeline, assertPipeline, buildRpcFixtures } from './build-rpc-fixtures';

function main(): number {
  const artifacts = path.resolve(__dirname, '..', '.artifacts');
  const home = path.join(artifacts, 'home');
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(artifacts, { recursive: true });

  console.log('=== AI Engineer Coach — authless pipeline verifier ===\n');
  console.log(`Generating fixtures into ${home} ...`);
  const summary = generateFixtures({ home });
  console.log(
    `  claude=${summary.claudeSessions} codex=${summary.codexSessions} ` +
    `copilotCli=${summary.copilotCliSessions} vscode=${summary.vscodeSessions} ` +
    `opencode=${summary.openCodeSessions} (total=${summary.totalSessions})\n`,
  );

  console.log('Parsing with the real extension pipeline ...');
  const pipeline = buildPipeline(home);
  console.log(`  parsed ${pipeline.result.sessions.length} sessions, ${pipeline.result.workspaces.size} workspaces\n`);

  const results = assertPipeline(pipeline);
  let failures = 0;
  for (const r of results) {
    if (r.ok) {
      console.log(`  PASS  ${r.label}`);
    } else {
      failures++;
      console.error(`  FAIL  ${r.label}${r.detail ? ' — ' + r.detail : ''}`);
    }
  }

  const rpc = buildRpcFixtures(pipeline);
  const rpcPath = path.join(artifacts, 'rpc-fixtures.json');
  fs.writeFileSync(rpcPath, JSON.stringify(rpc), 'utf-8');
  fs.writeFileSync(path.join(artifacts, 'summary.json'), JSON.stringify(summary, null, 2), 'utf-8');
  console.log(`\nWrote RPC fixtures (${Object.keys(rpc).length} methods) → ${rpcPath}`);

  console.log(`\n${failures === 0 ? 'ALL ASSERTIONS PASSED' : failures + ' ASSERTION(S) FAILED'}`);
  return failures === 0 ? 0 : 1;
}

process.exit(main());
