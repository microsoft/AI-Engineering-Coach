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

/** What git reports for a clean checkout of the v0.2.0 tag, and after an uncommitted edit. */
const CLEAN = { version: '0.2.0', commit: 'abc1234', dirty: false, branch: '', dev: false };
const EDITED = { ...CLEAN, dirty: true, branch: 'main', dev: true };

/** Evaluates a CommonJS bundle and returns its exports. */
function evaluate(code) {
  const module = { exports: {} };
  new Function('module', 'exports', code)(module, module.exports);
  return module.exports;
}

describe('buildInfoOptions', () => {
  it('gives src/core/build-info.ts the stamp as __AIC_BUILD_INFO__', async () => {
    const info = { ...EDITED, builtAt: '2026-11-03T09:30:07.000Z' };
    const result = await esbuild.build({
      entryPoints: [join(ROOT, 'src', 'core', 'build-info.ts')], bundle: true, platform: 'node', format: 'cjs',
      write: false, logLevel: 'silent', ...buildInfoOptions(() => info),
    });
    const module = evaluate(result.outputFiles[0].text);
    expect(module.BUILD_INFO).toEqual(info);
    expect(module.formatBuildLogFields()).toBe(
      'version=0.2.0 commit=abc1234 dirty=true dev=true branch=main builtAt=2026-11-03T09:30:07.000Z');
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

  /**
   * Three fake bundles and a source whose state the test changes, the way edits and reverts change
   * what git reports. Each compute() reads that state and gets a new build time.
   */
  function setup(initial = CLEAN) {
    const source = { ...initial };
    let clock = 0;
    const compute = vi.fn(() => ({ ...source, builtAt: `T${++clock}` }));
    const writes = [];
    const stamp = createWatchStamp({
      initial: { ...source, builtAt: 'T0' }, compute, settleMs: 50,
      write: (info, generation) => writes.push({ info, generation }),
    });
    const bundles = fakeBundles(stamp, ['extension', 'webview', 'worker']);
    const all = Object.values(bundles);
    const generations = () => writes.map(write => write.generation);
    /** The last stamp written to dist/build-info.json, after checking that every bundle embeds it. */
    function published() {
      const { info } = writes.at(-1);
      for (const bundle of all) expect(bundle.embedded).toEqual(info);
      return info;
    }
    return { stamp, source, compute, writes, generations, published, bundles, all };
  }

  const settle = () => vi.advanceTimersByTimeAsync(1000);

  async function started(initial) {
    const context = setup(initial);
    for (const bundle of context.all) bundle.build();
    await settle();
    return context;
  }

  it('keeps the initial stamp while the source is unchanged', async () => {
    const { generations, published, all } = await started();
    expect(generations()).toEqual([0]);
    expect(published()).toEqual({ ...CLEAN, builtAt: 'T0' });
    for (const bundle of all) expect(bundle.rebuild).not.toHaveBeenCalled();
  });

  it('restamps after a change and rebuilds the other bundles with the same stamp', async () => {
    const { source, generations, published, bundles } = await started();
    Object.assign(source, EDITED);
    bundles.webview.build(); // The watcher rebuilds only the bundle that uses the changed file.
    expect(generations()).toEqual([0]);
    await settle();
    expect(generations()).toEqual([0, 1]);
    expect(published()).toMatchObject(EDITED);
    expect(bundles.webview.rebuild).not.toHaveBeenCalled();
    expect(bundles.extension.rebuild).toHaveBeenCalledOnce();
    expect(bundles.worker.rebuild).toHaveBeenCalledOnce();
  });

  it('stamps once for the builds that one change starts together, and waits for all of them', async () => {
    const { source, generations, published, bundles } = await started();
    Object.assign(source, EDITED);
    bundles.extension.start();
    bundles.webview.start();
    bundles.webview.load();
    bundles.webview.end();
    await settle(); // The extension is still building: nothing is synced or written yet.
    expect(bundles.worker.rebuild).not.toHaveBeenCalled();
    expect(generations()).toEqual([0]);
    bundles.extension.load();
    bundles.extension.end();
    await settle();
    expect(generations()).toEqual([0, 1]);
    expect(published()).toMatchObject(EDITED);
    expect(bundles.extension.rebuild).not.toHaveBeenCalled();
    expect(bundles.worker.rebuild).toHaveBeenCalledOnce();
  });

  it('restamps every bundle when the source changed after overlapping builds took their stamp', async () => {
    // On the release tag, reverting the last edit starts a rebuild that stamps the clean source.
    // A webview-only edit saved before that rebuild finishes starts another that reuses the stamp.
    const { source, generations, published, bundles } = await started(EDITED);
    Object.assign(source, CLEAN);
    bundles.extension.start();
    Object.assign(source, EDITED);
    bundles.webview.start();
    for (const bundle of [bundles.extension, bundles.webview]) {
      bundle.load();
      bundle.end();
    }
    await settle();
    expect(published()).toMatchObject({ dirty: true, dev: true, branch: 'main' });
    expect(generations()).toEqual([0, 2]); // The clean stamp was never published.
  });

  it('leaves a bundle that failed to build until its files change again', async () => {
    const { source, writes, generations, published, bundles } = await started();
    Object.assign(source, EDITED);
    bundles.webview.build([{ text: 'Expected ";" but found "}"' }]);
    await settle();
    expect(bundles.webview.rebuild).not.toHaveBeenCalled(); // No rebuild loop on a broken file.
    expect(generations()).toEqual([0, 1]);
    const first = writes.at(-1).info;
    expect([bundles.extension.embedded, bundles.worker.embedded]).toEqual([first, first]);
    bundles.webview.build(); // The fix
    await settle();
    expect(generations()).toEqual([0, 1, 2]);
    expect(published().builtAt).not.toBe(first.builtAt);
  });

  it('writes nothing before every bundle has finished its first build', async () => {
    const { generations, bundles } = setup();
    bundles.extension.build();
    bundles.webview.build();
    await settle();
    expect(generations()).toEqual([]);
    expect(bundles.worker.rebuild).not.toHaveBeenCalled();
    bundles.worker.build();
    await settle();
    expect(generations()).toEqual([0]);
  });

  it('keeps the current stamp when the source cannot be read, instead of stopping the watcher', async () => {
    const { source, compute, generations, published, bundles } = await started();
    Object.assign(source, EDITED);
    bundles.webview.build();
    compute.mockImplementationOnce(() => { throw new SyntaxError('Unexpected end of JSON input'); }); // package.json mid-save
    await settle();
    expect(generations()).toEqual([0, 1]);
    expect(published()).toMatchObject(EDITED);
  });

  it('stops checking after dispose', async () => {
    const { stamp, generations, bundles, all } = setup();
    for (const bundle of all) bundle.build();
    stamp.dispose();
    await settle();
    expect(generations()).toEqual([]);
    expect(bundles.extension.rebuild).not.toHaveBeenCalled();
  });

  // refresh() is for a CSS-only edit: esbuild.mjs rewrites dist/webview/styles.css itself, and no
  // esbuild build runs.
  describe('refresh', () => {
    it('restamps every bundle and dist/build-info.json once for a change esbuild does not see', async () => {
      const { stamp, source, generations, published, all } = await started();
      Object.assign(source, EDITED);
      stamp.refresh();
      stamp.refresh(); // fs.watch often reports one save twice.
      await settle();
      expect(generations()).toEqual([0, 1]);
      expect(published()).toMatchObject(EDITED);
      for (const bundle of all) expect(bundle.rebuild).toHaveBeenCalledOnce();
    });

    it('waits for a running build, then restamps for a change made after that build stamped', async () => {
      const { stamp, source, generations, published, bundles } = await started();
      Object.assign(source, EDITED);
      bundles.webview.start(); // A watcher build stamps the edited source.
      stamp.refresh(); // The CSS changes while it runs.
      await settle();
      expect(generations()).toEqual([0]);
      bundles.webview.load();
      const running = bundles.webview.embedded;
      bundles.webview.end();
      await settle();
      expect(generations()).toEqual([0, 2]);
      expect(published().builtAt).not.toBe(running.builtAt);
    });

    it('lets a watcher build that starts after the change cover it with the same stamp', async () => {
      const { stamp, source, generations, published, bundles } = await started();
      Object.assign(source, EDITED);
      stamp.refresh();
      bundles.extension.build(); // A TypeScript change rebuilds before the pending refresh runs.
      await settle();
      expect(generations()).toEqual([0, 1]);
      expect(published()).toMatchObject(EDITED);
    });

    it('waits for every first build before restamping', async () => {
      const { stamp, generations, published, bundles } = setup();
      bundles.extension.build();
      stamp.refresh(); // Same source as the initial stamp: only the build time changes.
      await settle();
      expect(generations()).toEqual([]);
      bundles.webview.build();
      bundles.worker.build();
      await settle();
      expect(generations()).toEqual([1]);
      expect(published()).toMatchObject(CLEAN);
      expect(published().builtAt).not.toBe('T0');
    });

    it('keeps the request while the source cannot be read, and restamps at the next check', async () => {
      const { stamp, source, compute, generations, published, bundles } = await started();
      Object.assign(source, EDITED);
      compute.mockImplementationOnce(() => { throw new Error('EBUSY: package.json'); });
      stamp.refresh();
      await settle();
      expect(generations()).toEqual([0]);
      compute.mockImplementationOnce(() => { throw new Error('EBUSY: package.json'); });
      bundles.webview.build(); // A rebuild that can't compute a stamp either keeps the current one.
      await settle();
      expect(generations()).toEqual([0, 1]);
      expect(published()).toMatchObject(EDITED);
    });

    it('does nothing after dispose', async () => {
      const { stamp, compute, generations, all } = await started();
      compute.mockClear();
      stamp.dispose();
      stamp.refresh();
      await settle();
      expect(compute).not.toHaveBeenCalled();
      expect(generations()).toEqual([0]);
      for (const bundle of all) expect(bundle.rebuild).not.toHaveBeenCalled();
    });
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

  it('refreshes every bundle after a rebuild or refresh(), as watch mode runs them', async () => {
    const source = { ...CLEAN };
    let clock = 0;
    let wrote = () => {};
    const writes = [];
    const stamp = createWatchStamp({
      initial: { ...source, builtAt: 'T0' }, compute: () => ({ ...source, builtAt: `T${++clock}` }), settleMs: 10,
      write: (info, generation) => { writes.push({ info, generation }); wrote(); },
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
    /** The stamp both bundles embed, after checking that it is the one last written. */
    const embedded = () => {
      const stamps = ['extension', 'webview'].map(name => evaluate(readFileSync(join(dir, `${name}.cjs`), 'utf8')).info);
      expect(stamps).toEqual([writes.at(-1).info, writes.at(-1).info]);
      return stamps[0];
    };
    try {
      let written = nextWrite();
      await Promise.all(contexts.map(context => context.rebuild()));
      await written;
      expect(embedded()).toEqual({ ...CLEAN, builtAt: 'T0' });
      Object.assign(source, EDITED);
      written = nextWrite();
      await contexts[1].rebuild(); // What the watcher runs after a change to the webview's files
      await written;
      expect(embedded()).toMatchObject(EDITED);
      Object.assign(source, CLEAN); // The edit is reverted, say in the CSS that esbuild doesn't see.
      written = nextWrite();
      stamp.refresh(); // What esbuild.mjs calls after rebuilding the dashboard CSS
      await written;
      expect(embedded()).toMatchObject(CLEAN);
      expect(writes.map(write => write.generation)).toEqual([0, 1, 2]);
    } finally {
      stamp.dispose();
    }
  }, 30_000);
});
