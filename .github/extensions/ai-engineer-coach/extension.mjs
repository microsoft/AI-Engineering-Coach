/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Local-dev loader stub. The GitHub Copilot app only discovers project canvases under
 * .github/extensions/<name>/extension.mjs, but this repo's canvas is authored as an apm
 * package (see ../../../apm.yml) with its source of truth under .apm/extensions/. This stub
 * forwards to that source so cloning + building this repo directly (without `apm install`)
 * keeps working. Do not edit the canvas logic here — edit
 * ../../../.apm/extensions/ai-engineer-coach/extension.mjs instead. */

import "../../../.apm/extensions/ai-engineer-coach/extension.mjs";
