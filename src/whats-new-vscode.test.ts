/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import {
  announceUpdate,
  LAST_SEEN_VERSION_KEY,
  registerWhatsNew,
  SHOW_RELEASE_NOTES_COMMAND,
  showReleaseNotes,
} from './whats-new-vscode';

interface MockState {
  entries: [string, number][];
  setting?: boolean;
  stats: unknown;
}

const mocks = vi.hoisted(() => {
  const state: MockState = { entries: [], stats: null };
  return Object.assign(state, {
    executeCommand: vi.fn<(command: string, ...args: unknown[]) => Promise<unknown>>(),
    registerCommand: vi.fn<(command: string, callback: () => unknown) => { dispose(): void }>(),
    showInformationMessage: vi.fn<(message: string, ...items: string[]) => Promise<string | undefined>>(),
    showWarningMessage: vi.fn<(message: string) => Promise<undefined>>(),
    showTextDocument: vi.fn<(uri: unknown, options: unknown) => Promise<void>>(),
    updateSetting: vi.fn<(key: string, value: unknown, target: number) => Promise<void>>(),
  });
});

vi.mock('vscode', () => ({
  FileType: { File: 1, Directory: 2 },
  ConfigurationTarget: { Global: 1 },
  Uri: { joinPath: (base: { path: string }, ...segments: string[]) => ({ path: [base.path, ...segments].join('/') }) },
  commands: { executeCommand: mocks.executeCommand, registerCommand: mocks.registerCommand },
  window: {
    showInformationMessage: mocks.showInformationMessage,
    showWarningMessage: mocks.showWarningMessage,
    showTextDocument: mocks.showTextDocument,
  },
  workspace: {
    fs: { readDirectory: () => Promise.resolve(mocks.entries) },
    getConfiguration: (section: string) => ({
      get: (key: string, fallback: boolean) => (section === 'aiEngineerCoach' && key === 'showReleaseNotesAfterUpdate'
        ? mocks.setting ?? fallback : fallback),
      update: mocks.updateSetting,
    }),
  },
}));
vi.mock('./core/cache', () => ({ loadSidebarStats: () => mocks.stats }));
vi.mock('./core/runtime-debug', () => ({ runtimeDebug: () => {} }));

const EXTENSION_URI = { path: '/extension' };
const CHANGELOG_URI = { path: '/extension/changelog.md' };

function fakeContext(previous?: string) {
  const state = new Map<string, unknown>(previous === undefined ? [] : [[LAST_SEEN_VERSION_KEY, previous]]);
  const context = {
    extensionUri: EXTENSION_URI,
    subscriptions: [] as { dispose(): void }[],
    globalState: {
      get: (key: string) => state.get(key),
      update: vi.fn((key: string, value: unknown) => { state.set(key, value); return Promise.resolve(); }),
    },
  };
  return { context, extensionContext: context as unknown as vscode.ExtensionContext, state };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.entries = [['package.json', 1], ['changelog.md', 1], ['dist', 2]];
  mocks.setting = undefined;
  mocks.stats = null;
  mocks.executeCommand.mockResolvedValue(undefined);
  mocks.showInformationMessage.mockResolvedValue(undefined);
  mocks.registerCommand.mockReturnValue({ dispose: () => {} });
});

describe('showReleaseNotes', () => {
  it('opens the packaged changelog in the Markdown preview', async () => {
    await showReleaseNotes(EXTENSION_URI as unknown as vscode.Uri);
    expect(mocks.executeCommand).toHaveBeenCalledWith('markdown.showPreview', CHANGELOG_URI);
    expect(mocks.showTextDocument).not.toHaveBeenCalled();
  });

  it('finds the repository spelling when running from source', async () => {
    mocks.entries = [['CHANGELOG.md', 1], ['changelog.md', 2]];
    await showReleaseNotes(EXTENSION_URI as unknown as vscode.Uri);
    expect(mocks.executeCommand).toHaveBeenCalledWith('markdown.showPreview', { path: '/extension/CHANGELOG.md' });
  });

  it('falls back to a text editor when the Markdown preview is unavailable', async () => {
    mocks.executeCommand.mockRejectedValue(new Error("command 'markdown.showPreview' not found"));
    await showReleaseNotes(EXTENSION_URI as unknown as vscode.Uri);
    expect(mocks.showTextDocument).toHaveBeenCalledWith(CHANGELOG_URI, { preview: true });
  });

  it('warns when the build has no changelog', async () => {
    mocks.entries = [['package.json', 1]];
    await showReleaseNotes(EXTENSION_URI as unknown as vscode.Uri);
    expect(mocks.showWarningMessage).toHaveBeenCalledWith('This AI Engineer Coach build does not include release notes.');
    expect(mocks.executeCommand).not.toHaveBeenCalled();
  });
});

