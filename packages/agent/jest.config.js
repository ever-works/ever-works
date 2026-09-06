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
                    // `@ever-works/agent-plugins` is mapped to SOURCE below, so
                    // without this ts-jest type-checks that library using THIS
                    // package's compiler options — and this package sets
                    // `strictNullChecks: false`, under which the library's
                    // discriminated result unions (`{ok: true, ...} | {ok: false, ...}`)
                    // stop narrowing and every consumer of one fails to compile.
                    // The library is strictly type-checked and tested in its own
                    // package, which is the right place for it; re-checking it
                    // here under weaker settings only produces false failures.
                    exclude: ['**/agent-plugins/src/**'],
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
        '^@ever-works/plugin/helpers/ssrf-guard$':
            '<rootDir>/../../plugin/src/helpers/ssrf-guard.ts',
        '^@ever-works/plugin/(.*)$': '<rootDir>/../../plugin/src/$1/index.ts',
        // Resolve the conformance library to SOURCE, exactly as the two
        // siblings below do. Without this a spec importing it would load
        // `dist/`, which only exists after a build — so the suite would
        // pass or fail depending on whether someone had run one.
        '^@ever-works/agent-plugins$': '<rootDir>/../../agent-plugins/src/index.ts',
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
