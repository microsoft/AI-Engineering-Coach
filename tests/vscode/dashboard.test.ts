/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { error } from 'vscode-extension-tester';
import { Dashboard } from './dashboard';

const mocks = vi.hoisted(() => ({
  executeCommand: vi.fn<(title: string) => Promise<void>>(),
  defaultContent: vi.fn<() => Promise<void>>(),
  switchToFrame: vi.fn<(timeout: number) => Promise<void>>(),
  documentId: vi.fn<() => Promise<string>>(),
  editorReady: vi.fn<() => Promise<boolean>>(),
  takeScreenshot: vi.fn<() => Promise<string>>(),
  executeScript: vi.fn<() => Promise<string>>(),
  saveSnapshot: vi.fn<typeof import('./snapshots')['saveSnapshot']>(),
  wait: vi.fn<(condition: () => Promise<boolean>, timeout: number, message?: string) => Promise<boolean>>(),
  getNotifications: vi.fn<() => Promise<unknown[]>>(),
  centerNotifications: vi.fn<(type: unknown) => Promise<unknown[]>>(),
  waitForWorkbench: vi.fn<(timeout: number) => Promise<void>>(),
}));

vi.mock('vscode-extension-tester', async importOriginal => {
  const actual = await importOriginal<typeof import('vscode-extension-tester')>();
  return {
    ...actual,
    VSBrowser: { instance: { driver: {
      switchTo: () => ({ defaultContent: mocks.defaultContent }),
      findElement: () => ({ getId: mocks.documentId }),
      takeScreenshot: mocks.takeScreenshot,
      executeScript: mocks.executeScript,
      wait: mocks.wait,
    }, waitForWorkbench: mocks.waitForWorkbench } },
    Workbench: class {
      executeCommand = mocks.executeCommand;
      getNotifications = mocks.getNotifications;
      openNotificationsCenter = () => Promise.resolve({ getNotifications: mocks.centerNotifications });
    },
    WebView: class { switchToFrame = mocks.switchToFrame; },
    until: { ...actual.until, elementLocated: () => mocks.editorReady },
  };
});

vi.mock('./snapshots', () => ({ saveSnapshot: mocks.saveSnapshot }));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.executeCommand.mockResolvedValue();
  mocks.defaultContent.mockResolvedValue();
  mocks.switchToFrame.mockResolvedValue();
  mocks.documentId.mockResolvedValue('initial-document');
  mocks.editorReady.mockResolvedValue(true);
  mocks.takeScreenshot.mockResolvedValue('captured-image');
  mocks.executeScript.mockResolvedValue('[]');
  mocks.saveSnapshot.mockResolvedValue();
  mocks.waitForWorkbench.mockResolvedValue();
  mocks.getNotifications.mockResolvedValue([]);
  mocks.centerNotifications.mockResolvedValue([]);
  mocks.wait.mockImplementation(async (condition, _timeout, message) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (await condition()) return true;
    }
    throw new Error(message ?? 'Wait timed out');
  });
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('desktop webview synchronization', () => {
  it('opens the dashboard once and waits for its editor before entering the webview', async () => {
    await new Dashboard().open();
    expect(mocks.executeCommand).toHaveBeenCalledExactlyOnceWith('AI Engineer Coach: Open Dashboard');
    expect(mocks.editorReady.mock.invocationCallOrder[0]).toBeLessThan(mocks.switchToFrame.mock.invocationCallOrder[0]);
    expect(mocks.switchToFrame).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['stale frame', new error.StaleElementReferenceError('The inner frame was replaced')],
    ['wrapped stale outer frame', new Error('WebviewMixin.switchToFrame: outer iframe became stale during frame switch. See the upstream issue.')],
    ['missing frame', new error.NoSuchFrameError('The inner frame was removed')],
    ['missing document', new error.NoSuchElementError('The document was removed')],
  ])('reacquires a %s without executing the reload command again', async (_name, failure) => {
    const dashboard = new Dashboard();
    await dashboard.open();
    vi.clearAllMocks();
    mocks.documentId.mockResolvedValueOnce('initial-document').mockResolvedValue('replacement-document');
    mocks.switchToFrame.mockRejectedValueOnce(failure);

    await dashboard.command('Reload Data');

    expect(mocks.executeCommand).toHaveBeenCalledExactlyOnceWith('AI Engineer Coach: Reload Data');
    expect(mocks.switchToFrame).toHaveBeenCalledTimes(2);
    const resets = mocks.defaultContent.mock.invocationCallOrder;
    expect(resets.at(-1)).toBeGreaterThan(mocks.switchToFrame.mock.invocationCallOrder[0]);
    expect(resets.at(-1)).toBeLessThan(mocks.switchToFrame.mock.invocationCallOrder[1]);
  });

  it('does not accept the old document while a reload is still being delivered', async () => {
    const dashboard = new Dashboard();
    await dashboard.open();
    vi.clearAllMocks();
    mocks.documentId.mockResolvedValueOnce('initial-document')
      .mockResolvedValueOnce('initial-document').mockResolvedValue('replacement-document');

    await dashboard.command('Reload Data');

    expect(mocks.switchToFrame).toHaveBeenCalledTimes(2);
    expect(mocks.executeCommand).toHaveBeenCalledTimes(1);
  });

  it('uses the remaining deadline rather than restarting the timeout after a stale frame', async () => {
    mocks.switchToFrame.mockRejectedValueOnce(new error.StaleElementReferenceError());
    vi.spyOn(Date, 'now').mockReturnValueOnce(1000).mockReturnValueOnce(1000).mockReturnValue(1100);

    await new Dashboard().open();

    expect(mocks.switchToFrame.mock.calls).toEqual([[60_000], [59_900]]);
  });
});

