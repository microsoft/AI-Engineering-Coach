/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Reads the latest stable GitHub Release of this extension. One anonymous GET with a constant
 * User-Agent: no version, machine, or user identifiers and no Authorization header. Responses
 * are size-capped and validated against the exact URLs and asset names the release workflow
 * publishes, so nothing else from the response is trusted. */

import { z } from 'zod';
import { readTextWithByteLimit } from '../webview/fetch-utils';

export const UPDATE_REPOSITORY = 'microsoft/AI-Engineering-Coach';
export const PACKAGE_NAME = 'ai-engineer-coach';
export const USER_AGENT = 'AI-Engineer-Coach-Update-Check';
export const GITHUB_API_VERSION = '2026-03-10';
/** Test-only: points the feed and downloads at a loopback server (see CONTRIBUTING.md). */
export const TEST_ORIGIN_ENV = 'AI_ENGINEER_COACH_UPDATE_TEST_ORIGIN';
/** The workflow identity that uploads release assets with GITHUB_TOKEN. */
export const RELEASE_UPLOADER = 'github-actions[bot]';
export const MAX_VSIX_BYTES = 20 * 1024 * 1024;

const MAX_RELEASE_JSON_BYTES = 1024 * 1024;
const MAX_CHECKSUM_FILE_BYTES = 4096;
const CHECK_TIMEOUT_MS = 10_000;
const DEFAULT_RATE_LIMIT_WAIT_MS = 60_000;
const STABLE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA256_DIGEST = /^sha256:([0-9a-f]{64})$/;

export interface FeedEndpoints {
  /** REST API origin, e.g. https://api.github.com. */
  apiBase: string;
  /** Web origin that release pages and download URLs must use, e.g. https://github.com. */
  webBase: string;
  /** `URL.host` values (host plus any non-default port) that downloads may visit. */
  downloadHosts: ReadonlySet<string>;
  /** Protocol every request must use. */
  protocol: 'https:' | 'http:';
  /** True when a loopback test origin replaced GitHub. */
  test: boolean;
}

export const GITHUB_ENDPOINTS: FeedEndpoints = {
  apiBase: 'https://api.github.com',
  webBase: 'https://github.com',
  // github.com answers with a 302 to a short-lived signed URL on the release-assets host;
  // objects.githubusercontent.com is the storage host GitHub used before it.
  downloadHosts: new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']),
  protocol: 'https:',
  test: false,
};

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);

/** GitHub, unless the test-only variable names a loopback origin with an explicit port. */
export function resolveFeedEndpoints(env: NodeJS.ProcessEnv = process.env): FeedEndpoints {
  const raw = env[TEST_ORIGIN_ENV];
  if (!raw) return GITHUB_ENDPOINTS;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return GITHUB_ENDPOINTS;
  }
  const isLoopbackOrigin = (url.protocol === 'http:' || url.protocol === 'https:')
    && LOOPBACK_HOSTS.has(url.hostname) && url.port !== ''
    && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash;
  if (!isLoopbackOrigin) return GITHUB_ENDPOINTS;
  return {
    apiBase: url.origin,
    webBase: url.origin,
    downloadHosts: new Set([url.host]),
    protocol: url.protocol as 'https:' | 'http:',
    test: true,
  };
}

/** A validated stable release; every URL equals the one the release workflow publishes. */
export interface UpdateCandidate {
  version: string;
  releaseUrl: string;
  publishedAt: string;
  immutable: boolean;
  vsix: {
    name: string;
    url: string;
    size: number;
    /** Hex SHA-256 that GitHub computed when the asset was uploaded. */
    sha256?: string;
    uploader: string;
  };
  /** Download URL of the `<vsix>.sha256` asset, used when GitHub reports no digest. */
  checksumUrl?: string;
}

const assetSchema = z.object({
  name: z.string(),
  size: z.number().int().nonnegative(),
  state: z.string(),
  digest: z.string().nullish(),
  browser_download_url: z.string(),
  uploader: z.object({ login: z.string() }).nullish(),
});

