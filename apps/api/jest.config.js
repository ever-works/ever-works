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
                    // 151002: ts-jest specific warning
                    // 2305: workspace package declarations may lag source exports (handled by moduleNameMapper)
                    // 2307: cross-package @src path alias not resolved by TS (handled by moduleNameMapper)
                    // 2589: deep type instantiation in zodToJsonSchema chain reachable via @ever-works/agent
                    ignoreCodes: [151002, 2305, 2307, 2589],
                },
            },
        ],
    },
    collectCoverageFrom: ['**/*.(t|j)s'],
    coverageDirectory: '../coverage',
    testEnvironment: 'node',
    // Raise the per-test timeout from Jest's 5s default. ts-jest's first-run
    // type-checking on shared CI runners can push a fast async test past the
    // 5s budget; 30s matches the agent package and is the standard ts-jest
    // recommendation for CI stability.
    testTimeout: 30000,
    moduleNameMapper: {
        '^@src/generators/(.*)$': '<rootDir>/../../../packages/agent/src/generators/$1/index.ts',
        // Items-generator's source lives under @ever-works/agent, but
        // entities import it via the api `@src/...` alias. Map it through
        // so cross-package tests (claim-account.service.spec,
        // deploy.e2e.spec, etc.) can load entities without TS2307.
        '^@src/items-generator/(.*)$': '<rootDir>/../../../packages/agent/src/items-generator/$1',
        '^@src/(.*)$': '<rootDir>/$1',
        // Map workspace packages to their source TypeScript files for testing
        '^@ever-works/plugin$': '<rootDir>/../../../packages/plugin/src/index.ts',
        // Specific subpath: `@ever-works/plugin/helpers/ssrf-guard` is a single
        // file (not a folder with index), separated from `helpers/index.ts` so
        // its `node:net`/`node:dns` imports stay out of the client bundle.
        // Map BEFORE the catch-all `helpers` rule below so the regex order matters.
        '^@ever-works/plugin/helpers/ssrf-guard$': '<rootDir>/../../../packages/plugin/src/helpers/ssrf-guard.ts',
        '^@ever-works/plugin/(.*)$': '<rootDir>/../../../packages/plugin/src/$1/index.ts',
        '^@ever-works/contracts$': '<rootDir>/../../../packages/contracts/src/index.ts',
        '^@ever-works/contracts/(.*)$': '<rootDir>/../../../packages/contracts/src/$1/index.ts',
        '^@ever-works/agent/(.*)$': '<rootDir>/../../../packages/agent/src/$1/index.ts',
        '^@ever-works/agent$': '<rootDir>/../../../packages/agent/src/index.ts',
        '^@ever-works/monitoring$': '<rootDir>/../../../packages/monitoring/src/index.ts',
        // Handle .js extension in ESM-style imports (resolve to .ts)
        '^(\\.{1,2}/.*)\\.js$': '$1',
    },
    // Ignore dist folder and .d.ts files
    testPathIgnorePatterns: ['/node_modules/', '/dist/'],
    modulePathIgnorePatterns: ['<rootDir>/../dist/'],
};
