/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* A loopback stand-in for GitHub Releases, used only by the desktop update suite. It serves
 * `GET /repos/{repo}/releases/latest` in GitHub's shape and the VSIX behind the same 302 hop
 * that github.com uses for release assets. The packaged extension reaches it only through the
 * test-only AI_ENGINEER_COACH_UPDATE_TEST_ORIGIN variable, so the suite never contacts GitHub. */

import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export const UPDATE_TEST_ORIGIN_ENV = 'AI_ENGINEER_COACH_UPDATE_TEST_ORIGIN';
const REPOSITORY = 'microsoft/AI-Engineering-Coach';
/** Answers every request with "connection refused": nothing listens on the discard port. */
export const CLOSED_LOOPBACK_ORIGIN = 'http://127.0.0.1:9';

export type UpdateServerMode = 'good' | 'bad-digest';

export interface RecordedRequest {
  method: string;
  path: string;
  userAgent: string;
  authorization: boolean;
}

export interface UpdateServer {
  origin: string;
  close(): Promise<void>;
}

/** Serves `vsix` as release `v<version>`; `POST /__test/mode` switches modes and `GET /__test/requests` lists requests. */
export async function startUpdateServer(version: string, vsix: Buffer): Promise<UpdateServer> {
  let mode: UpdateServerMode = 'good';
  const requests: RecordedRequest[] = [];
  const name = `ai-engineer-coach-${version}.vsix`;
  const digest = createHash('sha256').update(vsix).digest('hex');

  function release(origin: string): unknown {
    const repo = `${origin}/${REPOSITORY}`;
    return {
      html_url: `${repo}/releases/tag/v${version}`,
      tag_name: `v${version}`,
      name: `v${version}`,
      draft: false,
      prerelease: false,
      immutable: true,
      published_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
      body: `## [${version}]\n\nDesktop update test release.`,
      assets: [{
        name,
        size: vsix.byteLength,
        state: 'uploaded',
        digest: `sha256:${mode === 'good' ? digest : createHash('sha256').update('not the package').digest('hex')}`,
        browser_download_url: `${repo}/releases/download/v${version}/${name}`,
        uploader: { login: 'github-actions[bot]', type: 'Bot' },
      }],
    };
  }

  function handle(req: IncomingMessage, res: ServerResponse, origin: string): void {
    const path = new URL(req.url ?? '/', origin).pathname;
    if (path === '/__test/requests') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(requests));
      return;
    }
    if (path === '/__test/mode' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        mode = Buffer.concat(chunks).toString('utf8') === 'bad-digest' ? 'bad-digest' : 'good';
        res.writeHead(204).end();
      });
      return;
    }
    requests.push({
      method: req.method ?? '',
      path,
      userAgent: req.headers['user-agent'] ?? '',
      authorization: req.headers.authorization !== undefined,
    });
    if (req.method === 'GET' && path === `/repos/${REPOSITORY}/releases/latest`) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(release(origin)));
    } else if (req.method === 'GET' && path === `/${REPOSITORY}/releases/download/v${version}/${name}`) {
      // github.com redirects asset downloads to a short-lived storage URL.
      res.writeHead(302, { location: `/release-assets/${name}?signature=test` }).end();
    } else if (req.method === 'GET' && path === `/release-assets/${name}`) {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(vsix.byteLength) }).end(vsix);
    } else {
      res.writeHead(404).end();
    }
  }

  let origin = '';
  const server: Server = createServer((req, res) => handle(req, res, origin));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

/** Test-side helpers that talk to the running server through its origin. */
export async function setUpdateServerMode(origin: string, mode: UpdateServerMode): Promise<void> {
  const response = await fetch(`${origin}/__test/mode`, { method: 'POST', body: mode });
  if (response.status !== 204) throw new Error(`Could not switch the update server to ${mode}`);
}

export async function updateServerRequests(origin: string): Promise<RecordedRequest[]> {
  return (await fetch(`${origin}/__test/requests`)).json() as Promise<RecordedRequest[]>;
}
