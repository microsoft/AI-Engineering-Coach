/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/* npm run package: packages the VSIX with README.extension.md as its README and the dated
 * changelog (CHANGELOG.md plus changelog.d, see scripts/build-changelog.mjs) as its CHANGELOG.
 * vsce reads both from fixed names, so the originals are parked as *.github.md while it runs.
 * The originals always come back: replacements are staged before any original is touched, every
 * swap is undone whichever step fails, and a run that was killed mid-way is repaired by the next. */

import { execSync } from "child_process";
import { copyFileSync, existsSync, renameSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { pathToFileURL } from "url";
import { BUILD_INFO_ENV, computeBuildInfo } from "./build-info.mjs";
import { buildChangelog } from "./build-changelog.mjs";

/** Swapped files, in swap order: `file` is parked as `backup` and replaced by staged content. */
export const SWAPS = [
  { file: "README.md", backup: "README.github.md" },
  { file: "CHANGELOG.md", backup: "CHANGELOG.github.md" },
];
const STAGED_SUFFIX = ".aic-staging";

/**
 * Puts back originals that a killed run left parked. Without this, the next run would park the
 * replacement over the original and lose it.
 * @param {string} root
 * @param {(message: string) => void} log
 */
export function restoreInterrupted(root, log) {
  for (const { file, backup } of SWAPS) {
    rmSync(join(root, file + STAGED_SUFFIX), { force: true });
    if (!existsSync(join(root, backup))) continue;
    renameSync(join(root, backup), join(root, file));
    log(`Restored ${file} from ${backup}, left by an interrupted npm run package.`);
  }
}

/**
 * Runs `run` with README.md and CHANGELOG.md replaced, then restores the originals.
 * @param {{ root: string, changelog: string, run: () => void, log?: (message: string) => void }} options
 */
export function withPackagedFiles({ root, changelog, run, log = console.warn }) {
  restoreInterrupted(root, log);
  const at = (/** @type {string} */ name) => join(root, name);
  // Stage first: a failed copy or write must not leave an original missing or truncated.
  const staged = SWAPS.map(({ file }) => at(file + STAGED_SUFFIX));
  try {
    copyFileSync(at("README.extension.md"), staged[0]);
    writeFileSync(staged[1], changelog);
  } catch (err) {
    for (const path of staged) rmSync(path, { force: true });
    throw err;
  }
  /** @type {typeof SWAPS} */
  const parked = [];
  /** @type {unknown} */
  let failure;
  try {
    SWAPS.forEach(({ file, backup }, i) => {
      renameSync(at(file), at(backup));
      parked.push(SWAPS[i]);
      renameSync(staged[i], at(file));
    });
    run();
  } catch (err) {
    failure = err;
  } finally {
    const unrestored = [];
    for (const { file, backup } of parked.reverse()) {
      try {
        renameSync(at(backup), at(file));
      } catch (err) {
        unrestored.push(`${backup} -> ${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    for (const path of staged) rmSync(path, { force: true });
    if (unrestored.length > 0) {
      const restore = new Error(`Could not restore the original files; rename them back by hand:\n  ${unrestored.join("\n  ")}`);
      // eslint-disable-next-line no-unsafe-finally -- a lost original must never be reported as success
      throw failure === undefined ? restore : new AggregateError([failure, restore], restore.message);
    }
  }
  if (failure !== undefined) throw failure;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = join(import.meta.dirname, "..");
  // Stamp the build and date the changelog before swapping files: the swapped files would
  // otherwise mark every packaged build as having uncommitted changes.
  const buildInfo = computeBuildInfo({ cwd: root });
  const changelog = buildChangelog({ root });
  withPackagedFiles({
    root,
    changelog,
    run: () => execSync("vsce package --allow-missing-repository --no-dependencies", {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, [BUILD_INFO_ENV]: JSON.stringify(buildInfo) },
    }),
  });
}
