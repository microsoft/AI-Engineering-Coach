/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readTextWithByteLimit } from './fetch-utils';

export const CATALOG_BASE = 'https://awesome-copilot.github.com';

const CATALOG_FEED_MAX_BYTES = 5 * 1024 * 1024;

const CATALOG_FEEDS = [
  { slug: 'skills', kind: 'skill' },
  { slug: 'agents', kind: 'agent' },
  { slug: 'instructions', kind: 'instruction' },
] as const;

type CatalogFeed = typeof CATALOG_FEEDS[number];

export interface RawCatalogItem {
  kind: 'skill' | 'agent' | 'instruction' | 'hook';
  id: string;
  title: string;
  description: string;
  category: string;
  path: string;
  url: string;
}

let catalogCache: RawCatalogItem[] | undefined;
let catalogPromise: Promise<RawCatalogItem[]> | undefined;

function isCatalogRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseCatalogItem(item: unknown, feed: CatalogFeed, index: number): RawCatalogItem {
  if (!isCatalogRecord(item)
    || typeof item.title !== 'string' || !item.title.trim()
    || typeof item.description !== 'string'
    || (item.category !== undefined && typeof item.category !== 'string')) {
    throw new Error(`Invalid ${feed.slug} catalog item ${index + 1}`);
  }

  const catalogPath = feed.kind === 'skill' ? item.skillFile : item.path;
  if (typeof catalogPath !== 'string'
    || !catalogPath.startsWith(`${feed.slug}/`)
    || !catalogPath.endsWith('.md')
    || !catalogPath.split('/').every(segment => segment !== '.' && segment !== '..' && /^[A-Za-z0-9._-]+$/.test(segment))) {
    throw new Error(`Invalid markdown path in ${feed.slug} catalog item ${index + 1}`);
  }

  return {
    kind: feed.kind,
    id: `${feed.kind}:${catalogPath}`,
    title: item.title.trim(),
    description: item.description.trim(),
    category: typeof item.category === 'string' ? item.category.trim() : '',
    path: catalogPath,
    url: `https://github.com/github/awesome-copilot/blob/main/${catalogPath}`,
  };
}

async function fetchCatalogFeed(feed: CatalogFeed): Promise<RawCatalogItem[]> {
  const response = await fetch(`${CATALOG_BASE}/data/${feed.slug}.json`, { redirect: 'error' });
  if (!response.ok) throw new Error(`Failed to fetch ${feed.slug} catalog: HTTP ${response.status}`);
  const text = await readTextWithByteLimit(response, CATALOG_FEED_MAX_BYTES, 'Catalog feed too large');
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error: unknown) {
    throw new Error(`Invalid ${feed.slug} catalog JSON`, { cause: error });
  }
  if (!isCatalogRecord(data) || !Array.isArray(data.items)) {
    throw new Error(`Invalid ${feed.slug} catalog format: expected an items array`);
  }
  if (data.items.length === 0) {
    throw new Error(`The ${feed.slug} catalog is empty. The catalog format may have changed.`);
  }
  return data.items.map((item: unknown, index: number) => parseCatalogItem(item, feed, index));
}

export async function getCatalogItems(): Promise<RawCatalogItem[]> {
  if (catalogCache) return catalogCache;
  if (!catalogPromise) {
    const request: Promise<RawCatalogItem[]> = Promise.all(CATALOG_FEEDS.map(fetchCatalogFeed))
      .then(catalogs => {
        const items = catalogs.flat();
        // A reload must not let an older request repopulate the cleared cache.
        if (catalogPromise === request) catalogCache = items;
        return items;
      })
      .finally(() => {
        if (catalogPromise === request) catalogPromise = undefined;
      });
    catalogPromise = request;
  }
  return catalogPromise;
}

export function clearCatalogCache(): void {
  catalogCache = undefined;
  catalogPromise = undefined;
}