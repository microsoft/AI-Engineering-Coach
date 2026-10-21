import { test, expect, type Page } from '@playwright/test';
import type { ImageGalleryData } from '../../src/core/analyzer-images';

const URL = 'http://localhost:3999/tests/e2e/harness.html';
const IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const harnesses = ['VS Code', 'Insiders', 'Copilot CLI', 'Copilot App', 'Claude', 'Codex', 'OpenCode JSON', 'OpenCode SQLite', 'Xcode'];

async function openGallery(page: Page, unavailable: string[] = []): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1400 });
  await page.goto(URL);
  await page.waitForFunction(() => {
    const content = document.getElementById('content');
    return content && content.innerHTML.length > 200 && !content.querySelector('.loading-spinner') && !content.querySelector('.error-boundary');
  }, { timeout: 10_000 });
  const data: ImageGalleryData = {
    moments: harnesses.map((harness, index) => ({
      id: 'shared-request-id', sessionId: `session-${index}`, timestamp: Date.now(), date: '2026-10-19',
      workspace: harness, workspaceId: `ws-${index}`, promptExcerpt: 'Inspect this screenshot',
      responseExcerpt: 'A recorded answer', imageCount: 1, model: 'test-model', agent: harness,
      editedFiles: [], aiLoc: 0, turnNumber: 1, sessionTurns: 1,
    })),
    stories: [], journeys: [], qualityFlags: [],
    summary: {
      totalImages: harnesses.length, totalMoments: harnesses.length, totalSessions: harnesses.length,
      avgImagesPerMoment: 1, topWorkspace: 'VS Code', topModel: 'test-model', dateRange: '', dailyImages: [],
    },
  };
  await page.evaluate(({ data, image, unavailable }) => {
    const root = window as Window & {
      getMockData: (method: string, params: Record<string, unknown>) => unknown;
      imageCalls?: { sessionId: unknown; requestId: unknown }[];
    };
    const original = root.getMockData;
    root.imageCalls = [];
    root.getMockData = (method, params) => {
      if (method === 'getImageGallery') return data;
      if (method === 'getSessionImages') {
        root.imageCalls!.push({ sessionId: params.sessionId, requestId: params.requestId });
        return { images: unavailable.includes(String(params.sessionId)) ? [] : [image] };
      }
      return original(method, params);
    };
  }, { data, image: IMAGE, unavailable });
  await page.locator('[data-page="image-gallery"]').click();
}

test('renders loadable moments for every harness even when their request IDs overlap', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await openGallery(page);
  await expect(page.locator('.img-card')).toHaveCount(harnesses.length);
  await expect(page.locator('.img-card-img')).toHaveCount(harnesses.length);
  await expect.poll(() => page.locator('.img-card-img').evaluateAll(images =>
    images.every(image => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0),
  )).toBe(true);
  const calls = await page.evaluate(() => (window as Window & { imageCalls: { sessionId: string }[] }).imageCalls);
  expect(new Set(calls.map(call => call.sessionId)).size).toBe(harnesses.length);
  expect(errors).toEqual([]);
});

test('a missing image does not hide another session with the same request ID', async ({ page }) => {
  await openGallery(page, ['session-0']);
  await expect(page.locator('.img-card')).toHaveCount(harnesses.length - 1);
  await expect(page.getByRole('heading', { name: 'No Loadable Images Found' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Claude 1', exact: true }).click();
  await expect(page.locator('.img-card')).toHaveCount(1);
  await expect(page.locator('.img-card-img')).toHaveAttribute('src', IMAGE);
});

test('keeps the unavailable-image state when none of the recorded files can be loaded', async ({ page }) => {
  await openGallery(page, harnesses.map((_harness, index) => `session-${index}`));
  await expect(page.getByRole('heading', { name: 'No Loadable Images Found' })).toBeVisible();
  await expect(page.locator('.img-card')).toHaveCount(0);
  await expect(page.locator('.img-range-count')).toHaveText(`${harnesses.length} moments`);
});
