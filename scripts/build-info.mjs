/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Computes the build stamp that every bundle reads as the global __AIC_BUILD_INFO__ and that
 * esbuild.mjs writes to dist/build-info.json, so a running or installed build can be identified.
 * Reads package.json and local git state only, and never fails the build when git is missing.
 * buildInfoOptions() serves the stamp to esbuild; createWatchStamp() keeps it fresh in watch mode. */

import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

/** Packaging computes the stamp before swapping READMEs and hands it to the nested build. */
export const BUILD_INFO_ENV = 'AIC_BUILD_INFO';

/**
 * @typedef {object} BuildInfo
 * @property {string} version  package.json version at build time
 * @property {string} commit   short git commit SHA, or "unknown"
 * @property {boolean} dirty   tracked files had uncommitted changes
 * @property {string} branch   source branch of a dev build; empty for release builds
 * @property {string} builtAt  ISO-8601 build time (UTC)
 * @property {boolean} dev     false only for a clean build of the v<version> tag
 */

/** @param {string} cwd */
function gitRunner(cwd) {
  /** @param {string[]} args */
  return args => {
    try {
      return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
    } catch {
      return undefined;
    }
  };
}

/**
 * @param {unknown} value
 * @returns {value is BuildInfo}
 */
function isBuildInfo(value) {
  if (typeof value !== 'object' || value === null) return false;
  const v = /** @type {Record<string, unknown>} */ (value);
  return typeof v.version === 'string' && typeof v.commit === 'string' && typeof v.dirty === 'boolean'
    && typeof v.branch === 'string' && typeof v.builtAt === 'string' && typeof v.dev === 'boolean';
}

/**
 * Parses a stamp passed through {@link BUILD_INFO_ENV}; undefined when the variable is unset.
 * @param {string | undefined} raw
 * @returns {BuildInfo | undefined}
 */
export function parseBuildInfo(raw) {
  if (raw === undefined || raw === '') return undefined;
  /** @type {unknown} */
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    value = undefined;
  }
  if (!isBuildInfo(value)) throw new Error(`${BUILD_INFO_ENV} is not a valid build stamp: ${raw}`);
  const { version, commit, dirty, branch, builtAt, dev } = value;
  return { version, commit, dirty, branch, builtAt, dev };
}

/**
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, now?: Date, run?: (args: string[]) => string | undefined }} [options]
 * @returns {BuildInfo}
 */
export function computeBuildInfo({ cwd = process.cwd(), env = process.env, now = new Date(), run = gitRunner(cwd) } = {}) {
  const override = parseBuildInfo(env[BUILD_INFO_ENV]);
  if (override) return override;

  /** @type {{ version: string }} */
  const { version } = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
  const commit = run(['rev-parse', '--short=7', 'HEAD']) || env.GITHUB_SHA?.slice(0, 7) || 'unknown';
  // Untracked files are ignored: scratch files would otherwise mark every local build dirty.
  const dirty = Boolean(run(['status', '--porcelain', '--untracked-files=no']));
  const tag = `v${version}`;
  const tagged = (env.GITHUB_REF_TYPE === 'tag' && env.GITHUB_REF_NAME === tag)
    || (run(['tag', '--points-at', 'HEAD']) ?? '').split(/\r?\n/).includes(tag);
  const dev = dirty || !tagged;
  const head = run(['rev-parse', '--abbrev-ref', 'HEAD']);
  const ciBranch = env.GITHUB_HEAD_REF || (env.GITHUB_REF_TYPE === 'branch' ? env.GITHUB_REF_NAME : '') || '';
  const branch = dev ? (head && head !== 'HEAD' ? head : ciBranch) : '';
  return { version, commit, dirty, branch, builtAt: now.toISOString(), dev };
}

/**
 * One line for build logs, e.g. "v0.2.0 dev build, commit abc1234-dirty on main, built 2026-10-31T11:15:02.000Z".
 * @param {BuildInfo} info
 */
export function describeBuildInfo(info) {
  const commit = info.dirty ? `${info.commit}-dirty` : info.commit;
  const kind = info.dev ? 'dev build' : 'release build';
  const branch = info.branch ? ` on ${info.branch}` : '';
  return `v${info.version} ${kind}, commit ${commit}${branch}, built ${info.builtAt}`;
}

/** The module `inject` adds to every bundle; the stamp plugin serves it from memory. */
const STAMP_MODULE = 'virtual:aic-build-info';

