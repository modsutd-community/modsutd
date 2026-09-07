import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

// Flat config, which is the only kind ESLint 9 reads. It replaces .eslintrc.cjs
// and carries the same three rules that file did - the migration is the config
// format, not the standards.
//
// `ignores` in its own object is global. Anywhere else it would only apply to
// the block it sits in, which is the usual way a flat config quietly starts
// linting the build output.
export default tseslint.config(
  { ignores: ['dist', 'playwright-report', 'test-results', 'public/data'] },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // react-hooks 7 turns the React Compiler rules on by default. They are a
      // different standard from rules-of-hooks, not a stricter version of it:
      // set-state-in-effect flags the ordinary "fetch, then setState when it
      // resolves" that loads every panel here, and refs flags assigning a ref
      // during render, which is how a callback prop is kept out of an effect's
      // deps. Twelve sites, each a real refactor, and none of them a bug today.
      //
      // Off for now, and worth adopting deliberately - one rule at a time, with
      // the gate green in between. rules-of-hooks and exhaustive-deps, which
      // this project has always enforced, stay on.
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/use-memo': 'off',
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  // The build scripts are plain node ESM, not browser TypeScript. New coverage:
  // the old --ext ts,tsx never reached them.
  //
  // The relays in ../api are NOT here. ESLint 9 refuses a file above the
  // config's own directory, and moving the config to the repo root to reach six
  // small handlers would drag every path in this file up with it. They are
  // syntax-checked by node and covered by telegram-link.test.js instead.
  {
    files: ['scripts/**/*.mjs'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
);
