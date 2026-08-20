import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

/**
 * Flat ESLint config.
 *
 * The `no-restricted-syntax` rules below are a privacy guardrail, not a style
 * preference: they block the console patterns that historically leak PII
 * (Issue #1 section 58). Server code must log through `src/worker/lib/logger.ts`.
 */
const noConsoleInWorker = {
  'no-console': 'error',
  'no-restricted-globals': [
    'error',
    { name: 'console', message: 'Use the allowlisted logger in src/worker/lib/logger.ts.' },
  ],
};

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'coverage/**',
      '.wrangler/**',
      'node_modules/**',
      'worker-configuration.d.ts',
      'api/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // Config files live outside the tsconfig projects.
          allowDefaultProject: ['eslint.config.mjs'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'always'],
      'no-implicit-coercion': 'error',
    },
  },
  {
    files: ['src/worker/**/*.ts'],
    rules: noConsoleInWorker,
  },
  {
    // The logger is the single sanctioned console sink.
    files: ['src/worker/lib/logger.ts'],
    rules: { 'no-console': 'off', 'no-restricted-globals': 'off' },
  },
  {
    files: ['src/web/**/*.{ts,tsx}'],
    languageOptions: {
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
  {
    // Mock adapters satisfy async provider interfaces without awaiting.
    files: ['src/worker/providers/mock/**/*.ts'],
    rules: { '@typescript-eslint/require-await': 'off' },
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
    },
  },
  {
    files: ['*.config.ts', '*.config.mjs', 'eslint.config.mjs'],
    languageOptions: { globals: globals.node },
    rules: { '@typescript-eslint/no-unsafe-assignment': 'off' },
  },
);
