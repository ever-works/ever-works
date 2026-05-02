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
                    ignoreCodes: [151002, 2307],
                },
            },
        ],
    },
    collectCoverageFrom: ['**/*.(t|j)s'],
    coverageWork: '../coverage',
    testEnvironment: 'node',
    moduleNameMapper: {
        '^@src/generators/(.*)$': '<rootDir>/../../../packages/agent/src/generators/$1/index.ts',
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