const releaseSchema = z.object({
  tag_name: z.string(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  immutable: z.boolean().optional(),
  published_at: z.string().nullable(),
  html_url: z.string(),
  assets: z.array(assetSchema).max(100),
});

export type CandidateResult = { ok: true; candidate: UpdateCandidate } | { ok: false; reason: string };

const storedCandidateSchema = z.object({
  version: z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/),
  releaseUrl: z.string(),
  publishedAt: z.string(),
  immutable: z.boolean(),
  vsix: z.object({
    name: z.string(),
    url: z.string(),
    size: z.number().int().positive().max(MAX_VSIX_BYTES),
    sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    uploader: z.string(),
  }),
  checksumUrl: z.string().optional(),
});

/** True for a candidate read back from storage in the shape `toUpdateCandidate` produces. */
export function isUpdateCandidate(value: unknown): value is UpdateCandidate {
  return storedCandidateSchema.safeParse(value).success;
}

type ReleaseAsset = z.infer<typeof assetSchema>;
type VsixResult = { ok: true; asset: ReleaseAsset; sha256?: string } | { ok: false; reason: string };

/** The one VSIX asset of the release, uploaded at the expected URL and within the size limit. */
function pickVsix(assets: ReleaseAsset[], name: string, url: string): VsixResult {
  const matches = assets.filter(asset => asset.name === name);
  if (matches.length !== 1) return { ok: false, reason: `the release has no single ${name} asset` };
  const [asset] = matches;
  if (asset.state !== 'uploaded') return { ok: false, reason: `${name} is not fully uploaded` };
  if (asset.size <= 0 || asset.size > MAX_VSIX_BYTES) return { ok: false, reason: `${name} has an unexpected size` };
  if (asset.browser_download_url !== url) return { ok: false, reason: `${name} has an unexpected download URL` };
  if (!asset.digest) return { ok: true, asset };
  const match = SHA256_DIGEST.exec(asset.digest);
  return match ? { ok: true, asset, sha256: match[1] } : { ok: false, reason: `${name} has an unexpected digest` };
}

/** URL of the release's `<vsix>.sha256` asset, if it has the expected shape. */
function checksumUrlOf(assets: ReleaseAsset[], name: string, url: string): string | undefined {
  const checksum = assets.find(asset => asset.name === name);
  const valid = checksum !== undefined && checksum.state === 'uploaded'
    && checksum.size > 0 && checksum.size <= MAX_CHECKSUM_FILE_BYTES && checksum.browser_download_url === url;
  return valid ? url : undefined;
}

/** Accepts only a published, stable `vX.Y.Z` release whose VSIX asset has the expected name and URL. */
export function toUpdateCandidate(value: unknown, endpoints: FeedEndpoints = GITHUB_ENDPOINTS): CandidateResult {
  const parsed = releaseSchema.safeParse(value);
  if (!parsed.success) return { ok: false, reason: 'the release response has an unexpected format' };
  const release = parsed.data;
  if (release.draft || release.prerelease) return { ok: false, reason: 'the latest release is a draft or pre-release' };
  if (!STABLE_TAG.test(release.tag_name)) return { ok: false, reason: 'the latest release tag is not vX.Y.Z' };
  const version = release.tag_name.slice(1);
  const repoWeb = `${endpoints.webBase}/${UPDATE_REPOSITORY}`;
  const releaseUrl = `${repoWeb}/releases/tag/v${version}`;
  if (release.html_url !== releaseUrl) return { ok: false, reason: 'the release page URL is unexpected' };
  const publishedAt = release.published_at ? Date.parse(release.published_at) : Number.NaN;
  if (!Number.isFinite(publishedAt)) return { ok: false, reason: 'the release has no publication date' };

  const vsixName = `${PACKAGE_NAME}-${version}.vsix`;
  const downloadBase = `${repoWeb}/releases/download/v${version}`;
  const vsix = pickVsix(release.assets, vsixName, `${downloadBase}/${vsixName}`);
  if (!vsix.ok) return vsix;
  return {
    ok: true,
    candidate: {
      version,
      releaseUrl,
      publishedAt: new Date(publishedAt).toISOString(),
      immutable: release.immutable === true,
      vsix: {
        name: vsixName,
        url: vsix.asset.browser_download_url,
        size: vsix.asset.size,
        sha256: vsix.sha256,
        uploader: vsix.asset.uploader?.login ?? '',
      },
      checksumUrl: checksumUrlOf(release.assets, `${vsixName}.sha256`, `${downloadBase}/${vsixName}.sha256`),
    },
  };
}

