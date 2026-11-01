/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { after, before, describe, it } from 'mocha';
import { VSBrowser } from 'vscode-extension-tester';
import { Dashboard } from '../dashboard';
import {
  addReloadFixture, assertFixturesUnchanged, FIRST_PROMPT, fixturePaths,
  INITIAL_COUNTS, INITIAL_NET_LOC, PROJECT_NAMES, RELOADED_COUNTS, scenarioContext,
} from '../fixtures';

describe('Packaged VSIX with synthetic sessions', () => {
  const dashboard = new Dashboard();
  const { root, timestamp } = scenarioContext();
  let reloaded = false;

  before(async () => {
    await dashboard.open();
  });

  after(async () => {
    await assertFixturesUnchanged(root, timestamp, reloaded);
    const runtime = await fs.readFile(fixturePaths(root).runtimeLog, 'utf8');
    assert.match(runtime, /\[extension\] activate/);
    assert.match(runtime, /\[panel\] parse-complete/);
    assert.match(runtime, /\[panel\] warmUp-done/);
    assert.doesNotMatch(runtime, /uncaught-exception|unhandled-rejection|loadData-error|rules-load-error|metrics-load-error/);
    // The extension kills the parse worker as soon as it reports done, so the parse cache must
    // already be on disk by then; otherwise every launch parses all logs again.
    assert.match(runtime, /\[parse-worker\] cache-write-wait[^\n]*settled=true/);
    const cacheDir = path.dirname(fixturePaths(root).runtimeLog);
    for (const file of ['parsed.json', 'meta.json']) {
      assert.ok((await fs.stat(path.join(cacheDir, file))).size > 0, `${file} was not persisted`);
    }
  });

  it('activates the installed extension and renders real worker results', async () => {
    await dashboard.expectStats(INITIAL_COUNTS);
    await dashboard.waitForText('#content', 'Local Agent');
    await dashboard.snapshot('01-dashboard', 'Dashboard: 3 projects, 21 sessions, 63 requests and 315 AI LoC');
    await dashboard.scrollTo('#dailyChart');
    await dashboard.snapshot('01-dashboard-activity', 'Dashboard activity: 7 days and the three-project breakdown');
    await dashboard.scrollTo('#content');
  });

  it('navigates to the timeline and displays a synthetic session', async () => {
    await dashboard.navigate('timeline', 'Timeline');
    await dashboard.waitForText('#timelineStats', '3 sessions');
    await dashboard.waitForText('#timelineStats', '9 requests');
    await dashboard.waitForText('#timelineStats', 'Max concurrent: 3');
    await dashboard.click('.timeline-lane');
    await dashboard.waitForText('#timelineDetail', FIRST_PROMPT);
    await dashboard.expectHealthy();
    await dashboard.snapshot('02-timeline', 'Timeline: 3 overlapping projects and the selected session details');
  });

  it('loads the Output page through the real webview message bridge', async () => {
    await dashboard.navigate('output', 'Output');
    await dashboard.waitForText('#content', 'AI-Generated LoC');
    await dashboard.click('#outputRange [data-range="28"]');
    await dashboard.waitForText('#output-tab-content .stat-card:nth-child(1) .stat-value', INITIAL_COUNTS['AI LoC'], true);
    await dashboard.waitForText('#output-tab-content .stat-card:nth-child(2) .stat-value', String(INITIAL_NET_LOC), true);
    await dashboard.click('[data-prod-tab="workspace"]');
    await dashboard.expectHealthy();
    await dashboard.snapshot('03-output', 'Output by project: 315 added lines and 294 net lines across 7 days');
  });

  it('renders nonempty activity patterns and the three-project breakdown', async () => {
    await dashboard.navigate('patterns', 'Activity Patterns');
    await dashboard.expectCount('#heatmapGrid .heatmap-cell', 168);
    await dashboard.expectCount('#heatmapGrid .heatmap-cell:not(:empty)', 7);
    await dashboard.waitForText('#heatmapGrid .heatmap-cell', '9', true);
    await dashboard.expectHealthy();
    await dashboard.snapshot('04-patterns-hours', 'Patterns: 7 active days with weekday, weekend and evening activity');
    await dashboard.click('#patternTabs [data-tab="projects"]');
    await dashboard.expectCount('#tabProjects .project-card', 3);
    for (const project of PROJECT_NAMES) await dashboard.waitForText('#tabProjects .proj-name', project, true);
    await dashboard.waitForText('#tabProjects .proj-requests', '21 reqs', true);
    await dashboard.waitForText('#tabProjects .proj-loc', '105 LoC', true);
    await dashboard.expectHealthy();
    await dashboard.snapshot('05-patterns-projects', 'Patterns: TypeScript, Python and Go project summaries');
  });

  it('reloads changed files without retaining stale results or duplicating sessions', async () => {
    await addReloadFixture(root, timestamp);
    reloaded = true;
    await dashboard.command('Reload Data');
    // A replacement webview starts on Dashboard; its layout can still be loading.
    await dashboard.expectStats(RELOADED_COUNTS);
    await dashboard.expectCount('#sidebar [data-page="dashboard"].active', 1);
    const log = fixturePaths(root).runtimeLog;
    const parsesBefore = (await fs.readFile(log, 'utf8')).match(/\[panel\] parse-complete/g)?.length ?? 0;
    await dashboard.command('Reload Data');
    await VSBrowser.instance.driver.wait(async () =>
      ((await fs.readFile(log, 'utf8')).match(/\[panel\] parse-complete/g)?.length ?? 0) > parsesBefore,
    60_000, 'Reload should run the parse worker again');
    await dashboard.expectStats(RELOADED_COUNTS);
    const runtime = await fs.readFile(log, 'utf8');
    assert.match(runtime, /\[extension\] command-reload/);
    assert.match(runtime, /\[panel\] parse-complete[^\n]*sessions=22/);
    await dashboard.snapshot('06-reloaded', 'Reloaded twice: 22 sessions, 66 requests and 330 AI LoC, without duplicates');
  });

  it('reopens the dashboard with the same data', async () => {
    await dashboard.close();
    await dashboard.open();
    await dashboard.expectStats(RELOADED_COUNTS);
    await dashboard.snapshot('07-reopened', 'Reopened dashboard: the same 22 sessions, 66 requests and 330 AI LoC');
  });
});

describe('Packaged VSIX without GitHub Copilot', () => {
  const dashboard = new Dashboard();

  before(async () => {
    await dashboard.open();
  });

  it('hides Copilot-only features while GitHub Copilot is unavailable', async () => {
    // The harness sets chat.disableAIFeatures, so VS Code offers the extension no Copilot model.
    await dashboard.click('#sidebar [data-page="dashboard"]');
    await dashboard.expectHidden('.dash-section.llm-only');
    await dashboard.expectHidden('#sidebar [data-page="skills"]');
    await dashboard.expectHidden('#sidebar [data-page="level-up"]');
    await dashboard.navigate('anti-patterns', 'Anti-Patterns');
    await dashboard.expectHidden('.occ-explain-btn');
    await dashboard.click('#sidebar [data-page="config-health"]');
    await dashboard.expectHidden('#ctxReviewBtn');
    await dashboard.expectDisabled('button.llm-fallback', 'Sign in to GitHub Copilot in VS Code to use this.');
    await dashboard.expectHealthy();
    await dashboard.snapshot('08-copilot-unavailable',
      'Copilot unavailable: Why?, Skill Finder and Level Up hidden, Review Context Files disabled with a sign-in hint');
  });
});
