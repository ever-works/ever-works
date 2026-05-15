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
                    // 2307: cross-package @src path alias not resolved by TS (handled by moduleNameMapper)
                    // 2589: deep type instantiation in zodToJsonSchema chain reachable via @ever-works/agent
                    ignoreCodes: [151002, 2307, 2589],
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
        // `@src/items-generator/...` is an agent-package-internal alias (its own
        // tsconfig maps `@src/*` to `packages/agent/src/*`). When a packages/agent
        // entity that uses this alias is pulled into an apps/api test (via the
        // entity barrel), the API's `@src` → `apps/api/src` mapping below cannot
        // resolve it. Redirect it to the agent source tree explicitly.
        '^@src/items-generator/(.*)$': '<rootDir>/../../../packages/agent/src/items-generator/$1.ts',
        '^@src/(.*)$': '<rootDir>/$1',
        // Map workspace packages to their source TypeScript files for testing
        '^@ever-works/plugin$': '<rootDir>/../../../packages/plugin/src/index.ts',
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
