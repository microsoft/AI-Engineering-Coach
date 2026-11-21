/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { describe, it } from 'mocha';
import { Dashboard } from '../dashboard';
import { fixturePaths, scenarioContext } from '../fixtures';

describe('Packaged VSIX without session logs', () => {
  it('shows the no-data explanation instead of hanging or reading another profile', async () => {
    const dashboard = new Dashboard();
    await dashboard.open();
    await dashboard.waitForText('.error p', 'No AI coding session logs found.');
    const runtime = await fs.readFile(fixturePaths(scenarioContext().root).runtimeLog, 'utf8');
    assert.match(runtime, /logs-dirs-found[^\n]*count=0 external=false/);
    assert.match(runtime, /loadData-no-dirs/);
    assert.doesNotMatch(runtime, /parse-complete|uncaught-exception|unhandled-rejection/);
    await dashboard.snapshot('01-empty-state', 'Empty profile: the expected no-session-data explanation');
  });
});
