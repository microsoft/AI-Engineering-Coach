import { test, expect, Page } from '@playwright/test';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const HARNESS_URL = 'http://localhost:3999/tests/e2e/harness.html';

// esbuild.mjs writes this from the same stamp it injects into dist/webview/app.js.
const build = JSON.parse(readFileSync(resolve('dist', 'build-info.json'), 'utf8')) as {
  version: string; commit: string; dirty: boolean; dev: boolean;
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
    await expect(footer.locator('.build-info-version')).toHaveText(build.dev ? `v${build.version} dev` : `v${build.version}`);
    await expect(footer.locator('.build-info-meta')).toContainText(build.dirty ? `${build.commit}-dirty` : build.commit);
    await expect(footer).toHaveAttribute('title', new RegExp(`^AI Engineer Coach ${build.version.replaceAll('.', '\\.')} \\(`));
    await expect(page.locator('#build-info-status')).toBeHidden();
  });
});
