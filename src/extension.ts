/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* VS Code extension entry point */

import * as path from 'path';
import * as vscode from 'vscode';
import { Analyzer } from './core/analyzer';
import { findLogsDirs, parseAllLogsViaWorker } from './core/parser';
import { getRuntimeDebugLogPath, installRuntimeDebugHooks, runtimeDebug, setOutputHook } from './core/runtime-debug';
import { loadAllRuleLayersAsync, loadAllMetricLayersAsync, setDefaultTrustGate } from './core/rule-loader';
import {
  approve as approveTrust,
  createTrustGate,
  getPending,
  clearPending,
  listApproved,
  revoke as revokeTrust,
  setDefaultTrustStore,
  type PendingEntry,
} from './core/rule-trust';
import { exportSummaryFiles } from './summary-export-vscode';


type PanelModule = typeof import('./webview/panel');
let panelModulePromise: Promise<PanelModule> | null = null;
function loadPanelModule(): Promise<PanelModule> {
  if (!panelModulePromise) panelModulePromise = import('./webview/panel');
  return panelModulePromise;
}

async function exportSummaryFromLogs(): Promise<void> {
  const dirs = findLogsDirs();
  if (dirs.length === 0) {
    vscode.window.showErrorMessage('No AI coding session log directories found.');
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Exporting AI Engineer Coach summary',
      cancellable: false,
    },
    async progress => {
      const parsed = await parseAllLogsViaWorker(dirs, update => {
        progress.report({ message: update.detail ?? 'Reading session logs' });
      });
      const analyzer = new Analyzer(parsed.sessions, parsed.editLocIndex, parsed.workspaces);
      await exportSummaryFiles(analyzer);
    },
  );
}

async function reviewPendingTrust(context: vscode.ExtensionContext): Promise<Set<string>> {
  const pending = getPending();
  if (pending.length === 0) return new Set();

  const summary = `${pending.length} local rule/metric file${pending.length === 1 ? ' was' : 's were'} found on disk but have not been approved to run. These files execute custom DSL expressions and could be malicious. Review before loading?`;
  const action = await vscode.window.showWarningMessage(
    summary,
    { modal: true, detail: pending.map(p => `- [${p.layer}/${p.kind}] ${p.filePath}`).join('\n') },
    'Review & Approve',
    'Skip',
  );
  if (action !== 'Review & Approve') return new Set();

  type PickItem = vscode.QuickPickItem & { entry: PendingEntry };
  const items: PickItem[] = pending.map(p => ({
    label: `$(file-code) ${path.basename(p.filePath)}`,
    description: `${p.layer} ${p.kind}`,
    detail: p.filePath,
    entry: p,
    picked: false,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title: 'Approve local rule/metric files',
    placeHolder: 'Select files to approve. Unselected files will remain blocked.',
    ignoreFocusOut: true,
  });

  const approved = new Set<string>();
  if (!picked || picked.length === 0) return approved;
  for (const item of picked) {
    await approveTrust(context.globalState, item.entry.filePath, item.entry.content);
    approved.add(item.entry.filePath);
  }
  vscode.window.showInformationMessage(
    `Approved ${approved.size} file${approved.size === 1 ? '' : 's'}. Reloading rules...`,
  );
  return approved;
}

export function activate(context: vscode.ExtensionContext) {
  installRuntimeDebugHooks();
  runtimeDebug('extension', 'activate', `runtimeLog=${getRuntimeDebugLogPath()}`);

  const outputChannel = vscode.window.createOutputChannel('AI Engineer Coach');
  context.subscriptions.push(outputChannel);
  setOutputHook((msg) => outputChannel.appendLine(msg));

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  const trustGate = createTrustGate(context.globalState);
  setDefaultTrustGate(trustGate);
  setDefaultTrustStore(context.globalState);
  clearPending();

  const rulesPromise = loadAllRuleLayersAsync(workspaceRoot, trustGate).then(counts => {
    runtimeDebug('extension', 'rules-loaded',
      `builtin=${counts.builtin} personal=${counts.personal} project=${counts.project} pending=${getPending().length}` +
      (workspaceRoot ? ` root=${workspaceRoot}` : ''));
  }).catch(err => {
    runtimeDebug('extension', 'rules-load-error', String(err));
  });

  const metricsPromise = loadAllMetricLayersAsync(workspaceRoot, trustGate).then(counts => {
    if (counts.builtin + counts.personal + counts.project > 0) {
      runtimeDebug('extension', 'metrics-loaded',
        `builtin=${counts.builtin} personal=${counts.personal} project=${counts.project}`);
    }
  }).catch(err => {
    runtimeDebug('extension', 'metrics-load-error', String(err));
  });

  const ready = Promise.all([rulesPromise, metricsPromise]);

  async function promptAndReload(): Promise<void> {
    const approved = await reviewPendingTrust(context);
    if (approved.size === 0) return;
    clearPending();
    await loadAllRuleLayersAsync(workspaceRoot, trustGate);
    await loadAllMetricLayersAsync(workspaceRoot, trustGate);
    try {
      const reg = await import('./core/detector-registry');
      reg.invalidateDetectorRegistry();
    } catch { /* ignore */ }
    const { DashboardPanel } = await loadPanelModule();
    DashboardPanel.current?.reload(true);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('aiEngineerCoach.open', async () => {
      runtimeDebug('extension', 'command-open');
      await ready;
      // Gate dashboard creation behind the approval review.
      if (getPending().length > 0) await promptAndReload();
      const { DashboardPanel } = await loadPanelModule();
      DashboardPanel.createOrShow(context.extensionUri, context);
    }),
    vscode.commands.registerCommand('aiEngineerCoach.reload', async () => {
      runtimeDebug('extension', 'command-reload');
      await ready;
      if (getPending().length > 0) await promptAndReload();
      const { DashboardPanel } = await loadPanelModule();
      if (DashboardPanel.current) {
        DashboardPanel.current.reload(true);
      } else {
        DashboardPanel.createOrShow(context.extensionUri, context);
      }
    }),
    vscode.commands.registerCommand('aiEngineerCoach.exportSummary', async () => {
      runtimeDebug('extension', 'command-export-summary');
      await ready;
      if (getPending().length > 0) await promptAndReload();
      await exportSummaryFromLogs();
    }),
    vscode.commands.registerCommand('aiEngineerCoach.reviewLocalRules', async () => {
      runtimeDebug('extension', 'command-review-trust');
      await ready;
      if (getPending().length === 0) {
        const approvedCount = Object.keys(listApproved(context.globalState)).length;
        const action = await vscode.window.showInformationMessage(
          `No pending local rule files. ${approvedCount} file(s) currently approved.`,
          'Revoke All',
          'Close',
        );
        if (action === 'Revoke All') {
          for (const p of Object.keys(listApproved(context.globalState))) {
            await revokeTrust(context.globalState, p);
          }
          vscode.window.showInformationMessage('All approvals revoked. Reload the dashboard to re-scan.');
        }
        return;
      }
      await promptAndReload();
    }),
  );

  void ready.then(() => loadPanelModule()).then(({ DashboardSidebarProvider }) => {
    const sidebarProvider = new DashboardSidebarProvider(context.extensionUri);
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider('aiEngineerCoach.welcome', sidebarProvider),
    );
  });
}

export function deactivate() {
  runtimeDebug('extension', 'deactivate');
  setOutputHook(null);
}
