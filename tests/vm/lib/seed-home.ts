/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * Seed synthetic session logs into the *real* HOME directory that the
 * VS-Code-under-test (launched by ExTester) will run as.
 *
 * The extension parser discovers logs relative to HOME (~/.claude, ~/.codex,
 * ~/.copilot, ~/.config/Code, ~/.local/share/opencode), so writing fixtures
 * there makes the installed extension light up with realistic analytics —
 * with NO login and NO real account data. This is what makes the real-VS-Code
 * authless UI test possible.
 *
 * Usage:
 *   HOME=/home/tester npx tsx tests/vm/lib/seed-home.ts
 *   (or rely on the process HOME / USERPROFILE)
 */

import * as os from 'os';
import { generateFixtures } from './generate-fixtures';

function main(): void {
  const home = process.env.SEED_HOME || process.env.HOME || process.env.USERPROFILE || os.homedir();
  if (!home) {
    console.error('seed-home: could not resolve a HOME directory to seed.');
    process.exit(1);
  }

  const summary = generateFixtures({ home });
  console.log(
    `Seeded ${summary.totalSessions} synthetic sessions into ${home} ` +
    `(claude=${summary.claudeSessions} codex=${summary.codexSessions} ` +
    `copilotCli=${summary.copilotCliSessions} vscode=${summary.vscodeSessions} ` +
    `opencode=${summary.openCodeSessions}).`,
  );
}

main();
