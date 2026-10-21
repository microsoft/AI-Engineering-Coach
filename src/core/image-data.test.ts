/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { execFileSync } from 'child_process';
import { buildSync } from 'esbuild';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  imageReferencesFromAttachments,
  imageReferencesFromContent,
  imageReferencesFromVariables,
  imageReferencesFromXcode,
  loadImageReferences,
  mergeImageReferences,
  MAX_IMAGE_BYTES,
} from './image-data';
import { assertTrustedPath } from './parser-shared';

vi.mock('fs', async importOriginal => ({ ...await importOriginal<typeof import('fs')>() }));
vi.mock('os', async importOriginal => ({ ...await importOriginal<typeof import('os')>() }));

const bytes = [137, 80, 78, 71, 13, 10, 26, 10];
const base64 = Buffer.from(bytes).toString('base64');
const image = `data:image/png;base64,${base64}`;
let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'coach-image-data-'));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('local image representations', () => {
  it.each([
    { kind: 'image', value: Object.fromEntries(bytes.map((value, i) => [String(i), value])) },
    { kind: 'image', data: bytes },
    { kind: 'image', value: { data: base64, mimeType: 'image/png' } },
    { kind: 'image', value: image },
  ])('loads VS Code image variables: %j', variable => {
    expect(loadImageReferences(imageReferencesFromVariables([variable]), root)).toEqual([image]);
  });

  it.each([
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } },
    { type: 'input_image', image_url: image },
    { type: 'input_image', image_url: { url: image } },
    { type: 'file', mime: 'image/png', url: image },
  ])('loads inline content images: %j', block => {
    expect(loadImageReferences(imageReferencesFromContent([block]), root)).toEqual([image]);
  });

  it('loads local files, file URLs, relative attachments, and Xcode image data', () => {
    const file = path.join(root, 'screen shot.png');
    fs.writeFileSync(file, Buffer.from(bytes));
    const references = [
      ...imageReferencesFromAttachments([{ type: 'image', path: file }]),
      ...imageReferencesFromAttachments([{ type: 'file', path: pathToFileURL(file).href }]),
      ...imageReferencesFromContent([{ type: 'local_image', path: 'screen shot.png' }]),
      ...imageReferencesFromXcode([{ data: base64, fileUrl: 'file:///deleted-image.png' }]),
    ];
    expect(loadImageReferences(references, root)).toEqual([image, image, image, image]);
  });

  it('opens image files without blocking before checking the descriptor file type', () => {
    const file = path.join(root, 'screenshot.png');
    fs.writeFileSync(file, Buffer.from(bytes));
    const open = fs.openSync;
    const flags = fs.constants.O_RDONLY | (process.platform === 'win32' ? 0 : fs.constants.O_NONBLOCK);
    const opened = vi.spyOn(fs, 'openSync').mockImplementationOnce((target, mode) => open(target, mode));
    const read = vi.spyOn(fs, 'readSync');
    const close = vi.spyOn(fs, 'closeSync');
    vi.spyOn(fs, 'fstatSync').mockReturnValue(fs.statSync(root));
    expect(loadImageReferences([{ path: file }, { data: base64 }], root)).toEqual([image]);
    expect(opened).toHaveBeenCalledOnce();
    expect(opened).toHaveBeenCalledWith(file, flags);
    expect(read).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledWith(opened.mock.results[0].value);
  });

  it.skipIf(process.platform === 'win32').each([false, true])('rejects FIFO images promptly even when replaced during open (replace=%s)', replaceDuringOpen => {
    const file = path.join(root, 'screenshot.png');
    if (replaceDuringOpen) fs.writeFileSync(file, Buffer.from(bytes));
    else execFileSync('mkfifo', [file], { cwd: os.tmpdir(), timeout: 5_000 });
    const bundle = path.join(root, 'image-data.cjs');
    const built = buildSync({
      entryPoints: [path.resolve('src', 'core', 'image-data.ts')],
      bundle: true, platform: 'node', format: 'cjs', write: false,
    });
    fs.writeFileSync(bundle, built.outputFiles[0].text);
    const script = `
      const { loadImageReferences } = require(process.argv[1]);
      const fs = require('fs');
      const file = fs.realpathSync(process.argv[2]);
      if (process.argv[5] === 'true') {
        const open = fs.openSync;
        fs.openSync = (target, flags) => {
          if (target === file) {
            fs.unlinkSync(file);
            require('child_process').execFileSync('mkfifo', [file]);
          }
          return open(target, flags);
        };
      }
      const images = loadImageReferences([{ path: file }, { data: process.argv[4] }], process.argv[3]);
      require('assert/strict').equal(fs.statSync(file).isFIFO(), true);
      process.stdout.write(JSON.stringify(images));
    `;
    const result = execFileSync(process.execPath, ['-e', script, bundle, file, root, base64, String(replaceDuringOpen)], {
      cwd: os.tmpdir(), encoding: 'utf-8', timeout: 5_000, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(JSON.parse(result)).toEqual([image]);
  });

  it('loads fsPath variables and serialized file URI objects', () => {
    const file = path.join(root, 'screen # 100%.png');
    fs.writeFileSync(file, Buffer.from(bytes));
    const variables = [
      { kind: 'image', value: { fsPath: file } },
      { kind: 'image', value: { scheme: 'file', authority: '', path: decodeURIComponent(pathToFileURL(file).pathname) } },
    ];
    expect(loadImageReferences(imageReferencesFromVariables(variables), root)).toEqual([image, image]);
  });

  it.each([{ data: [] }, { data: [999] }, { data: 'invalid base64' }])('retains valid value bytes when sibling data cannot be decoded: %j', ({ data }) => {
    const value = Object.fromEntries(bytes.map((byte, index) => [String(index), byte]));
    expect(loadImageReferences(imageReferencesFromVariables([{ kind: 'image', value, data }]), root)).toEqual([image]);
  });

  it.each([{ data: '' }, { data: [] }, { data: 'invalid base64' }])('retains a local Xcode fileUrl when inline data cannot decode: %j', ({ data }) => {
    const file = path.join(root, 'screenshot.png');
    fs.writeFileSync(file, Buffer.from(bytes));
    const references = imageReferencesFromXcode([{ fileUrl: pathToFileURL(file).href, data }]);
    expect(loadImageReferences(references, root)).toEqual([image]);
  });

  it('preserves nested image-variable file fallbacks when both inline representations are invalid', () => {
    const file = path.join(root, 'screenshot.png');
    fs.writeFileSync(file, Buffer.from(bytes));
    const value = { data: '', fileUrl: pathToFileURL(file).href };
    const variables = [{ kind: 'image', value, data: 'invalid base64' }];
    expect(loadImageReferences(imageReferencesFromVariables(variables), root)).toEqual([image]);
  });

  it.each(['workspace', 'temp'])('loads images through a canonical local %s root', kind => {
    const home = path.join(root, 'home');
    const target = path.join(root, 'target');
    const alias = path.join(root, 'alias');
    fs.mkdirSync(home);
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'screenshot.png'), Buffer.from(bytes));
    fs.symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
    for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_DATA_HOME']) vi.stubEnv(key, home);
    vi.spyOn(os, 'tmpdir').mockReturnValue(kind === 'temp' ? alias : home);
    expect(loadImageReferences([{ path: path.join(alias, 'screenshot.png') }], root, kind === 'workspace' ? alias : undefined))
      .toEqual([image]);
  });

  it('rejects an attachment link that escapes the canonical allowed local roots', () => {
    const home = path.join(root, 'home');
    const workspace = path.join(root, 'workspace');
    const outside = path.join(root, 'outside');
    for (const directory of [home, workspace, outside]) fs.mkdirSync(directory);
    fs.writeFileSync(path.join(outside, 'screenshot.png'), Buffer.from(bytes));
    fs.symlinkSync(outside, path.join(workspace, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_DATA_HOME']) vi.stubEnv(key, home);
    vi.spyOn(os, 'tmpdir').mockReturnValue(home);
    expect(loadImageReferences([{ path: path.join(workspace, 'escape', 'screenshot.png') }], root, workspace)).toEqual([]);
  });

  it.each([
    { scheme: 'file', path: '/deleted/screenshot.png' },
    { scheme: 'vscode-chat-code-block', path: '/screenshot.png' },
  ])('preserves embedded bytes alongside image variable URI metadata: %j', value => {
    const variables = [{ kind: 'image', value, data: bytes }];
    expect(loadImageReferences(imageReferencesFromVariables(variables), root)).toEqual([image]);
  });

  it('matches mirrored image identities before assigning fallback slots', () => {
    const second = Buffer.from([...bytes, 1]).toString('base64');
    const previous = [{ id: 'first', data: base64 }, { id: 'second', data: second }];
    const incoming = [{ id: 'second' }, { id: 'first' }];
    expect(loadImageReferences(mergeImageReferences(previous, incoming), root))
      .toEqual([image, `data:image/png;base64,${second}`]);
  });

  it('retains local-file fallbacks when a mirrored inline payload is invalid', () => {
    const file = path.join(root, 'screenshot.png');
    fs.writeFileSync(file, Buffer.from(bytes));
    const images = mergeImageReferences([{ path: file }], [{ data: 'invalid base64 payload' }]);
    expect(loadImageReferences(images, root)).toEqual([image]);
  });

  it.skipIf(process.platform !== 'win32')('rejects relative images under a network workspace before filesystem access', () => {
    const realpath = vi.spyOn(fs, 'realpathSync').mockImplementation(() => {
      throw new Error('Unexpected filesystem access');
    });
    expect(loadImageReferences([{ path: 'screenshot.png' }], root, '\\\\server\\share\\project')).toEqual([]);
    expect(realpath).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform !== 'win32')('rejects image paths that canonicalize to network shares before opening files', () => {
    vi.spyOn(fs, 'realpathSync').mockReturnValue('\\\\server\\share\\screenshot.png');
    const open = vi.spyOn(fs, 'openSync').mockImplementation(() => {
      throw new Error('Unexpected filesystem access');
    });
    expect(loadImageReferences([{ path: path.join(root, 'screenshot.png') }], root)).toEqual([]);
    expect(open).not.toHaveBeenCalled();
  });

  it('does not classify ordinary file or tool-result content as user images', () => {
    expect(imageReferencesFromAttachments([{ type: 'file', path: 'notes.txt' }])).toEqual([]);
    expect(imageReferencesFromContent([{ type: 'tool_result', content: [{ type: 'image' }] }])).toEqual([]);
    expect(imageReferencesFromVariables([null, { kind: 'file', value: 'test.png' }])).toEqual([]);
  });

  it('loads at most four images and skips invalid references without losing valid ones', () => {
    const references = [{ data: '<svg></svg>' }, ...Array.from({ length: 6 }, () => ({ data: base64 }))];
    expect(loadImageReferences(references, root)).toEqual(Array<string>(4).fill(image));
    expect(console.warn).toHaveBeenCalled();
  });

  it('rejects oversized inline and file images before decoding or reading them', () => {
    const file = path.join(root, 'oversized.png');
    const fd = fs.openSync(file, 'w');
    fs.ftruncateSync(fd, MAX_IMAGE_BYTES + 1);
    fs.closeSync(fd);
    expect(loadImageReferences([
      { data: 'A'.repeat(Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4) },
      { data: Buffer.alloc(MAX_IMAGE_BYTES + 1).toString('base64') },
      { path: file },
      { data: base64 },
    ], root)).toEqual([image]);
    expect(console.warn).toHaveBeenCalledTimes(3);
  });

  it('accepts the exact image size limit', () => {
    const data = Buffer.alloc(MAX_IMAGE_BYTES);
    data.set(bytes);
    const file = path.join(root, 'limit.png');
    fs.writeFileSync(file, data);
    const result = loadImageReferences([{ path: file }], root);
    expect(result).toHaveLength(1);
    expect(Buffer.from(result[0].split(',')[1], 'base64')).toHaveLength(MAX_IMAGE_BYTES);
  });

  it('rejects missing files, traversal, remote URLs, remote shares, and executable image data', () => {
    expect(loadImageReferences([
      { path: path.join(root, 'missing.png') },
      { path: '..\\escape.png' },
      { path: 'https://example.com/screen.png' },
      { path: 'file://remote-host/share/screen.png' },
      { path: '\\\\remote-host\\share\\screen.png' },
      { data: `data:image/svg+xml;base64,${Buffer.from('<svg><script>alert(1)</script></svg>').toString('base64')}` },
      { data: [137, 80, 78, 71, -1, 0, 0, 0] },
    ], root)).toEqual([]);
    expect(console.warn).toHaveBeenCalledTimes(7);
  });

  it('only extends attachment trust to the explicitly supplied workspace root', () => {
    const workspace = path.join(path.parse(root).root, 'coach-image-workspace');
    const file = path.join(workspace, 'screen.png');
    expect(() => assertTrustedPath(file)).toThrow('outside trusted directories');
    expect(() => assertTrustedPath(file, [workspace])).not.toThrow();
    expect(() => assertTrustedPath(path.join(path.dirname(workspace), 'other-workspace', 'screen.png'), [workspace]))
      .toThrow('outside trusted directories');
  });

  it.skipIf(process.platform !== 'win32')('loads Windows attachment paths with different drive and directory casing', () => {
    const file = path.join(root, 'Screenshot.PNG');
    fs.writeFileSync(file, Buffer.from(bytes));
    expect(loadImageReferences([{ path: file.toLowerCase() }], root)).toEqual([image]);
  });
});
