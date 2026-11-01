/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Installs the release the user chose: downloads and verifies its VSIX behind a cancellable
 * progress notification, hands the file to VS Code's extension installer, and deletes it again.
 * Windows of a profile take turns, and none goes back to an older release than another one has
 * just installed. */

import * as fs from 'fs/promises';
import * as vscode from 'vscode';
import { saveDownload } from './download-folder';
import { LockLostError, withInstallLock, writeInstallRecord, type InstallLockHost, type InstallRecord } from './install-lock';
import { describeNetworkError, type FeedEndpoints, type UpdateCandidate } from './release-feed';
import { isNewerVersion } from './update-policy';
import { LEASE_SETTLE_MS } from './update-schedule';
import { downloadVerifiedVsix, UpdateDownloadError } from './vsix-download';

export interface InstallReleaseOptions {
  fetch: typeof globalThis.fetch;
  endpoints: FeedEndpoints;
  /** Where to save the package; VS Code installs a VSIX only from a file: (or vscode-remote:) URI. */
  downloadDirectory: () => Promise<string>;
}

export interface InstallOnceOptions extends InstallReleaseOptions, InstallLockHost {
  /** The folder all local windows of the profile share; undefined when there is none on disk. */
  sharedFolder: () => Promise<string | undefined>;
  /** Identifies this installation, as `InstallRecord.location` does. */
  location: string;
  /** When this window started: an install recorded since then hasn't run here yet. */
  since: number;
  /** The install that globalState reports for this installation since this window started. */
  sharedRecord: () => InstallRecord | undefined;
  /** Records the install in globalState; runs while other windows wait for their turn. */
  onInstalled: (record: InstallRecord) => Promise<void>;
}

export type InstallOutcome =
  | { kind: 'installed'; record: InstallRecord }
  | { kind: 'busy' }
  | { kind: 'cancelled' }
  | { kind: 'failed'; reason: string };

function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

function newest(records: (InstallRecord | undefined)[]): InstallRecord | undefined {
  return records.reduce<InstallRecord | undefined>((best, record) =>
    record && (!best || isNewerVersion(record.version, best.version)) ? record : best, undefined);
}

/**
 * Installs `release` unless another window of the profile is installing, or has installed this
 * or a newer release since this window started; that install then counts as this one. Installs
 * take turns, so an older release can never replace a newer one, however the clicks interleave.
 * Never throws.
 */
export async function installReleaseOnce(release: UpdateCandidate, options: InstallOnceOptions): Promise<InstallOutcome> {
  try {
    const folder = await options.sharedFolder();
    if (!folder) {
      await installRelease(release, options);
      const record = { version: release.version, location: options.location, at: options.now() };
      await options.onInstalled(record);
      return { kind: 'installed', record };
    }
    const result = await withInstallLock(folder, options, async (last, lock) => {
      const recent = last && last.location === options.location && last.at >= options.since ? last : undefined;
      const installed = newest([recent, options.sharedRecord()]);
      if (installed && !isNewerVersion(release.version, installed.version)) {
        await options.onInstalled(installed);
        return installed;
      }
      await installRelease(release, options, () => lock.confirm());
      const record = { version: release.version, location: options.location, at: options.now() };
      const written = await writeInstallRecord(folder, record).then(() => true, () => false);
      await options.onInstalled(record);
      // Without the record, the next window goes by globalState, so give it time to arrive there.
      if (!written) await options.sleep(LEASE_SETTLE_MS);
      return record;
    });
    return result.kind === 'busy' ? result : { kind: 'installed', record: result.value };
  } catch (err: unknown) {
    if (err instanceof LockLostError) return { kind: 'busy' };
    if (isAbort(err)) return { kind: 'cancelled' };
    return { kind: 'failed', reason: err instanceof UpdateDownloadError ? err.message : describeNetworkError(err) };
  }
}

/**
 * Rejects with an `AbortError` when the user cancels, or with the download or install error.
 * `beforeInstall` runs right before VS Code's installer starts and can still stop the update.
 */
async function installRelease(release: UpdateCandidate, options: InstallReleaseOptions, beforeInstall?: () => Promise<void>): Promise<void> {
  let file: string | undefined;
  try {
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `Updating AI Engineer Coach to v${release.version}`,
      cancellable: true,
    }, async (progress, token) => {
      const controller = new AbortController();
      const cancellation = token.onCancellationRequested(() => controller.abort());
      try {
        let reported = 0;
        progress.report({ message: 'Downloading…' });
        const bytes = await downloadVerifiedVsix({
          fetch: options.fetch,
          candidate: release,
          endpoints: options.endpoints,
          signal: controller.signal,
          onProgress: (received, total) => {
            const percent = Math.floor((received / total) * 100);
            if (percent >= reported + 10) {
              progress.report({ increment: percent - reported, message: `Downloading… ${percent}%` });
              reported = percent;
            }
          },
        });
        controller.signal.throwIfAborted();
        progress.report({ message: 'Installing…' });
        file = await saveDownload(await options.downloadDirectory(), release.vsix.name, bytes);
        // Cancel may have been clicked while the file was written; the installer can't be stopped.
        controller.signal.throwIfAborted();
        await beforeInstall?.();
        await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(file));
      } finally {
        cancellation.dispose();
      }
    });
  } finally {
    if (file) await fs.rm(file, { force: true }).catch(() => undefined);
  }
}
