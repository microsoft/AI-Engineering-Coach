/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Webview panel manager -- creates and manages the dashboard webview shell */

import { fork } from 'child_process';
import * as vscode from 'vscode';
import { Analyzer } from '../core/analyzer';
import { saveSidebarStats } from '../core/cache';
import { clearCache, findLogsDirs, parseAllLogsViaWorker, ParseResult, type LoadProgress } from '../core/parser';
import { hasExternalHarnessSources } from '../core/parser-harnesses';
import { runtimeDebug } from '../core/runtime-debug';
import { WebviewMessage } from '../core/types';
import { panelCache } from './panel-cache';
import { clearCatalogCache } from './panel-catalog';
import { getDashboardHtml, getErrorHtml } from './panel-html';
import { getRpcHandler } from './panel-rpc';
import { PanelRequestService } from './panel-request-service';
import { DashboardSidebarProvider } from './panel-sidebar';
import { isRequestMessage, isSafeExternalHttpsUrl, postResponse, errorResult } from './panel-shared';

export { DashboardSidebarProvider } from './panel-sidebar';

export class DashboardPanel {
  private static instance: DashboardPanel | undefined;
  private static readonly viewType = 'aiEngineerCoach';

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private readonly requestService: PanelRequestService;
  private readonly globalState: vscode.Memento;
  private readonly disposables: vscode.Disposable[] = [];

