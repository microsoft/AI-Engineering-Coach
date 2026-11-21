/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { renameSync, copyFileSync, writeFileSync } from "fs";
import { execSync } from "child_process";
import { BUILD_INFO_ENV, computeBuildInfo } from "./build-info.mjs";
import { buildChangelog } from "./build-changelog.mjs";

// Stamp the build and date the changelog before swapping files: the swapped files would
// otherwise mark every packaged build as having uncommitted changes.
const buildInfo = computeBuildInfo();
// The VSIX ships CHANGELOG.md with the changelog.d fragments merged in under their merge dates.
const changelog = buildChangelog();

// Each swap is undone in its own finally, so a failure at any step restores both files.
renameSync("README.md", "README.github.md");
try {
  copyFileSync("README.extension.md", "README.md");
  renameSync("CHANGELOG.md", "CHANGELOG.github.md");
  try {
    writeFileSync("CHANGELOG.md", changelog);
    execSync("vsce package --allow-missing-repository --no-dependencies", {
      stdio: "inherit",
      env: { ...process.env, [BUILD_INFO_ENV]: JSON.stringify(buildInfo) },
    });
  } finally {
    renameSync("CHANGELOG.github.md", "CHANGELOG.md");
  }
} finally {
  renameSync("README.github.md", "README.md");
}