/** One-click install needs an immutable release, a workflow upload, and a checksum to compare. */
export function canInstallCandidate(candidate: UpdateCandidate): boolean {
  return candidate.immutable
    && candidate.vsix.uploader === RELEASE_UPLOADER
    && (candidate.vsix.sha256 !== undefined || candidate.checksumUrl !== undefined);
}

/** URL of the releases list, used when no specific release is known. */
export function releasesPageUrl(endpoints: FeedEndpoints = GITHUB_ENDPOINTS): string {
  return `${endpoints.webBase}/${UPDATE_REPOSITORY}/releases`;
}

export type FeedResult =
  | { kind: 'release'; candidate: UpdateCandidate; etag?: string }
  | { kind: 'not-modified' }
  /** 404: nothing has been released yet. */
  | { kind: 'no-release' }
  /** A 200 response that is not a usable stable release; kept quiet like `no-release`. */
  | { kind: 'invalid'; reason: string }
  | { kind: 'rate-limited'; retryAt: number }
  | { kind: 'error'; message: string };

export interface FetchLatestOptions {
  fetch: typeof globalThis.fetch;
  endpoints?: FeedEndpoints;
  /** ETag of the last 200 response; sent as If-None-Match. */
  etag?: string;
  now?: () => number;
  timeoutMs?: number;
}

function rateLimitRetryAt(headers: Headers, status: number, now: number): number | undefined {
  const retryAfter = headers.get('retry-after');
  const retryAfterSeconds = Number(retryAfter);
  if (retryAfter !== null && retryAfter.trim() !== '' && Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return now + retryAfterSeconds * 1000;
  }
  if (headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(headers.get('x-ratelimit-reset'));
    return Number.isFinite(reset) && reset > 0 ? reset * 1000 : now + DEFAULT_RATE_LIMIT_WAIT_MS;
  }
  return status === 429 ? now + DEFAULT_RATE_LIMIT_WAIT_MS : undefined;
}

/** A short reason for logs and messages, without echoing response bodies. */
export function describeNetworkError(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'the request timed out';
    const cause = (err as { cause?: unknown }).cause;
    const code = typeof cause === 'object' && cause !== null ? (cause as { code?: unknown }).code : undefined;
    return typeof code === 'string' ? `${err.message} (${code})` : err.message;
  }
  return String(err);
}

/** GET /repos/{repo}/releases/latest; never throws. */
export async function fetchLatestRelease(options: FetchLatestOptions): Promise<FeedResult> {
  const endpoints = options.endpoints ?? GITHUB_ENDPOINTS;
  const now = options.now ?? Date.now;
  const headers: Record<string, string> = {
    'User-Agent': USER_AGENT,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
  };
  if (options.etag) headers['If-None-Match'] = options.etag;
  try {
    const response = await options.fetch(`${endpoints.apiBase}/repos/${UPDATE_REPOSITORY}/releases/latest`, {
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs ?? CHECK_TIMEOUT_MS),
    });
    if (response.status === 304) return { kind: 'not-modified' };
    if (response.status === 404) return { kind: 'no-release' };
    if (response.status === 403 || response.status === 429) {
      const retryAt = rateLimitRetryAt(response.headers, response.status, now());
      if (retryAt !== undefined) return { kind: 'rate-limited', retryAt };
    }
    if (response.status !== 200) return { kind: 'error', message: `GitHub answered HTTP ${response.status}` };
    const text = await readTextWithByteLimit(response, MAX_RELEASE_JSON_BYTES, 'the release response is too large');
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { kind: 'invalid', reason: 'the release response is not JSON' };
    }
    const result = toUpdateCandidate(json, endpoints);
    if (!result.ok) return { kind: 'invalid', reason: result.reason };
    return { kind: 'release', candidate: result.candidate, etag: response.headers.get('etag') ?? undefined };
  } catch (err: unknown) {
    return { kind: 'error', message: describeNetworkError(err) };
  }
}
