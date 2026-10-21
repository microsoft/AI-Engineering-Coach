/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import { Worker } from 'worker_threads';
import type { SessionSource } from './cache';
import type { Session } from './types';
import type { SessionSourceRequest } from './session-images';
import { SessionSchema } from './schemas';
import { warnCore } from './log';
import type { ImageRequestMatch } from './image-data';

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

export class SessionImageLoader {
  private worker: ImageWorker | null = null;
  private queue: Promise<void> = Promise.resolve();
  private idleTimer: ReturnType<typeof setTimeout> | undefined;

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

  private enqueue<T>(request: SessionSourceRequest, decode: (value: object) => T): Promise<T> {
    const result = this.queue.then(() => this.run(request, decode));
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
      };
      const fail = (error: Error): void => {
        cleanup();
        this.dispose();
        warnCore('image-extract', 'Image worker failed', error);
        reject(error);
      };
      const onError = (error: Error): void => fail(error);
      const onExit = (code: number): void => fail(new Error(`Image worker exited before replying (code ${code})`));
      const onMessage = (value: unknown): void => {
        if (typeof value !== 'object' || value === null || !('type' in value)) {
          fail(new Error('Invalid image worker response'));
          return;
        }
        if (value.type === 'error') {
          fail(new Error('message' in value && typeof value.message === 'string' ? value.message : 'Image extraction failed'));
          return;
        }
        if (value.type !== request.type) {
          fail(new Error('Invalid session worker response'));
          return;
        }
        let result: T;
        try {
          result = decode(value);
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
