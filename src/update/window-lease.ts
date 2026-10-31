/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Lets one window at a time run the automatic check and announcement. globalState reaches other
 * windows only after a moment, so a window writes its lease, waits long enough for a competing
 * write to arrive, and reads the lease back: the window whose write landed last goes ahead. */

import { afterLease, LEASE_SETTLE_MS, leasedByOther, takeLease, type Lease, type ScheduleState } from './update-schedule';

export interface LeaseHost {
  /** Identifies this window. */
  owner: string;
  read: () => ScheduleState;
  write: (lease: Lease) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  random: () => number;
  /** The window closed while it waited. */
  closed: () => boolean;
}

/** Runs `task` if this window holds the lease; otherwise returns when to try again. */
export async function runUnderLease(host: LeaseHost, task: () => Promise<void>): Promise<number | undefined> {
  const before = host.read();
  if (leasedByOther(before, host.owner, host.now())) return afterLease(before.lease, host.now(), host.random);
  const lease = takeLease(host.owner, host.now());
  await host.write(lease);
  await host.sleep(LEASE_SETTLE_MS);
  if (host.closed()) return undefined;
  const current = host.read().lease;
  if (current?.owner !== host.owner) return afterLease(current ?? lease, host.now(), host.random);
  await task();
  return undefined;
}
