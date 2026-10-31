/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Installs the release the user chose: downloads and verifies its VSIX behind a cancellable
 * progress notification, hands the file to VS Code's extension installer, and deletes it again. */

import * as fs from 'fs/promises';
import * as vscode from 'vscode';
import { saveDownload } from './download-folder';
import type { FeedEndpoints, UpdateCandidate } from './release-feed';
import { downloadVerifiedVsix } from './vsix-download';

export interface InstallReleaseOptions {
  fetch: typeof globalThis.fetch;
  endpoints: FeedEndpoints;
  /** Where to save the package; VS Code installs a VSIX only from a file: (or vscode-remote:) URI. */
  downloadDirectory: () => Promise<string>;
}

/** Rejects with an `AbortError` when the user cancels, or with the download or install error. */
export async function installRelease(release: UpdateCandidate, options: InstallReleaseOptions): Promise<void> {
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
        await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(file));
      } finally {
        cancellation.dispose();
      }
    });
  } finally {
    if (file) await fs.rm(file, { force: true }).catch(() => undefined);
  }
}
