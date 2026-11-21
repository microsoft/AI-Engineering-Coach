/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, it, expect } from 'vitest';
import {
  getRuntimeDebugLogPath,
  runtimeDebug,
  setOutputHook,
  installRuntimeDebugHooks,
} from './runtime-debug';

describe('getRuntimeDebugLogPath', () => {
  it('returns a string path ending with runtime.log', () => {
    const p = getRuntimeDebugLogPath();
    expect(p).toMatch(/runtime\.log$/);
  });

  it('ensures the directory exists', () => {
    const p = getRuntimeDebugLogPath();
    expect(fs.existsSync(path.dirname(p))).toBe(true);
  });
});

describe('runtimeDebug', () => {
  it('appends a line to the runtime log file', () => {
    const logPath = getRuntimeDebugLogPath();
    const sizeBefore = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;

    runtimeDebug('test-scope', 'test-message');

    const sizeAfter = fs.statSync(logPath).size;
    expect(sizeAfter).toBeGreaterThan(sizeBefore);
  });

  it('includes scope and message in logged output', () => {
    const logPath = getRuntimeDebugLogPath();
    runtimeDebug('my-scope', 'my-message-unique-123');
    const content = fs.readFileSync(logPath, 'utf-8');
    expect(content).toContain('[my-scope]');
    expect(content).toContain('my-message-unique-123');
  });

  it('includes detail when provided as string', () => {
    const logPath = getRuntimeDebugLogPath();
    runtimeDebug('scope', 'msg', 'detail-string-xyz');
    const content = fs.readFileSync(logPath, 'utf-8');
    expect(content).toContain('detail-string-xyz');
  });

  it('includes detail when provided as Error', () => {
    const logPath = getRuntimeDebugLogPath();
    runtimeDebug('scope', 'msg', new Error('test-error-abc'));
    const content = fs.readFileSync(logPath, 'utf-8');
    expect(content).toContain('test-error-abc');
  });

  it('includes detail when provided as object', () => {
    const logPath = getRuntimeDebugLogPath();
    runtimeDebug('scope', 'msg', { key: 'value-obj-test' });
    const content = fs.readFileSync(logPath, 'utf-8');
    expect(content).toContain('value-obj-test');
  });

  it('includes memory usage info', () => {
    const logPath = getRuntimeDebugLogPath();
    runtimeDebug('scope', 'mem-check');
    const content = fs.readFileSync(logPath, 'utf-8');
    expect(content).toContain('rss=');
    expect(content).toContain('heap=');
  });
});

describe('setOutputHook', () => {
  afterEach(() => {
    setOutputHook(null);
  });

  it('calls the hook with each logged message', () => {
    const messages: string[] = [];
    setOutputHook((msg) => messages.push(msg));

    runtimeDebug('hook-test', 'hooked-msg');

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('hooked-msg');
  });

  it('can be cleared by passing null', () => {
    const messages: string[] = [];
    setOutputHook((msg) => messages.push(msg));
    setOutputHook(null);

    runtimeDebug('hook-test', 'should-not-hook');

    expect(messages).toHaveLength(0);
  });
});

describe('installRuntimeDebugHooks', () => {
  it('installs hooks without throwing', () => {
    expect(() => installRuntimeDebugHooks('test')).not.toThrow();
  });

  it('is idempotent (does not install twice)', () => {
    const logPath = getRuntimeDebugLogPath();
    const contentBefore = fs.readFileSync(logPath, 'utf-8');
    const hookLines = contentBefore.split('\n').filter(l => l.includes('process-hooks-installed')).length;

    installRuntimeDebugHooks('test2');
    installRuntimeDebugHooks('test2');

    const contentAfter = fs.readFileSync(logPath, 'utf-8');
    const hookLinesAfter = contentAfter.split('\n').filter(l => l.includes('process-hooks-installed')).length;
    // Should not have added more than 1 additional line (first call of this test)
    expect(hookLinesAfter - hookLines).toBeLessThanOrEqual(1);
  });
});
