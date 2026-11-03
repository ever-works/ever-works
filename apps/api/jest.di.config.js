const base = require('./jest.config');

/**
 * DI-compile lane for apps/api (EW-757).
 *
 * Separate from `jest.config.js` because it answers a different question and
 * has a different cost profile. `*.di.spec.ts` files ask Nest to BUILD THE
 * CONTAINER — the one check that fails when a provider is injected but never
 * provided, which is the defect class that takes the API process down while
 * every other suite stays green (SeatsService / AgentRepository, PR #2233).
 *
 * Three deliberate differences from the main lane, each of which was measured
 * rather than assumed:
 *
 * 1. `isolatedModules` + `diagnostics: false`. Type-checking is NOT this
 *    lane's job — `pnpm build`, `pnpm --filter ever-works-api type-check` and
 *    the main jest lane all still type-check apps/api exactly as before. The
 *    saving is not cosmetic: compiling ApiModule under the main lane's
 *    language-service transform took 6m41s to reach its FIRST error, and the
 *    ticket's earlier probes recorded 172s and 250s. Transpile-only brings the
 *    whole compile into the seconds range, which is what makes a per-PR gate
 *    viable at all.
 * 2. `module: CommonJS` (the app tsconfig says `NodeNext`). Under
 *    `transpileModule` TypeScript has no program to consult, so with NodeNext
 *    it infers each file's format from the filename alone and emits raw ESM
 *    for workspace sources — `export * from './item/index.js'` reaches Jest's
 *    CJS runtime and throws `SyntaxError: Unexpected token 'export'`. Pinning
 *    CommonJS here restores the emit the main lane already gets from its
 *    program. Nothing about the app's own build changes.
 * 3. A package-aware resolver for `@src/*` plus stubs for the two ESM-only
 *    leaf libraries in the graph. See `test/src-alias-resolver.js` and
 *    `test/jest-mocks/README.md` for why neither can mask a DI failure.
 *
 * Run it with `pnpm --filter ever-works-api test:di`. CI runs it as its own
 * step in `lint-and-test` so a red DI gate is legible on its own.
 *
 * @type {import('jest').Config}
 */
const moduleNameMapper = { ...base.moduleNameMapper };

// Hand `@src/...` to the resolver instead: a text-only mapper cannot tell
// which package asked, and both apps/api and packages/agent define the alias.
for (const key of Object.keys(moduleNameMapper)) {
    if (key.startsWith('^@src')) delete moduleNameMapper[key];
}

module.exports = {
    ...base,
    // Only the compile specs. They are excluded from the main lane
    // (`jest.config.js` -> testPathIgnorePatterns) so they run once, here.
    testRegex: '.*\\.di\\.spec\\.ts$',
    testPathIgnorePatterns: ['/node_modules/', '/dist/'],
    resolver: '<rootDir>/../test/src-alias-resolver.js',
    transform: {
        '^.+\\.(t|j)s$': [
            'ts-jest',
            {
                diagnostics: false,
                tsconfig: {
                    isolatedModules: true,
                    module: 'CommonJS',
                    moduleResolution: 'Node',
                },
            },
        ],
    },
    moduleNameMapper: {
        ...moduleNameMapper,
        // Real Nest modules reached from ApiModule that are NOT stubbed:
        // mapped to SOURCE so this lane exercises their real wiring and does
        // not depend on a prior `pnpm build` having produced their `dist`.
        '^@ever-works/trigger-tasks$': '<rootDir>/../../../packages/tasks/src/index.ts',
        // ESM-only leaf utilities reached through the agent barrels. Neither
        // exports a Nest provider, so substituting them cannot hide an
        // unresolvable dependency — see test/jest-mocks/README.md.
        '^p-map$': '<rootDir>/../../../packages/agent/test/jest-mocks/p-map.ts',
        '^github-slugger$': '<rootDir>/../test/jest-mocks/github-slugger.ts',
        // Order matters: the subpath rule must precede the bare-specifier one.
        '^better-auth/plugins$': '<rootDir>/../test/jest-mocks/better-auth-plugins.ts',
        '^better-auth$': '<rootDir>/../test/jest-mocks/better-auth.ts',
    },
};