describe('desktop notifications and window reloads', () => {
  const notification = (message: string | Error) => ({
    getMessage: message instanceof Error ? vi.fn().mockRejectedValue(message) : vi.fn().mockResolvedValue(message),
    takeAction: vi.fn().mockResolvedValue(undefined),
  });

  it('clicks the button of the matching toast, skipping stale ones', async () => {
    const match = notification('AI Engineer Coach v0.1.1 is available. You have v0.1.0.');
    mocks.getNotifications.mockResolvedValue([
      notification(new error.StaleElementReferenceError('The toast was replaced')), notification('Something else'), match,
    ]);
    await new Dashboard().notificationAction(/^AI Engineer Coach v0\.1\.1 is available\./, 'Update');
    expect(match.takeAction).toHaveBeenCalledExactlyOnceWith('Update');
    expect(mocks.centerNotifications).not.toHaveBeenCalled();
  });

  it('looks in the notification center once the toast has been hidden', async () => {
    const match = notification('AI Engineer Coach v0.1.1 is installed. Reload the window to start using it.');
    mocks.getNotifications.mockResolvedValue([]);
    mocks.wait.mockRejectedValueOnce(new error.TimeoutError('Waiting for the toast'));
    mocks.centerNotifications.mockResolvedValue([match]);
    expect(await new Dashboard().waitForNotification(/is installed/)).toBe(match);
  });

  it('reports a notification that never appeared', async () => {
    mocks.getNotifications.mockResolvedValue([]);
    mocks.wait.mockRejectedValueOnce(new error.TimeoutError('Waiting for the toast'));
    mocks.centerNotifications.mockResolvedValue([notification('Unrelated')]);
    await expect(new Dashboard().waitForNotification(/is available/)).rejects.toThrow('Expected a notification matching /is available/');
  });

  it('waits for a new document and the workbench after a window reload', async () => {
    mocks.documentId.mockResolvedValueOnce('before').mockResolvedValueOnce('before').mockResolvedValue('after');
    const trigger = vi.fn().mockResolvedValue(undefined);
    await new Dashboard().expectWindowReload(trigger);
    expect(trigger).toHaveBeenCalledTimes(1);
    expect(mocks.documentId).toHaveBeenCalledTimes(3);
    expect(mocks.waitForWorkbench).toHaveBeenCalledExactlyOnceWith(60_000);
  });
});

