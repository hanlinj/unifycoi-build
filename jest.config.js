/** @type {import('jest').Config} */
// Two projects so the design-system component tests (jsdom) never disturb the existing
// node-env suite. Node runs tests/**/*.test.ts (762 tests); jsdom runs tests/**/*.test.tsx
// (React Testing Library). The two globs are disjoint (.ts vs .tsx).
const tsTransform = ['ts-jest', {
  tsconfig: { module: 'commonjs', moduleResolution: 'node', jsx: 'react-jsx' },
}];
// kysely (Phase 13 migration) ships ESM-only ("type": "module", no CJS build) — its dist
// files are plain .js, so the ts-jest transform needs allowJs to compile them to CJS too.
const tsTransformAllowJs = ['ts-jest', {
  tsconfig: { module: 'commonjs', moduleResolution: 'node', jsx: 'react-jsx', allowJs: true },
}];

const common = {
  rootDir: '.',
  moduleNameMapper: { '^@/(.*)$': '<rootDir>/src/$1' },
  setupFiles: ['<rootDir>/tests/setup.ts'],
  transform: {
    'node_modules/kysely/.+\\.js$': tsTransformAllowJs,
    '^.+\\.tsx?$': tsTransform,
  },
  // jest's default ignores all of node_modules — this carves out just kysely so the line
  // above actually gets a chance to run on it. Purely additive: every other node_modules
  // package stays ignored as before.
  transformIgnorePatterns: ['/node_modules/(?!(kysely)/)'],
};

module.exports = {
  projects: [
    {
      ...common,
      displayName: 'node',
      preset: 'ts-jest',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/tests/**/*.test.ts'],
    },
    {
      ...common,
      displayName: 'jsdom',
      preset: 'ts-jest',
      testEnvironment: 'jsdom',
      testMatch: ['<rootDir>/tests/**/*.test.tsx'],
      setupFilesAfterEnv: ['<rootDir>/tests/setup-jsdom.ts'],
    },
  ],
};
