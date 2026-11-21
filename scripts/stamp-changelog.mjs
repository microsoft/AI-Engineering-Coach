/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/* Dates the pending changelog entries (see skills/stamp-changelog.md):
 *   npm run changelog:stamp [-- --date YYYY-MM-DD]
 * moves the "## [Unreleased]" entries in CHANGELOG.md under today's UTC date, joining that
 * date's section when it exists. Run it in a pull request just before it merges. */

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { stampUnreleased } from './changelog.mjs';

const CHANGELOG = join(import.meta.dirname, '..', 'CHANGELOG.md');
const USAGE = 'Usage: npm run changelog:stamp [-- --date YYYY-MM-DD]';

/** @param {string[]} args */
function stamp(args) {
  let date = new Date().toISOString().slice(0, 10);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--date' && args[i + 1]) date = args[++i];
    else throw new Error(`Unknown option "${args[i]}"\n${USAGE}`);
  }
  writeFileSync(CHANGELOG, stampUnreleased(readFileSync(CHANGELOG, 'utf8'), { date }));
  console.log(`CHANGELOG.md: [Unreleased] entries moved under ## ${date}. Review and commit them with the pull request.`);
}

try {
  stamp(process.argv.slice(2));
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
