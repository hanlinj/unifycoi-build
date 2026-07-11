// Phase 13 migration, Stage 5 pre-commit gap-closing: the codebase had NO ESLint setup at all
// before this. Scoped deliberately narrow — just the two rules that catch the highest-risk
// silent bug class in a sync→async conversion (a dropped `await` that used to be a no-op on a
// sync call and is now a silently-ignored Promise): @typescript-eslint/no-floating-promises and
// @typescript-eslint/no-misused-promises. Not a general lint-everything setup; broadening scope
// (style rules, react rules, etc.) is a separate decision for whoever owns that later.
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['node_modules/**', '.next/**', 'db-postgres/**', '**/*.js', '**/*.mjs'],
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
    },
  }
);
