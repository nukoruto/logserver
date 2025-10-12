import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.join(__dirname, '..');
const ENTRY = path.join(APP_ROOT, 'dist', 'static', 'index.html');

test('renderer renders expected controls and layout without data', async ({ page }) => {
  await page.addInitScript(() => {
    // @ts-expect-error - injected stub for Electron preload bridge
    window.sessionSplitter = {
      algoVersion: 'test-algo',
      selectFile: async () => null,
      preview: async () => {
        throw new Error('not implemented');
      },
      export: async () => ({ canceled: true })
    };
  });

  await page.goto(`file://${ENTRY}`);

  await expect(page.locator('h1')).toHaveText('Session Splitter GUI');
  await expect(page.locator('#algo-version')).toHaveText('test-algo');
  await expect(page.locator('#select-file')).toBeVisible();
  await expect(page.locator('#export')).toBeVisible();

  const controlLabels = page.locator('.controls label');
  await expect(controlLabels).toHaveCount(2);
  await expect(page.locator('#idle-timeout')).toHaveAttribute('type', 'number');
  await expect(page.locator('#user-select')).toHaveCount(1);

  const slider = page.locator('#delta-slider');
  await expect(slider).toHaveAttribute('type', 'range');
  await expect(page.locator('#delta-input')).toHaveAttribute('type', 'number');

  const canvases = page.locator('canvas');
  await expect(canvases).toHaveCount(2);
  await expect(page.locator('#threshold-list')).toBeVisible();
  await expect(page.locator('#preview-table tbody tr')).toHaveCount(0);

  const status = await page.locator('#status').textContent();
  expect(status).toContain('CSV を選択してプレビューを開始してください。');
});
