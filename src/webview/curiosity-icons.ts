/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { InvestigationSource } from '../core/types/curiosity-types';
import { html } from './render';
import { SVG } from './svg-icons';

export function sourceIcon(source: InvestigationSource) {
  return html`<span class=${`curiosity-source-icon curiosity-icon-${source}`} aria-hidden="true">
    ${source === 'web' ? SVG.globe : source === 'delegated' ? SVG.robot
      : html`<svg viewBox="0 0 24 24" fill="none"><path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-12-2 14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`}
  </span>`;
}

export const menuIcon = html`<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
