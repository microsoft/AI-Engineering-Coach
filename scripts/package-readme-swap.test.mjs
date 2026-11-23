/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withPackagedFiles } from './package-readme-swap.mjs';

const ORIGINAL = { 'README.md': 'GitHub README with uncommitted edits\n', 'CHANGELOG.md': '# Changelog\n\n## 2026-05-06\n' };
let root;
const read = (/** @type {string} */ name) => readFileSync(join(root, name), 'utf8');
const files = () => readdirSync(root).sort();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aic-package-'));
  for (const [name, text] of Object.entries(ORIGINAL)) writeFileSync(join(root, name), text);
  writeFileSync(join(root, 'README.extension.md'), 'Marketplace README\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** The originals are byte-identical and no backup or staged file is left behind. */
function expectOriginals() {
  for (const [name, text] of Object.entries(ORIGINAL)) expect(read(name), name).toBe(text);
  expect(files()).toEqual(['CHANGELOG.md', 'README.extension.md', 'README.md']);
}

describe('withPackagedFiles', () => {
  it('gives vsce the Marketplace README and the dated changelog, then restores both originals', () => {
    let seen;
    withPackagedFiles({ root, changelog: 'dated changelog\n', run: () => { seen = [read('README.md'), read('CHANGELOG.md')]; } });
    expect(seen).toEqual(['Marketplace README\n', 'dated changelog\n']);
    expectOriginals();
  });

  it('restores both originals and rethrows when vsce fails', () => {
    const failure = new Error('vsce failed');
    expect(() => withPackagedFiles({ root, changelog: 'x', run: () => { throw failure; } })).toThrow(failure);
    expectOriginals();
  });

  it('touches no original when a replacement cannot be staged', () => {
    rmSync(join(root, 'README.extension.md'));
    let ran = false;
    expect(() => withPackagedFiles({ root, changelog: 'x', run: () => { ran = true; } })).toThrow(/README\.extension\.md/);
    expect(ran).toBe(false);
    for (const [name, text] of Object.entries(ORIGINAL)) expect(read(name)).toBe(text);
    expect(files()).toEqual(['CHANGELOG.md', 'README.md']);
  });

  it('puts back the first original when the second file cannot be swapped', () => {
    rmSync(join(root, 'CHANGELOG.md'));
    expect(() => withPackagedFiles({ root, changelog: 'x', run: () => {} })).toThrow(/CHANGELOG\.md/);
    expect(read('README.md')).toBe(ORIGINAL['README.md']);
    expect(files()).toEqual(['README.extension.md', 'README.md']);
  });

  it('repairs a run that was killed while vsce ran, instead of overwriting the parked originals', () => {
    // What a killed run leaves: originals parked, replacements and a staged file in place.
    for (const [name, backup] of [['README.md', 'README.github.md'], ['CHANGELOG.md', 'CHANGELOG.github.md']]) {
      writeFileSync(join(root, backup), read(name));
      writeFileSync(join(root, name), 'replacement from the killed run\n');
    }
    writeFileSync(join(root, 'CHANGELOG.md.aic-staging'), 'partial');
    const logs = [];
    withPackagedFiles({ root, changelog: 'x', run: () => {}, log: message => logs.push(message) });
    expectOriginals();
    expect(logs).toEqual([
      'Restored README.md from README.github.md, left by an interrupted npm run package.',
      'Restored CHANGELOG.md from CHANGELOG.github.md, left by an interrupted npm run package.',
    ]);
  });

  it('reports a restore that fails, together with the vsce failure, instead of hiding either', () => {
    let error;
    try {
      withPackagedFiles({ root, changelog: 'x', run: () => {
        rmSync(join(root, 'CHANGELOG.github.md')); // The parked original disappears while vsce runs.
        throw new Error('vsce failed');
      } });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors[0].message).toBe('vsce failed');
    expect(error.message).toMatch(/^Could not restore the original files; rename them back by hand:\n {2}CHANGELOG\.github\.md -> CHANGELOG\.md: /);
    expect(read('README.md')).toBe(ORIGINAL['README.md']);
    expect(existsSync(join(root, 'CHANGELOG.md.aic-staging'))).toBe(false);
  });
});
