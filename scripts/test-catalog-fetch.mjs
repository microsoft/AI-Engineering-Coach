/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Smoke-test the production catalog loader against the live community feeds.
 * Run: npm run analyze:catalog-fetch
 */

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

async function main() {
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL('../src/webview/panel-catalog.ts', import.meta.url))],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
  });
  const { getCatalogItems, clearCatalogCache } = await import(
    `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`
  );
  const items = await getCatalogItems();
  if (items.length === 0) throw new Error('The production loader returned an empty catalog');

  for (const kind of ['skill', 'agent', 'instruction']) {
    const matches = items.filter(item => item.kind === kind);
    if (matches.length === 0) throw new Error(`No ${kind} items loaded`);
    console.log(`PASS ${kind}: ${matches.length} items`);
  }
  if (!items.every(item => item.title.trim() && item.path.endsWith('.md') && item.id === `${item.kind}:${item.path}`)) {
    throw new Error('Catalog entries must have titles, markdown paths, and stable IDs');
  }
  if (await getCatalogItems() !== items) throw new Error('Successful catalog results were not cached');
  clearCatalogCache();
  console.log(`PASS ${items.length} total items; markdown paths, stable IDs, and caching verified`);
}

main().catch(error => {
  console.error('Catalog smoke test failed:', error);
  process.exitCode = 1;
});
