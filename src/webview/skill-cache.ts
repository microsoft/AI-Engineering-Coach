/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Shared cache so dashboard skill results propagate to the skills page.
   Scoped by workspace + harness filter so switching filters preserves each. */

import { WorkflowCluster, TriagedCluster, CatalogItem, DateFilter } from '../core/types';

export interface SkillCacheData {
  clusters: WorkflowCluster[];
  triaged: TriagedCluster[];
  catalogMatches: CatalogItem[];
  catalogTotalScanned?: number;
  timestamp: number;
}

const cache = new Map<string, SkillCacheData>();
const MAX_AGE = 10 * 60_000; // 10 minutes

function cacheKey(f?: DateFilter): string {
  return `${f?.workspaceId || '*'}|${f?.harness || '*'}`;
}

/** Store results scoped to the current filter */
export function setSkillCache(data: SkillCacheData, filter?: DateFilter): void {
  cache.set(cacheKey(filter), data);
}

/** Read cached results for the current filter (returns null if stale or absent) */
export function getSkillCache(filter?: DateFilter): SkillCacheData | null {
  const key = cacheKey(filter);
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > MAX_AGE) { cache.delete(key); return null; }
  return entry;
}

/** Clear a specific filter's cache */
export function clearSkillCache(filter?: DateFilter): void {
  cache.delete(cacheKey(filter));
}
