/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Fingerprints of an editor workspace directory, for the disk cache to tell which workspaces changed: its chat and
 * editing-session folders, and the Copilot CLI log read with it. */

import * as fs from 'fs';
import * as path from 'path';

/** Files a Copilot CLI log beside an editor workspace's chats is read with: the log, and its sidecar (harness, name). */
const CLI_SIBLINGS = ['events.jsonl', 'workspace.yaml'];

function statStamp(st: fs.Stats | null): string {
  return st ? `${st.size}:${st.mtimeMs}` : '-';
}

export function cliFingerprint(wsPath: string): string {
  return CLI_SIBLINGS.map(name => {
    try {
      return statStamp(fs.statSync(path.join(wsPath, name)));
    } catch {
      return statStamp(null);
    }
  }).join('|');
}

export async function cliFingerprintAsync(wsPath: string): Promise<string> {
  const stats = await Promise.allSettled(CLI_SIBLINGS.map(name => fs.promises.stat(path.join(wsPath, name))));
  return stats.map(s => statStamp(s.status === 'fulfilled' ? s.value : null)).join('|');
}

/**
 * Fast directory fingerprint.
 * Uses directory mtime (changes on add/remove) + count of relevant entries.
 * Only counts .json/.jsonl files for chatSessions, directories for editingSessions.
 */
export function dirFingerprint(dirPath: string, countDirs = false): { count: number; mtime: number } {
  try {
    const st = fs.statSync(dirPath);
    if (!st.isDirectory()) return { count: 0, mtime: 0 };
    if (!countDirs) {
      const entries = fs.readdirSync(dirPath);
      return {
        count: entries.filter(name => name.endsWith('.json') || name.endsWith('.jsonl')).length,
        mtime: st.mtimeMs,
      };
    }
    const entries = fs.readdirSync(dirPath, { withFileTypes: true })
      .filter(entry => entry.isDirectory());
    let mtime = st.mtimeMs;
    for (const entry of entries) {
      try {
        mtime = Math.max(mtime, fs.statSync(path.join(dirPath, entry.name, 'state.json')).mtimeMs);
      } catch {
        // A partially written editing-session directory may not have state.json yet.
      }
    }
    return { count: entries.length, mtime };
  } catch {
    return { count: 0, mtime: 0 };
  }
}

/**
 * Fast async directory fingerprint.
 * Uses directory mtime (changes on add/remove) + count of relevant entries.
 */
export async function dirFingerprintAsync(dirPath: string, countDirs = false): Promise<{ count: number; mtime: number }> {
  try {
    const st = await fs.promises.stat(dirPath);
    if (!st.isDirectory()) return { count: 0, mtime: 0 };
    if (!countDirs) {
      const entries = await fs.promises.readdir(dirPath);
      return {
        count: entries.filter(name => name.endsWith('.json') || name.endsWith('.jsonl')).length,
        mtime: st.mtimeMs,
      };
    }
    const entries = (await fs.promises.readdir(dirPath, { withFileTypes: true }))
      .filter(entry => entry.isDirectory());
    let mtime = st.mtimeMs;
    const BATCH_SIZE = 128;
    for (let i = 0; i < entries.length; i += BATCH_SIZE) {
      const stats = await Promise.allSettled(
        entries.slice(i, i + BATCH_SIZE)
          .map(entry => fs.promises.stat(path.join(dirPath, entry.name, 'state.json'))),
      );
      for (const result of stats) {
        if (result.status === 'fulfilled') mtime = Math.max(mtime, result.value.mtimeMs);
      }
    }
    return { count: entries.length, mtime };
  } catch {
    return { count: 0, mtime: 0 };
  }
}
