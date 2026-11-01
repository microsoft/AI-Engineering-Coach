/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Test fixtures for the update check: a tiny VSIX-shaped payload and GitHub release JSON in the
 * shape `GET /repos/{repo}/releases/latest` returns, as published by .github/workflows/release.yml. */

import { createHash } from 'crypto';

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Bytes that start with the ZIP local-file signature, like every VSIX. */
export function fakeVsix(size = 64, fill = 7): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(size).fill(fill);
  bytes.set([0x50, 0x4b, 0x03, 0x04]);
  return bytes;
}

export interface ReleaseFixtureOptions {
  webBase?: string;
  bytes?: Uint8Array<ArrayBuffer>;
  /** `undefined` uses the real digest of `bytes`; `null` omits it. */
  digest?: string | null;
  immutable?: boolean;
  uploader?: string;
  publishedAt?: string;
  checksumAsset?: boolean;
}

export function releaseJson(version: string, options: ReleaseFixtureOptions = {}): Record<string, unknown> {
  const repo = `${options.webBase ?? 'https://github.com'}/microsoft/AI-Engineering-Coach`;
  const bytes = options.bytes ?? fakeVsix();
  const name = `ai-engineer-coach-${version}.vsix`;
  const download = `${repo}/releases/download/v${version}`;
  const assets: Record<string, unknown>[] = [{
    name,
    size: bytes.byteLength,
    state: 'uploaded',
    content_type: 'application/octet-stream',
    digest: options.digest === undefined ? `sha256:${sha256Hex(bytes)}` : options.digest,
    browser_download_url: `${download}/${name}`,
    uploader: { login: options.uploader ?? 'github-actions[bot]', type: 'Bot' },
  }];
  if (options.checksumAsset !== false) {
    assets.push({
      name: `${name}.sha256`,
      size: 64 + 2 + name.length + 1,
      state: 'uploaded',
      digest: `sha256:${'0'.repeat(64)}`,
      browser_download_url: `${download}/${name}.sha256`,
      uploader: { login: 'github-actions[bot]', type: 'Bot' },
    });
  }
  return {
    url: `https://api.github.com/repos/microsoft/AI-Engineering-Coach/releases/1`,
    html_url: `${repo}/releases/tag/v${version}`,
    tag_name: `v${version}`,
    name: `v${version}`,
    draft: false,
    prerelease: false,
    immutable: options.immutable ?? true,
    created_at: '2026-09-30T12:00:00Z',
    published_at: options.publishedAt ?? '2026-10-01T12:00:00Z',
    body: `## [${version}] - 2026-10-01\n\n### Added\n\n- Something new`,
    assets,
  };
}

export function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers as Record<string, string> | undefined) },
  });
}
