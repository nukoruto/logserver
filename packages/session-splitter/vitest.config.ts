import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.spec.ts', 'tests/**/*.test.ts', 'tests/**/*.spec.ts', 'src/**/__tests__/**/*.test.ts'],
    environment: 'node',
    globals: false,
    reporters: 'default',
    typecheck: {
      tsconfig: 'tsconfig.test.json'
    }
  }
});
