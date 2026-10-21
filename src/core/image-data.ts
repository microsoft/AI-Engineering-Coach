/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { assertTrustedPath, getTrustedRoots } from './parser-shared';
import { warnCore } from './log';

export interface ImageReference {
  id?: string;
  data?: unknown;
  path?: string;
  alternatives?: ImageReference[];
}

export interface ImageRequestMatch {
  userEventId?: string;
  requestIndex?: number;
}

export const MAX_IMAGES_PER_REQUEST = 4;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function imagePath(value: unknown): boolean {
  return typeof value === 'string' && /\.(?:png|jpe?g|gif|webp|bmp|avif)(?:[?#].*)?$/i.test(value);
}

function imageLocation(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!isRecord(value)) return undefined;
  if (typeof value.external === 'string') return value.external;
  if (typeof value.fsPath === 'string') return value.fsPath;
  if (typeof value.path !== 'string') return undefined;
  if (value.scheme === 'file') {
    const url = new URL('file:///');
    if (typeof value.authority === 'string') url.hostname = value.authority;
    url.pathname = encodeURI(value.path).replaceAll('#', '%23').replaceAll('?', '%3F');
    return url.href;
  }
  if (typeof value.scheme === 'string' && value.scheme !== 'file') return `${value.scheme}:${value.path}`;
  if (typeof value.authority === 'string' && value.authority) return `//${value.authority}${value.path}`;
  return value.path;
}

function reference(value: Record<string, unknown>): ImageReference {
  const source = isRecord(value.source) ? value.source : {};
  const url = isRecord(value.image_url) ? value.image_url.url : value.image_url;
  const location = imageLocation(typeof value.scheme === 'string' ? value
    : value.path ?? value.fsPath ?? value.fileUrl ?? value.uri ?? value.url ?? value.external ?? url ?? source.url);
  const data = source.data ?? value.data ?? value.value;
  const id = typeof value.file_id === 'string' ? value.file_id : undefined;
  const alternatives: ImageReference[] = location === undefined ? []
    : [location.startsWith('data:') ? { id, data: location } : { id, path: location }];
  if (typeof data === 'string' && !data.startsWith('data:') && imagePath(data)) return { id, path: data, alternatives };
  return data === undefined ? alternatives[0] ?? { id } : { id, data, alternatives };
}

export function imageReferencesFromVariables(value: unknown): ImageReference[] {
  return records(value).filter(v => v.kind === 'image').map(v => {
    const data = v.value;
    const fallback = isRecord(data) && ['data', 'uri', 'path', 'external', 'fsPath'].some(key => key in data)
      ? reference(data) : reference({ ...v, data: undefined });
    const primary = reference(v);
    return v.data === undefined ? fallback : { ...primary, alternatives: [fallback, ...primary.alternatives ?? []] };
  });
}

export function imageRequestIndex(sessionId: string, requestId: string, kind: 'cli' | 'codex', match?: ImageRequestMatch): number | null {
  if (match?.requestIndex !== undefined) return Number.isSafeInteger(match.requestIndex) && match.requestIndex >= 0 ? match.requestIndex : null;
  const prefix = `${sessionId}:${kind}:`;
  if (!requestId.startsWith(prefix)) return null;
  const suffix = requestId.slice(prefix.length);
  const index = Number(suffix);
  return /^\d+$/.test(suffix) && Number.isSafeInteger(index) ? index : null;
}

export function imageReferencesFromAttachments(value: unknown): ImageReference[] {
  return records(value)
    .filter(v => v.type === 'image'
      || (typeof v.mimeType === 'string' && v.mimeType.startsWith('image/'))
      || imagePath(v.path ?? v.url ?? v.uri))
    .map(reference);
}

export function imageReferencesFromContent(value: unknown): ImageReference[] {
  return records(value)
    .filter(v => v.type === 'image' || v.type === 'input_image' || v.type === 'local_image'
      || (v.type === 'file' && ((typeof v.mime === 'string' && v.mime.startsWith('image/')) || imagePath(v.url))))
    .map(reference);
}

export function imageReferencesFromXcode(value: unknown): ImageReference[] {
  return records(value).map(reference);
}

export function imageReferencesFromCodex(payload: Record<string, unknown>): ImageReference[] {
  const images = imageReferencesFromContent(payload.content);
  for (const value of Array.isArray(payload.images) ? payload.images : []) {
    if (typeof value === 'string') images.push({ data: value });
  }
  for (const value of Array.isArray(payload.file_ids) ? payload.file_ids : []) {
    if (typeof value === 'string') images.push({ id: value });
  }
  for (const value of Array.isArray(payload.local_images) ? payload.local_images : []) {
    if (typeof value === 'string') images.push({ path: value });
    else if (isRecord(value)) images.push(reference(value));
  }
  return images;
}

function imageCandidates(image: ImageReference): ImageReference[] {
  const { alternatives, ...primary } = image;
  return [primary, ...(alternatives ?? []).flatMap(imageCandidates)];
}

function sameImage(first: ImageReference, second: ImageReference): boolean {
  return (first.id !== undefined && first.id === second.id)
    || (first.path !== undefined && first.path === second.path)
    || (first.data !== undefined && first.data === second.data);
}

export function mergeImageReferences(previous: ImageReference[], incoming: ImageReference[]): ImageReference[] {
  const result = [...previous];
  const unmatched = new Set(previous.map((_image, index) => index));
  const matches = incoming.map(image => {
    const index = previous.findIndex((existing, index) => unmatched.has(index)
      && imageCandidates(existing).some(first => imageCandidates(image).some(second => sameImage(first, second))));
    if (index >= 0) unmatched.delete(index);
    return index;
  });
  for (const [index, image] of incoming.entries()) {
    // Match stable identities first, then pair remaining mirror slots in order.
    // Keep alternate payloads so incomplete mirrors cannot discard local data.
    const target = matches[index] >= 0 ? matches[index] : unmatched.values().next().value ?? result.length;
    unmatched.delete(target);
    const candidates = [...imageCandidates(image), ...(result[target] ? imageCandidates(result[target]) : [])];
    const quality = (candidate: ImageReference): number => candidate.data !== undefined ? 2 : candidate.path ? 1 : 0;
    candidates.sort((first, second) => quality(second) - quality(first));
    result[target] = { ...candidates[0], alternatives: candidates.slice(1) };
  }
  return result;
}

function imageMime(bytes: Uint8Array): string | null {
  if (bytes.length < 8) return null;
  if (bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes[0] === 71 && bytes[1] === 73 && bytes[2] === 70) return 'image/gif';
  if (bytes[0] === 82 && bytes[1] === 73 && bytes[2] === 70 && bytes[3] === 70
    && Buffer.from(bytes.subarray(8, 12)).toString() === 'WEBP') return 'image/webp';
  if (bytes[0] === 66 && bytes[1] === 77) return 'image/bmp';
  if (Buffer.from(bytes.subarray(4, 8)).toString() === 'ftyp'
    && ['avif', 'avis'].includes(Buffer.from(bytes.subarray(8, 12)).toString())) return 'image/avif';
  return null;
}

function imageBytes(data: unknown): Uint8Array | null {
  if (typeof data === 'string') {
    const match = /^data:image\/[a-z0-9.+-]+;base64,([\s\S]*)$/i.exec(data);
    const base64 = (match ? match[1] : data).replaceAll(/\s/g, '');
    if (base64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw new Error('Image exceeds the 10 MB limit');
    if (!/^[a-z0-9+/]*={0,2}$/i.test(base64) || base64.length % 4 === 1) {
      throw new Error('Invalid base64 image data');
    }
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error('Image exceeds the 10 MB limit');
    return bytes;
  }
  if (!Array.isArray(data) && !isRecord(data)) return null;
  const length = Array.isArray(data) ? data.length : Object.keys(data).length;
  if (length > MAX_IMAGE_BYTES) throw new Error('Image exceeds the 10 MB limit');
  if (length < 8) return null;
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    const value: unknown = Array.isArray(data) ? data[i] : data[String(i)];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 255) {
      throw new Error('Invalid image byte array');
    }
    bytes[i] = value;
  }
  return bytes;
}

