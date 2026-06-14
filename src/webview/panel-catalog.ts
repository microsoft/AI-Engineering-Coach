/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readTextWithByteLimit } from './fetch-utils';

export const CATALOG_BASE = 'https://awesome-copilot.github.com';

const CATALOG_PAGE_MAX_BYTES = 5 * 1024 * 1024;

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

/** Remove HTML tags iteratively until stable (avoids incomplete sanitization). */
function stripHtml(text: string): string {
  let prev = text;
   
  while (true) {
    const next = prev.replaceAll(/<[^>]*>/g, '');
    if (next === prev) return next;
    prev = next;
  }
}

async function fetchCatalogPage(slug: string, kind: RawCatalogItem['kind']): Promise<RawCatalogItem[]> {
  const url = `${CATALOG_BASE}/${slug}/`;
  const response = await fetch(url, { redirect: 'error' });
  if (!response.ok) return [];
  const html = await readTextWithByteLimit(response, CATALOG_PAGE_MAX_BYTES, 'Catalog page too large');

  const items: RawCatalogItem[] = [];
  const articleRegex = /<article\s+class="resource-item"[^>]*data-path="([^"]*)"[^>]*>([\s\S]*?)<\/article>/g;
  let match: RegExpExecArray | null;
  while ((match = articleRegex.exec(html)) !== null) {
    const path = match[1];
    const block = match[2];

    const titleMatch = block.match(/<div class="resource-title">([^<]*)<\/div>/);
    const descMatch = block.match(/<div class="resource-description">([\s\S]*?)<\/div>/);
    const categoryMatch = block.match(/tag-category">([^<]*)</);

    const title = titleMatch ? titleMatch[1].trim() : '';
    const description = descMatch ? stripHtml(descMatch[1].trim()) : '';
    const category = categoryMatch ? categoryMatch[1].trim() : '';

    if (!title) continue;

    items.push({
      kind,
      id: `${kind}:${path}`,
      title,
      description,
      category,
      path,
      url: `${CATALOG_BASE}/${slug}/#${path.split('/').pop()?.replace(/\.[^.]+$/, '') || ''}`,
    });
  }

  return items;
}

export async function getCatalogItems(): Promise<RawCatalogItem[]> {
  if (catalogCache) return catalogCache;
  if (!catalogPromise) {
    catalogPromise = (async () => {
      const [skills, agents, instructions, hooks] = await Promise.all([
        fetchCatalogPage('skills', 'skill'),
        fetchCatalogPage('agents', 'agent'),
        fetchCatalogPage('instructions', 'instruction'),
        fetchCatalogPage('hooks', 'hook'),
      ]);
      catalogCache = [...skills, ...agents, ...instructions, ...hooks];
      catalogPromise = undefined;
      return catalogCache;
    })();
  }
  return catalogPromise;
}

export function clearCatalogCache(): void {
  catalogCache = undefined;
  catalogPromise = undefined;
}