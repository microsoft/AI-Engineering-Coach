/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { fork } from 'child_process';
import { IncomingMessage, ServerResponse } from 'http';
import { Socket } from 'net';
import { runInNewContext } from 'vm';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Analyzer } from '../core/analyzer';
import { parseAllLogsViaWorker } from '../core/parser';
import { createCanvasHost, type CanvasHost } from './host';

const analyzerCalls = vi.hoisted(() => ({
  warmUp: vi.fn<Analyzer['warmUp']>().mockResolvedValue(undefined),
  getAntiPatterns: vi.fn(() => ({ patterns: [] })),
  getCuriosity: vi.fn(() => ({ analyzed: 1 })),
}));

vi.mock('child_process', () => ({ fork: vi.fn() }));
vi.mock('../core/parser', () => ({
  findLogsDirs: () => ['/fixture/logs'],
  parseAllLogsViaWorker: vi.fn(),
}));
vi.mock('../core/analyzer', () => ({
  Analyzer: class {
    warmUp = analyzerCalls.warmUp;
    getAntiPatterns = analyzerCalls.getAntiPatterns;
    getCuriosity = analyzerCalls.getCuriosity;
  },
}));

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

function request(host: CanvasHost, url: string, body?: object) {
  const req = new IncomingMessage(new Socket());
  req.url = url;
  req.method = body ? 'POST' : 'GET';
  req.headers = { host: '127.0.0.1', 'content-type': 'application/json' };
  const res = new ServerResponse(req);
  const end = vi.spyOn(res, 'end').mockImplementation(() => res);
  const write = vi.spyOn(res, 'write').mockReturnValue(true);
  host.handle(req, res);
  if (body) {
    req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  }
  return { end, write };
}

it('launches the canvas parser with Node and keeps child output off the protocol stream', async () => {
  vi.mocked(parseAllLogsViaWorker).mockImplementationOnce(async (_dirs, _progress, deps) => {
    deps?.fork?.('/fixture/parse-worker.js', [], { execArgv: ['--expose-gc'] });
    return { sessions: [], workspaces: new Map(), editLocIndex: new Map(), sessionSourceIndex: new Map() };
  });
  const host = createCanvasHost({ distDir: '/fixture/dist' });
  const events = request(host, '/events');
  host.start();
  host.start();
  await vi.waitFor(() => expect(events.write).toHaveBeenCalledWith(expect.stringContaining('"type":"dataReady"')));
  expect(fork).toHaveBeenCalledExactlyOnceWith('/fixture/parse-worker.js', [], {
    execArgv: ['--expose-gc'], execPath: 'node', stdio: ['ignore', 2, 2, 'ipc'],
  });
  const forkWarmUp = analyzerCalls.warmUp.mock.calls.at(-1)![1];
  forkWarmUp?.('/fixture/warm-up-worker.js', [], { serialization: 'advanced' });
  expect(fork).toHaveBeenLastCalledWith('/fixture/warm-up-worker.js', [], {
    serialization: 'advanced', execPath: 'node', stdio: ['ignore', 2, 2, 'ipc'],
  });
  expect(request(host, '/events').write).toHaveBeenCalledWith(expect.stringContaining('"type":"dataReady"'));
  host.dispose();
});

it('reports analytics failure without publishing partial readiness', async () => {
  analyzerCalls.warmUp.mockRejectedValueOnce(new Error('worker timeout'));
  vi.mocked(parseAllLogsViaWorker).mockResolvedValueOnce({
    sessions: [], workspaces: new Map(), editLocIndex: new Map(), sessionSourceIndex: new Map(),
  });
  const host = createCanvasHost({ distDir: '/fixture/dist' });
  const events = request(host, '/events');
  host.start();
  await vi.waitFor(() => expect(events.write).toHaveBeenCalledWith(expect.stringContaining('"phase":-1')));
  const heavy = request(host, '/rpc', { id: 'heavy', method: 'getAntiPatterns' });
  await vi.waitFor(() => expect(heavy.end).toHaveBeenCalledWith(expect.stringContaining('"error":"worker timeout"')));
  expect(request(host, '/rpc', { id: 'light', method: 'getCuriosity' }).end)
    .toHaveBeenCalledWith(expect.stringContaining('"error":"worker timeout"'));
  expect(events.write.mock.calls.map(call => String(call[0])).join('')).not.toContain('"type":"dataReady"');
  expect(request(host, '/events').write).toHaveBeenCalledWith(expect.stringContaining('worker timeout. Reload the canvas to retry.'));
  expect(analyzerCalls.getAntiPatterns).not.toHaveBeenCalled();
  expect(analyzerCalls.getCuriosity).not.toHaveBeenCalled();
  host.dispose();
});