function assertLocalImagePath(filePath: string): void {
  if (filePath.startsWith('\\\\') || filePath.startsWith('//')) throw new Error('Remote image files are not supported');
}

function canonicalImageRoots(filePath: string, additionalRoots: string[]): string[] {
  const roots = new Set([...getTrustedRoots(), ...additionalRoots].map(root => path.resolve(root)));
  const canonical: string[] = [];
  for (const root of roots) {
    const relative = path.relative(root, filePath);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
    assertLocalImagePath(root);
    const resolved = fs.realpathSync(root);
    assertLocalImagePath(resolved);
    canonical.push(resolved);
  }
  return canonical;
}

function readImageFile(location: string, baseDir: string, workspaceRootPath?: string): Uint8Array {
  let filePath = location;
  if (/^file:/i.test(location)) {
    const url = new URL(location);
    if (url.hostname && url.hostname !== 'localhost') throw new Error('Remote image files are not supported');
    filePath = fileURLToPath(url);
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(location) && !/^[a-z]:[\\/]/i.test(location)) {
    throw new Error('Remote image URLs are not supported');
  }
  assertLocalImagePath(filePath);
  if (filePath.replaceAll('\\', '/').split('/').includes('..')) throw new Error('Image path traversal detected');
  filePath = path.resolve(workspaceRootPath || baseDir, filePath);
  assertLocalImagePath(filePath);
  const roots = workspaceRootPath ? [workspaceRootPath] : [];
  assertTrustedPath(filePath, roots);
  const canonicalRoots = canonicalImageRoots(filePath, roots);
  const resolved = fs.realpathSync(filePath);
  assertLocalImagePath(resolved);
  assertTrustedPath(resolved, canonicalRoots);
  // A FIFO must not block before its descriptor can be rejected as a non-file.
  const fd = fs.openSync(resolved, fs.constants.O_RDONLY | (process.platform === 'win32' ? 0 : fs.constants.O_NONBLOCK));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) throw new Error('Image is not a file or exceeds the 10 MB limit');
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = fs.readSync(fd, bytes, offset, bytes.length - offset, null);
      if (read === 0) throw new Error('Image changed while reading');
      offset += read;
    }
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}

function loadImageReference(image: ImageReference, baseDir: string, workspaceRootPath?: string): string | null {
  for (const candidate of imageCandidates(image)) {
    try {
      const bytes = candidate.path
        ? readImageFile(candidate.path, baseDir, workspaceRootPath)
        : imageBytes(candidate.data);
      if (!bytes) {
        warnCore('image-extract', 'Image reference has no recorded data or local file');
        continue;
      }
      const mime = imageMime(bytes);
      if (!mime) throw new Error('Unsupported image data');
      return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
    } catch (error) {
      warnCore('image-extract', 'Could not load a local image', error);
    }
  }
  return null;
}

export function loadImageReferences(images: ImageReference[], baseDir: string, workspaceRootPath?: string): string[] {
  const result: string[] = [];
  for (const image of images) {
    if (result.length >= MAX_IMAGES_PER_REQUEST) break;
    const uri = loadImageReference(image, baseDir, workspaceRootPath);
    if (uri) result.push(uri);
  }
  return result;
}
