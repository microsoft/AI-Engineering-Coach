/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Decides what the update UI shows and when to notify. Pure, so every rule is unit-tested:
 * automatic checks run only for release builds with both settings on; only newer versions are
 * offered; a release is announced once, after VS Code's extension update delay has passed,
 * unless the user skipped that version. A manual check reveals the result immediately. */

import { compareVersions } from '../core/build-info';
import type { UpdateStatus } from '../core/types/rpc-types';
import { canInstallCandidate, type UpdateCandidate } from './release-feed';

export interface CheckGate {
  /** `ExtensionMode.Production`: never check from F5 or test hosts. */
  production: boolean;
  /** `BUILD_INFO.dev`: only clean builds of a release tag check on their own. */
  dev: boolean;
  /** `aiEngineerCoach.updates.autoCheck`. */
  autoCheck: boolean;
  /** VS Code's `extensions.autoCheckUpdates`. */
  vscodeAutoCheck: boolean;
}

export function automaticChecksEnabled(gate: CheckGate): boolean {
  return gate.production && !gate.dev && gate.autoCheck && gate.vscodeAutoCheck;
}

export interface UpdateMarkers {
  /** The version the once-per-version notification was shown for. */
  notifiedVersion?: string;
  /** "Skip This Version". */
  skippedVersion?: string;
  /** Installed by this extension; the window still runs the older build until it reloads. */
  installedVersion?: string;
}

export interface EvaluateInput {
  candidate: UpdateCandidate | undefined;
  /** Version of the running build. */
  current: string;
  markers: UpdateMarkers;
  /** Automatic checks are enabled, so cached results may be shown and announced. */
  automatic: boolean;
  /** A manual check in this window showed this version. */
  revealedVersion?: string;
  /** VS Code's `extensions.autoUpdateDelay`, in milliseconds. */
  cooldownMs: number;
  now: number;
}

export interface Evaluation {
  status: UpdateStatus;
  /** Show the once-per-version notification now. */
  notify: boolean;
}

const NONE: UpdateStatus = { state: 'none' };

/** True when `version` is a newer X.Y.Z than `current`; false for anything unparseable. */
export function isNewerVersion(version: string, current: string): boolean {
  try {
    return compareVersions(version, current) > 0;
  } catch {
    return false;
  }
}

export function evaluateUpdate(input: EvaluateInput): Evaluation {
  const { candidate, current, markers } = input;
  if (markers.installedVersion && isNewerVersion(markers.installedVersion, current)) {
    return { status: { state: 'installed', latest: markers.installedVersion }, notify: false };
  }
  if (!candidate || !isNewerVersion(candidate.version, current)) return { status: NONE, notify: false };
  const revealed = input.revealedVersion === candidate.version;
  if (!input.automatic && !revealed) return { status: NONE, notify: false };
  const skipped = markers.skippedVersion === candidate.version;
  const cooledDown = input.now >= Date.parse(candidate.publishedAt) + input.cooldownMs;
  if (!revealed && (skipped || !cooledDown)) return { status: NONE, notify: false };
  return {
    status: {
      state: 'available',
      current,
      latest: candidate.version,
      publishedAt: candidate.publishedAt,
      canInstall: canInstallCandidate(candidate),
    },
    notify: !revealed && markers.notifiedVersion !== candidate.version,
  };
}

/** VS Code's `extensions.autoUpdateDelay` (hours) as milliseconds, defaulting to 12 h. */
export function cooldownFromSetting(hours: unknown): number {
  const value = typeof hours === 'number' && Number.isFinite(hours) ? hours : 12;
  return Math.min(Math.max(value, 0), 24 * 30) * 60 * 60 * 1000;
}
