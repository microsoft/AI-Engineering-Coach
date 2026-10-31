/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { after, before, describe, it } from 'mocha';
import { By } from 'vscode-extension-tester';
import { Dashboard } from '../dashboard';
import { fixturePaths, readInstalledBuild, scenarioContext, type InstalledBuild } from '../fixtures';
import { setUpdateServerMode, UPDATE_TEST_ORIGIN_ENV, updateServerRequests } from '../update-server';

const escape = (text: string) => text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

/**
 * Splits runtime.log into entries (stack lines belong to the entry above) and separates the
 * shutdown of the extension host that "Reload Window" replaced: VS Code cancels that host's
 * pending calls, including its built-in authentication providers' unregistration.
 */
function splitAtReload(log: string): { normal: string[]; replacedHostShutdown: string[] } {
  const entries = log.split(/\r?\n(?=\d{4}-\d{2}-\d{2}T)/);
  const replacedPid = /pid=(\d+)/.exec(entries.find(entry => /\[update\] reload \|/.test(entry)) ?? '')?.[1];
  const normal: string[] = [];
  const replacedHostShutdown: string[] = [];
  let shuttingDown = false;
  for (const entry of entries) {
    const pid = /pid=(\d+)/.exec(entry)?.[1];
    if (pid === replacedPid && /\[extension\] deactivate \|/.test(entry)) shuttingDown = true;
    (shuttingDown && pid === replacedPid ? replacedHostShutdown : normal).push(entry);
  }
  return { normal, replacedHostShutdown };
}

describe('Packaged VSIX update from a local release server', () => {
  const dashboard = new Dashboard();
  const { root } = scenarioContext();
  const origin = process.env[UPDATE_TEST_ORIGIN_ENV] ?? '';
  const next = process.env.AIC_E2E_UPDATE_VERSION ?? '';
  let build: InstalledBuild;
  let available: RegExp;

  async function installedFolders(): Promise<string[]> {
    return (await fs.readdir(fixturePaths(root).extensions, { withFileTypes: true }))
      .filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  }

  before(async () => {
    assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/, 'The update suite must use the loopback release server');
    assert.match(next, /^\d+\.\d+\.\d+$/);
    build = await readInstalledBuild(root);
    available = new RegExp(`^AI Engineer Coach v${escape(next)} is available\\. You have v${escape(build.version)}\\.$`);
    // Activate the extension through its view, as a user would.
    await dashboard.inActivityBarView(async view => (await view.findWebElement(By.css('p#build-info'))).getText());
  });

  after(async () => {
    // A missing log means the extension never activated; the failing hook or test already says why.
    const log = await fs.readFile(fixturePaths(root).runtimeLog, 'utf8').catch(() => '');
    const { normal, replacedHostShutdown } = splitAtReload(log);
    const problems = normal.filter(entry => /uncaught-exception|unhandled-rejection/.test(entry));
    assert.deepEqual(problems, [], 'The extension must not leave uncaught exceptions or unhandled rejections');
    const unexpected = replacedHostShutdown.filter(entry =>
      /uncaught-exception/.test(entry) || (/unhandled-rejection/.test(entry) && !/unhandled-rejection \|[^\n]*\| Canceled: Canceled/.test(entry)));
    assert.deepEqual(unexpected, [], 'Only cancellations may happen while the replaced extension host shuts down');
  });

  it('refuses a download whose checksum does not match the release', async () => {
    await setUpdateServerMode(origin, 'bad-digest');
    await dashboard.runCommand('Check for Updates');
    await dashboard.notificationAction(available, 'Update');
    const failure = await dashboard.waitForNotification(new RegExp(
      `^Couldn't install AI Engineer Coach v${escape(next)}: the download's SHA-256 checksum doesn't match the release\\.$`));
    assert.ok((await failure.getActions()).length > 0, 'The failure should offer the release page');
    await dashboard.snapshot('01-update-refused', 'Update refused: the downloaded VSIX did not match the release checksum');
    await failure.dismiss();
    assert.equal((await installedFolders()).length, 1, 'Nothing may be installed after a failed verification');
  });

  it('installs the newer release after Update and reloads into it', async () => {
    await setUpdateServerMode(origin, 'good');
    await dashboard.runCommand('Check for Updates');
    await dashboard.notificationAction(available, 'Update');
    const installed = await dashboard.waitForNotification(new RegExp(
      `^AI Engineer Coach v${escape(next)} is installed\\. Reload the window to start using it\\.$`));
    await dashboard.snapshot('02-update-installed', `Update installed: v${next} is ready after a reload`);
    assert.ok((await installedFolders()).some(name => name.endsWith(`-${next}`)), `v${next} should be installed`);

    await dashboard.expectWindowReload(() => installed.takeAction('Reload Window'));
    const line = await dashboard.inActivityBarView(async view => (await view.findWebElement(By.css('p#build-info'))).getText());
    assert.match(line, new RegExp(`^v${escape(next)} \\(dev\\) · `), `The reloaded window should run v${next}: ${line}`);
    // What's New announces the new version on its own after the reload.
    await dashboard.waitForNotification(new RegExp(`^AI Engineer Coach was updated to v${escape(next)}\\.$`));
    await dashboard.snapshot('03-update-reloaded', `Reloaded into v${next}; What's New offers the release notes`);

    const requests = await updateServerRequests(origin);
    assert.deepEqual(requests.map(request => request.path), [
      '/repos/microsoft/AI-Engineering-Coach/releases/latest',
      `/microsoft/AI-Engineering-Coach/releases/download/v${next}/ai-engineer-coach-${next}.vsix`,
      `/release-assets/ai-engineer-coach-${next}.vsix`,
      '/repos/microsoft/AI-Engineering-Coach/releases/latest',
      `/microsoft/AI-Engineering-Coach/releases/download/v${next}/ai-engineer-coach-${next}.vsix`,
      `/release-assets/ai-engineer-coach-${next}.vsix`,
    ], 'Only the two checks and their downloads may reach the release server');
    assert.ok(requests.every(request => request.userAgent === 'AI-Engineer-Coach-Update-Check' && !request.authorization),
      'Requests must be anonymous and carry only the constant User-Agent');

    const runtime = await fs.readFile(fixturePaths(root).runtimeLog, 'utf8');
    assert.match(runtime, new RegExp(String.raw`\[update\] check \|[^\n]*manual=true result=release latest=${escape(next)}`));
    assert.match(runtime, new RegExp(String.raw`\[update\] install-failed \|[^\n]*version=${escape(next)}`));
    assert.match(runtime, new RegExp(String.raw`\[update\] installed \|[^\n]*version=${escape(next)}`));
  });
});
