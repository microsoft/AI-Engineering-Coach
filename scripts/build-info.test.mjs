/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFileSync } from 'child_process';
import * as esbuild from 'esbuild';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BUILD_INFO_ENV, buildInfoOptions, computeBuildInfo, createWatchStamp, describeBuildInfo, parseBuildInfo,
} from './build-info.mjs';

const ROOT = join(import.meta.dirname, '..');
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const NOW = new Date('2026-10-31T11:15:02.000Z');

/** @param {Record<string, string>} responses git arguments joined by spaces → stdout */
function fakeGit(responses) {
  return (/** @type {string[]} */ args) => responses[args.join(' ')];
}

const CLEAN_BRANCH = {
  'rev-parse --short=7 HEAD': 'abc1234',
  'status --porcelain --untracked-files=no': '',
  'tag --points-at HEAD': '',
  'rev-parse --abbrev-ref HEAD': 'feature/stamp',
};

function stamp(responses, env = {}) {
  return computeBuildInfo({ cwd: ROOT, env, now: NOW, run: fakeGit(responses) });
}

let gitCommit;
try {
  gitCommit = execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
} catch {
  gitCommit = undefined;
}

describe('computeBuildInfo', () => {
  it('stamps a clean branch checkout as a dev build of that branch', () => {
    expect(stamp(CLEAN_BRANCH)).toEqual({
      version: VERSION, commit: 'abc1234', dirty: false, branch: 'feature/stamp', builtAt: '2026-10-31T11:15:02.000Z', dev: true,
    });
  });

  it('marks uncommitted changes to tracked files as dirty', () => {
    const info = stamp({ ...CLEAN_BRANCH, 'status --porcelain --untracked-files=no': ' M src/extension.ts' });
    expect(info).toMatchObject({ dirty: true, dev: true });
  });

  it('treats a clean checkout of the version tag as a release build without a branch', () => {
    const info = stamp({ ...CLEAN_BRANCH, 'tag --points-at HEAD': `other\nv${VERSION}`, 'rev-parse --abbrev-ref HEAD': 'HEAD' });
    expect(info).toMatchObject({ dirty: false, dev: false, branch: '' });
  });

  it('keeps a dirty tagged checkout a dev build', () => {
    const info = stamp({ ...CLEAN_BRANCH, 'tag --points-at HEAD': `v${VERSION}`, 'status --porcelain --untracked-files=no': ' M CHANGELOG.md' });
    expect(info).toMatchObject({ dirty: true, dev: true, branch: 'feature/stamp' });
  });

  it('recognizes a GitHub Actions run for the version tag', () => {
    const info = stamp({ ...CLEAN_BRANCH, 'rev-parse --abbrev-ref HEAD': 'HEAD' }, { GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: `v${VERSION}` });
    expect(info).toMatchObject({ dev: false, branch: '' });
  });

  it('ignores a GitHub Actions tag that does not match the version', () => {
    const info = stamp({ ...CLEAN_BRANCH, 'rev-parse --abbrev-ref HEAD': 'HEAD' }, { GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v999.0.0' });
    expect(info).toMatchObject({ dev: true, branch: '' });
  });

  it('uses the pull request branch for a detached CI checkout', () => {
    const info = stamp({ ...CLEAN_BRANCH, 'rev-parse --abbrev-ref HEAD': 'HEAD' },
      { GITHUB_HEAD_REF: 'feat/pr-branch', GITHUB_REF_TYPE: 'branch', GITHUB_REF_NAME: '42/merge' });
    expect(info.branch).toBe('feat/pr-branch');
  });

  it('uses the pushed branch for a detached CI push checkout', () => {
    const info = stamp({ ...CLEAN_BRANCH, 'rev-parse --abbrev-ref HEAD': 'HEAD' }, { GITHUB_REF_TYPE: 'branch', GITHUB_REF_NAME: 'main' });
    expect(info.branch).toBe('main');
  });

  it('falls back to GITHUB_SHA, then "unknown", when git is unavailable', () => {
    expect(stamp({}, { GITHUB_SHA: 'def5678901234' })).toMatchObject({ commit: 'def5678', dirty: false, dev: true, branch: '' });
    expect(stamp({})).toMatchObject({ commit: 'unknown', dirty: false, dev: true });
  });

  it('returns the stamp passed through the environment unchanged', () => {
    const passed = { version: '9.8.7', commit: 'feedbee', dirty: false, branch: '', builtAt: '2026-01-02T03:04:05.000Z', dev: false };
    const env = { [BUILD_INFO_ENV]: JSON.stringify({ ...passed, extra: 'ignored' }), GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v0.0.1' };
    expect(stamp(CLEAN_BRANCH, env)).toEqual(passed);
  });

  it.runIf(gitCommit)('matches package.json and git HEAD in this repository', () => {
    const info = computeBuildInfo({ cwd: ROOT, env: {}, now: NOW });
    expect(info.version).toBe(VERSION);
    expect(info.commit).toBe(gitCommit);
  });
});

describe('parseBuildInfo', () => {
  it('treats an unset or empty variable as no override', () => {
    expect(parseBuildInfo(undefined)).toBeUndefined();
    expect(parseBuildInfo('')).toBeUndefined();
  });

  it('rejects malformed stamps instead of shipping them', () => {
    expect(() => parseBuildInfo('{')).toThrow(BUILD_INFO_ENV);
    expect(() => parseBuildInfo(JSON.stringify({ version: '1.0.0' }))).toThrow(BUILD_INFO_ENV);
  });
});

describe('describeBuildInfo', () => {
  it('summarizes dev and release builds for build logs', () => {
    expect(describeBuildInfo({ version: '0.2.0', commit: 'abc1234', dirty: true, branch: 'main', builtAt: 't', dev: true }))
      .toBe('v0.2.0 dev build, commit abc1234-dirty on main, built t');
    expect(describeBuildInfo({ version: '0.2.0', commit: 'abc1234', dirty: false, branch: '', builtAt: 't', dev: false }))
      .toBe('v0.2.0 release build, commit abc1234, built t');
  });
});

/** A distinct stamp per number, as a fresh computeBuildInfo() would give after each change. */
function stampNumber(n) {
  const id = String(n).padStart(2, '0');
  return { version: '0.2.0', commit: `c0000${id}`, dirty: n > 0, branch: 'main', builtAt: `2026-11-03T09:30:${id}.000Z`, dev: true };
}

/** Evaluates a CommonJS bundle and returns its exports. */
function evaluate(code) {
  const module = { exports: {} };
  new Function('module', 'exports', code)(module, module.exports);
  return module.exports;
}

describe('buildInfoOptions', () => {
  it('gives src/core/build-info.ts the stamp as __AIC_BUILD_INFO__', async () => {
    const info = stampNumber(7);
    const result = await esbuild.build({
      entryPoints: [join(ROOT, 'src', 'core', 'build-info.ts')], bundle: true, platform: 'node', format: 'cjs',
      write: false, logLevel: 'silent', ...buildInfoOptions(() => info),
    });
    const module = evaluate(result.outputFiles[0].text);
    expect(module.BUILD_INFO).toEqual(info);
    expect(module.formatBuildLogFields()).toBe(
      'version=0.2.0 commit=c000007 dirty=true dev=true branch=main builtAt=2026-11-03T09:30:07.000Z');
  });
});

/**
 * Bundles whose builds the test drives step by step through the stamp plugin's hooks, the way
 * esbuild calls them, so build interleavings are deterministic.
 */
function fakeBundles(stamp, names) {
  return Object.fromEntries(names.map(name => {
    const hooks = {};
    const { plugins: [plugin] } = stamp.options(name);
    plugin.setup({
      onStart: callback => { hooks.start = callback; },
      onResolve: () => {},
      onLoad: (_options, callback) => { hooks.load = callback; },
      onEnd: callback => { hooks.end = callback; },
    });
    const bundle = {
      embedded: undefined,
      start: () => hooks.start(),
      load: () => { bundle.embedded = JSON.parse(/= (.*);\n$/.exec(hooks.load().contents)[1]); },
      end: (errors = []) => hooks.end({ errors }),
      build: (errors = []) => { bundle.start(); bundle.load(); bundle.end(errors); },
      rebuild: vi.fn(async () => { bundle.build(); }),
    };
    stamp.attach(name, bundle);
    return [name, bundle];
  }));
}

describe('createWatchStamp', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function setup() {
    let n = 0;
    const compute = vi.fn(() => stampNumber(++n));
    const writes = [];
    const stamp = createWatchStamp({
      initial: stampNumber(0), compute, settleMs: 50, write: (info, generation) => writes.push({ info, generation }),
    });
    const bundles = fakeBundles(stamp, ['extension', 'webview', 'worker']);
    return { stamp, compute, writes, bundles, all: Object.values(bundles) };
  }

  const settle = () => vi.advanceTimersByTimeAsync(1000);

  async function started() {
    const context = setup();
    for (const bundle of context.all) bundle.build();
    await settle();
    return context;
  }

  it('starts from the initial stamp without computing another', async () => {
    const { compute, writes, all } = await started();
    expect(compute).not.toHaveBeenCalled();
    expect(writes).toEqual([{ info: stampNumber(0), generation: 0 }]);
    for (const bundle of all) {
      expect(bundle.embedded).toEqual(stampNumber(0));
      expect(bundle.rebuild).not.toHaveBeenCalled();
    }
  });

  it('restamps after a change and rebuilds the other bundles with the same stamp', async () => {
    const { compute, writes, bundles, all } = await started();
    bundles.webview.build(); // The watcher rebuilds only the bundle that uses the changed file.
    expect(compute).toHaveBeenCalledOnce();
    expect(writes).toHaveLength(1);
    await settle();
    for (const bundle of all) expect(bundle.embedded).toEqual(stampNumber(1));
    expect(bundles.webview.rebuild).not.toHaveBeenCalled();
    expect(bundles.extension.rebuild).toHaveBeenCalledOnce();
    expect(bundles.worker.rebuild).toHaveBeenCalledOnce();
    expect(writes.at(-1)).toEqual({ info: stampNumber(1), generation: 1 });
    expect(compute).toHaveBeenCalledOnce();
  });

  it('stamps once for the builds that one change starts together, and waits for all of them', async () => {
    const { compute, writes, bundles } = await started();
    bundles.extension.start();
    bundles.webview.start();
    bundles.webview.load();
    bundles.webview.end();
    await settle(); // The extension is still building: nothing is synced or written yet.
    expect(bundles.worker.rebuild).not.toHaveBeenCalled();
    expect(writes).toHaveLength(1);
    bundles.extension.load();
    bundles.extension.end();
    await settle();
    expect(compute).toHaveBeenCalledOnce();
    expect([bundles.extension.embedded, bundles.webview.embedded, bundles.worker.embedded])
      .toEqual([stampNumber(1), stampNumber(1), stampNumber(1)]);
    expect(bundles.extension.rebuild).not.toHaveBeenCalled();
    expect(bundles.worker.rebuild).toHaveBeenCalledOnce();
    expect(writes.at(-1)).toEqual({ info: stampNumber(1), generation: 1 });
  });

  it('leaves a bundle that failed to build until its files change again', async () => {
    const { compute, writes, bundles } = await started();
    bundles.webview.build([{ text: 'Expected ";" but found "}"' }]);
    await settle();
    expect(bundles.webview.rebuild).not.toHaveBeenCalled(); // No rebuild loop on a broken file.
    expect([bundles.extension.embedded, bundles.worker.embedded]).toEqual([stampNumber(1), stampNumber(1)]);
    expect(writes.at(-1)).toEqual({ info: stampNumber(1), generation: 1 });
    bundles.webview.build(); // The fix
    await settle();
    expect(compute).toHaveBeenCalledTimes(2);
    expect([bundles.extension.embedded, bundles.webview.embedded, bundles.worker.embedded])
      .toEqual([stampNumber(2), stampNumber(2), stampNumber(2)]);
    expect(writes.at(-1)).toEqual({ info: stampNumber(2), generation: 2 });
  });

  it('writes nothing before every bundle has finished its first build', async () => {
    const { writes, bundles } = setup();
    bundles.extension.build();
    bundles.webview.build();
    await settle();
    expect(writes).toEqual([]);
    expect(bundles.worker.rebuild).not.toHaveBeenCalled();
    bundles.worker.build();
    await settle();
    expect(writes).toEqual([{ info: stampNumber(0), generation: 0 }]);
  });

  it('stops checking after dispose', async () => {
    const { stamp, writes, bundles, all } = setup();
    for (const bundle of all) bundle.build();
    stamp.dispose();
    await settle();
    expect(writes).toEqual([]);
    expect(bundles.extension.rebuild).not.toHaveBeenCalled();
  });
});

describe('createWatchStamp with esbuild', () => {
  let dir;
  const contexts = [];
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'aic-stamp-')); });
  afterEach(async () => {
    await Promise.all(contexts.splice(0).map(context => context.dispose()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('refreshes every bundle after a rebuild, as watch mode runs it', async () => {
    let n = 0;
    let wrote = () => {};
    const generations = [];
    const stamp = createWatchStamp({
      initial: stampNumber(0), compute: () => stampNumber(++n), settleMs: 10,
      write: (_info, generation) => { generations.push(generation); wrote(); },
    });
    const nextWrite = () => new Promise(resolve => { wrote = resolve; });
    for (const name of ['extension', 'webview']) {
      writeFileSync(join(dir, `${name}.ts`), 'declare const __AIC_BUILD_INFO__: unknown;\nexport const info = __AIC_BUILD_INFO__;\n');
      const context = await esbuild.context({
        entryPoints: [join(dir, `${name}.ts`)], outfile: join(dir, `${name}.cjs`), bundle: true, platform: 'node',
        format: 'cjs', logLevel: 'silent', ...stamp.options(name),
      });
      stamp.attach(name, context);
      contexts.push(context);
    }
    const embedded = () => ['extension', 'webview'].map(name => evaluate(readFileSync(join(dir, `${name}.cjs`), 'utf8')).info);
    try {
      let written = nextWrite();
      await Promise.all(contexts.map(context => context.rebuild()));
      await written;
      expect(embedded()).toEqual([stampNumber(0), stampNumber(0)]);
      written = nextWrite();
      await contexts[1].rebuild(); // What the watcher runs after a change to the webview's files
      await written;
      expect(embedded()).toEqual([stampNumber(1), stampNumber(1)]);
      expect(generations).toEqual([0, 1]);
    } finally {
      stamp.dispose();
    }
  }, 30_000);
});
