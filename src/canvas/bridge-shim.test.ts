/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * @vitest-environment jsdom
 *
 * Regression test for #269. The canvas host replays `dataReady` on /events the moment a client
 * connects. If the bridge shim subscribes before app.js has attached its message listener (at
 * shim evaluation, or on DOMContentLoaded when the bundle has not run yet), the replay reaches
 * no listener and the dashboard never leaves its loading screen. This wires the shim the host
 * actually serves to the real webview listener and replays as soon as the stream opens.
 */

import { IncomingMessage, ServerResponse } from 'http';
import { Socket } from 'net';
import { runInThisContext } from 'vm';
import { afterEach, expect, it, vi } from 'vitest';
import { createCanvasHost } from './host';

afterEach(() => vi.unstubAllGlobals());

function servedBridgeShim(): string {
  const host = createCanvasHost({ distDir: '/fixture/dist' });
  const req = new IncomingMessage(new Socket());
  req.url = '/';
  req.method = 'GET';
  const res = new ServerResponse(req);
  const end = vi.spyOn(res, 'end').mockImplementation(() => res);
  host.handle(req, res);
  host.dispose();
  const html = String(end.mock.calls[0][0]);
  const start = html.indexOf('<script>') + '<script>'.length;
  return html.slice(start, html.indexOf('</script>', start));
}

it('delivers the replayed dataReady even when the page finishes loading before the dashboard listens', async () => {
  const streams: string[] = [];
  vi.stubGlobal('EventSource', class {
    onmessage?: (event: { data: string }) => void;
    constructor(url: string) {
      streams.push(url);
      setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: 'dataReady', currentWorkspace: 'my-repo' }) }));
    }
  });
  runInThisContext(servedBridgeShim());

  // An async or code-split bundle can attach its listener after DOMContentLoaded has fired.
  document.dispatchEvent(new Event('DOMContentLoaded'));
  await new Promise(resolve => setTimeout(resolve, 10));

  const { initMessageListener } = await import('../webview/shared');
  const onDataReady = vi.fn();
  initMessageListener(() => { /* progress is not under test */ }, onDataReady);

  await vi.waitFor(() => expect(onDataReady).toHaveBeenCalledWith('my-repo', { skippedFiles: 0, skippedLines: 0 }));
  expect(streams).toEqual(['/events']);
});
