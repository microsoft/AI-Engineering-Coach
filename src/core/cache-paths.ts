/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Location of the parse cache and runtime log. Resolved on every call, not at module load, so it
 * always follows the current HOME/USERPROFILE: the unit-test setup (src/test/hermetic-home.ts)
 * points those at a temp dir to keep tests away from the developer's real cache. */

import * as path from 'path';

export function getCacheDir(): string {
  return path.join(process.env.HOME || process.env.USERPROFILE || '', '.copilot-analytics-cache');
}
