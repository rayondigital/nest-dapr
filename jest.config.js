module.exports = {
  verbose: false,
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: 'tests',
  testEnvironment: 'node',
  testRegex: '.spec.ts$',
  bail: 1,
  maxWorkers: 1,
  testTimeout: 30000,
  transform: {
    '^.+\\.(t|j)s$': [
      'ts-jest',
      {
        tsconfig: 'tests/tsconfig.test.json',
        isolatedModules: true,
        diagnostics: false,
      },
    ],
  },
  // node-fetch v3+ is pure ESM with no CJS build - must be transformed.
  // (transforming them causes thousands of allowJs warnings and is wasteful).
  transformIgnorePatterns: ['/node_modules/(?!(node-fetch|@js-temporal|@bufbuild|@connectrpc)/)'],
};
