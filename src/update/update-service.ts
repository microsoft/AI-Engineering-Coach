/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* VS Code side of the update check: reads the settings, keeps the shared state in globalState,
 * schedules automatic checks, shows the once-per-version notification, and installs a verified
 * VSIX only after the user clicks Update. Nothing reloads the window without a click. Registered
 * from extension.ts only; the Copilot app canvas never loads this module. */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { BUILD_INFO, type BuildInfo } from '../core/build-info';
import { runtimeDebug } from '../core/runtime-debug';
import type { UpdateStatus } from '../core/types/rpc-types';
import { purgeStaleDownloads, saveDownload } from './download-folder';
import {
  canInstallCandidate, describeNetworkError, fetchLatestRelease, isUpdateCandidate, releasesPageUrl, resolveFeedEndpoints,
  type FeedEndpoints, type FeedResult, type UpdateCandidate,
} from './release-feed';
import { describeManualCheck } from './update-messages';
import { automaticChecksEnabled, cooldownFromSetting, evaluateUpdate, isNewerVersion, type Evaluation, type UpdateMarkers } from './update-policy';
import {
  afterFailure, afterRateLimit, afterSuccess, claimCheck, isCheckDue, nextCheckTime, timerDelay, type ScheduleState,
} from './update-schedule';
import { downloadVerifiedVsix, UpdateDownloadError } from './vsix-download';

export const CHECK_FOR_UPDATES_COMMAND = 'aiEngineerCoach.checkForUpdates';
export const INSTALL_UPDATE_COMMAND = 'aiEngineerCoach.installUpdate';
export const UPDATE_STATE_KEY = 'aiEngineerCoach.update.state';
const AUTO_CHECK_SETTING = 'aiEngineerCoach.updates.autoCheck';
const UPDATE_AVAILABLE_CONTEXT = 'aiEngineerCoach.updateAvailable';

const UPDATE = 'Update';
const INSTALL = 'Install';
const RELEASE_NOTES = 'Release Notes';
const SKIP = 'Skip This Version';
const OPEN_RELEASE_PAGE = 'Open Release Page';
const RELOAD_WINDOW = 'Reload Window';

export interface PersistedUpdateState extends ScheduleState, UpdateMarkers {
  /** ETag of the last 200 response, sent as If-None-Match while `release` is cached. */
  etag?: string;
  /** The latest stable release, already validated. */
  release?: UpdateCandidate;
  /** Where `installedVersion` was installed; globalState is shared with remote windows. */
  installedLocation?: string;
}

