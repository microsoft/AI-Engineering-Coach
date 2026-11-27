/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import { Worker } from 'worker_threads';
import type { SessionSource } from './cache';
import type { Session, TimelineSessionText, TimelineTextSuperseded } from './types';
import type { SessionSourceRequest, TimelineTextRequest } from './session-images';
import { SessionSchema, TimelineSessionTextSchema } from './schemas';
import { warnCore } from './log';
import type { ImageRequestMatch } from './image-data';

const SUPERSEDED: TimelineTextSuperseded = { superseded: true };
/** A lane-text read stopped for a newer one: its caller gets `SUPERSEDED`. */
const CANCELLED = new Error('Lane-text read replaced by a newer one');

interface ImageWorker {
  on(event: 'message', listener: (value: unknown) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'exit', listener: (code: number) => void): void;
  off(event: 'message', listener: (value: unknown) => void): void;
  off(event: 'error', listener: (error: Error) => void): void;
  off(event: 'exit', listener: (code: number) => void): void;
  postMessage(request: SessionSourceRequest): void;
  terminate(): Promise<number>;
  unref(): void;
}

/** A worker reply to `request`, decoded; throws on an error reply or one of another kind. */
function decodeReply<T>(request: SessionSourceRequest, value: unknown, decode: (value: object) => T): T {
  if (typeof value !== 'object' || value === null || !('type' in value)) throw new Error('Invalid image worker response');
  if (value.type === 'error') {
    throw new Error('message' in value && typeof value.message === 'string' ? value.message : 'Image extraction failed');
  }
  if (value.type !== request.type) throw new Error('Invalid session worker response');
  return decode(value);
}

export class SessionImageLoader {
  private worker: ImageWorker | null = null;
  private queue: Promise<void> = Promise.resolve();
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private textTicket = 0;
  /** The request the worker is running, and how to stop it. */
  private running: { text: boolean; cancel: () => void } | null = null;

  constructor(private readonly createWorker: () => ImageWorker = () => new Worker(path.join(__dirname, 'parse-worker.js'), {
    execArgv: [],
    resourceLimits: { maxOldGenerationSizeMb: 1024 },
  })) {}

  load(source: SessionSource, sessionId: string, requestId: string, match?: ImageRequestMatch): Promise<string[]> {
    return this.enqueue({ type: 'session-images', source, sessionId, requestId, ...match }, value => {
      if (!('images' in value) || !Array.isArray(value.images)
        || !value.images.every((image: unknown) => typeof image === 'string')) {
        throw new Error('Invalid image worker response');
      }
      return value.images;
    });
  }

  loadSession(source: SessionSource, sessionId: string): Promise<Session | null> {
    return this.enqueue({ type: 'session-detail', source, sessionId }, value => {
      if (!('session' in value)) throw new Error('Invalid session worker response');
      return value.session === null ? null : SessionSchema.parse(value.session);
    });
  }

  /** One Timeline lane's text, built and scrubbed in the worker: the host gets only what the lane shows. Only the newest
   *  such read matters (one lane's details are shown at a time): one still queued behind it is dropped unread, and one
   *  already running is stopped (its worker ends), both as `{ superseded: true }`, so the lane shown isn't kept waiting,
   *  and the webview's request timeout, which counts that wait, isn't spent on a lane no longer shown. */
  loadTimelineText(request: TimelineTextRequest): Promise<TimelineSessionText | TimelineTextSuperseded | null> {
    const ticket = ++this.textTicket;
    if (this.running?.text) this.running.cancel();
    return this.enqueue<TimelineSessionText | TimelineTextSuperseded | null>(request, value => {
      if (!('text' in value)) throw new Error('Invalid timeline text worker response');
      return value.text === null ? null : TimelineSessionTextSchema.parse(value.text);
    }, () => (ticket === this.textTicket ? undefined : SUPERSEDED)).catch((error: unknown) => {
      if (error === CANCELLED) return SUPERSEDED;
      throw error;
    });
  }

  private enqueue<T>(request: SessionSourceRequest, decode: (value: object) => T, skip?: () => T | undefined): Promise<T> {
    const result = this.queue.then(() => skip?.() ?? this.run(request, decode));
    // A failed request must not prevent subsequent image requests from running.
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  dispose(): void {
    clearTimeout(this.idleTimer);
    const worker = this.worker;
    this.worker = null;
    if (worker) void worker.terminate();
  }

  private run<T>(request: SessionSourceRequest, decode: (value: object) => T): Promise<T> {
    clearTimeout(this.idleTimer);
    if (!this.worker) {
      const created = this.createWorker();
      created.on('error', (error: Error) => {
        warnCore('image-extract', 'Image worker error', error);
        if (this.worker === created) this.worker = null;
      });
      created.on('exit', () => {
        if (this.worker === created) this.worker = null;
      });
      this.worker = created;
    }
    const worker = this.worker;
    worker.unref();
    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer);
        worker.off('message', onMessage);
        worker.off('error', onError);
        worker.off('exit', onExit);
        if (this.running === running) this.running = null;
      };
      const running = {
        text: request.type === 'timeline-text',
        cancel: (): void => {
          cleanup();
          this.dispose();
          reject(CANCELLED);
        },
      };
      this.running = running;
      const fail = (error: Error): void => {
        cleanup();
        this.dispose();
        warnCore('image-extract', 'Image worker failed', error);
        reject(error);
      };
      const onError = (error: Error): void => fail(error);
      const onExit = (code: number): void => fail(new Error(`Image worker exited before replying (code ${code})`));
      const onMessage = (value: unknown): void => {
        let result: T;
        try {
          result = decodeReply(request, value, decode);
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        cleanup();
        this.idleTimer = setTimeout(() => this.dispose(), 10_000);
        this.idleTimer.unref?.();
        resolve(result);
      };
      const timer = setTimeout(() => fail(new Error('Image extraction timed out')), 120_000);
      worker.on('message', onMessage);
      worker.on('error', onError);
      worker.on('exit', onExit);
      try {
        worker.postMessage(request);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
}

const imageLoader = new SessionImageLoader();

export function loadSessionImages(source: SessionSource, sessionId: string, requestId: string, match?: ImageRequestMatch): Promise<string[]> {
  return imageLoader.load(source, sessionId, requestId, match);
}

export function loadSessionDetails(source: SessionSource, sessionId: string): Promise<Session | null> {
  return imageLoader.loadSession(source, sessionId);
}

export function loadSessionTimelineText(request: TimelineTextRequest): Promise<TimelineSessionText | TimelineTextSuperseded | null> {
  return imageLoader.loadTimelineText(request);
}
