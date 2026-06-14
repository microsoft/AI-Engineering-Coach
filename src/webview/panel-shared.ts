/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { WebviewMessage, ErrorResult } from '../core/types';

export type RequestMessage = Extract<WebviewMessage, { type: 'request' }>;

/**
 * Build a typed error payload. Use this instead of `{ error: 'msg' }` literals
 * so TypeScript enforces the canonical `ErrorResult` shape defined in core/types.
 */
export function errorResult(message: string, extra: Record<string, unknown> = {}): ErrorResult {
  return { error: message, ...extra };
}

export function isString(value: unknown): value is string {
  return typeof value === 'string';
}

export function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isRequestMessage(value: unknown): value is RequestMessage {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.type !== 'request' || !isString(record.id) || !isString(record.method)) return false;
  // Handlers index into params by key, so reject arrays and primitives.
  if (record.params !== undefined && !isRecord(record.params)) return false;
  return true;
}

export function postResponse(webview: vscode.Webview, id: string, data: unknown): void {
  webview.postMessage({ type: 'response', id, data });
}

export function postError(webview: vscode.Webview, id: string, message: string, extra: Record<string, unknown> = {}): void {
  webview.postMessage({ type: 'response', id, data: errorResult(message, extra) });
}

export function postEvent(webview: vscode.Webview, method: string, data: unknown): void {
  webview.postMessage({ type: 'event', method, data });
}

export function getNonce(): string {
  return crypto.randomBytes(16).toString('base64url');
}

/** Escape HTML special characters to prevent XSS when interpolating into templates. */
export function escapeHtmlAttr(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function hasUrlControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1F || code === 0x7F) return true;
  }
  return false;
}

export function isSafeExternalHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string' || hasUrlControlChars(value) || !value.toLowerCase().startsWith('https://')) {
    return false;
  }
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname.length > 0 && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Characters permitted in a single user-supplied path segment. */
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

export function safeJoinUnder(
  baseDir: string,
  segments: string[],
  opts?: { allowedExts?: string[] },
): string | null {
  if (segments.length === 0) return null;
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..' || !SAFE_SEGMENT.test(segment)) return null;
  }

  const finalSegment = segments[segments.length - 1];
  if (opts?.allowedExts && !opts.allowedExts.includes(path.extname(finalSegment).toLowerCase())) {
    return null;
  }

  const resolvedBase = path.resolve(baseDir);
  const resolved = path.resolve(resolvedBase, ...segments);
  if (resolved !== resolvedBase && !resolved.startsWith(resolvedBase + path.sep)) return null;
  return resolved;
}
