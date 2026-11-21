/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { fixtureDatasetSchema } from './fixtures';

const safeName = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
const snapshotSchema = z.object({ name: safeName, title: z.string().min(1) });
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
type Snapshot = z.infer<typeof snapshotSchema>;
interface GallerySnapshot extends Snapshot { scenario: string; image: string }
interface SnapshotRun {
  version: string;
  platform: string;
  vsixHash: string;
  results: { scenario: string; exitCode: number }[];
}

export async function saveSnapshot(artifacts: string, snapshot: Snapshot, image: string): Promise<void> {
  if (!path.isAbsolute(artifacts)) throw new Error('Snapshot artifacts must use an absolute directory');
  const metadata = snapshotSchema.parse(snapshot);
  const png = Buffer.from(image, 'base64');
  if (!png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error('Desktop snapshot did not contain a PNG image');
  }
  const directory = path.join(artifacts, 'snapshots');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, `${metadata.name}.png`), png, { flag: 'wx' });
  await fs.writeFile(path.join(directory, `${metadata.name}.json`), JSON.stringify(metadata) + '\n', { flag: 'wx' });
}

async function readSnapshots(artifacts: string, scenario: string): Promise<GallerySnapshot[]> {
  const directory = path.join(artifacts, safeName.parse(scenario), 'snapshots');
  let entries: string[];
  try {
    entries = await fs.readdir(directory);
  } catch (err: unknown) {
    // A suite can fail before reaching its first snapshot.
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return [];
    throw err;
  }
  const snapshots: GallerySnapshot[] = [];
  for (const file of entries.filter(entry => entry.endsWith('.json')).sort()) {
    const metadata = snapshotSchema.parse(JSON.parse(await fs.readFile(path.join(directory, file), 'utf8')));
    const png = await fs.readFile(path.join(directory, `${metadata.name}.png`));
    snapshots.push({ ...metadata, scenario, image: `data:image/png;base64,${png.toString('base64')}` });
  }
  return snapshots;
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

async function datasetHtml(artifacts: string, scenario: string): Promise<string> {
  const file = path.join(artifacts, safeName.parse(scenario), 'dataset.json');
  let content: string;
  try {
    content = await fs.readFile(file, 'utf8');
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return '';
    throw err;
  }
  const dataset = fixtureDatasetSchema.parse(JSON.parse(content));
  const projects = dataset.projects.map(project =>
    `${escapeHtml(project.name)} (${escapeHtml(project.language)})`).join(', ');
  return `<li><strong>${escapeHtml(scenario)}</strong>: ${dataset.projects.length} projects, ` +
    `${dataset.initial.sessions} sessions, ${dataset.initial.requests} requests, ${dataset.initial.aiLoc} AI LoC ` +
    `(${dataset.initial.netAiLoc} net) across ${dataset.activeDays} active days.` +
    `${projects ? `<br>Projects: ${projects}.` : '<br>Deliberately empty profile.'}` +
    `${dataset.afterReload ? `<br>After the planned reload addition: ${dataset.afterReload.sessions} sessions, ` +
      `${dataset.afterReload.requests} requests, ${dataset.afterReload.aiLoc} AI LoC (${dataset.afterReload.netAiLoc} net).` : ''}` +
    (dataset.inputFiles.initial > 0
      ? `<br>Raw inputs: <code>${escapeHtml(scenario)}/fixtures/initial</code>; ` +
        `planned reload files: <code>${escapeHtml(scenario)}/fixtures/reload</code>.`
      : '<br>No session input files are seeded for this scenario.') + '</li>';
}

function galleryHtml(run: SnapshotRun, snapshots: GallerySnapshot[], outcomes: string, datasets: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'">
<title>VS Code smoke snapshots</title>
<style>
body { margin: 2rem auto; padding: 0 1rem; max-width: 1440px; font: 16px system-ui, sans-serif; color: #e6edf3; background: #0d1117; }
h1, h2 { line-height: 1.3; } p, li { line-height: 1.6; } code { overflow-wrap: anywhere; }
figure { margin: 2rem 0; padding: 1rem; background: #161b22; border: 1px solid #30363d; border-radius: 8px; }
figcaption { margin-bottom: 1rem; } img { display: block; width: 100%; height: auto; } small { color: #b1bac4; }
</style>
</head>
<body>
<h1>VS Code smoke snapshots</h1>
<p>VS Code target: <strong>${escapeHtml(run.version)}</strong> on ${escapeHtml(run.platform)}.</p>
<p>Tested VSIX SHA-256: <code>${escapeHtml(run.vsixHash)}</code></p>
<p>Captured after milestone assertions against synthetic data. These are execution evidence, not pixel-comparison baselines.
A later failure still makes the suite fail.</p>
<h2>Suite results</h2>
<ul>${outcomes}</ul>
${datasets}
${snapshots.length === 0 ? '<p>No snapshots were captured. Inspect the test logs for startup or assertion failures.</p>'
    : snapshots.map(snapshot => `<figure>
<figcaption><strong>${escapeHtml(snapshot.title)}</strong><br><small>${escapeHtml(snapshot.scenario)} / ${escapeHtml(snapshot.name)}</small></figcaption>
<img src="${snapshot.image}" alt="${escapeHtml(snapshot.title)}" loading="lazy">
</figure>`).join('\n')}
</body>
</html>
`;
}

export async function writeSnapshotReport(artifacts: string, run: SnapshotRun): Promise<void> {
  const snapshots = (await Promise.all(run.results.map(result => readSnapshots(artifacts, result.scenario)))).flat();
  const outcomes = run.results.map(result => {
    const count = snapshots.filter(snapshot => snapshot.scenario === result.scenario).length;
    return `<li><strong>${escapeHtml(result.scenario)}</strong>: ${result.exitCode === 0 ? 'Passed' : 'Failed'}; ${count} snapshot${count === 1 ? '' : 's'}</li>`;
  }).join('\n') || '<li>No suites completed.</li>';
  const datasetRows = (await Promise.all(run.results.map(result => datasetHtml(artifacts, result.scenario)))).join('\n');
  const datasets = datasetRows.trim() ? `<h2>Synthetic test data</h2>
<p>Fully synthetic; no personal logs were read. Definitions: <code>tests/vscode/data/projects.json</code>.
Raw input copies and the planned reload addition are included in the artifact, alongside each suite's <code>dataset.json</code>.</p>
<ul>${datasetRows}</ul>` : '';
  await fs.writeFile(path.join(artifacts, 'gallery.html'), galleryHtml(run, snapshots, outcomes, datasets));
  await fs.writeFile(path.join(artifacts, 'snapshots.md'), `## VS Code smoke snapshots

VS Code target: <code>${escapeHtml(run.version)}</code> on <code>${escapeHtml(run.platform)}</code>.

<ul>${outcomes}</ul>

${datasets}

${snapshots.length} milestone screenshots captured. Suite results above include failures after a capture.
`);
}
