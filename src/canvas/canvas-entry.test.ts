/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Loads the real canvas entry files (the .github/extensions forwarding stub and the
 * .apm/extensions source) in a child Node process with a stubbed Copilot SDK, so moving
 * either file or changing the repo-root depth fails here instead of only in the app. */

import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { afterEach, beforeEach, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');
const CANVAS = path.join('extensions', 'ai-engineer-coach', 'extension.mjs');
const stubSource = path.join(repoRoot, '.github', CANVAS);
const apmSource = path.join(repoRoot, '.apm', CANVAS);

interface EntryResult {
  id: string;
  joined: boolean;
  plainUrl: string;
  curiosityUrl: string;
  status: { built: boolean };
  root: string;
}

let tmp: string;

beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aec-canvas-entry-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function copy(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function writeHarness(): string {
  const sdk = path.join(tmp, 'harness', 'sdk.mjs');
  fs.mkdirSync(path.dirname(sdk), { recursive: true });
  fs.writeFileSync(sdk, [
    'export function createCanvas(def) { globalThis.__aecCanvas = def; return def; }',
    'export async function joinSession(opts) { globalThis.__aecJoined = opts; return { sessionId: "test", log: async () => {} }; }',
  ].join('\n'));
  fs.writeFileSync(path.join(tmp, 'harness', 'hooks.mjs'), [
    `const sdkUrl = ${JSON.stringify(pathToFileURL(sdk).href)};`,
    'export async function resolve(specifier, context, next) {',
    '  if (specifier === "@github/copilot-sdk/extension") return { url: sdkUrl, shortCircuit: true };',
    '  return next(specifier, context);',
    '}',
  ].join('\n'));
  const runner = path.join(tmp, 'harness', 'run.mjs');
  fs.writeFileSync(runner, [
    'import { register } from "node:module";',
    'import { pathToFileURL } from "node:url";',
    'register("./hooks.mjs", import.meta.url);',
    'await import(pathToFileURL(process.argv[2]).href);',
    'const canvas = globalThis.__aecCanvas;',
    'const plain = canvas.open({ input: undefined });',
    'const curiosity = canvas.open({ input: { page: "curiosity" } });',
    'const status = await (await fetch(`${plain.url}/status`)).json();',
    'const root = await (await fetch(`${plain.url}/`)).text();',
    'const joined = Array.isArray(globalThis.__aecJoined?.canvases) && globalThis.__aecJoined.canvases[0] === canvas;',
    'process.stdout.write(JSON.stringify({ id: canvas.id, joined, plainUrl: plain.url, curiosityUrl: curiosity.url, status, root }));',
    'process.exit(0);',
  ].join('\n'));
  return runner;
}

function runEntry(entry: string): Promise<EntryResult> {
  const runner = writeHarness();
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [runner, entry], { timeout: 10_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${error.message}\n${stderr}`));
      else resolve(JSON.parse(stdout) as EntryResult);
    });
  });
}

function expectCanvas(result: EntryResult): void {
  expect(result.id).toBe('dashboard');
  expect(result.joined).toBe(true);
  expect(result.plainUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  expect(result.curiosityUrl).toBe(`${result.plainUrl}/?page=curiosity`);
}

it('loads the canvas through the .github/extensions forwarding stub', async () => {
  const root = path.join(tmp, 'repo');
  copy(stubSource, path.join(root, '.github', CANVAS));
  copy(apmSource, path.join(root, '.apm', CANVAS));

  const result = await runEntry(path.join(root, '.github', CANVAS));

  expectCanvas(result);
  expect(result.status).toEqual({ built: false });
  expect(result.root).toContain('Build required');
});

it('loads an apm-deployed copy of the canvas without the .apm source', async () => {
  const consumer = path.join(tmp, 'consumer');
  copy(apmSource, path.join(consumer, '.github', CANVAS));

  const result = await runEntry(path.join(consumer, '.github', CANVAS));

  expectCanvas(result);
  expect(result.status).toEqual({ built: false });
  expect(result.root).toContain('Build required');
});

it('resolves the built dashboard from the repo root when loaded through the stub', async () => {
  const root = path.join(tmp, 'repo');
  copy(stubSource, path.join(root, '.github', CANVAS));
  copy(apmSource, path.join(root, '.apm', CANVAS));
  const distDir = path.join(root, 'dist');
  fs.mkdirSync(path.join(distDir, 'webview'), { recursive: true });
  fs.writeFileSync(path.join(distDir, 'webview', 'app.js'), '');
  fs.writeFileSync(path.join(distDir, 'canvas-host.cjs'),
    'exports.createCanvasHost = ({ distDir }) => ({ start() {}, handle(req, res) { res.end("fake host " + distDir); } });');

  const result = await runEntry(path.join(root, '.github', CANVAS));

  expectCanvas(result);
  expect(result.status).toEqual({ built: true });
  expect(result.root).toBe(`fake host ${distDir}`);
});
