/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Webview-side localization. `vscode.l10n` is unavailable in the webview, so we
 * configure the `@vscode/l10n` runtime from the bundle the extension host injects
 * as `window.__l10nBundle` (see panel-html.ts). Configuring at module load — before
 * any page renders — guarantees `t()` is ready by first use. */

import * as l10n from '@vscode/l10n';

declare global {
  interface Window {
    __l10nBundle?: Record<string, string>;
  }
}

const contents = window.__l10nBundle;
if (contents && Object.keys(contents).length > 0) {
  l10n.config({ contents });
}

export const t = l10n.t;
