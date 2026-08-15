/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Out-of-process parse worker host: forks parse-worker.js, applies chunked-IPC backpressure,
 * assembles the streamed result, and retries once at a higher heap ceiling on OOM (issue #106).
 * Extracted from parser.ts to isolate the child-process/IPC concern from in-process parsing. */

import * as path from 'path';
import { runtimeDebug } from './runtime-debug';
import { ChunkAssembler, type WorkerChunkPayload, type WorkerDonePayload } from './parse-chunking';
import { setMemoryCache, stripSessionsForMemory } from './cache';
import type { DirMetas, ParseResult } from './cache';
import type { ParseWarning } from './parser-shared';
import type { LoadProgress, ProgressCallback } from './parser';

const WORKER_MAX_OLD_SPACE_MB = 4096;
const RETRY_WORKER_MAX_OLD_SPACE_MB = 6144;

/** child_process.fork, narrowed to what the host uses. Injectable so the orchestration can be
 *  unit-tested against a fake child without spawning a real process. */
type ForkFn = typeof import('child_process').fork;

/** A worker failure is retryable (worth a second attempt at a higher heap ceiling) only when it
 *  looks like an out-of-memory / hard-abort death, not a deterministic parse error that would
 *  fail again. Kept pure and exported so the retry decision is unit-testable (issue #106). */
export function isRetryableWorkerError(message: string): boolean {
  return /heap out of memory|memory limit|sigabrt|sigkill|exited with code/i.test(message.toLowerCase());
}

/** The worker's `done` message is the chunking done payload plus worker-only dir fingerprints. */
type WorkerDoneMessagePayload = WorkerDonePayload & {
  dirMetas: DirMetas;
  parseWarnings?: ParseWarning[];
  parseWarningCounts?: { skippedFiles: number; skippedLines: number };
};

/** Surface any files the worker could not parse to the "AI Engineer Coach" output channel, so a
 *  silent partial parse becomes discoverable. runtimeDebug routes through the channel hook set up
 *  in extension.ts (View → Output → "AI Engineer Coach"). */
function logParseWarnings(warnings: ParseWarning[] | undefined): void {
  if (!warnings || warnings.length === 0) return;
  runtimeDebug('parser', 'parse-warnings', `${warnings.length} file(s) could not be parsed:`);
  for (const w of warnings) {
    runtimeDebug('parser', 'parse-warnings', `  [${w.scope}] ${w.file} — ${w.reason}`);
  }
}

export async function parseAllLogsViaWorker(
  logsDirs: string[],
  onProgress?: ProgressCallback,
  deps?: { fork?: ForkFn },
): Promise<ParseResult> {
  let forkFn: ForkFn;
  if (deps?.fork) {
    forkFn = deps.fork;
  } else {
    try {
      ({ fork: forkFn } = await import('child_process'));
    } catch {
      runtimeDebug('parser', 'child-process-unavailable');
      throw new Error('child process parsing is unavailable on this runtime');
    }
  }

  const workerPath = path.join(__dirname, 'parse-worker.js');
  const runChildAttempt = (maxOldSpaceMb: number, attempt: number): Promise<ParseResult> => {
    runtimeDebug('parser', 'child-start', `attempt=${attempt} logsDirs=${logsDirs.length} worker=${workerPath} maxOldSpaceMb=${maxOldSpaceMb}`);

    return new Promise((resolve, reject) => {
      const TIMEOUT_MS = 10 * 60_000;
      let child: import('child_process').ChildProcess;
      try {
        child = forkFn(workerPath, [], {
          execArgv: [
            `--max-old-space-size=${maxOldSpaceMb}`,
            // Expose global.gc so the worker can proactively reclaim transient parse garbage
            // before RSS reaches Electron's ~2GB allocator OOM ceiling (issue #106).
            '--expose-gc',
          ],
        });
      } catch {
        runtimeDebug('parser', 'child-constructor-failed', `attempt=${attempt}`);
        reject(new Error('failed to start parse worker child process'));
        return;
      }

      let lastPhase = -1;
      let lastWorkspaceLogged = 0;
      let settled = false;

      // Per-phase wall-clock accounting for the local sync-timing summary (issue #106 follow-up).
      const attemptStart = Date.now();
      let phaseStart = attemptStart;
      const phaseDurations = new Map<number, number>();
      const recordPhaseEnd = (phase: number): void => {
        if (phase < 0) return;
        phaseDurations.set(phase, (phaseDurations.get(phase) ?? 0) + (Date.now() - phaseStart));
        phaseStart = Date.now();
      };

      // Chunked-IPC assembler (issue #106, S1). Declared per-attempt so a retry starts fresh.
      const assembler = new ChunkAssembler();

      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill();
        fn();
      };

      const fail = (reason: string): void => {
        finish(() => reject(new Error(reason)));
      };

      const timer = setTimeout(() => {
        runtimeDebug('parser', 'child-timeout', `attempt=${attempt} timeoutMs=${TIMEOUT_MS}`);
        fail('parse worker timeout (10m)');
      }, TIMEOUT_MS);

      child.on('message', (msg: { type: 'progress'; progress: LoadProgress } | { type: 'chunk'; seq: number; payload: WorkerChunkPayload } | { type: 'done'; payload: WorkerDoneMessagePayload } | { type: 'error'; message?: string }) => {
        if (msg.type === 'progress') {
          if (msg.progress.phase !== lastPhase) {
            recordPhaseEnd(lastPhase);
            lastPhase = msg.progress.phase;
            runtimeDebug('parser', 'child-progress-phase', `attempt=${attempt} phase=${msg.progress.phase} detail=${msg.progress.detail || ''}`);
          }
          const match = msg.progress.detail?.match(/^(\d+)\/(\d+):/);
          if (match) {
            const current = Number(match[1]);
            const total = Number(match[2]);
            if (current >= lastWorkspaceLogged + 25 || current === total) {
              lastWorkspaceLogged = current;
              runtimeDebug('parser', 'child-progress-workspaces', `attempt=${attempt} ${current}/${total}`);
            }
          }
          onProgress?.(msg.progress);
          return;
        }

        if (msg.type === 'chunk') {
          assembler.addChunk(msg.payload);
          // Ack so the worker can release its in-flight window and emit the next chunk. Without
          // this backpressure the worker flushed the whole result into its native IPC buffer and
          // aborted with a native OOM (issue #106).
          try {
            child.send({ type: 'ack', seq: msg.seq });
          } catch {
            // Child already gone; the exit handler will settle the attempt.
          }
          return;
        }

        if (msg.type === 'done') {
          recordPhaseEnd(lastPhase);
          const assembled = assembler.finish(msg.payload);
          runtimeDebug('parser', 'child-done', `attempt=${attempt} chunks=${assembler.chunkCount} workspaces=${msg.payload.workspaces.length} sessions=${assembled.sessions.length}`);
          const phaseBreakdown = [...phaseDurations.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([phase, ms]) => `p${phase}=${ms}ms`)
            .join(' ');
          runtimeDebug('parser', 'worker-phase-timing',
            `attempt=${attempt} totalMs=${Date.now() - attemptStart} ${phaseBreakdown}`);
          logParseWarnings(msg.payload.parseWarnings);
          finish(() => {
            const result: ParseResult = {
              workspaces: assembled.workspaces,
              sessions: assembled.sessions,
              editLocIndex: assembled.editLocIndex,
              sessionSourceIndex: assembled.sessionSourceIndex,
              parseWarnings: msg.payload.parseWarningCounts ?? { skippedFiles: 0, skippedLines: 0 },
            };
            setMemoryCache(result, msg.payload.dirMetas);
            // Child already sent the stripped representation, but keep this idempotent.
            stripSessionsForMemory(result.sessions);
            resolve(result);
          });
          return;
        }

        const message = msg.message || 'parse worker failed';
        runtimeDebug('parser', 'child-error-message', `attempt=${attempt} ${message}`);
        fail(message);
      });

      child.on('error', (err: Error) => {
        runtimeDebug('parser', 'child-error-event', `attempt=${attempt} ${err.message}`);
        fail(err.message);
      });

      child.on('exit', (code, signal) => {
        runtimeDebug('parser', 'child-exit', `attempt=${attempt} code=${code} signal=${signal || ''}`.trim());
        if (!settled) {
          const reason = signal ? `Child process killed by ${signal}` : `Child process exited with code ${code}`;
          fail(reason);
        }
      });

      child.send({ logsDirs });
    });
  };

  try {
    return await runChildAttempt(WORKER_MAX_OLD_SPACE_MB, 1);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!isRetryableWorkerError(message)) throw error;
    runtimeDebug('parser', 'child-retry', `reason=${message} maxOldSpaceMb=${RETRY_WORKER_MAX_OLD_SPACE_MB}`);
    return runChildAttempt(RETRY_WORKER_MAX_OLD_SPACE_MB, 2);
  }
}
