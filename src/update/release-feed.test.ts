/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  canInstallCandidate, fetchLatestRelease, GITHUB_ENDPOINTS, isUpdateCandidate, MAX_VSIX_BYTES, resolveFeedEndpoints, TEST_ORIGIN_ENV,
  toUpdateCandidate, type FeedEndpoints,
} from './release-feed';
import { fakeVsix, jsonResponse, releaseJson, sha256Hex } from './test-fixtures';

const API_URL = 'https://api.github.com/repos/microsoft/AI-Engineering-Coach/releases/latest';

beforeEach(() => {
  // Every test injects its own fetch; a real network call is a bug.
  vi.stubGlobal('fetch', () => { throw new Error('Network access is disabled in unit tests'); });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function candidateOf(value: unknown, endpoints?: FeedEndpoints) {
  const result = toUpdateCandidate(value, endpoints);
  if (!result.ok) throw new Error(result.reason);
  return result.candidate;
}

function reasonOf(value: unknown): string {
  const result = toUpdateCandidate(value);
  if (result.ok) throw new Error('Expected the release to be rejected');
  return result.reason;
}

describe('toUpdateCandidate', () => {
  it('keeps the validated release fields', () => {
    const bytes = fakeVsix(128);
    const candidate = candidateOf(releaseJson('0.4.0', { bytes }));
    expect(candidate).toEqual({
      version: '0.4.0',
      releaseUrl: 'https://github.com/microsoft/AI-Engineering-Coach/releases/tag/v0.4.0',
      publishedAt: '2026-10-01T12:00:00.000Z',
      immutable: true,
      vsix: {
        name: 'ai-engineer-coach-0.4.0.vsix',
        url: 'https://github.com/microsoft/AI-Engineering-Coach/releases/download/v0.4.0/ai-engineer-coach-0.4.0.vsix',
        size: 128,
        sha256: sha256Hex(bytes),
        uploader: 'github-actions[bot]',
      },
      checksumUrl: 'https://github.com/microsoft/AI-Engineering-Coach/releases/download/v0.4.0/ai-engineer-coach-0.4.0.vsix.sha256',
    });
    expect(canInstallCandidate(candidate)).toBe(true);
  });

  it.each([
    ['a draft', { draft: true }],
    ['a pre-release', { prerelease: true }],
  ])('rejects %s', (_label, patch) => {
    expect(reasonOf({ ...releaseJson('0.4.0'), ...patch })).toBe('the latest release is a draft or pre-release');
  });

  it.each(['v0.4', 'v0.4.0-beta', 'v0.4.0+abc', 'v01.4.0', '0.4.0', 'v0.4.0 ', 'release-0.4.0'])('rejects the tag %j', tag => {
    expect(reasonOf({ ...releaseJson('0.4.0'), tag_name: tag })).toBe('the latest release tag is not vX.Y.Z');
  });

  it('rejects a release page in another repository', () => {
    const release = releaseJson('0.4.0');
    expect(reasonOf({ ...release, html_url: 'https://github.com/someone/AI-Engineering-Coach/releases/tag/v0.4.0' }))
      .toBe('the release page URL is unexpected');
  });

  it('rejects unpublished releases', () => {
    expect(reasonOf({ ...releaseJson('0.4.0'), published_at: null })).toBe('the release has no publication date');
    expect(reasonOf({ ...releaseJson('0.4.0'), published_at: 'soon' })).toBe('the release has no publication date');
  });

  it('requires exactly one VSIX asset for the tag', () => {
    const release = releaseJson('0.4.0');
    const assets = release.assets as Record<string, unknown>[];
    expect(reasonOf({ ...release, assets: assets.slice(1) })).toBe('the release has no single ai-engineer-coach-0.4.0.vsix asset');
    expect(reasonOf({ ...release, assets: [assets[0], assets[0]] })).toBe('the release has no single ai-engineer-coach-0.4.0.vsix asset');
    expect(reasonOf({ ...release, assets: [{ ...assets[0], name: 'ai-engineer-coach-0.3.0.vsix' }] }))
      .toBe('the release has no single ai-engineer-coach-0.4.0.vsix asset');
  });

  it.each([
    ['not fully uploaded', { state: 'starter' }, 'ai-engineer-coach-0.4.0.vsix is not fully uploaded'],
    ['empty', { size: 0 }, 'ai-engineer-coach-0.4.0.vsix has an unexpected size'],
    ['too large', { size: MAX_VSIX_BYTES + 1 }, 'ai-engineer-coach-0.4.0.vsix has an unexpected size'],
    ['hosted elsewhere', { browser_download_url: 'https://example.com/ai-engineer-coach-0.4.0.vsix' },
      'ai-engineer-coach-0.4.0.vsix has an unexpected download URL'],
    ['from another tag', { browser_download_url: 'https://github.com/microsoft/AI-Engineering-Coach/releases/download/v0.3.0/ai-engineer-coach-0.4.0.vsix' },
      'ai-engineer-coach-0.4.0.vsix has an unexpected download URL'],
    ['with a SHA-512 digest', { digest: `sha512:${'a'.repeat(128)}` }, 'ai-engineer-coach-0.4.0.vsix has an unexpected digest'],
    ['with an uppercase digest', { digest: `sha256:${'A'.repeat(64)}` }, 'ai-engineer-coach-0.4.0.vsix has an unexpected digest'],
  ])('rejects a VSIX asset that is %s', (_label, patch, reason) => {
    const release = releaseJson('0.4.0');
    const [vsix, ...rest] = release.assets as Record<string, unknown>[];
    expect(reasonOf({ ...release, assets: [{ ...vsix, ...patch }, ...rest] })).toBe(reason);
  });

  it('rejects responses that are not a release', () => {
    for (const value of [null, 'release', [], {}, { ...releaseJson('0.4.0'), assets: 'none' }, { ...releaseJson('0.4.0'), draft: 'no' }]) {
      expect(reasonOf(value)).toBe('the release response has an unexpected format');
    }
  });

  it('uses the checksum asset when GitHub reports no digest', () => {
    const candidate = candidateOf(releaseJson('0.4.0', { digest: null }));
    expect(candidate.vsix.sha256).toBeUndefined();
    expect(candidate.checksumUrl).toMatch(/ai-engineer-coach-0\.4\.0\.vsix\.sha256$/);
    expect(canInstallCandidate(candidate)).toBe(true);
    expect(canInstallCandidate(candidateOf(releaseJson('0.4.0', { digest: null, checksumAsset: false })))).toBe(false);
  });

  it('ignores a checksum asset with an unexpected URL', () => {
    const release = releaseJson('0.4.0');
    const [vsix, checksum] = release.assets as Record<string, unknown>[];
    const candidate = candidateOf({ ...release, assets: [vsix, { ...checksum, browser_download_url: 'https://example.com/x.sha256' }] });
    expect(candidate.checksumUrl).toBeUndefined();
  });

  it('allows one-click install only for immutable releases uploaded by the release workflow', () => {
    expect(canInstallCandidate(candidateOf(releaseJson('0.4.0', { immutable: false })))).toBe(false);
    expect(canInstallCandidate(candidateOf(releaseJson('0.4.0', { uploader: 'a-maintainer' })))).toBe(false);
  });

  it('validates against the test origin when one is configured', () => {
    const endpoints = resolveFeedEndpoints({ [TEST_ORIGIN_ENV]: 'http://127.0.0.1:41234' });
    const release = releaseJson('0.4.0', { webBase: 'http://127.0.0.1:41234' });
    expect(candidateOf(release, endpoints).vsix.url)
      .toBe('http://127.0.0.1:41234/microsoft/AI-Engineering-Coach/releases/download/v0.4.0/ai-engineer-coach-0.4.0.vsix');
    expect(toUpdateCandidate(release).ok).toBe(false);
  });
});

describe('isUpdateCandidate', () => {
  it('accepts stored candidates and rejects anything else', () => {
    const candidate = candidateOf(releaseJson('0.4.0'));
    expect(isUpdateCandidate(candidate)).toBe(true);
    const stored: unknown = JSON.parse(JSON.stringify(candidateOf(releaseJson('0.4.0', { digest: null }))));
    expect(isUpdateCandidate(stored)).toBe(true);
    expect(isUpdateCandidate({ ...candidate, version: 'v0.4.0' })).toBe(false);
    expect(isUpdateCandidate({ ...candidate, vsix: { ...candidate.vsix, sha256: 'not-a-digest' } })).toBe(false);
    expect(isUpdateCandidate({ ...candidate, vsix: { ...candidate.vsix, size: MAX_VSIX_BYTES + 1 } })).toBe(false);
    expect(isUpdateCandidate({ ...candidate, vsix: undefined })).toBe(false);
    expect(isUpdateCandidate({ version: '0.4.0' })).toBe(false);
    expect(isUpdateCandidate(null)).toBe(false);
  });
});

describe('resolveFeedEndpoints', () => {
  it('uses GitHub by default', () => {
    expect(resolveFeedEndpoints({})).toBe(GITHUB_ENDPOINTS);
    expect(GITHUB_ENDPOINTS.apiBase).toBe('https://api.github.com');
    expect([...GITHUB_ENDPOINTS.downloadHosts]).toEqual(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
  });

  it.each(['http://127.0.0.1:41234', 'http://localhost:9', 'https://[::1]:8443'])('accepts the loopback test origin %s', origin => {
    const endpoints = resolveFeedEndpoints({ [TEST_ORIGIN_ENV]: origin });
    const url = new URL(origin);
    expect(endpoints).toEqual({
      apiBase: url.origin, webBase: url.origin, downloadHosts: new Set([url.host]), protocol: url.protocol, test: true,
    });
  });

  it.each([
    'http://example.com:8080', 'http://127.0.0.1', 'http://user:secret@127.0.0.1:1', 'http://127.0.0.1:1/path',
    'http://127.0.0.1:1/?q=1', 'file:///tmp/feed', 'ftp://127.0.0.1:21', 'not a url', 'http://127.0.0.2:80',
  ])('ignores the non-loopback or malformed origin %s', origin => {
    expect(resolveFeedEndpoints({ [TEST_ORIGIN_ENV]: origin })).toBe(GITHUB_ENDPOINTS);
  });
});

describe('fetchLatestRelease', () => {
  it('sends one anonymous, versioned GET without identifiers', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse(releaseJson('0.4.0'), { headers: { etag: 'W/"abc"' } }));
    const result = await fetchLatestRelease({ fetch });
    expect(result).toMatchObject({ kind: 'release', etag: 'W/"abc"', candidate: { version: '0.4.0' } });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(API_URL);
    expect(init?.headers).toEqual({
      'User-Agent': 'AI-Engineer-Coach-Update-Check',
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2026-03-10',
    });
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('revalidates with the stored ETag', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null, { status: 304 }));
    expect(await fetchLatestRelease({ fetch, etag: 'W/"abc"' })).toEqual({ kind: 'not-modified' });
    expect(fetch.mock.calls[0][1]?.headers).toMatchObject({ 'If-None-Match': 'W/"abc"' });
  });

  it('treats a 404 as "nothing released yet"', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('{"message":"Not Found"}', { status: 404 }));
    expect(await fetchLatestRelease({ fetch })).toEqual({ kind: 'no-release' });
  });

  it('waits for the reset time when the anonymous rate limit is exhausted', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('{}', {
      status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1800000000' },
    }));
    expect(await fetchLatestRelease({ fetch, now: () => 1_000 })).toEqual({ kind: 'rate-limited', retryAt: 1_800_000_000_000 });
  });

  it('honors retry-after for secondary rate limits', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('{}', { status: 429, headers: { 'retry-after': '120' } }));
    expect(await fetchLatestRelease({ fetch, now: () => 1_000 })).toEqual({ kind: 'rate-limited', retryAt: 121_000 });
    fetch.mockResolvedValue(new Response('{}', { status: 429 }));
    expect(await fetchLatestRelease({ fetch, now: () => 1_000 })).toEqual({ kind: 'rate-limited', retryAt: 61_000 });
  });

  it.each([
    [403, 'GitHub answered HTTP 403'],
    [500, 'GitHub answered HTTP 500'],
    [301, 'GitHub answered HTTP 301'],
  ])('reports HTTP %i as a retryable error', async (status, message) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null, { status }));
    expect(await fetchLatestRelease({ fetch })).toEqual({ kind: 'error', message });
  });

  it('reports network failures without throwing', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(
      Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }));
    expect(await fetchLatestRelease({ fetch })).toEqual({ kind: 'error', message: 'fetch failed (ECONNREFUSED)' });
  });

  it('gives up after the timeout', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError')));
    }));
    expect(await fetchLatestRelease({ fetch, timeoutMs: 5 })).toEqual({ kind: 'error', message: 'the request timed out' });
  });

  it('rejects oversized and malformed bodies', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response('{}', { status: 200, headers: { 'content-length': String(2 * 1024 * 1024) } }))
      .mockResolvedValueOnce(new Response('<html>', { status: 200 }))
      .mockResolvedValueOnce(jsonResponse({ ...releaseJson('0.4.0'), prerelease: true }));
    expect(await fetchLatestRelease({ fetch })).toEqual({ kind: 'error', message: 'the release response is too large' });
    expect(await fetchLatestRelease({ fetch })).toEqual({ kind: 'invalid', reason: 'the release response is not JSON' });
    expect(await fetchLatestRelease({ fetch })).toEqual({ kind: 'invalid', reason: 'the latest release is a draft or pre-release' });
  });

  it('calls the test origin instead of GitHub', async () => {
    const endpoints = resolveFeedEndpoints({ [TEST_ORIGIN_ENV]: 'http://127.0.0.1:41234' });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null, { status: 404 }));
    await fetchLatestRelease({ fetch, endpoints });
    expect(fetch.mock.calls[0][0]).toBe('http://127.0.0.1:41234/repos/microsoft/AI-Engineering-Coach/releases/latest');
  });
});
