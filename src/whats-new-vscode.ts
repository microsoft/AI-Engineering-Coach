/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* "What's New": the command opens the changelog bundled in the installed extension, and the
 * first activation after an upgrade offers it once. Local only: reads the extension folder
 * and VS Code state, never the network. */

import * as vscode from 'vscode';
import { BUILD_INFO } from './core/build-info';
import { loadSidebarStats } from './core/cache';
import { runtimeDebug } from './core/runtime-debug';
import { findChangelogName, shouldAnnounceUpdate } from './core/whats-new';

export const SHOW_RELEASE_NOTES_COMMAND = 'aiEngineerCoach.showReleaseNotes';
export const LAST_SEEN_VERSION_KEY = 'aiEngineerCoach.lastSeenVersion';
const CONFIG_SECTION = 'aiEngineerCoach';
const SHOW_AFTER_UPDATE_SETTING = 'showReleaseNotesAfterUpdate';
const WHATS_NEW = "What's New";
const DONT_SHOW_AGAIN = "Don't Show Again";

/** Opens the bundled changelog in the Markdown preview, or as text when the preview is unavailable. */
export async function showReleaseNotes(extensionUri: vscode.Uri): Promise<void> {
  const entries = await vscode.workspace.fs.readDirectory(extensionUri);
  const name = findChangelogName(entries.filter(([, type]) => type === vscode.FileType.File).map(([entry]) => entry));
  if (!name) {
    void vscode.window.showWarningMessage('This AI Engineer Coach build does not include release notes.');
    return;
  }
  const changelog = vscode.Uri.joinPath(extensionUri, name);
  try {
    await vscode.commands.executeCommand('markdown.showPreview', changelog);
  } catch (err: unknown) {
    runtimeDebug('extension', 'whats-new-preview-unavailable', err);
    await vscode.window.showTextDocument(changelog, { preview: true });
  }
}

/** Offers the release notes once after the version increases, and records the version either way. */
export async function announceUpdate(context: vscode.ExtensionContext, version: string = BUILD_INFO.version): Promise<void> {
  const previous = context.globalState.get<string>(LAST_SEEN_VERSION_KEY);
  if (previous === version) return;
  await context.globalState.update(LAST_SEEN_VERSION_KEY, version);
  const hasPriorUse = previous === undefined && loadSidebarStats() !== null;
  if (!shouldAnnounceUpdate(previous, version, hasPriorUse)) return;
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  if (!config.get<boolean>(SHOW_AFTER_UPDATE_SETTING, true)) return;
  runtimeDebug('extension', 'whats-new-offered', `from=${previous ?? 'untracked'} to=${version}`);
  const choice = await vscode.window.showInformationMessage(
    `AI Engineer Coach was updated to v${version}.`, WHATS_NEW, DONT_SHOW_AGAIN);
  if (choice === WHATS_NEW) await showReleaseNotes(context.extensionUri);
  else if (choice === DONT_SHOW_AGAIN) await config.update(SHOW_AFTER_UPDATE_SETTING, false, vscode.ConfigurationTarget.Global);
}

export function registerWhatsNew(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(SHOW_RELEASE_NOTES_COMMAND, () => {
      runtimeDebug('extension', 'command-whats-new');
      return showReleaseNotes(context.extensionUri);
    }),
  );
  void announceUpdate(context).catch((err: unknown) => runtimeDebug('extension', 'whats-new-error', err));
}