export interface UpdateServiceOptions {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  random?: () => number;
  build?: Pick<BuildInfo, 'version' | 'dev'>;
  endpoints?: FeedEndpoints;
  /** Directory for downloaded packages; defaults to `<globalStorage>/updates`. */
  downloadDir?: () => Promise<string>;
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

/** For calls whose outcome doesn't matter: VS Code cancels them when the window reloads or closes. */
function ignoreRejection(thenable: Thenable<unknown>): void {
  Promise.resolve(thenable).catch(() => undefined);
}

export class UpdateService implements vscode.Disposable {
  private status: UpdateStatus = { state: 'none' };
  private readonly statusEmitter = new vscode.EventEmitter<UpdateStatus>();
  readonly onDidChangeStatus = this.statusEmitter.event;
  private readonly disposables: vscode.Disposable[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private checking: Promise<FeedResult> | undefined;
  private installing = false;
  private revealedVersion: string | undefined;
  private disposed = false;

  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly build: Pick<BuildInfo, 'version' | 'dev'>;
  private readonly endpoints: FeedEndpoints;
  private readonly downloadDir: (() => Promise<string>) | undefined;
  /** Identifies this installation: local or a remote host, and its extensions folder. */
  private readonly location: string;
  /** One-click install is verified in local windows only; remote windows get the release page. */
  private readonly localWindow: boolean;

  constructor(private readonly context: vscode.ExtensionContext, options: UpdateServiceOptions = {}) {
    // Bound late so VS Code's proxy-aware fetch patch is the one that runs.
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.build = options.build ?? BUILD_INFO;
    this.endpoints = options.endpoints ?? resolveFeedEndpoints();
    this.downloadDir = options.downloadDir;
    this.location = `${vscode.env.remoteName ?? 'local'}:${path.posix.dirname(context.extensionUri.path)}`;
    this.localWindow = vscode.env.remoteName === undefined;
  }

  start(): void {
    this.disposables.push(vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration(AUTO_CHECK_SETTING) || event.affectsConfiguration('extensions.autoCheckUpdates')
        || event.affectsConfiguration('extensions.autoUpdateDelay')) {
        this.refresh();
        this.reschedule(true);
      }
    }));
    void this.forgetInstalledMarker();
    void this.purgeStaleDownloads();
    this.refresh();
    this.reschedule(true);
  }

  getStatus(): UpdateStatus {
    return this.status;
  }

  /** "Check for Updates": asks GitHub now and reports every outcome. */
  async checkNow(): Promise<void> {
    if (this.status.state === 'installed') {
      await this.offerReload(this.status.latest);
      return;
    }
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'Checking for AI Engineer Coach updates' },
      () => this.check(true));
    this.reschedule(false);
    const report = describeManualCheck(result, this.readState().release, this.build.version);
    if (report.kind === 'offer') {
      this.revealedVersion = report.release.version;
      this.refresh();
      await this.offer(report.release, 'manual');
    } else if (report.kind === 'info') {
      ignoreRejection(vscode.window.showInformationMessage(report.message));
    } else if (!report.offerReleasesPage) {
      ignoreRejection(vscode.window.showWarningMessage(report.message));
    } else if (await vscode.window.showWarningMessage(report.message, OPEN_RELEASE_PAGE) === OPEN_RELEASE_PAGE) {
      await vscode.env.openExternal(vscode.Uri.parse(releasesPageUrl(this.endpoints)));
    }
  }

  /** "Install Update", the dashboard footer and the activity-bar view: a native confirmation first. */
  async promptInstall(): Promise<void> {
    if (this.status.state === 'installed') {
      await this.reloadAfterUpdate();
      return;
    }
    if (this.installing) return;
    const release = this.readState().release;
    if (this.status.state !== 'available' || !release || release.version !== this.status.latest) {
      await this.checkNow();
      return;
    }
    const installable = this.canInstall(release);
    const reason = this.localWindow ? "This release can't be installed from here."
      : 'One-click updates are available only in local windows.';
    const detail = installable
      ? `This downloads ${release.vsix.name} from GitHub Releases, checks its SHA-256 checksum, and installs it. `
        + 'Reload the window afterwards to start using it.'
      : `${reason} Download ${release.vsix.name} from the release page and run `
        + '"Extensions: Install from VSIX..." to install it.';
    const actions = installable ? [INSTALL, RELEASE_NOTES, SKIP] : [OPEN_RELEASE_PAGE, SKIP];
    const choice = await vscode.window.showInformationMessage(
      `Update AI Engineer Coach to v${release.version}?`, { modal: true, detail }, ...actions);
    await this.handleChoice(choice, release);
  }

  /** Reloads only when this window has installed a newer build. */
  reloadAfterUpdate(): Promise<void> {
    if (this.status.state === 'installed') {
      runtimeDebug('update', 'reload', `version=${this.status.latest}`);
      // The reload tears down this extension host, so the command's result never arrives.
      ignoreRejection(vscode.commands.executeCommand('workbench.action.reloadWindow'));
    }
    return Promise.resolve();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const disposable of this.disposables) disposable.dispose();
    this.disposables.length = 0;
    this.statusEmitter.dispose();
  }

  /** One-click install needs a verifiable release and, until remote installs are verified, a local window. */
  private canInstall(release: UpdateCandidate): boolean {
    return this.localWindow && canInstallCandidate(release);
  }

  private readState(): PersistedUpdateState {
    const value = this.context.globalState.get<unknown>(UPDATE_STATE_KEY);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
    const state = value as PersistedUpdateState;
    // Stored by an earlier check, possibly by another version of the extension.
    return isUpdateCandidate(state.release) ? state : { ...state, release: undefined, etag: undefined };
  }

  private async writeState(patch: Partial<PersistedUpdateState>): Promise<void> {
    await this.context.globalState.update(UPDATE_STATE_KEY, { ...this.readState(), ...patch });
  }

  private automatic(): boolean {
    return automaticChecksEnabled({
      production: this.context.extensionMode === vscode.ExtensionMode.Production,
      dev: this.build.dev,
      autoCheck: vscode.workspace.getConfiguration().get<boolean>(AUTO_CHECK_SETTING, true) !== false,
      vscodeAutoCheck: vscode.workspace.getConfiguration('extensions').get<boolean>('autoCheckUpdates', true) !== false,
    });
  }

  private evaluate(): Evaluation {
    const state = this.readState();
    const installedHere = state.installedLocation === this.location;
    return evaluateUpdate({
      candidate: state.release,
      current: this.build.version,
      markers: { ...state, installedVersion: installedHere ? state.installedVersion : undefined },
      automatic: this.automatic(),
      revealedVersion: this.revealedVersion,
      allowInstall: this.localWindow,
      cooldownMs: cooldownFromSetting(vscode.workspace.getConfiguration('extensions').get<number>('autoUpdateDelay')),
      now: this.now(),
    });
  }

  private refresh(): Evaluation {
    const evaluation = this.evaluate();
    if (!this.installing) this.setStatus(evaluation.status);
    return evaluation;
  }

  private setStatus(status: UpdateStatus): void {
    if (JSON.stringify(status) === JSON.stringify(this.status)) return;
    this.status = status;
    ignoreRejection(vscode.commands.executeCommand('setContext', UPDATE_AVAILABLE_CONTEXT, status.state === 'available' || status.state === 'installed'));
    this.statusEmitter.fire(status);
  }

  private reschedule(justActivated: boolean): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.disposed || !this.automatic()) return;
    const now = this.now();
    const at = nextCheckTime(this.readState(), now, this.random, justActivated);
    this.timer = setTimeout(() => { void this.onTimer(); }, timerDelay(at, now));
  }

  private async onTimer(): Promise<void> {
    this.timer = undefined;
    if (this.disposed || !this.automatic()) return;
    try {
      if (isCheckDue(this.readState(), this.now())) await this.check(false);
      const evaluation = this.refresh();
      const release = this.readState().release;
      if (evaluation.notify && release && !this.installing) {
        this.offer(release, 'automatic').catch((err: unknown) => runtimeDebug('update', 'offer-error', err));
      }
    } catch (err: unknown) {
      runtimeDebug('update', 'check-error', err);
    } finally {
      if (!this.disposed) this.reschedule(false);
    }
  }

  /** Asks GitHub once and records the outcome in the shared state; never throws. */
  private check(manual: boolean): Promise<FeedResult> {
    this.checking ??= this.runCheck(manual).finally(() => { this.checking = undefined; });
    return this.checking;
  }

  private async runCheck(manual: boolean): Promise<FeedResult> {
    const now = this.now();
    const before = this.readState();
    if (before.rateLimitedUntil !== undefined && before.rateLimitedUntil > now) {
      return { kind: 'rate-limited', retryAt: before.rateLimitedUntil };
    }
    await this.writeState(claimCheck(before, now));
    const etag = before.release ? before.etag : undefined;
    const result = await fetchLatestRelease({ fetch: this.fetchImpl, endpoints: this.endpoints, etag, now: this.now });
    const state = this.readState();
    switch (result.kind) {
      case 'release':
        await this.writeState({ ...afterSuccess(now, this.random), etag: result.etag, release: result.candidate });
        break;
      case 'not-modified':
        await this.writeState(afterSuccess(now, this.random));
        break;
      case 'no-release':
      case 'invalid':
        await this.writeState({ ...afterSuccess(now, this.random), etag: undefined, release: undefined });
        break;
      case 'rate-limited':
        await this.writeState(afterRateLimit(state, now, result.retryAt, this.random));
        break;
      case 'error':
        await this.writeState(afterFailure(state, now, this.random));
        break;
    }
    const detail = result.kind === 'release' ? ` latest=${result.candidate.version}`
      : result.kind === 'invalid' ? ` reason=${result.reason}`
        : result.kind === 'error' ? ` reason=${result.message}`
          : result.kind === 'rate-limited' ? ` retryAt=${new Date(result.retryAt).toISOString()}` : '';
    runtimeDebug('update', 'check', `manual=${manual} result=${result.kind}${detail} etag=${etag ? 'sent' : 'none'}`);
    return result;
  }

  private async offer(release: UpdateCandidate, origin: 'automatic' | 'manual'): Promise<void> {
    if (origin === 'automatic') await this.writeState({ notifiedVersion: release.version });
    const actions = this.canInstall(release) ? [UPDATE, RELEASE_NOTES, SKIP] : [OPEN_RELEASE_PAGE, SKIP];
    const choice = await vscode.window.showInformationMessage(
      `AI Engineer Coach v${release.version} is available. You have v${this.build.version}.`, ...actions);
    await this.handleChoice(choice, release);
  }

  private async handleChoice(choice: string | undefined, release: UpdateCandidate): Promise<void> {
    switch (choice) {
      case UPDATE:
      case INSTALL:
        await this.installUpdate(release);
        return;
      case RELEASE_NOTES:
      case OPEN_RELEASE_PAGE:
        await vscode.env.openExternal(vscode.Uri.parse(release.releaseUrl));
        return;
      case SKIP:
        await this.writeState({ skippedVersion: release.version });
        if (this.revealedVersion === release.version) this.revealedVersion = undefined;
        runtimeDebug('update', 'skip', `version=${release.version}`);
        this.refresh();
        return;
      default:
        return;
    }
  }

  private async installUpdate(release: UpdateCandidate): Promise<void> {
    if (this.installing) return;
    if (!this.canInstall(release)) {
      await vscode.env.openExternal(vscode.Uri.parse(release.releaseUrl));
      return;
    }
    this.installing = true;
    this.setStatus({ state: 'updating', latest: release.version });
    let failure: { error: unknown } | undefined;
    try {
      await this.downloadAndInstall(release);
    } catch (err: unknown) {
      failure = { error: err };
    } finally {
      this.installing = false;
    }
    if (!failure) {
      await this.writeState({ installedVersion: release.version, installedLocation: this.location });
      runtimeDebug('update', 'installed', `version=${release.version}`);
      this.refresh();
      await this.offerReload(release.version);
      return;
    }
    this.refresh();
    if (isAbort(failure.error)) {
      runtimeDebug('update', 'install-cancelled', `version=${release.version}`);
      return;
    }
    const reason = failure.error instanceof UpdateDownloadError ? failure.error.message : describeNetworkError(failure.error);
    runtimeDebug('update', 'install-failed', `version=${release.version} reason=${reason}`);
    const choice = await vscode.window.showErrorMessage(
      `Couldn't install AI Engineer Coach v${release.version}: ${reason}.`, OPEN_RELEASE_PAGE);
    if (choice === OPEN_RELEASE_PAGE) await vscode.env.openExternal(vscode.Uri.parse(release.releaseUrl));
  }

  /** Downloads and verifies the package, hands it to VS Code, and deletes it again. */
  private async downloadAndInstall(release: UpdateCandidate): Promise<void> {
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
            fetch: this.fetchImpl,
            candidate: release,
            endpoints: this.endpoints,
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
          file = await saveDownload(await this.downloadDirectory(), release.vsix.name, bytes);
          await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(file));
        } finally {
          cancellation.dispose();
        }
      });
    } finally {
      if (file) await fs.rm(file, { force: true }).catch(() => undefined);
    }
  }

  private async offerReload(version: string): Promise<void> {
    const choice = await vscode.window.showInformationMessage(
      `AI Engineer Coach v${version} is installed. Reload the window to start using it.`, RELOAD_WINDOW);
    if (choice === RELOAD_WINDOW) await this.reloadAfterUpdate();
  }

  private async downloadDirectory(): Promise<string> {
    if (this.downloadDir) return this.downloadDir();
    // VS Code installs a VSIX only from file: (or vscode-remote:) URIs.
    if (this.context.globalStorageUri.scheme === 'file') return path.join(this.context.globalStorageUri.fsPath, 'updates');
    return fs.mkdtemp(path.join(os.tmpdir(), 'ai-engineer-coach-update-'));
  }

  /** Removes packages left behind by a crash or an interrupted install. */
  private async purgeStaleDownloads(): Promise<void> {
    if (!this.downloadDir && this.context.globalStorageUri.scheme !== 'file') return;
    await purgeStaleDownloads(await this.downloadDirectory(), this.now());
  }

  /** The installed build is running now, so "reload to update" no longer applies. */
  private async forgetInstalledMarker(): Promise<void> {
    const state = this.readState();
    if (state.installedVersion && state.installedLocation === this.location
      && !isNewerVersion(state.installedVersion, this.build.version)) {
      await this.writeState({ installedVersion: undefined, installedLocation: undefined });
      this.refresh();
    }
  }
}

let currentService: UpdateService | undefined;

/** The update service of this window, for the dashboard and the activity-bar view. */
export function getUpdateService(): UpdateService | undefined {
  return currentService;
}

export function registerUpdateCheck(context: vscode.ExtensionContext, options: UpdateServiceOptions = {}): UpdateService {
  const endpoints = options.endpoints ?? resolveFeedEndpoints();
  if (endpoints.test) runtimeDebug('update', 'test-origin', endpoints.apiBase);
  const service = new UpdateService(context, { ...options, endpoints });
  currentService = service;
  context.subscriptions.push(
    service,
    vscode.commands.registerCommand(CHECK_FOR_UPDATES_COMMAND, () => {
      runtimeDebug('extension', 'command-check-for-updates');
      return service.checkNow();
    }),
    vscode.commands.registerCommand(INSTALL_UPDATE_COMMAND, () => {
      runtimeDebug('extension', 'command-install-update');
      return service.promptInstall();
    }),
    { dispose: () => { if (currentService === service) currentService = undefined; } },
  );
  service.start();
  return service;
}
