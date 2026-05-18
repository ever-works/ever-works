/** @type {import('jest').Config} */
module.exports = {
    moduleFileExtensions: ['js', 'json', 'ts'],
    rootDir: 'src',
    testRegex: '.*\\.spec\\.ts$',
    transform: {
        '^.+\\.(t|j)s$': [
            'ts-jest',
            {
                diagnostics: {
                    ignoreCodes: [151002],
                },
            },
        ],
    },
    collectCoverageFrom: ['**/*.(t|j)s'],
    coverageDirectory: '../coverage',
    testEnvironment: 'node',
    // Raise the per-test timeout from Jest's 5s default. Some specs that pass
    // locally in <100ms time out at 5000ms on shared GitHub-Actions runners
    // because ts-jest's first-run type-checking + the test's own awaited work
    // race past the budget. 30s is the standard "ts-jest on CI" recommendation
    // and matches what other NestJS+ts-jest monorepos use; truly slow tests
    // still surface, just not via spurious timeouts.
    testTimeout: 30000,
    moduleNameMapper: {
        '^@src/(.*)$': '<rootDir>/$1',
        // Map workspace packages to their source TypeScript files for testing
        '^@ever-works/plugin$': '<rootDir>/../../plugin/src/index.ts',
        // Specific subpath: `@ever-works/plugin/helpers/ssrf-guard` is a single
        // file (not a folder with index), separated from `helpers/index.ts` so
        // its `node:net`/`node:dns` imports stay out of the client bundle.
        // Map BEFORE the catch-all `helpers` rule below so the regex order matters.
        '^@ever-works/plugin/helpers/ssrf-guard$': '<rootDir>/../../plugin/src/helpers/ssrf-guard.ts',
        '^@ever-works/plugin/(.*)$': '<rootDir>/../../plugin/src/$1/index.ts',
        '^@ever-works/contracts$': '<rootDir>/../../contracts/src/index.ts',
        '^@ever-works/contracts/(.*)$': '<rootDir>/../../contracts/src/$1/index.ts',
        // p-map is ESM-only and ts-jest can't load it. Substitute a
        // Promise.all-based stub for all specs (see test/jest-mocks/p-map.ts).
        '^p-map$': '<rootDir>/../test/jest-mocks/p-map.ts',
        // Handle .js extension in ESM-style imports (resolve to .ts)
        '^(\\.{1,2}/.*)\\.js$': '$1',
    },
    // Ignore dist folder and .d.ts files
    testPathIgnorePatterns: ['/node_modules/', '/dist/'],
    modulePathIgnorePatterns: ['<rootDir>/../dist/'],
};
