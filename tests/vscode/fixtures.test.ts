/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addReloadFixture, assertFixturesUnchanged, exportFixtureDataset, fixtureDatasetSchema,
  fixtureFiles, fixturePaths, isolatedEnvironment, prepareFixtures,
} from './fixtures';
import { discoverSuites, vscodeVersion } from './run';

const timestamp = Date.UTC(2026, 0, 15, 12);
let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'aec-fixtures-'));
  for (const [key, value] of Object.entries(isolatedEnvironment(root, {}))) vi.stubEnv(key, value);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

describe('desktop test fixtures', () => {
  it('parses real raw sessions with exact counts and discovers the added reload fixture', async () => {
    await prepareFixtures(root, timestamp, true);
    const { findLogsDirs, parseAllLogs } = await import('../../src/core/parser');
    expect(findLogsDirs()).toEqual([fixturePaths(root).logs]);
    const initial = parseAllLogs(findLogsDirs());
    expect(initial.sessions).toHaveLength(21);
    expect(initial.sessions.reduce((sum, session) => sum + session.requests.length, 0)).toBe(63);
    expect(initial.workspaces.size).toBe(3);
    await assertFixturesUnchanged(root, timestamp);
    await addReloadFixture(root, timestamp);
    const reloaded = parseAllLogs(findLogsDirs());
    expect(reloaded.sessions).toHaveLength(22);
    expect(reloaded.sessions.reduce((sum, session) => sum + session.requests.length, 0)).toBe(66);
    await assertFixturesUnchanged(root, timestamp, true);
  });

  describe('multi-project fixture analytics', () => {
    it('counts real edit operations without double-counting code repeated in responses', async () => {
      await prepareFixtures(root, timestamp, true);
      const { parseAllLogs } = await import('../../src/core/parser');
      const { Analyzer } = await import('../../src/core/analyzer');
      const parsed = parseAllLogs([fixturePaths(root).logs]);
      const analyzer = new Analyzer(parsed.sessions, parsed.editLocIndex, parsed.workspaces);
      const production = analyzer.getCodeProduction();
      expect(parsed.editLocIndex.size).toBe(42);
      expect(production.summary).toMatchObject({ totalAiLoc: 315, totalRemovedAiLoc: 21, totalNetAiLoc: 294 });
      expect(production.byLanguage.labels.slice().sort()).toEqual(['go', 'python', 'typescript']);
      expect(production.byLanguage.aiLoc).toEqual([105, 105, 105]);
      expect(analyzer.getDailyActivity().loc).toEqual([45, 45, 45, 45, 45, 45, 45]);
      await addReloadFixture(root, timestamp);
      const reloaded = parseAllLogs([fixturePaths(root).logs]);
      expect(new Analyzer(reloaded.sessions, reloaded.editLocIndex, reloaded.workspaces).getCodeProduction().summary)
        .toMatchObject({ totalAiLoc: 330, totalRemovedAiLoc: 22, totalNetAiLoc: 308 });
    });

    it('populates all seven days, overlapping timeline sessions, and three project summaries', async () => {
      await prepareFixtures(root, timestamp, true);
      const { parseAllLogs } = await import('../../src/core/parser');
      const { Analyzer } = await import('../../src/core/analyzer');
      const parsed = parseAllLogs([fixturePaths(root).logs]);
      const analyzer = new Analyzer(parsed.sessions, parsed.editLocIndex, parsed.workspaces);
      expect(analyzer.getHeatmap().heatmap.flat().filter(value => value > 0)).toEqual([9, 9, 9, 9, 9, 9, 9]);
      expect(analyzer.getWorkLifeBalance()).toMatchObject({ totalRequests: 63, weekdayReqs: 45, weekendReqs: 18, activeDays: 7 });
      expect(analyzer.getDayTimeline()).toMatchObject({ sessionCount: 3, maxConcurrent: 3 });
      const projects = analyzer.getProjectOverview().projects;
      expect(projects.map(project => project.workspaceName).sort()).toEqual(['inventory-api', 'release-worker', 'sensor-pipeline']);
      expect(projects.map(project => project.totalRequests)).toEqual([21, 21, 21]);
      expect(projects.map(project => project.estimatedLoc)).toEqual([105, 105, 105]);
    });
  });

  describe('published synthetic dataset', () => {
    it('exports the actual initial inputs separately from the planned reload addition', async () => {
      await prepareFixtures(root, timestamp, true);
      const artifacts = path.join(root, 'artifacts');
      await exportFixtureDataset(root, timestamp, artifacts, true);
      const summary = fixtureDatasetSchema.parse(JSON.parse(await fs.readFile(path.join(artifacts, 'dataset.json'), 'utf8')));
      expect(summary).toMatchObject({
        synthetic: true, activeDays: 7, initial: { sessions: 21, requests: 63, aiLoc: 315, netAiLoc: 294 },
        afterReload: { sessions: 22, requests: 66, aiLoc: 330, netAiLoc: 308 },
        inputFiles: { initial: 45, reload: 2 },
      });
      for (const [file, content] of fixtureFiles(root, timestamp)) {
        expect(await fs.readFile(path.join(artifacts, 'fixtures', 'initial', path.relative(fixturePaths(root).logs, file)), 'utf8'))
          .toBe(content);
      }
      await assertFixturesUnchanged(root, timestamp);
      expect(await fs.readdir(path.join(artifacts, 'fixtures', 'reload', 'inventory-api', 'chatSessions')))
        .toEqual(['inventory-api-reload.json']);
    });

    it('makes the deliberately empty scenario explicit in its dataset manifest', async () => {
      await prepareFixtures(root, timestamp, false);
      const artifacts = path.join(root, 'artifacts');
      await exportFixtureDataset(root, timestamp, artifacts, false);
      const summary = fixtureDatasetSchema.parse(JSON.parse(await fs.readFile(path.join(artifacts, 'dataset.json'), 'utf8')));
      expect(summary).toMatchObject({ projects: [], activeDays: 0, initial: { sessions: 0, requests: 0, aiLoc: 0 }, afterReload: null });
      expect(await fs.readdir(path.join(artifacts, 'fixtures'))).toEqual(['projects.json']);
    });
  });

  it('does not create a discoverable source for the empty scenario', async () => {
    await prepareFixtures(root, timestamp, false);
    const { findLogsDirs } = await import('../../src/core/parser');
    const { hasExternalHarnessSources } = await import('../../src/core/parser-harnesses');
    expect(findLogsDirs()).toEqual([]);
    expect(hasExternalHarnessSources()).toBe(false);
  });

  it('detects session data modified by the application', async () => {
    await prepareFixtures(root, timestamp, true);
    const file = [...fixtureFiles(root, timestamp).keys()][0];
    await fs.appendFile(file, 'unexpected data');
    await expect(assertFixturesUnchanged(root, timestamp)).rejects.toThrow('Session-log input was modified');
  });

  it('isolates every discovery root without mutating the parent environment', () => {
    const parent = { HOME: '/personal', USERPROFILE: '/personal', COPILOT_HOME: '/personal/copilot',
      VSCODE_PORTABLE: '/personal/code', VSCODE_IPC_HOOK_CLI: 'personal-socket', ELECTRON_RUN_AS_NODE: '1',
      NODE_OPTIONS: '--inspect', CODE_VERSION: 'latest', PATH: '/tools',
      MOCHA_GREP: 'activates|no-data', MOCHA_INVERT: 'true' };
    const env = isolatedEnvironment(root, parent);
    for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'COPILOT_HOME', 'TMP', 'TEMP', 'TMPDIR']) {
      expect(env[key]?.startsWith(root + path.sep)).toBe(true);
    }
    expect(env).not.toHaveProperty('VSCODE_PORTABLE');
    expect(env).not.toHaveProperty('VSCODE_IPC_HOOK_CLI');
    expect(env).not.toHaveProperty('ELECTRON_RUN_AS_NODE');
    expect(env).not.toHaveProperty('NODE_OPTIONS');
    expect(env).not.toHaveProperty('CODE_VERSION');
    expect(env).not.toHaveProperty('MOCHA_GREP');
    expect(env).not.toHaveProperty('MOCHA_INVERT');
    expect(env.PATH).toBe('/tools');
    expect(parent.HOME).toBe('/personal');
    expect(parent.MOCHA_GREP).toBe('activates|no-data');
    expect(parent.MOCHA_INVERT).toBe('true');
  });

  it('places fixture logs in the platform-specific discovery locations', () => {
    expect(fixturePaths(root, 'win32').logs).toContain(path.join('AppData', 'Roaming', 'Code', 'User'));
    expect(fixturePaths(root, 'darwin').logs).toContain(path.join('Library', 'Application Support', 'Code', 'User'));
    expect(fixturePaths(root, 'linux').logs).toContain(path.join('.config', 'Code', 'User'));
  });
});

describe('desktop VS Code version selection', () => {
  it('uses the manifest minimum and accepts compatible pinned or latest versions', () => {
    expect(vscodeVersion('^1.125.0')).toBe('1.125.0');
    expect(vscodeVersion('^1.125.0', '1.140.0')).toBe('1.140.0');
    expect(vscodeVersion('^1.125.0', 'latest')).toBe('latest');
  });

  describe('desktop suite discovery', () => {
    it('automatically includes new source suites but never stale compiled files', async () => {
      for (const file of ['populated.spec.ts', 'new-feature.spec.ts', 'helper.ts', 'deleted.spec.js']) {
        await fs.writeFile(path.join(root, file), '');
      }
      expect(await discoverSuites(root)).toEqual(['new-feature', 'populated']);
    });

    it('rejects an empty test selection', async () => {
      await expect(discoverSuites(root)).rejects.toThrow('No desktop smoke suites found');
    });
  });

  it('rejects incompatible versions and malformed input', () => {
    for (const version of ['1.124.0', '2.0.0', '../Code', 'stable']) {
      expect(() => vscodeVersion('^1.125.0', version)).toThrow();
    }
    expect(() => vscodeVersion('>=1.125.0')).toThrow();
  });
});
