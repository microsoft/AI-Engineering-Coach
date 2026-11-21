import { test, expect, Page } from '@playwright/test';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { harnessUrl } from './harness-url';

const HARNESS_URL = harnessUrl();

// esbuild.mjs writes this from the same stamp it injects into dist/webview/app.js.
const build = JSON.parse(readFileSync(resolve('dist', 'build-info.json'), 'utf8')) as {
  version: string; commit: string; dirty: boolean;
};

async function waitForDashboard(page: Page) {
  await page.goto(HARNESS_URL);
  await page.waitForFunction(() => {
    const content = document.getElementById('content');
    return content && content.innerHTML.length > 200 && !content.querySelector('.loading-spinner') && !content.querySelector('.error-boundary');
  }, { timeout: 10000 });
}

test.describe('Build stamp', () => {
  test('the sidebar footer identifies the running build', async ({ page }) => {
    await waitForDashboard(page);
    const footer = page.locator('#sidebar > #build-info');
    await expect(footer).toBeVisible();
    await expect(footer.locator('.build-info-version')).toHaveText(`v${build.version}`);
    await expect(footer.locator('.build-info-meta')).toContainText(build.dirty ? `${build.commit}-dirty` : build.commit);
    await expect(footer).toHaveAttribute('title', new RegExp(`^AI Engineer Coach ${build.version.replaceAll('.', '\\.')}\\n`));
    await expect(page.locator('#build-info-status')).toBeHidden();
  });
});
