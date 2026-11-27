/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import {
  announceUpdate,
  LAST_SEEN_CHANGES_KEY,
  registerWhatsNew,
  SHOW_RELEASE_NOTES_COMMAND,
  showReleaseNotes,
} from './whats-new-vscode';

interface MockState {
  entries: [string, number][];
  changelog: string;
  setting?: boolean;
  stats: unknown;
}

const mocks = vi.hoisted(() => {
  const state: MockState = { entries: [], changelog: '', stats: null };
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
    fs: {
      readDirectory: () => Promise.resolve(mocks.entries),
      readFile: () => Promise.resolve(new TextEncoder().encode(mocks.changelog)),
    },
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
  const state = new Map<string, unknown>(previous === undefined ? [] : [[LAST_SEEN_CHANGES_KEY, previous]]);
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
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-23T10:00:00Z'));
  mocks.entries = [['package.json', 1], ['changelog.md', 1], ['dist', 2]];
  mocks.changelog = '# Changelog\n\n## [Unreleased]\n\n## 2026-11-20\n\n- Newer\n\n## 2026-11-01\n\n- Older\n';
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
    expect(mocks.showWarningMessage).toHaveBeenCalledWith('This AI Engineer Coach build does not include a changelog.');
    expect(mocks.executeCommand).not.toHaveBeenCalled();
  });
});

describe('announceUpdate', () => {
  it('records the newest date silently on a fresh install', async () => {
    const { extensionContext, state } = fakeContext();
    await announceUpdate(extensionContext, '2026-11-01');
    expect(state.get(LAST_SEEN_CHANGES_KEY)).toBe('2026-11-01');
    expect(mocks.showInformationMessage).not.toHaveBeenCalled();
  });

  it('does nothing when the newest date is unchanged', async () => {
    const { context, extensionContext } = fakeContext('2026-11-01');
    await announceUpdate(extensionContext, '2026-11-01');
    expect(context.globalState.update).not.toHaveBeenCalled();
    expect(mocks.showInformationMessage).not.toHaveBeenCalled();
  });

  it('offers the changelog once for newer changes and opens it on request', async () => {
    mocks.showInformationMessage.mockResolvedValue("What's New");
    const { extensionContext, state } = fakeContext('2026-11-01');
    await announceUpdate(extensionContext, '2026-11-20');
    expect(state.get(LAST_SEEN_CHANGES_KEY)).toBe('2026-11-20');
    expect(mocks.showInformationMessage).toHaveBeenCalledWith(
      'AI Engineer Coach was updated with changes from 2026-11-20.', "What's New", "Don't Show Again");
    expect(mocks.executeCommand).toHaveBeenCalledWith('markdown.showPreview', CHANGELOG_URI);
  });

  it('reads the newest date from the bundled changelog', async () => {
    const { extensionContext, state } = fakeContext('2026-11-01');
    await announceUpdate(extensionContext);
    expect(state.get(LAST_SEEN_CHANGES_KEY)).toBe('2026-11-20');
    expect(mocks.showInformationMessage).toHaveBeenCalledOnce();
  });

  it('records nothing when the build has no dated changes', async () => {
    mocks.changelog = '# Changelog\n\n## [Unreleased]\n\n- Pending\n';
    const { context, extensionContext } = fakeContext('2026-11-01');
    await announceUpdate(extensionContext);
    mocks.entries = [['package.json', 1]];
    await announceUpdate(extensionContext);
    expect(context.globalState.update).not.toHaveBeenCalled();
    expect(mocks.showInformationMessage).not.toHaveBeenCalled();
  });

  it('turns the notification off globally on "Don\'t Show Again"', async () => {
    mocks.showInformationMessage.mockResolvedValue("Don't Show Again");
    await announceUpdate(fakeContext('2026-11-01').extensionContext, '2026-11-20');
    expect(mocks.updateSetting).toHaveBeenCalledWith('showReleaseNotesAfterUpdate', false, 1);
    expect(mocks.executeCommand).not.toHaveBeenCalled();
  });

  it('respects the setting but still records the date', async () => {
    mocks.setting = false;
    const { extensionContext, state } = fakeContext('2026-11-01');
    await announceUpdate(extensionContext, '2026-11-20');
    expect(state.get(LAST_SEEN_CHANGES_KEY)).toBe('2026-11-20');
    expect(mocks.showInformationMessage).not.toHaveBeenCalled();
  });

  it('stays quiet for an older build and keeps the newest date for the next upgrade', async () => {
    const { context, extensionContext, state } = fakeContext('2026-11-20');
    await announceUpdate(extensionContext, '2026-11-01');
    expect(context.globalState.update).not.toHaveBeenCalled();
    expect(state.get(LAST_SEEN_CHANGES_KEY)).toBe('2026-11-20');
    await announceUpdate(extensionContext, '2026-11-20');
    expect(mocks.showInformationMessage).not.toHaveBeenCalled();
  });

  it('treats earlier dashboard use without a recorded date as having seen only the first changes', async () => {
    mocks.stats = { harnesses: ['VS Code'], savedAt: 1 };
    await announceUpdate(fakeContext().extensionContext, '2026-11-01');
    expect(mocks.showInformationMessage).toHaveBeenCalledWith(
      'AI Engineer Coach was updated with changes from 2026-11-01.', "What's New", "Don't Show Again");
  });
});