  private analyzer: Analyzer | undefined;
  private parseResult: ParseResult | undefined;
  private pendingMessages: Extract<WebviewMessage, { type: 'request' }>[] = [];
  private dataReady = false;
  private disposed = false;
  private loading = false;
  private loadCompletedAt = 0;
  private lastProgress: LoadProgress | undefined;

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, context: vscode.ExtensionContext, forceReload = false) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.globalState = context.globalState;
    this.requestService = new PanelRequestService(
      this.panel.webview,
      () => this.analyzer,
      () => this.parseResult,
    );

    runtimeDebug('panel', 'constructor');
    this.panel.webview.html = getDashboardHtml(this.panel.webview, this.extensionUri);
    this.panel.onDidChangeViewState((e) => {
      runtimeDebug('panel', 'view-state', `visible=${e.webviewPanel.visible} active=${e.webviewPanel.active}`);
    }, null, this.disposables);
    this.panel.onDidDispose(() => {
      runtimeDebug('panel', 'disposed');
      this.dispose();
    }, null, this.disposables);
    this.panel.webview.onDidReceiveMessage((msg: unknown) => this.handleMessage(msg), null, this.disposables);

    void this.loadData(forceReload);
  }

  public static createOrShow(extensionUri: vscode.Uri, context: vscode.ExtensionContext, forceReload = false): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    if (DashboardPanel.instance) {
      runtimeDebug('panel', 'reveal-existing');
      DashboardPanel.instance.panel.reveal(column);
      if (forceReload) DashboardPanel.instance.reload(true);
      return;
    }

    runtimeDebug('panel', 'create-new');

    const panel = vscode.window.createWebviewPanel(
      DashboardPanel.viewType,
      'AI Engineer Coach',
      column,
      {
        enableScripts: true,
        // Retaining context prevents expensive re-parse on tab switch.
        // Trade-off: ~10-20MB extra memory when tab is hidden.
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist')],
      },
    );

    DashboardPanel.instance = new DashboardPanel(panel, extensionUri, context, forceReload);
  }

  public static get current(): DashboardPanel | undefined {
    return DashboardPanel.instance;
  }

  public reload(force = false): void {
    if (this.loading) {
      runtimeDebug('panel', 'reload-skipped-loading');
      return;
    }
    // Suppress watcher-triggered reloads within 10s of a completed load
    if (!force && Date.now() - this.loadCompletedAt < 10_000) {
      runtimeDebug('panel', 'reload-skipped-cooldown');
      return;
    }
    runtimeDebug('panel', 'reload');
    this.analyzer = undefined;
    this.parseResult = undefined;
    this.pendingMessages = [];
    this.dataReady = false;
    this.lastProgress = undefined;
    this.disposed = false;
    this.panel.webview.html = getDashboardHtml(this.panel.webview, this.extensionUri);
    void this.loadData(true);
  }

  private updateSidebarStats(): void {
    if (!this.parseResult) return;
    const harnesses = new Set<string>();
    for (const session of this.parseResult.sessions) {
      harnesses.add(session.harness);
    }
    saveSidebarStats({
      harnesses: Array.from(harnesses).sort(),
      savedAt: Date.now(),
    });
    DashboardSidebarProvider.instance?.refresh();
  }

  /** Authoritative skipped-file/line counts from the parse, sent with `dataReady` so the webview
   *  banner does not depend on a throttled progress tick (which never fires on a cache hit). */
  private skippedCounts(): { skippedFiles: number; skippedLines: number } {
    const w = this.parseResult?.parseWarnings;
    return { skippedFiles: w?.skippedFiles ?? 0, skippedLines: w?.skippedLines ?? 0 };
  }

  private async loadData(forceReload = false): Promise<void> {
    this.loading = true;
    const t0 = Date.now();
    runtimeDebug('panel', 'loadData-start');
    const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

    // Throttle progress messages to the webview: at most once per 250ms.
    let lastProgressTime = 0;
    let pendingProgress: Parameters<typeof sendRaw>[0] | undefined;
    let progressFlushTimer: ReturnType<typeof setTimeout> | undefined;
    const sendRaw = (progress: { phase: number; detail?: string; pct: number; sessions?: number; linesOfCode?: number; toolCalls?: number; imagesAnalyzed?: number; filesEdited?: number; requests?: number; workspacePlan?: string[]; workspaceDone?: string }) => {
      if (this.disposed) return;
      this.lastProgress = progress;
      try {
        this.panel.webview.postMessage({ type: 'progress', ...progress });
      } catch {
        // Webview may have been disposed between the flag check and the call.
      }
    };
    const sendProgress = (progress: Parameters<typeof sendRaw>[0]) => {
      if (this.disposed) {
        clearTimeout(progressFlushTimer);
        return;
      }
      const now = Date.now();
      // Always send immediately for phase changes, workspace grid updates, and the final "Ready".
      if (progress.phase !== pendingProgress?.phase || progress.workspacePlan || progress.workspaceDone || progress.pct >= 100) {
        clearTimeout(progressFlushTimer);
        progressFlushTimer = undefined;
        sendRaw(progress);
        lastProgressTime = now;
        pendingProgress = progress;
        return;
      }
      pendingProgress = progress;
      if (now - lastProgressTime >= 250) {
        clearTimeout(progressFlushTimer);
        progressFlushTimer = undefined;
        sendRaw(progress);
        lastProgressTime = now;
      } else if (!progressFlushTimer) {
        progressFlushTimer = setTimeout(() => {
          progressFlushTimer = undefined;
          if (pendingProgress && !this.disposed) {
            sendRaw(pendingProgress);
            lastProgressTime = Date.now();
          }
        }, 250 - (now - lastProgressTime));
      }
    };

    const safePost = (msg: Record<string, unknown>) => {
      if (this.disposed) return;
      try {
        this.panel.webview.postMessage(msg);
      } catch {
        // Webview disposed between check and call.
      }
    };

    const publishReady = () => {
      this.updateSidebarStats();
      this.dataReady = true;
      safePost({ type: 'dataReady', currentWorkspace: vscode.workspace.name || '', ...this.skippedCounts() });
      const pendingMessages = this.pendingMessages;
      this.pendingMessages = [];
      for (const message of pendingMessages) this.handleMessage(message);
    };

    try {
      if (forceReload) {
        clearCache();
        clearCatalogCache();
        panelCache.clear();
      }
      if (panelCache.analyzerInstance && panelCache.result) {
        runtimeDebug('panel', 'loadData-cache-hit');
        this.parseResult = panelCache.result;
        this.analyzer = panelCache.analyzerInstance;
        sendProgress({ phase: 4, detail: 'Computing analytics', pct: 90, sessions: this.parseResult.sessions.length });
        await panelCache.analyticsReady;
        if (this.disposed) return;
        sendProgress({ phase: 5, detail: 'Ready', pct: 100, sessions: this.parseResult.sessions.length });
        publishReady();
        runtimeDebug('panel', 'sync-timing',
          `result=warm-cache totalMs=${Date.now() - t0} sessions=${this.parseResult.sessions.length}`);
        return;
      }

      sendProgress({ phase: 0, detail: 'Discovering log directories', pct: 0 });
      await flush();
      if (this.disposed) return;

      const tDiscover = Date.now();
      const dirs = findLogsDirs();
      const discoverMs = Date.now() - tDiscover;
      const hasExternal = hasExternalHarnessSources();
      runtimeDebug('panel', 'logs-dirs-found', `count=${dirs.length} external=${hasExternal}`);
      // External harnesses (Claude Code, Codex, OpenCode) are collected by the
      // parse worker independently of `dirs`, so only abort when no source of
      // any kind is present. Otherwise a host with e.g. only Claude Code logs
      // (and no VS Code/Copilot directories) would never load.
      if (dirs.length === 0 && !hasExternal) {
        runtimeDebug('panel', 'loadData-no-dirs');
        if (!this.disposed) {
          try { this.panel.webview.html = getErrorHtml('No AI coding session logs found. Looked for VS Code, GitHub Copilot (CLI and Xcode), Claude Code, Codex, and OpenCode sessions.'); } catch { /* disposed */ }
        }
        return;
      }

      const tParse = Date.now();
      this.parseResult = await parseAllLogsViaWorker(dirs, progress => sendProgress(progress));
      const parseMs = Date.now() - tParse;
      if (this.disposed) return;
      runtimeDebug('panel', 'parse-complete', `sessions=${this.parseResult.sessions.length} workspaces=${this.parseResult.workspaces.size}`);
      const sessionCount = this.parseResult.sessions.length;

      sendProgress({ phase: 4, detail: 'Building analyzer', pct: 90, sessions: sessionCount });
      await flush();
      if (this.disposed) return;

      const tAnalyzer = Date.now();
      this.analyzer = new Analyzer(this.parseResult.sessions, this.parseResult.editLocIndex, this.parseResult.workspaces);
      const analyzerMs = Date.now() - tAnalyzer;
      runtimeDebug('panel', 'analyzer-built', `elapsedMs=${Date.now() - t0}`);

      const tWarmUp = Date.now();
      const analyticsReady = this.analyzer.warmUp((_phase, detail, pct) => {
        sendProgress({
          phase: 4, detail, pct: 90 + pct / 10, sessions: sessionCount,
        });
      }, fork);
      panelCache.store(this.parseResult, this.analyzer, analyticsReady);
      await analyticsReady;
      const warmUpMs = Date.now() - tWarmUp;
      runtimeDebug('panel', 'warmUp-done', `elapsedMs=${Date.now() - t0}`);
      if (this.disposed) return;

      sendProgress({ phase: 5, detail: 'Ready', pct: 100, sessions: sessionCount });
      publishReady();
      const dataReadyMs = Date.now() - t0;
      runtimeDebug('panel', 'data-ready-sent', `elapsedMs=${dataReadyMs}`);

      // Local-only sync timing summary (issue #106 follow-up). Surfaces a single, parseable
      // breakdown of where a cold Sync spends wall-clock time in the "AI Engineer Coach"
      // output channel. Never leaves the machine — routed through the same runtimeDebug hook.
      runtimeDebug('panel', 'sync-timing',
        `result=cold totalMs=${Date.now() - t0} dataReadyMs=${dataReadyMs} ` +
        `discoverMs=${discoverMs} parseMs=${parseMs} analyzerMs=${analyzerMs} warmUpMs=${warmUpMs} ` +
        `sessions=${sessionCount} dirs=${dirs.length}`);
      if (this.disposed) return;

    } catch (error: unknown) {
      runtimeDebug('panel', 'loadData-error', error);
      if (this.analyzer && panelCache.analyzerInstance === this.analyzer) panelCache.clear();
      if (!this.disposed) {
        try { this.panel.webview.html = getErrorHtml(error instanceof Error ? error.message : 'Failed to load data'); } catch { /* disposed */ }
      }
    } finally {
      clearTimeout(progressFlushTimer);
      this.loading = false;
      this.loadCompletedAt = Date.now();
    }
  }

  private handleMessage(msg: unknown): void {
    if (this.disposed) return;
    if (typeof msg === 'object' && msg !== null && 'type' in msg && msg.type === 'ready') {
      runtimeDebug('panel', 'webview-ready', `dataReady=${this.dataReady}`);
      if (this.dataReady) {
        this.panel.webview.postMessage({ type: 'dataReady', currentWorkspace: vscode.workspace.name || '', ...this.skippedCounts() });
      } else if (this.lastProgress) {
        this.panel.webview.postMessage({ type: 'progress', ...this.lastProgress });
      }
      return;
    }
    if (!isRequestMessage(msg)) return;

    // Open external URLs from webview
    if (msg.method === 'openExternal') {
      this.handleOpenExternal(msg);
      return;
    }

    // Reveal the "AI Engineer Coach" output channel (e.g. from the skipped-history banner).
    if (msg.method === 'showOutput') {
      void vscode.commands.executeCommand('aiEngineerCoach.showOutput');
      postResponse(this.panel.webview, msg.id, { ok: true });
      return;
    }

    // Budget persistence — handled before data readiness check
    if (msg.method === 'saveModelBudgets' || msg.method === 'loadModelBudgets') {
      this.handleBudgetMessage(msg);
      return;
    }

    // Host capability probe — answered immediately so the webview can gate
    // agent-dependent features. The VS Code host always has the local agent.
    if (msg.method === 'getCapabilities') {
      try { postResponse(this.panel.webview, msg.id, { host: 'vscode', llm: true }); } catch { /* disposed */ }
      return;
    }

    if (this.requestService.tryHandle(msg)) return;

    if (!this.dataReady || !this.analyzer || !this.parseResult) {
      this.pendingMessages.push(msg);
      return;
    }

    const handler = getRpcHandler(msg.method);
    if (!handler) {
      if (!this.disposed) {
        try { postResponse(this.panel.webview, msg.id, errorResult(`Unknown method: ${msg.method}`)); } catch { /* disposed */ }
      }
      return;
    }

    try {
      const analyzer = this.analyzer;
      const parseResult = this.parseResult;
      const params = (msg.params ?? {}) as Record<string, unknown>;
      const result = handler(analyzer, parseResult, params);
      // Support async RPC handlers (e.g. getSessionDetail loads from disk)
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        (result as Promise<unknown>).then(
          (data) => {
            if (!this.disposed) {
              try { postResponse(this.panel.webview, msg.id, data); } catch { /* disposed */ }
            }
          },
          (error) => {
            if (!this.disposed) {
              try { postResponse(this.panel.webview, msg.id, errorResult(error instanceof Error ? error.message : 'Internal error')); } catch { /* disposed */ }
            }
          },
        );
      } else {
        if (!this.disposed) {
          try { postResponse(this.panel.webview, msg.id, result); } catch { /* disposed */ }
        }
      }
    } catch (error: unknown) {
      const data = errorResult(error instanceof Error ? error.message : 'Internal error');
      if (!this.disposed) {
        try { postResponse(this.panel.webview, msg.id, data); } catch { /* disposed */ }
      }
    }
  }

  private handleOpenExternal(msg: Extract<WebviewMessage, { type: 'request' }>): void {
    const url = (msg.params as Record<string, unknown> | undefined)?.url;
    if (isSafeExternalHttpsUrl(url)) {
      void vscode.env.openExternal(vscode.Uri.parse(url));
      try { postResponse(this.panel.webview, msg.id, { ok: true }); } catch { /* disposed */ }
    } else {
      try { postResponse(this.panel.webview, msg.id, errorResult('Invalid external URL')); } catch { /* disposed */ }
    }
  }

  private static readonly BUDGET_STATE_KEY = 'modelBudgets';

  private handleBudgetMessage(msg: Extract<WebviewMessage, { type: 'request' }>): void {
    if (msg.method === 'saveModelBudgets') {
      const budgets = (msg.params as Record<string, unknown>)?.budgets;
      this.globalState.update(DashboardPanel.BUDGET_STATE_KEY, budgets).then(
        () => { if (!this.disposed) try { postResponse(this.panel.webview, msg.id, { ok: true }); } catch { /* disposed */ } },
        () => { if (!this.disposed) try { postResponse(this.panel.webview, msg.id, errorResult('Failed to save budgets')); } catch { /* disposed */ } },
      );
    } else {
      const budgets = this.globalState.get<Record<string, number>>(DashboardPanel.BUDGET_STATE_KEY, {});
      if (!this.disposed) try { postResponse(this.panel.webview, msg.id, budgets); } catch { /* disposed */ }
    }
  }

  private dispose(): void {
    runtimeDebug('panel', 'dispose');
    this.disposed = true;
    DashboardPanel.instance = undefined;
    this.panel.dispose();
    for (const disposable of this.disposables) disposable.dispose();
    this.disposables.length = 0;
  }
}
