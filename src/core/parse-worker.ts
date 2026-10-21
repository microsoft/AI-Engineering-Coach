/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Parse worker entry point.
 * Supports both worker_threads and child-process IPC so parsing can run
 * in an isolated process with its own heap limit.
 */

import { parentPort } from 'worker_threads';
import { stripSessionsForMemory } from './cache';
import { emitResultChunks, DEFAULT_SESSION_CHUNK_SIZE } from './parse-chunking';
import { createAckWindow, shouldSendProgressImmediately } from './parse-worker-stream';
import { parseAllLogsAsyncDetailed, type LoadProgress } from './parser';
import { getParseWarningCounts, getParseWarnings, setCuriosityDetector } from './parser-shared';
import { detectCuriosity } from './curiosity';
import { installRuntimeDebugHooks, runtimeDebug } from './runtime-debug';
import { createTelemetrySampler } from './worker-telemetry';
import { extractSourceImages, loadSourceSession, type SessionSourceRequest } from './session-images';

interface ParseWorkerRequest {
  logsDirs?: string[];
}

/** Number of sessions per streamed IPC chunk (issue #106, S1). */
const SESSION_CHUNK_SIZE = DEFAULT_SESSION_CHUNK_SIZE;

/** Max unacked chunks allowed in flight before the worker pauses emitting (issue #106). This
 *  bounds how many serialized chunks can sit in the child's native IPC write buffer, preventing
 *  the native (off-heap) OOM abort that a busy/slow parent triggered when the whole result was
 *  flushed at once. */
const CHUNK_ACK_WINDOW = 4;

interface ProgressMessage {
  type: 'progress';
  progress: LoadProgress;
}

const port = parentPort;
const canUseProcessChannel = typeof process.send === 'function';

if (!port && !canUseProcessChannel) throw new Error('parse-worker: no parent channel');
setCuriosityDetector(detectCuriosity);

installRuntimeDebugHooks('parse-worker');
runtimeDebug('parse-worker', port ? 'thread-started' : 'process-started');

function send(msg: unknown): void {
  if (port) port.postMessage(msg);
  else if (canUseProcessChannel) process.send?.(msg);
}

function parseWorkerRequest(msg: unknown): ParseWorkerRequest {
  if (typeof msg !== 'object' || msg === null) return {};
  const candidate = msg as { logsDirs?: unknown };
  return {
    logsDirs: Array.isArray(candidate.logsDirs)
      ? candidate.logsDirs.filter((dir): dir is string => typeof dir === 'string')
      : undefined,
  };
}

/** Parent -> worker chunk acknowledgement (issue #106). Routed away from the request handler so
 *  it never re-triggers a parse. */
interface AckMessage { type: 'ack'; seq: number }
function isAckMessage(msg: unknown): msg is AckMessage {
  return (
    typeof msg === 'object' && msg !== null &&
    (msg as { type?: unknown }).type === 'ack' &&
    typeof (msg as { seq?: unknown }).seq === 'number'
  );
}

/** Set by the streaming step to receive chunk acks from the parent. */
let onAck: ((seq: number) => void) | null = null;

function isSessionSourceRequest(value: object): value is SessionSourceRequest {
  const candidate = value as Partial<SessionSourceRequest>;
  const source = candidate.source;
  return (candidate.type === 'session-detail' || (candidate.type === 'session-images' && typeof candidate.requestId === 'string'
    && (candidate.userEventId === undefined || typeof candidate.userEventId === 'string')
    && (candidate.requestIndex === undefined || (Number.isSafeInteger(candidate.requestIndex) && candidate.requestIndex >= 0))))
    && typeof candidate.sessionId === 'string'
    && typeof source === 'object' && source !== null
    && typeof source.filePath === 'string' && typeof source.workspaceId === 'string'
    && typeof source.workspaceName === 'string' && typeof source.harness === 'string'
    && (source.workspaceRootPath === undefined || typeof source.workspaceRootPath === 'string')
    && ['vscode-session-file', 'cli-events', 'claude-jsonl', 'codex-jsonl', 'opencode-storage', 'opencode-db', 'xcode-db'].includes(source.kind)
    && (source.additionalFilePaths === undefined || (Array.isArray(source.additionalFilePaths)
      && source.additionalFilePaths.every(file => typeof file === 'string')));
}

