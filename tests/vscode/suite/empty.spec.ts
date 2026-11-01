/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { describe, it } from 'mocha';
import { Dashboard } from '../dashboard';
import { activateLinePattern, fixturePaths, readInstalledBuild, scenarioContext } from '../fixtures';

describe('Packaged VSIX without session logs', () => {
  it('shows the no-data explanation instead of hanging or reading another profile', async () => {
    const dashboard = new Dashboard();
    await dashboard.open();
    await dashboard.waitForText('.error p', 'No AI coding session logs found.');
    const { root } = scenarioContext();
    const runtime = await fs.readFile(fixturePaths(root).runtimeLog, 'utf8');
    assert.match(runtime, activateLinePattern(await readInstalledBuild(root)));
    assert.match(runtime, /logs-dirs-found[^\n]*count=0 external=false/);
    assert.match(runtime, /loadData-no-dirs/);
    assert.doesNotMatch(runtime, /parse-complete|uncaught-exception|unhandled-rejection/);
    await dashboard.snapshot('01-empty-state', 'Empty profile: the expected no-session-data explanation');
  });
});