it('retains startup errors for RPC calls and clients that connect later', async () => {
  vi.mocked(parseAllLogsViaWorker).mockRejectedValueOnce(new Error('spawn node ENOENT'));
  const host = createCanvasHost({ distDir: '/fixture/dist' });
  host.start();
  await Promise.resolve();
  const rpc = request(host, '/rpc', { id: '1', method: 'getCuriosity' });
  expect(rpc.end).toHaveBeenCalledWith(JSON.stringify({
    type: 'response', id: '1', data: { error: 'spawn node ENOENT' },
  }));
  expect(request(host, '/events').write).toHaveBeenCalledWith(expect.stringContaining('spawn node ENOENT. Reload the canvas to retry.'));
  host.dispose();
});

it.each(['script', 'SCRIPT', 'Script'])('waits for app.js to load before subscribing to replayed dataReady events (%s tags)', (scriptTag) => {
  const host = createCanvasHost({ distDir: '/fixture/dist' });
  const html = String(request(host, '/').end.mock.calls[0][0])
    .replaceAll('<script>', `<${scriptTag}>`)
    .replaceAll('</script>', `</${scriptTag}>`);
  const script = /<script>([\s\S]*?)<\/script>/i.exec(html)![1];
  const listeners = new Map<string, () => void>();
  const dispatchEvent = vi.fn();
  const streams: { onmessage?: (event: { data: string }) => void }[] = [];
  runInNewContext(script, {
    window: { dispatchEvent },
    document: { addEventListener: (name: string, callback: () => void) => listeners.set(name, callback) },
    MessageEvent,
    EventSource: class {
      onmessage?: (event: { data: string }) => void;
      constructor() { streams.push(this); }
    },
  });
  expect(streams).toHaveLength(0);
  listeners.get('DOMContentLoaded')!();
  expect(streams).toHaveLength(1);
  streams[0].onmessage!({ data: '{"type":"dataReady"}' });
  expect(dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ data: { type: 'dataReady' } }));
  host.dispose();
});

it('keeps every page behind analytics progress before publishing readiness', async () => {
  let finishWarmUp!: () => void;
  analyzerCalls.warmUp.mockReturnValueOnce(new Promise<void>(resolve => { finishWarmUp = resolve; }));
  vi.mocked(parseAllLogsViaWorker).mockResolvedValueOnce({
    sessions: [], workspaces: new Map(), editLocIndex: new Map(), sessionSourceIndex: new Map(),
  });
  const host = createCanvasHost({ distDir: '/fixture/dist' });
  const events = request(host, '/events');
  host.start();
  await vi.waitFor(() => expect(analyzerCalls.warmUp).toHaveBeenCalled());
  analyzerCalls.warmUp.mock.calls[0][0]?.(4, 'Computing analytics', 10);
  expect(events.write).toHaveBeenCalledWith(expect.stringContaining('"pct":91'));
  expect(request(host, '/events').write.mock.calls.map(call => String(call[0])).join('')).not.toContain('"type":"dataReady"');
  for (const method of ['getAntiPatterns', 'getCuriosity']) {
    expect(request(host, '/rpc', { id: 'pending', method }).end)
      .toHaveBeenCalledWith(expect.stringContaining('"error":"Data is still loading."'));
  }
  expect(analyzerCalls.getAntiPatterns).not.toHaveBeenCalled();
  expect(analyzerCalls.getCuriosity).not.toHaveBeenCalled();
  finishWarmUp();
  await vi.waitFor(() => expect(events.write).toHaveBeenCalledWith(expect.stringContaining('"type":"dataReady"')));
  expect(request(host, '/rpc', { id: '1', method: 'getAntiPatterns' }).end).toHaveBeenCalledWith(JSON.stringify({
    type: 'response', id: '1', data: { patterns: [] },
  }));
  expect(request(host, '/rpc', { id: '2', method: 'getCuriosity' }).end)
    .toHaveBeenCalledWith(expect.stringContaining('"analyzed":1'));
  host.dispose();
});
