/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Downloads a release VSIX and proves it is the file GitHub stored for that release: every
 * redirect hop must stay on an allowlisted HTTPS host, the size is capped while streaming, and
 * the SHA-256 must match GitHub's digest (or the release's .sha256 asset). Runs only after the
 * user clicks Update; sends no credentials. */

import { createHash } from 'crypto';
import { GITHUB_ENDPOINTS, MAX_VSIX_BYTES, USER_AGENT, describeNetworkError, type FeedEndpoints, type UpdateCandidate } from './release-feed';

const MAX_REDIRECTS = 3;
const MAX_CHECKSUM_FILE_BYTES = 4096;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04];

/** A failure the user should see; the message completes "Couldn't install the update: …". */
export class UpdateDownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpdateDownloadError';
  }
}

export interface DownloadOptions {
  fetch: typeof globalThis.fetch;
  candidate: UpdateCandidate;
  endpoints?: FeedEndpoints;
  signal?: AbortSignal;
  onProgress?: (receivedBytes: number, totalBytes: number) => void;
}

function checkUrl(url: URL, endpoints: FeedEndpoints): void {
  if (url.protocol !== endpoints.protocol || url.username || url.password || !endpoints.downloadHosts.has(url.host)) {
    throw new UpdateDownloadError(`the download was redirected to an unexpected location (${url.protocol}//${url.host})`);
  }
}

/** GET with manual redirects, validating every hop against the host allowlist. */
export async function fetchFromAllowedHosts(
  start: string,
  options: { fetch: typeof globalThis.fetch; endpoints: FeedEndpoints; signal?: AbortSignal; accept: string },
): Promise<Response> {
  let url = new URL(start);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    options.signal?.throwIfAborted();
    checkUrl(url, options.endpoints);
    let response: Response;
    try {
      response = await options.fetch(url.toString(), {
        headers: { 'User-Agent': USER_AGENT, Accept: options.accept },
        redirect: 'manual',
        signal: options.signal,
      });
    } catch (err: unknown) {
      if (options.signal?.aborted) throw err;
      throw new UpdateDownloadError(`the download failed: ${describeNetworkError(err)}`);
    }
    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new UpdateDownloadError('the download was redirected without a location');
      url = new URL(location, url);
      continue;
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new UpdateDownloadError(`the download failed with HTTP ${response.status}`);
    }
    return response;
  }
  throw new UpdateDownloadError('the download was redirected too many times');
}

/** Reads the body, aborting as soon as it exceeds `maxBytes`. */
export async function readBytesWithLimit(
  response: Response,
  maxBytes: number,
  onProgress?: (receivedBytes: number) => void,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'));
  if (response.headers.get('content-length') !== null && Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new UpdateDownloadError('the download is larger than expected');
  }
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw new UpdateDownloadError('the download is larger than expected');
    }
    chunks.push(value);
    onProgress?.(received);
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Parses a `sha256sum` line (`<64-hex>  <file>`) for the expected file. */
export function parseChecksumFile(text: string, fileName: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line.trim());
    if (match && match[2] === fileName) return match[1].toLowerCase();
  }
  return undefined;
}

async function expectedSha256(options: Required<Pick<DownloadOptions, 'fetch' | 'candidate'>> & { endpoints: FeedEndpoints; signal?: AbortSignal }): Promise<string> {
  const { candidate } = options;
  if (candidate.vsix.sha256) return candidate.vsix.sha256;
  if (!candidate.checksumUrl) throw new UpdateDownloadError('the release has no checksum to verify the download');
  const response = await fetchFromAllowedHosts(candidate.checksumUrl, { ...options, accept: 'application/octet-stream' });
  const text = new TextDecoder().decode(await readBytesWithLimit(response, MAX_CHECKSUM_FILE_BYTES));
  const sha256 = parseChecksumFile(text, candidate.vsix.name);
  if (!sha256) throw new UpdateDownloadError('the release checksum file is not in the expected format');
  return sha256;
}

/** Downloads the candidate's VSIX and returns its bytes only when size, checksum and format match. */
export async function downloadVerifiedVsix(options: DownloadOptions): Promise<Uint8Array> {
  const endpoints = options.endpoints ?? GITHUB_ENDPOINTS;
  const { candidate } = options;
  const sha256 = await expectedSha256({ fetch: options.fetch, candidate, endpoints, signal: options.signal });
  const response = await fetchFromAllowedHosts(candidate.vsix.url, {
    fetch: options.fetch, endpoints, signal: options.signal, accept: 'application/octet-stream',
  });
  const bytes = await readBytesWithLimit(response, Math.min(candidate.vsix.size, MAX_VSIX_BYTES),
    received => options.onProgress?.(received, candidate.vsix.size));
  if (bytes.byteLength !== candidate.vsix.size) {
    throw new UpdateDownloadError(`the download has ${bytes.byteLength} bytes, but the release lists ${candidate.vsix.size}`);
  }
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== sha256) throw new UpdateDownloadError("the download's SHA-256 checksum doesn't match the release");
  if (!ZIP_SIGNATURE.every((byte, index) => bytes[index] === byte)) {
    throw new UpdateDownloadError('the download is not a VSIX package');
  }
  return bytes;
}
