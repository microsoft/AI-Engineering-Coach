/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Where a verified VSIX waits while VS Code installs it: a fresh, user-only file under the
 * extension's own storage, deleted right after the install. Leftovers from a crash are
 * removed on the next activation. */

import { randomBytes } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';

const STALE_DOWNLOAD_MS = 24 * 60 * 60 * 1000;

/** Writes the package to a new file that no other process could have prepared. */
export async function saveDownload(directory: string, vsixName: string, bytes: Uint8Array): Promise<string> {
  await fs.mkdir(directory, { recursive: true });
  const base = vsixName.endsWith('.vsix') ? vsixName.slice(0, -'.vsix'.length) : vsixName;
  const file = path.join(directory, `${base}-${randomBytes(6).toString('hex')}.vsix`);
  await fs.writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
  return file;
}

/** Removes packages older than a day; quietly does nothing when the folder doesn't exist. */
export async function purgeStaleDownloads(directory: string, now: number): Promise<void> {
  let names: string[];
  try {
    names = await fs.readdir(directory);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith('.vsix')) continue;
    const file = path.join(directory, name);
    try {
      if (now - (await fs.stat(file)).mtimeMs > STALE_DOWNLOAD_MS) await fs.rm(file, { force: true });
    } catch {
      // Another window may have removed it already.
    }
  }
}
