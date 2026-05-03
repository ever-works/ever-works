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
    coverageWork: '../coverage',
    testEnvironment: 'node',
    moduleNameMapper: {
        '^@src/(.*)$': '<rootDir>/$1',
        // Map workspace packages to their source TypeScript files for testing
        '^@ever-works/plugin$': '<rootDir>/../../plugin/src/index.ts',
        '^@ever-works/plugin/(.*)$': '<rootDir>/../../plugin/src/$1/index.ts',
        '^@ever-works/contracts$': '<rootDir>/../../contracts/src/index.ts',
        '^@ever-works/contracts/(.*)$': '<rootDir>/../../contracts/src/$1/index.ts',
        // Handle .js extension in ESM-style imports (resolve to .ts)
        '^(\\.{1,2}/.*)\\.js$': '$1',
    },
    // Ignore dist folder and .d.ts files
    testPathIgnorePatterns: ['/node_modules/', '/dist/'],
    modulePathIgnorePatterns: ['<rootDir>/../dist/'],
};
