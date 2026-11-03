/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Bundles the parse worker and the cache-write worker side by side, as in dist/, for tests that
 * run the real parse worker. The caller deletes the returned directory. */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { build } from 'esbuild';

export async function bundleParseWorkers(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aec-worker-bundle-'));
  await build({
    entryPoints: {
      'parse-worker': path.resolve('src', 'core', 'parse-worker.ts'),
      'cache-write-worker': path.resolve('src', 'core', 'cache-write-worker.ts'),
    },
    outdir: dir, bundle: true, platform: 'node', format: 'cjs', target: 'es2022', logLevel: 'silent',
  });
  return dir;
}
