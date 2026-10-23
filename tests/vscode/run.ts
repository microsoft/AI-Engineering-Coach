/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { exportFixtureDataset, fixturePaths, isolatedEnvironment, prepareFixtures, scenarioContext } from './fixtures';
import { writeSnapshotReport } from './snapshots';

const PROJECT = path.resolve(__dirname, '..', '..');
const manifestSchema = z.object({
  name: z.string(), publisher: z.string(), version: z.string(),
  engines: z.object({ vscode: z.string() }),
});
const SUITES = path.join(PROJECT, 'tests', 'vscode', 'suite');

export async function discoverSuites(directory: string): Promise<string[]> {
  const names = (await fs.readdir(directory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.endsWith('.spec.ts'))
    .map(entry => entry.name.slice(0, -'.spec.ts'.length))
    .sort();
  if (names.length === 0) throw new Error('No desktop smoke suites found');
  if (names.some(name => !/^[a-z0-9][a-z0-9-]*$/.test(name))) {
    throw new Error('Desktop suite filenames must use lowercase letters, numbers, and hyphens');
  }
  return names;
}

export function vscodeVersion(engine: string, override?: string): string {
  if (override === 'latest') return override;
  const version = override ?? /^\^(\d+\.\d+\.\d+)$/.exec(engine)?.[1];
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error('Expected an exact VS Code version or "latest"; the default requires a ^x.y.z manifest engine.');
  }
  const minimum = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(engine);
  if (!minimum) throw new Error(`Unsupported VS Code engine range: ${engine}`);
  const [major, minor, patch] = version.split('.').map(Number);
  const [, minMajor, minMinor, minPatch] = minimum.map(Number);
  if (major !== minMajor || minor < minMinor || (minor === minMinor && patch < minPatch)) {
    throw new Error(`VS Code ${version} does not satisfy ${engine}`);
  }
  return version;
}

async function execute(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: PROJECT, env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`${path.basename(command)} terminated by ${signal}`));
      else resolve(code ?? 1);
    });
  });
}

async function copyArchives(source: string, destination: string): Promise<void> {
  await fs.mkdir(source, { recursive: true });
  await fs.mkdir(destination, { recursive: true });
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    if (entry.isFile() && (entry.name.endsWith('.zip') || entry.name.endsWith('.tar.gz'))) {
      await fs.copyFile(path.join(source, entry.name), path.join(destination, entry.name));
    }
  }
}

async function copyIfPresent(source: string, destination: string): Promise<void> {
  try {
    await fs.stat(source);
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return;
    throw err;
  }
  await fs.cp(source, destination, { recursive: true });
}

