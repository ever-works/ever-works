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
                    // Type-check THIS app's sources only. Sibling workspace packages are
                    // already type-checked by their own `build`/`test`, so re-checking their
                    // source here is redundant - and actively harmful: pulled in through the
                    // `@src` fallback below, `packages/agent` drags the whole entity/zod graph
                    // past TypeScript's instantiation limits, at which point `z.infer` silently
                    // widens fields to `unknown` and rains TS2345/TS2322 on code that is
                    // perfectly correct (and that `zod.parse()` guarantees at runtime). That is
                    // the same bailout already waived as 2589 above. Waiving 2345/2322 globally
                    // instead would hide REAL type errors in apps/api, so scope the diagnostics
                    // rather than widen the ignore list.
                    exclude: ['**/packages/**', '**/node_modules/**'],
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
        // `@src/...` is ambiguous across the monorepo: apps/api AND packages/agent
        // each define it for their own `src`. An api spec that transitively pulls in
        // an agent file hits that file's own `@src/...` import, which this mapper then
        // resolves against apps/api/src and fails the suite before a single test runs:
        //   Configuration error: Could not locate module
        //   @src/database/repositories/plugin-usage.repository
        // Jest accepts an ARRAY of targets and tries them in order, so prefer api's own
        // src and fall back to the agent package. The one-off `@src/generators` and
        // `@src/items-generator` rules above were this same bug patched per-path;
        // packages/agent has 148 `@src/entities/`, 57 `@src/database/` and 41
        // `@src/works-config/` imports, so per-path patching was never going to hold.
        //
        // This matters beyond tidiness: while these suites failed to RUN, no api-side
        // module-compile test could execute at all - which is how the
        // InboundTriggersModule DI regression reached production unnoticed.
        '^@src/(.*)$': ['<rootDir>/$1', '<rootDir>/../../../packages/agent/src/$1'],
        // Map workspace packages to their source TypeScript files for testing
        '^@ever-works/plugin$': '<rootDir>/../../../packages/plugin/src/index.ts',
        // Specific subpath: `@ever-works/plugin/helpers/ssrf-guard` is a single
        // file (not a folder with index), separated from `helpers/index.ts` so
        // its `node:net`/`node:dns` imports stay out of the client bundle.
        // Map BEFORE the catch-all `helpers` rule below so the regex order matters.
        '^@ever-works/plugin/helpers/ssrf-guard$':
            '<rootDir>/../../../packages/plugin/src/helpers/ssrf-guard.ts',
        '^@ever-works/plugin/(.*)$': '<rootDir>/../../../packages/plugin/src/$1/index.ts',
        '^@ever-works/contracts$': '<rootDir>/../../../packages/contracts/src/index.ts',
        '^@ever-works/contracts/(.*)$': '<rootDir>/../../../packages/contracts/src/$1/index.ts',
        '^@ever-works/agent$': '<rootDir>/../../../packages/agent/src/index.ts',
        '^@ever-works/agent/(.*)$': '<rootDir>/../../../packages/agent/src/$1/index.ts',
        '^@ever-works/monitoring$': '<rootDir>/../../../packages/monitoring/src/index.ts',
        // EW-637 — storage plugins source-mapped for tests.
        '^@ever-works/local-fs-plugin$':
            '<rootDir>/../../../packages/plugins/local-fs/src/index.ts',
        '^@ever-works/aws-s3-plugin$': '<rootDir>/../../../packages/plugins/aws-s3/src/index.ts',
        '^@ever-works/minio-plugin$': '<rootDir>/../../../packages/plugins/minio/src/index.ts',
        '^@ever-works/github-storage-plugin$':
            '<rootDir>/../../../packages/plugins/github-storage/src/index.ts',
        // Handle .js extension in ESM-style imports (resolve to .ts)
        '^(\\.{1,2}/.*)\\.js$': '$1',
    },
    // Ignore dist folder and .d.ts files
    testPathIgnorePatterns: ['/node_modules/', '/dist/'],
    modulePathIgnorePatterns: ['<rootDir>/../dist/'],
};
