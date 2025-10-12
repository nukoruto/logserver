const path = require('path');

/** @type {import('eslint').Linter.Config} */
module.exports = {
  root: true,
  ignorePatterns: [
    '**/dist/**',
    '**/build/**',
    '**/coverage/**',
    '**/node_modules/**',
    'artifacts/**',
    'outputs/**',
    '*.config.js',
    '*.config.cjs',
    '*.config.mjs',
    '*.config.ts',
    'pnpm-lock.yaml'
  ],
  overrides: [
    {
      files: ['**/*.js', '**/*.cjs', '**/*.mjs'],
      extends: ['eslint:recommended'],
      env: {
        es2022: true,
        node: true
      },
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module'
      },
      rules: {
        'no-console': 'off'
      }
    },
    {
      files: ['**/*.ts', '**/*.tsx'],
      parser: require.resolve('@typescript-eslint/parser', {
        paths: [
          __dirname,
          path.join(__dirname, 'collector'),
          path.join(__dirname, 'packages'),
          path.join(__dirname, 'apps')
        ]
      }),
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        project: false,
        tsconfigRootDir: __dirname
      },
      extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
      plugins: ['@typescript-eslint'],
      env: {
        es2022: true,
        node: true
      },
      rules: {
        '@typescript-eslint/explicit-function-return-type': 'off',
        '@typescript-eslint/no-explicit-any': 'warn',
        '@typescript-eslint/no-unused-vars': [
          'warn',
          {
            argsIgnorePattern: '^_',
            varsIgnorePattern: '^_',
            ignoreRestSiblings: true
          }
        ]
      }
    },
    {
      files: ['apps/splitter-gui/src/renderer.ts', 'apps/splitter-gui/src/renderer/**/*.ts', 'apps/splitter-gui/src/renderer/**/*.tsx'],
      env: {
        browser: true,
        node: false
      }
    },
    {
      files: ['**/*.test.{js,ts}', '**/__tests__/**/*.{js,ts}'],
      env: {
        jest: true
      },
      rules: {
        '@typescript-eslint/no-explicit-any': 'off'
      }
    }
  ]
};
