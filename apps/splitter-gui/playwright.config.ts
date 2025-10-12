import { defineConfig } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: path.join(__dirname, 'tests'),
  reporter: 'list',
  use: {
    screenshot: 'off',
    trace: 'off'
  },
  snapshotDir: path.join(__dirname, 'tests', '__screenshots__'),
  timeout: 30000
});
