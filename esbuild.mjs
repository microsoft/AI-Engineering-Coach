/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as esbuild from 'esbuild';
import * as fs from 'fs';
import * as path from 'path';
import { buildInfoOptions, computeBuildInfo, createWatchStamp, describeBuildInfo } from './scripts/build-info.mjs';

const isWatch = process.argv.includes('--watch');

// Stamp version, commit and build time into every bundle so the UI and runtime.log
// show which build is running (read through src/core/build-info.ts).
const buildInfo = computeBuildInfo();

// Ship the stamp with the bundle so an installed build can be identified from its extension folder.
function writeBuildInfo(info) {
  fs.mkdirSync('dist', { recursive: true });
  fs.writeFileSync(path.join('dist', 'build-info.json'), `${JSON.stringify(info, null, 2)}\n`);
}

const nodeBundle = { bundle: true, platform: 'node', target: 'es2022', format: 'cjs', sourcemap: true, external: ['vscode'] };

// Both the one-off build and the --watch contexts use these options.
const bundles = {
  // The extension host
  extension: { ...nodeBundle, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js' },
  // The warm-up worker (runs off the extension host thread)
  warmUpWorker: { ...nodeBundle, entryPoints: ['src/core/warm-up-worker.ts'], outfile: 'dist/warm-up-worker.js' },
  // The parse worker (runs the full parse pipeline off the extension host thread)
  parseWorker: { ...nodeBundle, entryPoints: ['src/core/parse-worker.ts'], outfile: 'dist/parse-worker.js' },
  // The cache write worker (writes cache data to disk off the main thread)
  cacheWriteWorker: { ...nodeBundle, entryPoints: ['src/core/cache-write-worker.ts'], outfile: 'dist/cache-write-worker.js' },
  // The canvas host (serves the webview as a Copilot app canvas; no vscode)
  canvasHost: { ...nodeBundle, entryPoints: ['src/canvas/host.ts'], outfile: 'dist/canvas-host.cjs' },
  // The webview script
  webview: {
    entryPoints: ['src/webview/app.ts'],
    bundle: true,
    platform: 'browser',
    target: 'es2022',
    format: 'iife',
    outfile: 'dist/webview/app.js',
    sourcemap: true,
  },
};

await Promise.all(Object.values(bundles).map(options => esbuild.build({ ...options, ...buildInfoOptions(() => buildInfo) })));
writeBuildInfo(buildInfo);

// Copy static webview assets
const webviewDist = 'dist/webview';
fs.mkdirSync(webviewDist, { recursive: true });

// Copy rule markdown files to dist/rules/
const rulesSrc = 'src/core/rules';
const rulesDist = 'dist/rules';
fs.mkdirSync(rulesDist, { recursive: true });
if (fs.existsSync(rulesSrc)) {
  for (const file of fs.readdirSync(rulesSrc).filter(f => f.endsWith('.md'))) {
    fs.copyFileSync(path.join(rulesSrc, file), path.join(rulesDist, file));
  }
}

// Copy metric definition files to dist/metrics/
const metricsSrc = 'src/core/metrics';
const metricsDist = 'dist/metrics';
fs.mkdirSync(metricsDist, { recursive: true });
if (fs.existsSync(metricsSrc)) {
  for (const file of fs.readdirSync(metricsSrc).filter(f => f.endsWith('.metric.md'))) {
    fs.copyFileSync(path.join(metricsSrc, file), path.join(metricsDist, file));
  }
}

const cssSources = [
  'src/webview/styles.css',
  'src/webview/styles-pages.css',
  'src/webview/styles-github-app.css',
  'src/webview/styles-github-app-issue-credits.css',
  'src/webview/styles-skills.css',
  'src/webview/styles-learning.css',
];

function bundleCss() {
  const bundledCss = cssSources
    .map(source => fs.readFileSync(source, 'utf-8').trimEnd())
    .join('\n\n');
  fs.writeFileSync(path.join(webviewDist, 'styles.css'), `${bundledCss}\n`);
}

bundleCss();

// Copy sidebar CSS separately (sidebar is its own webview)
fs.copyFileSync('src/webview/styles-sidebar.css', path.join(webviewDist, 'sidebar.css'));

console.log(`Build complete: ${describeBuildInfo(buildInfo)}.`);

if (isWatch) {
  // A rebuild after a change restamps, and the other bundles and dist/build-info.json are
  // brought up to that stamp, so the dashboard, activity-bar view, and runtime.log agree.
  const stamp = createWatchStamp({
    initial: buildInfo,
    compute: () => computeBuildInfo(),
    write: (info, generation) => {
      try {
        writeBuildInfo(info);
        if (generation > 0) console.log(`Build stamp refreshed: ${describeBuildInfo(info)}.`);
      } catch (err) {
        console.error('Writing dist/build-info.json failed:', err);
      }
    },
  });
  const contexts = await Promise.all(Object.entries(bundles).map(async ([name, options]) => {
    const context = await esbuild.context({ ...options, ...stamp.options(name) });
    stamp.attach(name, context);
    return context;
  }));
  await Promise.all(contexts.map(context => context.watch()));
  for (const source of cssSources) {
    fs.watch(source, () => {
      try {
        bundleCss();
        console.log(`CSS rebuilt (${source} changed)`);
      } catch (err) {
        console.error('CSS rebuild failed:', err);
      }
    });
  }
  console.log('Watching for changes...');
}
