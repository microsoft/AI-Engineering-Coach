/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Computes the build stamp that esbuild injects into every bundle as __AIC_BUILD_INFO__ and
 * writes to dist/build-info.json, so a running or installed build can be identified.
 * Reads package.json and local git state only, and never fails the build when git is missing. */

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
