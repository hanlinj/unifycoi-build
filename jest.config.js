/** @type {import('jest').Config} */
// Two projects so the design-system component tests (jsdom) never disturb the existing
// node-env suite. Node runs tests/**/*.test.ts (762 tests); jsdom runs tests/**/*.test.tsx
// (React Testing Library). The two globs are disjoint (.ts vs .tsx).
const tsTransform = ['ts-jest', {
  tsconfig: { module: 'commonjs', moduleResolution: 'node', jsx: 'react-jsx' },
}];

const common = {
  rootDir: '.',
  moduleNameMapper: { '^@/(.*)$': '<rootDir>/src/$1' },
  setupFiles: ['<rootDir>/tests/setup.ts'],
  transform: { '^.+\\.tsx?$': tsTransform },
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
