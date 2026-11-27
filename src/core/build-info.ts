/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Identifies the running build. esbuild injects __AIC_BUILD_INFO__ into every bundle
 * (computed by scripts/build-info.mjs and also shipped as dist/build-info.json), so the
 * extension host, workers, canvas host, and webview all read the same stamp. Unbundled
 * code such as unit tests gets a placeholder. */

export interface BuildInfo {
  /** `package.json` version at build time, for example "0.2.0". */
  version: string;
  /** Short git commit SHA, or "unknown" when git was unavailable. */
  commit: string;
  /** Tracked files had uncommitted changes when this was built. */
  dirty: boolean;
  /** Source branch, or empty for a detached checkout outside CI. */
  branch: string;
  /** ISO-8601 build time in UTC; empty when unbundled. */
  builtAt: string;
}

declare const __AIC_BUILD_INFO__: BuildInfo | undefined;

const UNBUNDLED: BuildInfo = { version: '0.0.0', commit: 'unknown', dirty: false, branch: '', builtAt: '' };

export const BUILD_INFO: Readonly<BuildInfo> = Object.freeze(
  typeof __AIC_BUILD_INFO__ === 'object' && __AIC_BUILD_INFO__ !== null ? { ...__AIC_BUILD_INFO__ } : { ...UNBUNDLED },
);

/** "abc1234", or "abc1234-dirty" when built with uncommitted changes. */
export function formatCommit(info: BuildInfo = BUILD_INFO): string {
  return info.dirty ? `${info.commit}-dirty` : info.commit;
}

/** "2026-10-31 11:15 UTC" from an ISO timestamp; empty when there is none. */
export function formatBuildTime(builtAt: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(builtAt);
  return match ? `${match[1]} ${match[2]} UTC` : builtAt;
}

/** One line identifying the build, e.g. "v0.1.0 · abc1234-dirty · main · built 2026-10-31 11:15 UTC". */
export function formatBuildDetails(info: BuildInfo = BUILD_INFO): string {
  const parts = [`v${info.version}`, formatCommit(info)];
  if (info.branch) parts.push(info.branch);
  if (info.builtAt) parts.push(`built ${formatBuildTime(info.builtAt)}`);
  return parts.join(' · ');
}

/** Multi-line description for tooltips. */
export function formatBuildTooltip(info: BuildInfo = BUILD_INFO): string {
  const lines = [`AI Engineer Coach ${info.version}`];
  lines.push(`Commit ${info.commit}${info.dirty ? ' with uncommitted changes' : ''}`);
  if (info.branch) lines.push(`Branch ${info.branch}`);
  if (info.builtAt) lines.push(`Built ${formatBuildTime(info.builtAt)}`);
  return lines.join('\n');
}

/** `key=value` fields for runtime.log; empty values are written as "-" so the line stays parseable. */
export function formatBuildLogFields(info: BuildInfo = BUILD_INFO): string {
  return `version=${info.version} commit=${info.commit} dirty=${info.dirty}`
    + ` branch=${info.branch || '-'} builtAt=${info.builtAt || '-'}`;
}
