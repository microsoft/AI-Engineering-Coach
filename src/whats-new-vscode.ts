/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/* "What's New": the command opens the changelog bundled in the installed extension, and the
 * first activation of a build with newer dated changes offers it once. Local only: reads the
 * extension folder and VS Code state, never the network. */

import * as vscode from 'vscode';
import { loadSidebarStats } from './core/cache';
import { runtimeDebug } from './core/runtime-debug';
import { findChangelogName, latestChangelogDate, shouldAnnounceUpdate } from './core/whats-new';

export const SHOW_RELEASE_NOTES_COMMAND = 'aiEngineerCoach.showReleaseNotes';
export const LAST_SEEN_CHANGES_KEY = 'aiEngineerCoach.lastSeenChangesDate';
const CONFIG_SECTION = 'aiEngineerCoach';
const SHOW_AFTER_UPDATE_SETTING = 'showReleaseNotesAfterUpdate';
const WHATS_NEW = "What's New";
const DONT_SHOW_AGAIN = "Don't Show Again";

async function findChangelog(extensionUri: vscode.Uri): Promise<vscode.Uri | undefined> {
  const entries = await vscode.workspace.fs.readDirectory(extensionUri);
  const name = findChangelogName(entries.filter(([, type]) => type === vscode.FileType.File).map(([entry]) => entry));
  return name ? vscode.Uri.joinPath(extensionUri, name) : undefined;
}

/** The newest dated section of the bundled changelog, or undefined when there is none. */
async function readLatestChangesDate(extensionUri: vscode.Uri): Promise<string | undefined> {
  const changelog = await findChangelog(extensionUri);
  if (!changelog) return undefined;
  return latestChangelogDate(new TextDecoder().decode(await vscode.workspace.fs.readFile(changelog)));
}

/** Opens the bundled changelog in the Markdown preview, or as text when the preview is unavailable. */
export async function showReleaseNotes(extensionUri: vscode.Uri): Promise<void> {
  const changelog = await findChangelog(extensionUri);
  if (!changelog) {
    void vscode.window.showWarningMessage('This AI Engineer Coach build does not include a changelog.');
    return;
  }
  try {
    await vscode.commands.executeCommand('markdown.showPreview', changelog);
  } catch (err: unknown) {
    runtimeDebug('extension', 'whats-new-preview-unavailable', err);
    await vscode.window.showTextDocument(changelog, { preview: true });
  }
}

/**
 * Offers the changelog once when this build has newer dated changes than the user last saw, and
 * records the newest date either way. `latest` overrides the date read from the bundled changelog.
 */
export async function announceUpdate(context: vscode.ExtensionContext, latest?: string): Promise<void> {
  const previous = context.globalState.get<string>(LAST_SEEN_CHANGES_KEY);
  // Check for earlier use before awaiting: a dashboard opened now may write its stats meanwhile.
  const hasPriorUse = previous === undefined && loadSidebarStats() !== null;
  const current = latest ?? await readLatestChangesDate(context.extensionUri);
  if (current === undefined || previous === current) return;
  await context.globalState.update(LAST_SEEN_CHANGES_KEY, current);
  if (!shouldAnnounceUpdate(previous, current, hasPriorUse)) return;
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  if (!config.get<boolean>(SHOW_AFTER_UPDATE_SETTING, true)) return;
  runtimeDebug('extension', 'whats-new-offered', `from=${previous ?? 'untracked'} to=${current}`);
  const choice = await vscode.window.showInformationMessage(
    `AI Engineer Coach was updated with changes from ${current}.`, WHATS_NEW, DONT_SHOW_AGAIN);
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
