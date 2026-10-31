/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { renameSync, copyFileSync } from "fs";
import { execSync } from "child_process";
import { BUILD_INFO_ENV, computeBuildInfo } from "./build-info.mjs";

// Stamp the build before swapping READMEs: the swapped README.md would otherwise
// mark every packaged build as having uncommitted changes.
const buildInfo = computeBuildInfo();

renameSync("README.md", "README.github.md");
copyFileSync("README.extension.md", "README.md");
try {
  execSync("vsce package --allow-missing-repository --no-dependencies", {
    stdio: "inherit",
    env: { ...process.env, [BUILD_INFO_ENV]: JSON.stringify(buildInfo) },
  });
} finally {
  renameSync("README.github.md", "README.md");
}
