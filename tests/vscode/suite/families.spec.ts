/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { after, before, describe, it } from 'mocha';
import { Dashboard } from '../dashboard';
import { assertFamilyFixturesUnchanged, FAMILY, fixturePaths, scenarioContext } from '../fixtures';

describe('Packaged VSIX with a synthetic Copilot App session family', () => {
  const dashboard = new Dashboard();
  const { root, timestamp } = scenarioContext();

  before(async () => {
    await dashboard.open();
  });

  after(async () => {
    await assertFamilyFixturesUnchanged(root, timestamp);
    const runtime = await fs.readFile(fixturePaths(root).runtimeLog, 'utf8');
    assert.match(runtime, new RegExp(`\\[panel\\] parse-complete[^\\n]*sessions=${FAMILY.sessions}`));
    assert.doesNotMatch(runtime, /uncaught-exception|unhandled-rejection|loadData-error/);
  });

  it('draws the family as a session tree with autonomy KPIs', async () => {
    await dashboard.expectStats({ Sessions: String(FAMILY.sessions), Requests: String(FAMILY.requests) });
    await dashboard.navigate('timeline', 'Timeline');
    await dashboard.waitForText('#tlxCount', `${FAMILY.sessions} of ${FAMILY.sessions} sessions shown`);
    await dashboard.waitForText('#tlxKpis', `4 of ${FAMILY.requests}`);
    await dashboard.waitForText('.tlx-fam', 'Checkout revamp');
    await dashboard.waitForText('.tlx-lane', 'Lint fixes');
    await dashboard.waitForText('.tlx-lane', 'grandchild');
    await dashboard.waitForText('.tlx-lane', 'started by relay');
    await dashboard.waitForText('.tlx-lane', 'Untitled Copilot CLI session');
    await dashboard.expectCount('.tlx-lanes .conn', 4);
    // The docs child's answered question is drawn as a wait on you.
    await dashboard.expectCount('.tlx-lane .wait.ask', 2);
    await dashboard.expectHealthy();
    await dashboard.snapshot('01-family-day', 'Timeline: a coordinator, three children, a grandchild and a lone CLI session');
  });

  it('judges the family and removes the GitHub handle from its branch', async () => {
    await dashboard.click('#tlxView [data-value="families"]');
    await dashboard.expectCount('.frow', 1);
    await dashboard.waitForText('.frow', 'Needed you');
    await dashboard.waitForText('#tlxFamilyDetail', 'branch checkout-revamp');
    await dashboard.waitForText('#tlxFamilyDetail', 'You typed 1 prompt into and answered 1 question or permission prompt in 2 of 4 child sessions');
    await dashboard.expectHealthy();
    await dashboard.snapshot('02-families', 'Families: one delegation that needed you, with its verdict and habit');
  });

  it('masks names before a screenshot', async () => {
    await dashboard.click('#tlxMask');
    await dashboard.waitForText('#tlxFamilyDetail h2', 'Session 1', true);
    await dashboard.expectCount('#tlxFamilyDetail .meta', 1);
    await dashboard.waitForText('#tlxFamilyDetail .meta', 'Repository A');
    await dashboard.snapshot('03-masked', 'Families with Mask names on: no session names, branches or repositories');
  });
});
