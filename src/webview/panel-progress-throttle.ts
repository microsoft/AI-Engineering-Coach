/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Throttle for progress messages from the extension host to the webview: routine updates go at
 * most once per interval, structural ones (a new phase, the tile plan, a finished workspace,
 * 100%) go at once. A queued update is sent before the next immediate one rather than dropped,
 * because it can carry state later messages don't repeat, such as the parser's final totals. */

export interface ThrottledProgress {
  phase: number;
  pct: number;
  workspacePlan?: unknown;
  workspaceDone?: unknown;
}

export interface ProgressThrottle<T> {
  push(progress: T): void;
  dispose(): void;
}

export function createProgressThrottle<T extends ThrottledProgress>(
  send: (progress: T) => void,
  intervalMs = 250,
  now: () => number = () => Date.now(),
): ProgressThrottle<T> {
  let lastSentAt = 0;
  let lastPhase: number | undefined;
  let queued: T | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const deliver = (progress: T): void => {
    send(progress);
    lastSentAt = now();
  };
  const flush = (): void => {
    clearTimeout(timer);
    timer = undefined;
    const pending = queued;
    queued = undefined;
    if (pending) deliver(pending);
  };

  return {
    push(progress: T): void {
      const immediate = progress.phase !== lastPhase || !!progress.workspacePlan || !!progress.workspaceDone || progress.pct >= 100;
      lastPhase = progress.phase;
      if (immediate) {
        flush();
        deliver(progress);
        return;
      }
      queued = progress;
      const wait = intervalMs - (now() - lastSentAt);
      if (wait <= 0) flush();
      else timer ??= setTimeout(flush, wait);
    },
    dispose(): void {
      clearTimeout(timer);
      timer = undefined;
      queued = undefined;
    },
  };
}
