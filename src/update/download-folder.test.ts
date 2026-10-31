/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { purgeStaleDownloads, saveDownload } from './download-folder';

const DAY = 24 * 60 * 60 * 1000;
let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'aec-downloads-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('saveDownload', () => {
  it('writes each package to a new, uniquely named file', async () => {
    const folder = path.join(root, 'updates');
    const first = await saveDownload(folder, 'ai-engineer-coach-0.4.0.vsix', new Uint8Array([1, 2, 3]));
    const second = await saveDownload(folder, 'ai-engineer-coach-0.4.0.vsix', new Uint8Array([4]));
    expect(path.basename(first)).toMatch(/^ai-engineer-coach-0\.4\.0-[0-9a-f]{12}\.vsix$/);
    expect(first).not.toBe(second);
    expect([...await fs.readFile(first)]).toEqual([1, 2, 3]);
    if (process.platform !== 'win32') expect((await fs.stat(first)).mode & 0o777).toBe(0o600);
  });
});

describe('purgeStaleDownloads', () => {
  it('removes only packages older than a day', async () => {
    const stale = path.join(root, 'ai-engineer-coach-0.3.0-aaaaaaaaaaaa.vsix');
    const fresh = path.join(root, 'ai-engineer-coach-0.4.0-bbbbbbbbbbbb.vsix');
    const other = path.join(root, 'notes.txt');
    for (const file of [stale, fresh, other]) await fs.writeFile(file, 'x');
    const old = new Date(Date.now() - 2 * DAY);
    await fs.utimes(stale, old, old);
    await fs.utimes(other, old, old);
    await purgeStaleDownloads(root, Date.now());
    expect((await fs.readdir(root)).sort()).toEqual([path.basename(fresh), 'notes.txt']);
  });

  it('does nothing when the folder does not exist', async () => {
    await expect(purgeStaleDownloads(path.join(root, 'missing'), Date.now())).resolves.toBeUndefined();
  });
});
