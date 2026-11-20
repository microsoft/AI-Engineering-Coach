/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Navigation hint: which sub-section the next page opens (a link's `data-nav-hint`). */
let navHint: string | undefined;

export function setNavHint(hint: string | undefined): void { navHint = hint; }

/** Takes the hint, so only the page navigated to sees it. */
export function consumeNavHint(): string | undefined {
  const hint = navHint;
  navHint = undefined;
  return hint;
}