function onMessage(handler: (msg: ParseWorkerRequest) => void | Promise<void>): void {
  const dispatch = (raw: unknown): void => {
    if (isAckMessage(raw)) {
      onAck?.(raw.seq);
      return;
    }
    if (typeof raw === 'object' && raw !== null && 'type' in raw && (raw.type === 'session-images' || raw.type === 'session-detail')) {
      try {
        if (!isSessionSourceRequest(raw)) throw new Error('Invalid session source request');
        if (raw.type === 'session-images') {
          send({ type: 'session-images', images: extractSourceImages(raw.source, raw.sessionId, raw.requestId, raw) });
        } else {
          send({ type: 'session-detail', session: loadSourceSession(raw.source, raw.sessionId) });
        }
      } catch (error) {
        send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    void handler(parseWorkerRequest(raw));
  };
  if (port) {
    port.on('message', dispatch);
    return;
  }
  process.on('message', dispatch);
}

/** Build a live telemetry snapshot of this worker for the loading UI (issue #106). The CPU-delta
 *  state lives inside the sampler; see worker-telemetry.ts for the (unit-tested) math. */
const sampleTelemetry = createTelemetrySampler({ warningCounts: () => getParseWarningCounts() });

onMessage(async (msg) => {
  let lastProgress: LoadProgress | null = null;
  // Periodically refresh telemetry even if the parse loop goes quiet during a single large
  // workspace, so the loading screen's resource gauges keep ticking (issue #106).
  const memTimer = setInterval(() => {
    if (lastProgress) {
      // Resend the last phase/pct with fresh telemetry only; drop one-shot grid fields so the
      // refresh never replays workspace-plan / workspace-done side effects in the UI.
      const { workspacePlan: _wp, workspaceDone: _wd, ...rest } = lastProgress;
      void _wp; void _wd;
      send({ type: 'progress', progress: { ...rest, telemetry: sampleTelemetry() } });
    }
  }, 500);
  memTimer.unref?.();
  try {
    const logsDirs = Array.isArray(msg.logsDirs) ? msg.logsDirs : [];
    runtimeDebug('parse-worker', 'message-start', `logsDirs=${logsDirs.length}`);

    // Throttle verbose intra-workspace progress messages, but always send
    // phase changes, workspace grid plans, and workspace completion updates.
    let lastSendTime = 0;
    let lastPhase = -1;
    let pending: ProgressMessage | null = null;
    const flushPending = () => {
      if (pending) {
        send(pending);
        pending = null;
        lastSendTime = Date.now();
      }
    };

    const { result, dirMetas } = await parseAllLogsAsyncDetailed(logsDirs, (progress) => {
      progress.telemetry = sampleTelemetry();
      lastProgress = progress;
      const progressMessage: ProgressMessage = { type: 'progress', progress };
      const now = Date.now();
      // Always send immediately for phase changes, workspace grid updates, or >= 100%.
      if (shouldSendProgressImmediately(progress, lastPhase)) {
        flushPending();
        send(progressMessage);
        lastPhase = progress.phase;
        lastSendTime = now;
        return;
      }
      if (now - lastSendTime >= 200) {
        send(progressMessage);
        lastSendTime = now;
        pending = null;
      } else {
        pending = progressMessage;
      }
    });
    // Flush any final pending progress before sending result.
    flushPending();

    // Keep full text only in the disk cache written by parseAllLogsAsyncDetailed.
    // The parent process receives the memory-efficient representation only.
    // (VS Code / CLI sessions are already stripped eagerly during parse; this also strips
    // external-harness sessions collected after the main loop.)
    stripSessionsForMemory(result.sessions);

    runtimeDebug('parse-worker', 'message-result', `workspaces=${result.workspaces.size} sessions=${result.sessions.length}`);

    // Stream the result to the parent in per-session-batch chunks (issue #106, S1). See
    // parse-chunking.ts for the emit/assemble contract; orphan edit/source entries are
    // returned in `done` so nothing is dropped.
    //
    // Backpressure (issue #106): the parent acks each chunk; the worker keeps at most
    // CHUNK_ACK_WINDOW chunks unacked so serialized payloads cannot accumulate in the child's
    // native IPC write buffer (the native OOM that V8 heap limits could not prevent).
    let nextSeq = 0;
    const ackWindow = createAckWindow(CHUNK_ACK_WINDOW);
    onAck = (seq) => ackWindow.onAck(seq);

    const done = await emitResultChunks(
      result,
      async (chunk) => {
        const seq = nextSeq++;
        send({ type: 'chunk', seq, payload: chunk });
        // Backpressure applies only to the child-process IPC channel, where unflushed chunks
        // accumulate in a native write buffer. The worker_threads path posts into the parent's
        // heap instead and never acks, so waiting there would deadlock (issue #106).
        if (port) return;
        // Pause while the window is full; each ack from the parent re-checks the condition.
        await ackWindow.waitForSlot(seq);
      },
      SESSION_CHUNK_SIZE,
    );
    onAck = null;

    send({
      type: 'done',
      payload: {
        workspaces: done.workspaces,
        orphanEditLoc: done.orphanEditLoc,
        orphanSources: done.orphanSources,
        dirMetas,
        parseWarnings: getParseWarnings(),
        parseWarningCounts: getParseWarningCounts(),
      },
    });
  } catch (e) {
    runtimeDebug('parse-worker', 'message-error', e);
    send({
      type: 'error',
      message: e instanceof Error ? e.message : String(e),
    });
  } finally {
    clearInterval(memTimer);
  }
});