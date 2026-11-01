/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Runs the real parsers and the Prompt Cache analyzer over your local logs and prints aggregates:
 * counts, percentages, token sums, model names and cause names. It never prints workspace names,
 * session ids, file paths or prompt text: parser diagnostics, which can, are held back and only counted
 * (see src/core/prompt-cache-report.ts). Usage: npm run analyze:prompt-cache [-- --from YYYY-MM-DD] */

import { findLogsDirs, parseAllLogs } from '../src/core/parser';
import { promptCacheReport } from '../src/core/prompt-cache-report';

const fromArg = process.argv.indexOf('--from');
const fromDate = fromArg > 0 ? process.argv[fromArg + 1] : undefined;

console.log(promptCacheReport(() => parseAllLogs(findLogsDirs()).sessions, fromDate).join('\n'));
