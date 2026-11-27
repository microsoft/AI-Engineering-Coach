/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { error } from 'vscode-extension-tester';
import { Dashboard } from './dashboard';

const mocks = vi.hoisted(() => ({
  executeCommand: vi.fn<(title: string) => Promise<void>>(),
  /** What the palette lists for a command it was given (`>` + title), and whether typing into it works. */
  listed: vi.fn<(text: string) => Promise<string[]>>(),
  defaultContent: vi.fn<() => Promise<void>>(),
  switchToFrame: vi.fn<(timeout: number) => Promise<void>>(),
  documentId: vi.fn<() => Promise<string>>(),
  editorReady: vi.fn<() => Promise<boolean>>(),
  takeScreenshot: vi.fn<() => Promise<string>>(),
  executeScript: vi.fn<() => Promise<string>>(),
  saveSnapshot: vi.fn<typeof import('./snapshots')['saveSnapshot']>(),
  wait: vi.fn<(condition: () => Promise<boolean>, timeout: number, message?: string) => Promise<boolean>>(),
  findWebElement: vi.fn<() => Promise<unknown>>(),
  findWebElements: vi.fn<() => Promise<{ getText(): Promise<string> }[]>>(),
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
    } } },
    Workbench: class {
      openCommandPrompt = () => {
        let text = '';
        return Promise.resolve({
          setText: (value: string) => { text = value; return Promise.resolve(); },
          getQuickPicks: async () => (await mocks.listed(text)).map(label => ({ getLabel: () => Promise.resolve(label) })),
          isDisplayed: () => Promise.resolve(true),
          selectQuickPick: (label: string) => mocks.executeCommand(label),
          cancel: () => Promise.resolve(),
        });
      };
    },
    WebView: class {
      switchToFrame = mocks.switchToFrame;
      findWebElement = mocks.findWebElement;
      findWebElements = mocks.findWebElements;
    },
    until: { ...actual.until, elementLocated: () => mocks.editorReady },
  };
});

vi.mock('./snapshots', () => ({ saveSnapshot: mocks.saveSnapshot }));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.executeCommand.mockResolvedValue();
  mocks.listed.mockImplementation(text => Promise.resolve([text.replace(/^>/, '')]));
  mocks.defaultContent.mockResolvedValue();
  mocks.switchToFrame.mockResolvedValue();
  mocks.documentId.mockResolvedValue('initial-document');
  mocks.editorReady.mockResolvedValue(true);
  mocks.takeScreenshot.mockResolvedValue('captured-image');
  mocks.executeScript.mockResolvedValue('[]');
  mocks.saveSnapshot.mockResolvedValue();
  mocks.findWebElement.mockResolvedValue({});
  mocks.findWebElements.mockResolvedValue([{ getText: () => Promise.resolve('Changelog') }]);
  mocks.wait.mockImplementation(async (condition, _timeout, message) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (await condition()) return true;
    }
    throw new Error(message ?? 'Wait timed out');
  });
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('desktop webview synchronization', () => {
  it('runs a command only once the palette lists it, as it may not while the workbench is still starting', async () => {
    mocks.listed
      .mockRejectedValueOnce(new error.ElementNotInteractableError('the palette closed under the keystrokes'))
      .mockResolvedValueOnce([]);
    await new Dashboard().open();
    expect(mocks.listed).toHaveBeenCalledTimes(3);
    expect(mocks.executeCommand).toHaveBeenCalledExactlyOnceWith('AI Engineer Coach: Open Dashboard');
  });

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

describe('reading another webview, such as the What\'s New preview', () => {
  it.each([
    ['wrapped stale outer frame', new Error('WebviewMixin.switchToFrame: outer iframe became stale during frame switch. See the upstream issue.')],
    ['stale frame', new error.StaleElementReferenceError('The preview was replaced')],
    ['missing marker', new error.NoSuchElementError('The preview is still rendering')],
  ])('retries a %s and returns to the workbench in between', async (_name, failure) => {
    mocks.switchToFrame.mockRejectedValueOnce(failure);
    expect(await new Dashboard().markdownPreviewHeadings()).toEqual(['Changelog']);
    expect(mocks.switchToFrame).toHaveBeenCalledTimes(2);
    expect(mocks.defaultContent.mock.invocationCallOrder.some(order =>
      order > mocks.switchToFrame.mock.invocationCallOrder[0] && order < mocks.switchToFrame.mock.invocationCallOrder[1])).toBe(true);
  });

  it('gives each attempt only the remaining deadline', async () => {
    mocks.switchToFrame.mockRejectedValueOnce(new error.StaleElementReferenceError());
    vi.spyOn(Date, 'now').mockReturnValueOnce(1000).mockReturnValueOnce(1000).mockReturnValue(1100);
    await new Dashboard().markdownPreviewHeadings();
    expect(mocks.switchToFrame.mock.calls).toEqual([[60_000], [59_900]]);
  });

  it('does not retry unexpected driver failures', async () => {
    const failure = new Error('Driver session disconnected');
    mocks.switchToFrame.mockRejectedValueOnce(failure);
    await expect(new Dashboard().markdownPreviewHeadings()).rejects.toBe(failure);
    expect(mocks.switchToFrame).toHaveBeenCalledTimes(1);
    expect(mocks.defaultContent).toHaveBeenCalled();
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
