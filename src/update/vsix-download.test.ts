/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveFeedEndpoints, TEST_ORIGIN_ENV, toUpdateCandidate, type UpdateCandidate } from './release-feed';
import { fakeVsix, releaseJson, sha256Hex } from './test-fixtures';
import { downloadVerifiedVsix, parseChecksumFile, UpdateDownloadError } from './vsix-download';

const VSIX_URL = 'https://github.com/microsoft/AI-Engineering-Coach/releases/download/v0.4.0/ai-engineer-coach-0.4.0.vsix';
const STORAGE_URL = 'https://release-assets.githubusercontent.com/github-production-release-asset/1/abc?sp=r&sig=x';
const CHECKSUM_URL = `${VSIX_URL}.sha256`;

beforeEach(() => {
  vi.stubGlobal('fetch', () => { throw new Error('Network access is disabled in unit tests'); });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function candidate(options: Parameters<typeof releaseJson>[1] = {}): UpdateCandidate {
  const result = toUpdateCandidate(releaseJson('0.4.0', options));
  if (!result.ok) throw new Error(result.reason);
  return result.candidate;
}

function redirect(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

function serve(routes: Record<string, () => Response>) {
  return vi.fn<typeof globalThis.fetch>(input => new Promise<Response>(resolve => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const route = routes[url];
    if (!route) throw new Error(`Unexpected request: ${url}`);
    resolve(route());
  }));
}

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err: unknown) {
    expect(err).toBeInstanceOf(UpdateDownloadError);
    return (err as Error).message;
  }
  throw new Error('Expected the download to fail');
}