async function runWorker(vsix: string, version: string, scenario: string): Promise<void> {
  if (!(await discoverSuites(SUITES)).includes(scenario)) throw new Error(`Unknown scenario: ${scenario}`);
  const { root, timestamp } = scenarioContext();
  const storage = process.env.AIC_E2E_STORAGE;
  const artifacts = process.env.AIC_E2E_ARTIFACTS;
  if (!storage || !artifacts) throw new Error('Missing test storage/artifact directories');
  await prepareFixtures(root, timestamp, scenario !== 'empty');
  await fs.mkdir(artifacts, { recursive: true });
  await exportFixtureDataset(root, timestamp, artifacts, scenario !== 'empty');
  const config = path.join(root, 'mocha.json');
  const settings = path.join(root, 'settings.json');
  await fs.writeFile(config, JSON.stringify({
    timeout: 90_000, retries: 0, failZero: true, forbidOnly: true, forbidPending: true, reporter: 'spec',
  }));
  await fs.writeFile(settings, JSON.stringify({
    'telemetry.telemetryLevel': 'off',
    'workbench.enableExperiments': false,
    'chat.disableAIFeatures': true,
    'workbench.colorTheme': 'Default Dark Modern',
  }));

  // Import only in the child, after its home/profile environment has been isolated.
  const { ExTester, ReleaseQuality } = await import('vscode-extension-tester');
  const extensions = path.join(root, 'extensions');
  const tester = new ExTester(storage, ReleaseQuality.Stable, extensions);
  try {
    await tester.downloadCode(version);
    await tester.downloadChromeDriver(version);
    await tester.installVsix({ vsixFile: vsix, installDependencies: false });
    const manifest = manifestSchema.parse(JSON.parse(await fs.readFile(path.join(PROJECT, 'package.json'), 'utf8')));
    const installed = (await fs.readdir(extensions, { withFileTypes: true })).filter(entry => entry.isDirectory());
    assert.equal(installed.length, 1, 'Only the packaged extension should be installed');
    const installedRoot = path.join(extensions, installed[0].name);
    const installedManifest = manifestSchema.parse(JSON.parse(await fs.readFile(path.join(installedRoot, 'package.json'), 'utf8')));
    assert.deepEqual(installedManifest, manifest, 'Installed VSIX does not match the repository manifest');
    for (const asset of ['extension.js', 'parse-worker.js', 'warm-up-worker.js', 'cache-write-worker.js',
      path.join('webview', 'app.js'), path.join('webview', 'styles.css')]) {
      assert.ok((await fs.stat(path.join(installedRoot, 'dist', asset))).size > 0, `Missing packaged asset: ${asset}`);
    }
    const suite = path.join(__dirname, 'suite', `${scenario}.spec.js`).replaceAll('\\', '/');
    const code = await tester.runTests(suite, {
      vscodeVersion: version, offline: true, config, settings, locale: 'en',
      resources: [fixturePaths(root).workspace],
    });
    if (code !== 0) throw new Error(`${scenario} VS Code smoke tests failed (${code})`);
  } finally {
    await copyIfPresent(fixturePaths(root).runtimeLog, path.join(artifacts, 'coach-runtime.log'));
    for (const name of ['screenshots', 'chromedriver.log', 'test.log', path.join('settings', 'logs')]) {
      await copyIfPresent(path.join(storage, name), path.join(artifacts, path.basename(name)));
    }
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { vsix: { type: 'string' }, 'vscode-version': { type: 'string' }, worker: { type: 'string' } },
  });
  const manifest = manifestSchema.parse(JSON.parse(await fs.readFile(path.join(PROJECT, 'package.json'), 'utf8')));
  const version = vscodeVersion(manifest.engines.vscode, values['vscode-version']);
  const vsix = path.resolve(PROJECT, values.vsix ?? `${manifest.name}-${manifest.version}.vsix`);
  if (values.worker) {
    await runWorker(vsix, version, values.worker);
    return;
  }
  const scenarios = await discoverSuites(SUITES);
  if (!values.vsix) {
    const npm = process.env.npm_execpath;
    if (!npm) throw new Error('Use npm run test:vscode, or supply --vsix with an existing package.');
    assert.equal(await execute(process.execPath, [npm, 'run', 'package']), 0, 'VSIX packaging failed');
  }
  const vsixHash = createHash('sha256').update(await fs.readFile(vsix)).digest('hex');
  const artifacts = path.join(PROJECT, 'test-results', 'vscode', `${Date.now()}-${process.pid}`);
  await fs.mkdir(artifacts, { recursive: true });
  const runRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aec-'));
  const storage = path.join(runRoot, 'runtime');
  const cache = path.join(PROJECT, '.vscode-test', 'cache', `${process.platform}-${process.arch}-${version}`);
  const fixtureDate = new Date();
  fixtureDate.setDate(fixtureDate.getDate() - 1);
  fixtureDate.setHours(12, 0, 0, 0);
  const results: { scenario: string; exitCode: number }[] = [];
  console.log(`Testing ${path.basename(vsix)} (sha256 ${vsixHash}) on VS Code ${version}`);
  console.log(`Desktop diagnostics: ${artifacts}`);
  try {
    await copyArchives(cache, storage);
    for (const scenario of scenarios) {
      const root = path.join(runRoot, scenario);
      const env = {
        ...isolatedEnvironment(root, process.env),
        AIC_E2E_SCENARIO_ROOT: root,
        AIC_E2E_TIMESTAMP: String(fixtureDate.getTime()),
        AIC_E2E_STORAGE: storage,
        AIC_E2E_ARTIFACTS: path.join(artifacts, scenario),
      };
      const exitCode = await execute(process.execPath, [__filename, '--worker', scenario, '--vsix', vsix, '--vscode-version', version], env);
      results.push({ scenario, exitCode });
    }
    assert.equal(createHash('sha256').update(await fs.readFile(vsix)).digest('hex'), vsixHash, 'The tested VSIX changed during the run');
    assert.ok(results.every(result => result.exitCode === 0), 'Desktop smoke tests failed; inspect the saved diagnostics.');
  } finally {
    try {
      const summary = {
        vsix, vsixHash, version, nodeVersion: process.version, platform: process.platform, arch: process.arch, results,
      };
      await fs.writeFile(path.join(artifacts, 'summary.json'), JSON.stringify(summary, null, 2));
      await writeSnapshotReport(artifacts, summary);
      console.log(`Desktop screenshot gallery: ${path.join(artifacts, 'gallery.html')}`);
      await copyArchives(storage, cache);
    } finally {
      await fs.rm(runRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
    }
  }
}

if (require.main === module) {
  void main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
