/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { splitAtReload, unexpectedShutdownErrors } from './runtime-log';

const APP = 'file:///private/var/folders/T/aec/runtime/Visual%20Studio%20Code.app/Contents/Resources/app';
// Logged on macOS while "Reload Window" replaced the extension host (VS Code 1.144).
const JSON_CLIENT_EXIT = [
  '2026-10-31T18:25:26.001Z pid=6043 [extension-host] uncaught-exception | rss=230.0MB | Error: Channel has been closed',
  `\tat i (${APP}/out/vs/workbench/api/node/extensionHostProcess.js:172:3935)`,
  `\tat PT.info (${APP.replace('file://', '')}/extensions/json-language-features/client/dist/node/jsonClientMain.js:14:709)`,
  '\tat ChildProcess.emit (node:events:514:28)',
  '\tat ChildProcess._handle.onexit (node:internal/child_process:324:12)',
].join('\n');

function log(...entries: string[]): string {
  return entries.join('\n');
}

describe('splitAtReload', () => {
  it('separates what the replaced host logs once the reload is requested, before or after deactivation', () => {
    const reload = '2026-10-31T18:25:20.000Z pid=6043 [update] reload | version=0.1.1';
    const deactivate = '2026-10-31T18:25:27.000Z pid=6043 [extension] deactivate |';
    const { normal, replacedHostShutdown } = splitAtReload(log(
      '2026-10-31T18:25:10.000Z pid=6043 [update] installed | version=0.1.1',
      reload,
      JSON_CLIENT_EXIT,
      deactivate,
      '2026-10-31T18:25:28.000Z pid=7001 [extension] activate | v0.1.1',
    ));
    expect(normal).toEqual([
      '2026-10-31T18:25:10.000Z pid=6043 [update] installed | version=0.1.1',
      '2026-10-31T18:25:28.000Z pid=7001 [extension] activate | v0.1.1',
    ]);
    expect(replacedHostShutdown).toEqual([reload, JSON_CLIENT_EXIT, deactivate]);
  });

  it('keeps everything in the normal log when the window never reloaded', () => {
    expect(splitAtReload(JSON_CLIENT_EXIT)).toEqual({ normal: [JSON_CLIENT_EXIT], replacedHostShutdown: [] });
  });
});

describe('unexpectedShutdownErrors', () => {
  it('allows cancellations and errors raised inside VS Code and its built-in extensions', () => {
    expect(unexpectedShutdownErrors([
      '2026-10-31T18:25:26.000Z pid=6043 [extension-host] unhandled-rejection | rss=1MB | Canceled: Canceled',
      JSON_CLIENT_EXIT,
    ])).toEqual([]);
  });

  it('reports errors that involve the extension or carry no stack', () => {
    const ours = [
      '2026-10-31T18:25:26.002Z pid=6043 [extension-host] uncaught-exception | rss=1MB | Error: boom',
      '\tat handle (/tmp/aec/extensions/ai-engineer-coach.ai-engineer-coach-0.1.0/dist/extension.js:1:2)',
      `\tat i (${APP}/out/vs/workbench/api/node/extensionHostProcess.js:172:3935)`,
    ].join('\n');
    const withoutStack = '2026-10-31T18:25:26.003Z pid=6043 [extension-host] unhandled-rejection | rss=1MB | oops';
    expect(unexpectedShutdownErrors([ours, withoutStack, JSON_CLIENT_EXIT])).toEqual([ours, withoutStack]);
  });
});
