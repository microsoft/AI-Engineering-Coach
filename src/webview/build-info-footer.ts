/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Build stamp at the bottom of the dashboard sidebar: version, commit, and build time, with
 * the full details in its tooltip. The status slot underneath is reserved for host-provided
 * notices, such as an available update; it stays hidden until setBuildInfoStatus fills it. */

import { BUILD_INFO, formatBuildTime, formatBuildTooltip, formatCommit, type BuildInfo } from '../core/build-info';

export interface BuildInfoStatus {
  text: string;
  title?: string;
  actionLabel?: string;
  onAction?: () => void;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Renders the footer as the last child of the sidebar, replacing any previous one. */
export function mountBuildInfoFooter(sidebar: HTMLElement, info: BuildInfo = BUILD_INFO): HTMLElement {
  sidebar.querySelector('#build-info')?.remove();
  const footer = element('footer', 'build-info');
  footer.id = 'build-info';
  footer.title = formatBuildTooltip(info);

  const version = element('div', 'build-info-version', `v${info.version}`);
  if (info.dev) version.append(' ', element('span', 'build-info-dev', 'dev'));
  const meta = element('div', 'build-info-meta', [formatCommit(info), formatBuildTime(info.builtAt)].filter(Boolean).join(' · '));
  const status = element('div', 'build-info-status');
  status.id = 'build-info-status';
  status.hidden = true;

  footer.append(version, meta, status);
  sidebar.append(footer);
  return footer;
}

/** Shows a notice, optionally with one action button, under the build stamp; `null` hides it. */
export function setBuildInfoStatus(status: BuildInfoStatus | null): void {
  const slot = document.getElementById('build-info-status');
  if (!slot) return;
  slot.replaceChildren();
  slot.hidden = status === null;
  slot.title = status?.title ?? '';
  if (!status) return;
  slot.append(element('span', 'build-info-status-text', status.text));
  if (status.actionLabel && status.onAction) {
    const action = element('button', 'build-info-action', status.actionLabel);
    action.type = 'button';
    action.addEventListener('click', status.onAction);
    slot.append(action);
  }
}
