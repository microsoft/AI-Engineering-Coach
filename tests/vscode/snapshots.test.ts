/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @vitest-environment jsdom

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { saveSnapshot, writeSnapshotReport } from './snapshots';
import { exportFixtureDataset, prepareFixtures } from './fixtures';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGz8AAAAASUVORK5CYII=';
const snapshot = { name: '01-dashboard', title: 'Dashboard: 2 sessions and 6 requests' };
let root: string;

beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'aec-snapshots-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe('desktop milestone snapshots', () => {
  it('preserves the captured PNG and its caption without overwriting a previous milestone', async () => {
    await saveSnapshot(root, snapshot, PNG);
    const file = path.join(root, 'snapshots', `${snapshot.name}.png`);
    expect(await fs.readFile(file)).toEqual(Buffer.from(PNG, 'base64'));
    expect(JSON.parse(await fs.readFile(path.join(root, 'snapshots', `${snapshot.name}.json`), 'utf8'))).toEqual(snapshot);
    await expect(saveSnapshot(root, snapshot, PNG)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await fs.readFile(file)).toEqual(Buffer.from(PNG, 'base64'));
  });

  it('rejects unsafe filenames and invalid image data', async () => {
    for (const name of ['../outside', 'nested/image', 'nested\\image']) {
      await expect(saveSnapshot(root, { ...snapshot, name }, PNG)).rejects.toThrow();
    }
    await expect(saveSnapshot('relative', snapshot, PNG)).rejects.toThrow('absolute directory');
    await expect(saveSnapshot(root, snapshot, 'not a PNG')).rejects.toThrow('PNG image');
    expect(await fs.readdir(root)).toEqual([]);
  });
});

describe('desktop screenshot report', () => {
  it('embeds images offline, escapes captions, and keeps failed suite outcomes visible', async () => {
    const title = 'Timeline <script>alert("test")</script> & session details';
    await saveSnapshot(path.join(root, 'populated'), { ...snapshot, title }, PNG);
    await saveSnapshot(path.join(root, 'empty'), { name: '01-empty', title: 'Expected empty state' }, PNG);
    await writeSnapshotReport(root, {
      version: '1.125.0', platform: 'linux', vsixHash: 'abc123',
      results: [{ scenario: 'empty', exitCode: 0 }, { scenario: 'populated', exitCode: 1 }],
    });

    const document = new DOMParser().parseFromString(await fs.readFile(path.join(root, 'gallery.html'), 'utf8'), 'text/html');
    const images = [...document.querySelectorAll('img')];
    expect(images).toHaveLength(2);
    expect(images.map(image => image.getAttribute('src'))).toEqual([`data:image/png;base64,${PNG}`, `data:image/png;base64,${PNG}`]);
    expect(images[1].alt).toBe(title);
    expect(document.querySelectorAll('script')).toHaveLength(0);
    expect(document.body.textContent).toContain('populated: Failed; 1 snapshot');
    expect(document.body.textContent).toContain('abc123');
    expect(document.body.textContent).toContain('1.125.0');
    expect(document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content')).toContain("default-src 'none'");
    const summary = await fs.readFile(path.join(root, 'snapshots.md'), 'utf8');
    expect(summary).toContain('2 milestone screenshots captured');
    expect(summary).toContain('populated</strong>: Failed');
  });

  it('reports a suite that fails before taking any screenshots without inventing success', async () => {
    await writeSnapshotReport(root, {
      version: 'latest', platform: 'linux', vsixHash: 'abc123',
      results: [{ scenario: 'populated', exitCode: 1 }],
    });
    expect(await fs.readFile(path.join(root, 'gallery.html'), 'utf8')).toContain('No snapshots were captured');
    expect(await fs.readFile(path.join(root, 'snapshots.md'), 'utf8')).toContain('Failed; 0 snapshots');
  });

  it('makes the checked-in dataset and generated raw inputs visible in the gallery and CI summary', async () => {
    const scenarioRoot = path.join(root, 'scenario');
    const timestamp = Date.UTC(2026, 0, 15, 12);
    await prepareFixtures(scenarioRoot, timestamp, true);
    await exportFixtureDataset(scenarioRoot, timestamp, path.join(root, 'populated'), true);
    await writeSnapshotReport(root, {
      version: '1.125.0', platform: 'linux', vsixHash: 'abc123',
      results: [{ scenario: 'populated', exitCode: 0 }],
    });
    for (const name of ['gallery.html', 'snapshots.md']) {
      const report = await fs.readFile(path.join(root, name), 'utf8');
      expect(report).toContain('3 projects, 21 sessions, 63 requests, 315 AI LoC');
      expect(report).toContain('inventory-api (typescript)');
      expect(report).toContain('sensor-pipeline (python)');
      expect(report).toContain('release-worker (go)');
      expect(report).toContain('tests/vscode/data/projects.json');
      expect(report).toContain('populated/fixtures/initial');
      expect(report).toContain('no personal logs were read');
    }
  });

  it('surfaces a missing captured PNG rather than generating a broken image', async () => {
    const suite = path.join(root, 'populated');
    await saveSnapshot(suite, snapshot, PNG);
    await fs.unlink(path.join(suite, 'snapshots', `${snapshot.name}.png`));
    await expect(writeSnapshotReport(root, {
      version: '1.125.0', platform: 'linux', vsixHash: 'abc123',
      results: [{ scenario: 'populated', exitCode: 0 }],
    })).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