describe('announceUpdate with untrusted dates', () => {
  it('never records a future date from the changelog, so later updates are still offered', async () => {
    mocks.changelog = '# Changelog\n\n## 2099-01-01\n\n## 2026-11-20\n\n- Newer\n\n## 2026-11-01\n\n- Older\n';
    const { extensionContext, state } = fakeContext('2026-11-01');
    await announceUpdate(extensionContext);
    expect(state.get(LAST_SEEN_CHANGES_KEY)).toBe('2026-11-20');
    await announceUpdate(extensionContext, '2026-11-22');
    expect(state.get(LAST_SEEN_CHANGES_KEY)).toBe('2026-11-22');
    expect(mocks.showInformationMessage).toHaveBeenCalledTimes(2);
  });

  it('replaces a future date recorded earlier instead of keeping it forever', async () => {
    mocks.stats = { harnesses: ['VS Code'], savedAt: 1 };
    const { extensionContext, state } = fakeContext('2099-01-01');
    await announceUpdate(extensionContext, '2026-11-20');
    expect(state.get(LAST_SEEN_CHANGES_KEY)).toBe('2026-11-20');
    expect(mocks.showInformationMessage).toHaveBeenCalledWith(
      'AI Engineer Coach was updated with changes from 2026-11-20.', "What's New", "Don't Show Again");
  });

  it('records nothing for an untrusted date passed in', async () => {
    const { context, extensionContext } = fakeContext('2026-11-01');
    await announceUpdate(extensionContext, '2026-02-30');
    await announceUpdate(extensionContext, '2099-01-01');
    expect(context.globalState.update).not.toHaveBeenCalled();
  });
});

describe('announceUpdate while a dashboard syncs', () => {
  it('does not count stats that a dashboard writes while the date is being recorded', async () => {
    const { context, extensionContext } = fakeContext();
    let finishUpdate = () => {};
    context.globalState.update.mockImplementationOnce(() => new Promise<void>(resolve => { finishUpdate = resolve; }));
    const announcing = announceUpdate(extensionContext);
    await vi.waitFor(() => expect(context.globalState.update).toHaveBeenCalled());
    mocks.stats = { harnesses: ['VS Code'], savedAt: 2 }; // A fresh install's first sync finishes meanwhile.
    finishUpdate();
    await announcing;
    expect(context.globalState.update).toHaveBeenCalledWith(LAST_SEEN_CHANGES_KEY, '2026-11-20');
    expect(mocks.showInformationMessage).not.toHaveBeenCalled();
  });
});

describe('registerWhatsNew', () => {
  it('registers the What\'s New command against the extension folder', async () => {
    const { context, extensionContext } = fakeContext('2026-11-20');
    registerWhatsNew(extensionContext);
    expect(context.subscriptions).toHaveLength(1);
    const [command, callback] = mocks.registerCommand.mock.calls[0];
    expect(command).toBe(SHOW_RELEASE_NOTES_COMMAND);
    expect(command).toBe('aiEngineerCoach.showReleaseNotes');
    await callback();
    expect(mocks.executeCommand).toHaveBeenCalledWith('markdown.showPreview', CHANGELOG_URI);
  });
});