/**
 * @typedef {object} BuildHooks
 * @property {() => void} [onStart]  runs before each build
 * @property {(result: { errors: unknown[] }) => void} [onEnd]  runs after each build
 */

/**
 * esbuild options that give a bundle the global `__AIC_BUILD_INFO__`. esbuild injects a virtual
 * module whose contents come from `stamp()` on every build and rebuild, so a watch rebuild can
 * embed a fresh stamp (a `define` is fixed when the context is created).
 * @param {() => BuildInfo} stamp
 * @param {BuildHooks} [hooks]
 */
export function buildInfoOptions(stamp, hooks = {}) {
  return {
    inject: [STAMP_MODULE],
    plugins: [{
      name: 'aic-build-info',
      /** @param {import('esbuild').PluginBuild} build */
      setup(build) {
        if (hooks.onStart) build.onStart(hooks.onStart);
        build.onResolve({ filter: /^virtual:aic-build-info$/ }, args => ({ path: args.path, namespace: 'aic-build-info' }));
        build.onLoad({ filter: /.*/, namespace: 'aic-build-info' }, () => ({
          contents: `export const __AIC_BUILD_INFO__ = ${JSON.stringify(stamp())};\n`,
          loader: 'js',
        }));
        if (hooks.onEnd) build.onEnd(hooks.onEnd);
      },
    }],
  };
}

/**
 * Keeps watch-mode stamps fresh and identical across bundles. The first rebuild that the watcher
 * starts after a change computes a new stamp; rebuilds it starts while that one runs belong to the
 * same change and reuse it. Once no build is running, every bundle that embeds an older stamp is
 * rebuilt, and then `write` records the stamp that all of them share (for dist/build-info.json).
 * A bundle whose last build failed waits for its own files to change, so a broken file can't cause
 * a rebuild loop.
 * @param {{
 *   initial: BuildInfo,
 *   compute: () => BuildInfo,
 *   write: (info: BuildInfo, generation: number) => void,
 *   settleMs?: number,
 * }} options
 */
export function createWatchStamp({ initial, compute, write, settleMs = 100 }) {
  let info = initial;
  let generation = 0;
  let written = -1;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  /** @type {Map<string, { rebuild(): Promise<unknown> }>} */
  const contexts = new Map();
  /** @type {Map<string, number>} the generation each bundle's last successful build embeds */
  const served = new Map();
  /** @type {Map<string, number>} the generation served to each build in progress */
  const serving = new Map();
  const started = new Set(); // bundles past their first build, which uses `initial`
  const building = new Set(); // builds in progress
  const watcherBuilds = new Set(); // builds in progress that the watcher started
  const requested = new Set(); // bundles this coordinator asked to rebuild
  const failed = new Set(); // bundles whose last build failed

  function settle() {
    if (building.size > 0) return; // each build schedules another check when it ends
    const names = [...contexts.keys()];
    if (!names.every(name => served.has(name) || failed.has(name))) return;
    const stale = names.filter(name => !failed.has(name) && served.get(name) !== generation);
    for (const name of stale) {
      requested.add(name);
      contexts.get(name)?.rebuild().catch(() => { requested.delete(name); });
    }
    if (stale.length === 0 && written !== generation && names.some(name => served.get(name) === generation)) {
      written = generation;
      write(info, generation);
    }
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(settle, settleMs);
  }

  return {
    /**
     * esbuild options for the bundle called `name`.
     * @param {string} name
     */
    options(name) {
      return buildInfoOptions(() => {
        serving.set(name, generation);
        return info;
      }, {
        onStart() {
          building.add(name);
          serving.delete(name);
          if (requested.delete(name)) return;
          if (started.has(name) && watcherBuilds.size === 0) {
            info = compute();
            generation += 1;
          }
          started.add(name);
          watcherBuilds.add(name);
        },
        onEnd(result) {
          building.delete(name);
          watcherBuilds.delete(name);
          if (result.errors.length > 0) {
            failed.add(name);
          } else {
            failed.delete(name);
            served.set(name, serving.get(name) ?? generation);
          }
          schedule();
        },
      });
    },
    /**
     * Registers the context created with `options(name)`, so the coordinator can rebuild it.
     * @param {string} name
     * @param {{ rebuild(): Promise<unknown> }} context
     */
    attach(name, context) {
      contexts.set(name, context);
    },
    dispose() {
      clearTimeout(timer);
    },
  };
}
