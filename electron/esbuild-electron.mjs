/*---------------------------------------------------------------------------------------------
 *  Build the Electron main + preload bundles into electron-dist/.
 *  Webview/core bundles are produced by the existing esbuild.mjs into dist/.
 *  This script copies that prebuilt dist/webview alongside our index.html so
 *  the Electron renderer can load a self-contained tree via file://.
 *--------------------------------------------------------------------------------------------*/

import * as esbuild from 'esbuild';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'electron-dist');

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// 1. Bundle main process (node, runs in Electron's main).
// `vscode` is aliased to our stub so that panel-rpc / panel-shared, which
// import vscode for both types and the rare runtime symbol, resolve cleanly.
// The desktop dispatcher never invokes the LLM/auth paths that would call
// stubbed methods; analyzer/data RPCs use none of the vscode surface.
await esbuild.build({
  entryPoints: [path.join(__dirname, 'main.ts')],
  outfile: path.join(OUT, 'main.js'),
  bundle: true,
  platform: 'node',
  target: 'es2022',
  format: 'cjs',
  sourcemap: true,
  external: ['electron'],
  alias: {
    vscode: path.join(__dirname, 'vscode-stub.ts'),
  },
});

// 2. Bundle preload (runs in renderer's isolated world; cannot use Node built-ins
//    directly via require unless sandbox:false — keep it tiny and Electron-only).
await esbuild.build({
  entryPoints: [path.join(__dirname, 'preload.ts')],
  outfile: path.join(OUT, 'preload.js'),
  bundle: true,
  platform: 'browser',
  target: 'es2022',
  format: 'cjs',
  sourcemap: true,
  external: ['electron'],
});

// 3. Copy index.html and the prebuilt webview/ tree from dist/.
fs.copyFileSync(path.join(__dirname, 'index.html'), path.join(OUT, 'index.html'));

const webviewSrc = path.join(ROOT, 'dist', 'webview');
const webviewDst = path.join(OUT, 'webview');
if (!fs.existsSync(webviewSrc)) {
  throw new Error('dist/webview not found. Run "npm run build" first to produce the webview bundle.');
}
fs.cpSync(webviewSrc, webviewDst, { recursive: true });

// 4. Copy parse workers (the parser spawns them via Worker(filePath)).
for (const worker of ['parse-worker.js', 'warm-up-worker.js', 'cache-write-worker.js']) {
  const src = path.join(ROOT, 'dist', worker);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(OUT, worker));
}

// 5. Copy rule + metric markdown bundles (loaded at runtime by core/rule-loader).
for (const dir of ['rules', 'metrics']) {
  const src = path.join(ROOT, 'dist', dir);
  if (fs.existsSync(src)) fs.cpSync(src, path.join(OUT, dir), { recursive: true });
}

// 6. Copy locale JSON files (read at runtime by i18n.ts).
const localesSrc = path.join(__dirname, 'locales');
if (fs.existsSync(localesSrc)) {
  fs.cpSync(localesSrc, path.join(OUT, 'locales'), { recursive: true });
}

console.log('Electron bundle ready in electron-dist/');
