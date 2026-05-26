/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* VS Code integration for summary export file writes. */

import * as vscode from 'vscode';
import {
  buildSummaryExportFromAnalyzer,
  getSummaryExportFilenames,
  renderSummaryJson,
  renderSummaryMarkdown,
  type SummaryExportAnalyzer,
} from './core/summary-export';
import type { DateFilter } from './core/types/session-types';

export interface SummaryExportWriteResult {
  ok: boolean;
  cancelled?: boolean;
  folder?: string;
  markdownPath?: string;
  jsonPath?: string;
}

export async function exportSummaryFiles(
  analyzer: SummaryExportAnalyzer,
  filter?: DateFilter,
): Promise<SummaryExportWriteResult> {
  const generatedAt = new Date();
  const report = buildSummaryExportFromAnalyzer(analyzer, filter, generatedAt);
  const filenames = getSummaryExportFilenames(generatedAt);
  const defaultUri = vscode.workspace.workspaceFolders?.[0]?.uri;

  const folders = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    defaultUri,
    openLabel: 'Export Summary',
    title: 'Choose a folder for the AI Engineer Coach summary',
  });

  const folder = folders?.[0];
  if (!folder) return { ok: false, cancelled: true };

  const markdownUri = vscode.Uri.joinPath(folder, filenames.markdown);
  const jsonUri = vscode.Uri.joinPath(folder, filenames.json);

  await vscode.workspace.fs.writeFile(markdownUri, Buffer.from(renderSummaryMarkdown(report), 'utf8'));
  await vscode.workspace.fs.writeFile(jsonUri, Buffer.from(renderSummaryJson(report), 'utf8'));

  const result = {
    ok: true,
    folder: folder.fsPath,
    markdownPath: markdownUri.fsPath,
    jsonPath: jsonUri.fsPath,
  };

  const action = await vscode.window.showInformationMessage(
    `Exported AI Engineer Coach summary to ${folder.fsPath}`,
    'Open Folder',
  );
  if (action === 'Open Folder') {
    await vscode.env.openExternal(folder);
  }

  return result;
}