describe('desktop webview failures', () => {
  it('fails if a reload never replaces the document', async () => {
    const dashboard = new Dashboard();
    await dashboard.open();
    vi.clearAllMocks();

    await expect(dashboard.command('Reload Data')).rejects.toThrow('replacement webview');

    expect(mocks.executeCommand).toHaveBeenCalledTimes(1);
  });

  describe('desktop screenshot capture', () => {
    it('saves the real driver image into this suite artifact directory without changing frame context', async () => {
      vi.stubEnv('AIC_E2E_ARTIFACTS', 'isolated-artifacts');
      await new Dashboard().snapshot('01-dashboard', 'Known session counts');
      expect(mocks.takeScreenshot).toHaveBeenCalledTimes(1);
      expect(mocks.saveSnapshot).toHaveBeenCalledExactlyOnceWith(
        'isolated-artifacts', { name: '01-dashboard', title: 'Known session counts' }, 'captured-image',
      );
      expect(mocks.defaultContent).not.toHaveBeenCalled();
    });

    it('fails explicitly when screenshot capture fails', async () => {
      vi.stubEnv('AIC_E2E_ARTIFACTS', 'isolated-artifacts');
      mocks.takeScreenshot.mockRejectedValueOnce(new Error('Screenshot capture failed'));
      await expect(new Dashboard().snapshot('01-dashboard', 'Known session counts')).rejects.toThrow('Screenshot capture failed');
      expect(mocks.saveSnapshot).not.toHaveBeenCalled();
    });

    it('waits for changing canvas pixels to settle before taking the screenshot', async () => {
      vi.stubEnv('AIC_E2E_ARTIFACTS', 'isolated-artifacts');
      mocks.executeScript.mockResolvedValueOnce('drawing').mockResolvedValue('finished');
      await new Dashboard().snapshot('01-dashboard', 'Known session counts');
      expect(mocks.executeScript).toHaveBeenCalledTimes(3);
      expect(mocks.takeScreenshot.mock.invocationCallOrder[0]).toBeGreaterThan(mocks.executeScript.mock.invocationCallOrder[2]);
    });

    it('does not capture an unsettled chart as a finished milestone', async () => {
      vi.stubEnv('AIC_E2E_ARTIFACTS', 'isolated-artifacts');
      mocks.executeScript.mockResolvedValueOnce('frame-1').mockResolvedValueOnce('frame-2').mockResolvedValueOnce('frame-3');
      await expect(new Dashboard().snapshot('01-dashboard', 'Known session counts')).rejects.toThrow('Waiting for charts');
      expect(mocks.takeScreenshot).not.toHaveBeenCalled();
    });

    it('requires isolated artifact storage before capturing', async () => {
      vi.stubEnv('AIC_E2E_ARTIFACTS', undefined);
      await expect(new Dashboard().snapshot('01-dashboard', 'Known session counts')).rejects.toThrow('Missing isolated');
      expect(mocks.takeScreenshot).not.toHaveBeenCalled();
    });
  });

  it('does not retry unexpected driver failures', async () => {
    const failure = new Error('Driver session disconnected');
    mocks.switchToFrame.mockRejectedValueOnce(failure);

    await expect(new Dashboard().open()).rejects.toBe(failure);

    expect(mocks.switchToFrame).toHaveBeenCalledTimes(1);
  });

  it('does not retry a different ExTester frame error', async () => {
    const failure = new Error('WebviewMixin.switchToFrame: active-frame iframe was not found within 60000ms.');
    mocks.switchToFrame.mockRejectedValueOnce(failure);
    await expect(new Dashboard().open()).rejects.toBe(failure);
    expect(mocks.switchToFrame).toHaveBeenCalledTimes(1);
  });
});
