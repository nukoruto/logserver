const path = require('path');

const moduleResolutionPaths = [
  __dirname,
  path.join(__dirname, 'collector'),
  path.join(__dirname, 'packages'),
  path.join(__dirname, 'apps')
];

const resolveModule = (specifier) =>
  require(require.resolve(specifier, { paths: moduleResolutionPaths }));

const js = resolveModule('@eslint/js');
const globals = resolveModule('globals');
const tsParser = resolveModule('@typescript-eslint/parser');
const tsPlugin = resolveModule('@typescript-eslint/eslint-plugin');

const ignorePatterns = [
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
];

const jsConfig = {
  files: ['**/*.js', '**/*.cjs', '**/*.mjs'],
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    globals: {
      ...globals.es2022,
      ...globals.node
    }
  },
  rules: {
    ...js.configs.recommended.rules,
    'no-console': 'off'
  }
};

const tsConfig = {
  files: ['**/*.ts', '**/*.tsx'],
  languageOptions: {
    parser: tsParser,
    parserOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      project: null,
      tsconfigRootDir: __dirname
    },
    globals: {
      ...globals.es2022,
      ...globals.node
    }
  },
  plugins: {
    '@typescript-eslint': tsPlugin
  },
  rules: {
    ...tsPlugin.configs.recommended.rules,
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
};

const rendererBrowserConfig = {
  files: [
    'apps/splitter-gui/src/renderer.ts',
    'apps/splitter-gui/src/renderer/**/*.ts',
    'apps/splitter-gui/src/renderer/**/*.tsx'
  ],
  languageOptions: {
    globals: {
      ...globals.browser
    }
  }
};

const testConfig = {
  files: [
    '**/*.test.js',
    '**/*.test.ts',
    '**/*.test.tsx',
    '**/__tests__/**/*.js',
    '**/__tests__/**/*.ts',
    '**/__tests__/**/*.tsx'
  ],
  languageOptions: {
    globals: {
      ...globals.node,
      ...globals.jest
    }
  },
  rules: {
    '@typescript-eslint/no-explicit-any': 'off'
  }
};

module.exports = [
  {
    ignores: ignorePatterns
  },
  jsConfig,
  tsConfig,
  rendererBrowserConfig,
  testConfig
];
