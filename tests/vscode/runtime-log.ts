/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Reads the extension's runtime.log in the desktop suites. Entries start with an ISO timestamp;
 * the stack lines of a logged error belong to the entry above them. */

/**
 * Separates what the extension host that "Reload Window" replaced logged once the reload was
 * requested: VS Code cancels that host's pending calls, such as unregistering its built-in
 * authentication providers, and built-in extensions can fail while their language servers exit,
 * before or after this extension's own deactivation.
 */
export function splitAtReload(log: string): { normal: string[]; replacedHostShutdown: string[] } {
  const entries = log.split(/\r?\n(?=\d{4}-\d{2}-\d{2}T)/);
  const replacedPid = /pid=(\d+)/.exec(entries.find(entry => /\[update\] reload \|/.test(entry)) ?? '')?.[1];
  const normal: string[] = [];
  const replacedHostShutdown: string[] = [];
  let shuttingDown = false;
  for (const entry of entries) {
    const pid = /pid=(\d+)/.exec(entry)?.[1];
    if (pid === replacedPid && /\[update\] reload \|/.test(entry)) shuttingDown = true;
    (shuttingDown && pid === replacedPid ? replacedHostShutdown : normal).push(entry);
  }
  return { normal, replacedHostShutdown };
}

/** True when every frame of a logged stack is in VS Code's own code (`resources/app`) or in Node. */
function raisedInsideVsCode(entry: string): boolean {
  const locations = entry.split(/\r?\n/).slice(1).flatMap(line => {
    const frame = /^\s*at (?:.*\((.+)\)|(.+))$/.exec(line);
    return frame ? [frame[1] ?? frame[2]] : [];
  });
  return locations.length > 0
    && locations.every(location => location.startsWith('node:') || /[\\/]resources[\\/]app[\\/]/i.test(location));
}

/** Errors in the replaced host's shutdown other than cancellations and failures inside VS Code. */
export function unexpectedShutdownErrors(replacedHostShutdown: string[]): string[] {
  return replacedHostShutdown.filter(entry => /uncaught-exception|unhandled-rejection/.test(entry)
    && !/unhandled-rejection \|[^\n]*\| Canceled: Canceled/.test(entry) && !raisedInsideVsCode(entry));
}