describe('announceUpdate', () => {
  it('records the version silently on a fresh install', async () => {
    const { extensionContext, state } = fakeContext();
    await announceUpdate(extensionContext, '0.2.0');
    expect(state.get(LAST_SEEN_VERSION_KEY)).toBe('0.2.0');
    expect(mocks.showInformationMessage).not.toHaveBeenCalled();
  });

  it('does nothing when the version is unchanged', async () => {
    const { context, extensionContext } = fakeContext('0.2.0');
    await announceUpdate(extensionContext, '0.2.0');
    expect(context.globalState.update).not.toHaveBeenCalled();
    expect(mocks.showInformationMessage).not.toHaveBeenCalled();
  });

  it('offers the release notes once after an upgrade and opens them on request', async () => {
    mocks.showInformationMessage.mockResolvedValue("What's New");
    const { extensionContext, state } = fakeContext('0.2.0');
    await announceUpdate(extensionContext, '0.4.0');
    expect(state.get(LAST_SEEN_VERSION_KEY)).toBe('0.4.0');
    expect(mocks.showInformationMessage).toHaveBeenCalledWith(
      'AI Engineer Coach was updated to v0.4.0.', "What's New", "Don't Show Again");
    expect(mocks.executeCommand).toHaveBeenCalledWith('markdown.showPreview', CHANGELOG_URI);
  });

  it('turns the notification off globally on "Don\'t Show Again"', async () => {
    mocks.showInformationMessage.mockResolvedValue("Don't Show Again");
    await announceUpdate(fakeContext('0.2.0').extensionContext, '0.4.0');
    expect(mocks.updateSetting).toHaveBeenCalledWith('showReleaseNotesAfterUpdate', false, 1);
    expect(mocks.executeCommand).not.toHaveBeenCalled();
  });

  it('respects the setting but still records the version', async () => {
    mocks.setting = false;
    const { extensionContext, state } = fakeContext('0.2.0');
    await announceUpdate(extensionContext, '0.4.0');
    expect(state.get(LAST_SEEN_VERSION_KEY)).toBe('0.4.0');
    expect(mocks.showInformationMessage).not.toHaveBeenCalled();
  });

  it('stays quiet after a downgrade', async () => {
    await announceUpdate(fakeContext('0.4.0').extensionContext, '0.2.0');
    expect(mocks.showInformationMessage).not.toHaveBeenCalled();
  });

  it('treats earlier dashboard use without a recorded version as an upgrade from 0.1.0', async () => {
    mocks.stats = { harnesses: ['VS Code'], savedAt: 1 };
    await announceUpdate(fakeContext().extensionContext, '0.2.0');
    expect(mocks.showInformationMessage).toHaveBeenCalledWith(
      'AI Engineer Coach was updated to v0.2.0.', "What's New", "Don't Show Again");
  });
});

describe('registerWhatsNew', () => {
  it('registers the What\'s New command against the extension folder', async () => {
    const { context, extensionContext } = fakeContext('0.0.0');
    registerWhatsNew(extensionContext);
    expect(context.subscriptions).toHaveLength(1);
    const [command, callback] = mocks.registerCommand.mock.calls[0];
    expect(command).toBe(SHOW_RELEASE_NOTES_COMMAND);
    expect(command).toBe('aiEngineerCoach.showReleaseNotes');
    await callback();
    expect(mocks.executeCommand).toHaveBeenCalledWith('markdown.showPreview', CHANGELOG_URI);
  });
});