describe('downloadVerifiedVsix', () => {
  it('follows GitHub\'s redirect to release storage and verifies the bytes', async () => {
    const bytes = fakeVsix(256);
    const fetch = serve({ [VSIX_URL]: () => redirect(STORAGE_URL), [STORAGE_URL]: () => new Response(bytes) });
    const progress = vi.fn();
    const result = await downloadVerifiedVsix({ fetch, candidate: candidate({ bytes }), onProgress: progress });
    expect(Buffer.from(result).equals(Buffer.from(bytes))).toBe(true);
    expect(progress).toHaveBeenLastCalledWith(256, 256);
    for (const [, init] of fetch.mock.calls) {
      expect(init?.redirect).toBe('manual');
      expect(init?.headers).toEqual({ 'User-Agent': 'AI-Engineer-Coach-Update-Check', Accept: 'application/octet-stream' });
    }
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([VSIX_URL, STORAGE_URL]);
  });

  it('resolves relative redirects against the current hop', async () => {
    const bytes = fakeVsix();
    const fetch = serve({
      [VSIX_URL]: () => redirect('/microsoft/AI-Engineering-Coach/releases/download/v0.4.0/moved.vsix', 307),
      'https://github.com/microsoft/AI-Engineering-Coach/releases/download/v0.4.0/moved.vsix': () => new Response(bytes),
    });
    await expect(downloadVerifiedVsix({ fetch, candidate: candidate({ bytes }) })).resolves.toHaveLength(bytes.byteLength);
  });

  it.each([
    ['plain HTTP', 'http://release-assets.githubusercontent.com/x'],
    ['an unknown host', 'https://evil.example.com/ai-engineer-coach-0.4.0.vsix'],
    ['a look-alike host', 'https://github.com.evil.example/x'],
    ['credentials', 'https://user:secret@release-assets.githubusercontent.com/x'],
    ['a non-default port', 'https://release-assets.githubusercontent.com:8443/x'],
  ])('refuses a redirect to %s', async (_label, location) => {
    const fetch = serve({ [VSIX_URL]: () => redirect(location) });
    expect(await failure(downloadVerifiedVsix({ fetch, candidate: candidate() })))
      .toMatch(/^the download was redirected to an unexpected location/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('stops after three redirects', async () => {
    const hop = (n: number) => `https://release-assets.githubusercontent.com/hop/${n}`;
    const fetch = serve({
      [VSIX_URL]: () => redirect(hop(1)), [hop(1)]: () => redirect(hop(2)), [hop(2)]: () => redirect(hop(3)), [hop(3)]: () => redirect(hop(4)),
    });
    expect(await failure(downloadVerifiedVsix({ fetch, candidate: candidate() }))).toBe('the download was redirected too many times');
  });

  it('reports redirects without a location and HTTP errors', async () => {
    expect(await failure(downloadVerifiedVsix({ fetch: serve({ [VSIX_URL]: () => new Response(null, { status: 302 }) }), candidate: candidate() })))
      .toBe('the download was redirected without a location');
    expect(await failure(downloadVerifiedVsix({ fetch: serve({ [VSIX_URL]: () => new Response('gone', { status: 410 }) }), candidate: candidate() })))
      .toBe('the download failed with HTTP 410');
  });

  it('wraps network failures', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }));
    expect(await failure(downloadVerifiedVsix({ fetch, candidate: candidate() }))).toBe('the download failed: fetch failed (ENOTFOUND)');
  });

  it('rejects a body larger than the release lists, before and while reading it', async () => {
    const bytes = fakeVsix(64);
    const declared = serve({ [VSIX_URL]: () => new Response(fakeVsix(65), { headers: { 'content-length': '65' } }) });
    expect(await failure(downloadVerifiedVsix({ fetch: declared, candidate: candidate({ bytes }) }))).toBe('the download is larger than expected');
    const streamed = serve({
      [VSIX_URL]: () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(fakeVsix(40));
          controller.enqueue(fakeVsix(40));
          controller.close();
        },
      })),
    });
    expect(await failure(downloadVerifiedVsix({ fetch: streamed, candidate: candidate({ bytes }) }))).toBe('the download is larger than expected');
  });

  it('rejects a truncated download', async () => {
    const fetch = serve({ [VSIX_URL]: () => new Response(fakeVsix(32)) });
    expect(await failure(downloadVerifiedVsix({ fetch, candidate: candidate({ bytes: fakeVsix(64) }) })))
      .toBe('the download has 32 bytes, but the release lists 64');
  });

  it('rejects bytes whose SHA-256 differs from GitHub\'s digest', async () => {
    const fetch = serve({ [VSIX_URL]: () => new Response(fakeVsix(64, 9)) });
    expect(await failure(downloadVerifiedVsix({ fetch, candidate: candidate({ bytes: fakeVsix(64, 7) }) })))
      .toBe("the download's SHA-256 checksum doesn't match the release");
  });

  it('rejects a file that is not a ZIP package', async () => {
    const bytes = new Uint8Array(64).fill(1);
    const fetch = serve({ [VSIX_URL]: () => new Response(bytes) });
    expect(await failure(downloadVerifiedVsix({ fetch, candidate: candidate({ bytes }) }))).toBe('the download is not a VSIX package');
  });

  it('falls back to the release .sha256 asset when GitHub reports no digest', async () => {
    const bytes = fakeVsix(64);
    const checksum = `${sha256Hex(bytes)}  ai-engineer-coach-0.4.0.vsix\n`;
    const fetch = serve({ [CHECKSUM_URL]: () => new Response(checksum), [VSIX_URL]: () => new Response(bytes) });
    await expect(downloadVerifiedVsix({ fetch, candidate: candidate({ bytes, digest: null }) })).resolves.toHaveLength(64);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([CHECKSUM_URL, VSIX_URL]);

    const wrongFile = serve({ [CHECKSUM_URL]: () => new Response(`${sha256Hex(bytes)}  other.vsix\n`) });
    expect(await failure(downloadVerifiedVsix({ fetch: wrongFile, candidate: candidate({ bytes, digest: null }) })))
      .toBe('the release checksum file is not in the expected format');
    expect(await failure(downloadVerifiedVsix({ fetch: serve({}), candidate: candidate({ bytes, digest: null, checksumAsset: false }) })))
      .toBe('the release has no checksum to verify the download');
  });

  it('stops when the user cancels', async () => {
    const controller = new AbortController();
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      const abort = () => reject(new DOMException('Aborted', 'AbortError'));
      if (init?.signal?.aborted) abort();
      init?.signal?.addEventListener('abort', abort);
    }));
    const download = downloadVerifiedVsix({ fetch, candidate: candidate(), signal: controller.signal });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(download).rejects.toMatchObject({ name: 'AbortError' });

    const before = new AbortController();
    before.abort();
    await expect(downloadVerifiedVsix({ fetch, candidate: candidate(), signal: before.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('downloads only from the loopback origin in test mode', async () => {
    const origin = 'http://127.0.0.1:41234';
    const endpoints = resolveFeedEndpoints({ [TEST_ORIGIN_ENV]: origin });
    const bytes = fakeVsix();
    const result = toUpdateCandidate(releaseJson('0.4.0', { webBase: origin, bytes }), endpoints);
    if (!result.ok) throw new Error(result.reason);
    const vsixUrl = `${origin}/microsoft/AI-Engineering-Coach/releases/download/v0.4.0/ai-engineer-coach-0.4.0.vsix`;
    const fetch = serve({ [vsixUrl]: () => redirect('/storage/blob'), [`${origin}/storage/blob`]: () => new Response(bytes) });
    await expect(downloadVerifiedVsix({ fetch, candidate: result.candidate, endpoints })).resolves.toHaveLength(bytes.byteLength);
    const escapes = serve({ [vsixUrl]: () => redirect(STORAGE_URL) });
    expect(await failure(downloadVerifiedVsix({ fetch: escapes, candidate: result.candidate, endpoints })))
      .toMatch(/^the download was redirected to an unexpected location/);
  });
});

describe('parseChecksumFile', () => {
  it('reads sha256sum text and binary mode lines for the named file', () => {
    const hash = 'A'.repeat(64);
    expect(parseChecksumFile(`${hash}  ai-engineer-coach-0.4.0.vsix`, 'ai-engineer-coach-0.4.0.vsix')).toBe('a'.repeat(64));
    expect(parseChecksumFile(`${hash} *ai-engineer-coach-0.4.0.vsix\r\n`, 'ai-engineer-coach-0.4.0.vsix')).toBe('a'.repeat(64));
    expect(parseChecksumFile(`${hash}  other.vsix`, 'ai-engineer-coach-0.4.0.vsix')).toBeUndefined();
    expect(parseChecksumFile('not a checksum', 'ai-engineer-coach-0.4.0.vsix')).toBeUndefined();
  });
});
