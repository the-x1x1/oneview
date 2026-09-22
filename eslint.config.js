// @ts-check
/**
 * Flat config for ESLint 9.
 *
 * There was no ESLint configuration in this repository at all until now. `eslint` and a
 * `pnpm lint` script had both been present from the start, and the CI matrix listed a
 * lint job — but the job could never run, because every job died at
 * `pnpm install --frozen-lockfile` (there was no committed lockfile). The first time CI
 * got far enough to try, lint exited 2 with "couldn't find an eslint.config.js file".
 *
 * This is deliberately a floor rather than a ceiling. The rules below are ones a
 * violation of is a real defect, not a style opinion — style is Prettier's job, and this
 * config turns off nothing Prettier would fight over because it enables no stylistic
 * rules in the first place. Tightening toward the full recommended sets is worth doing;
 * doing it in the same change that introduces the config would have meant a rule sweep
 * across ~470 files with no way to tell a genuine finding from a formatting preference.
 */
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    // Build output, caches, vendored declarations and recorded fixtures.
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/out/**',
      'apps/desktop/release/**',
      'apps/desktop/.vite-public/**',
      'apps/desktop/.electron-builder-cache/**',
      'artifacts/**',
      'coverage/**',
      'fixtures/**',
      // Hand-written stand-ins for libraries that cannot be installed in every
      // environment; they are declarations, and their shape is dictated by the real
      // packages rather than by this repository.
      'tools/dev/type-shims/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // TypeScript already proves these, and the base rules produce false positives on
      // type-only constructs and on ambient/global declarations.
      'no-undef': 'off',
      'no-unused-vars': 'off',

      // Unused code is worth catching; the leading-underscore convention is how this
      // codebase marks a parameter it must accept and deliberately ignores.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],

      // `catch {}` is used throughout, always with a comment saying why the failure is
      // not actionable. An empty block elsewhere is still a mistake.
      'no-empty': ['error', { allowEmptyCatch: true }],

      // `any` appears at the boundaries where this code adapts untyped third-party
      // surfaces, and every one of those is funnelled through a named adapter. Making it
      // an error here would flag the adapters and nothing else.
      '@typescript-eslint/no-explicit-any': 'warn',

      // Real defects.
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': ['error', { destructuring: 'all' }],
      'no-debugger': 'error',
      'no-console': 'off', // CLIs and the main process log to stdout by design.
    },
  },
  {
    // The renderer carries `eslint-disable-next-line react-hooks/exhaustive-deps` in
    // three places. Without the plugin those comments name a rule that does not exist,
    // which ESLint reports as an error in its own right — and, worse, the rule they were
    // written to suppress was never actually running.
    files: ['**/*.tsx', '**/*.ts'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    // Tests construct partial doubles on purpose.
    files: ['**/*.test.ts', '**/*.test.tsx', '**/testing/**'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
);
