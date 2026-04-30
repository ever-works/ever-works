---
id: overview
title: Testing Strategy & Setup
sidebar_label: Overview
sidebar_position: 1
---

# Testing Strategy & Setup

Ever Works uses a dual testing framework approach: **Jest** for the core agent package and API, and **Vitest** for plugin packages. This division reflects the different build tooling -- the agent and API use NestJS with SWC (Jest-compatible), while plugins are standalone ESM packages built with tsup (Vitest-compatible).

## Test Suite Overview

| Package | Framework | Suites | Tests | Config |
|---|---|---|---|---|
| `@ever-works/agent` | Jest + ts-jest | ~26 | ~719 | `packages/agent/jest.config.js` |
| `apps/api` | Jest | varies | varies | `apps/api/jest.config.js` |
| Each plugin (`packages/plugins/*`) | Vitest | 1-3 per plugin | varies | `vitest.config.ts` per plugin |
| `@ever-works/plugin` | Vitest | varies | varies | `packages/plugin/vitest.config.ts` |

## Running Tests

### All Tests

```bash
pnpm test                  # Run all tests across the monorepo
```

### Agent Package (Jest)

```bash
cd packages/agent

pnpm test                  # All agent tests
pnpm test:watch            # Watch mode for TDD
pnpm test:cov              # Run with coverage reporting

# Single test file or pattern
npx jest --testPathPattern='generators'
npx jest --testPathPattern='plugin-registry'
```

### Plugin Packages (Vitest)

```bash
cd packages/plugins/openai

pnpm test                  # All tests for a single plugin
npx vitest run src/openai.spec.ts   # Single file
```

### API Tests (Jest)

```bash
cd apps/api
pnpm test
```

## Jest Configuration (Agent)

The agent Jest config in `packages/agent/jest.config.js` has several important settings:

```javascript
module.exports = {
    moduleFileExtensions: ['js', 'json', 'ts'],
    rootDir: 'src',
    testRegex: '.*\\.spec\\.ts$',
    transform: {
        '^.+\\.(t|j)s$': ['ts-jest', {
            diagnostics: { ignoreCodes: [151002] },
        }],
    },
    testEnvironment: 'node',
    moduleNameMapper: {
        '^@src/(.*)$': '<rootDir>/$1',
        '^@ever-works/plugin$': '<rootDir>/../../plugin/src/index.ts',
        '^@ever-works/plugin/(.*)$': '<rootDir>/../../plugin/src/$1/index.ts',
        '^@ever-works/contracts$': '<rootDir>/../../contracts/src/index.ts',
        '^@ever-works/contracts/(.*)$': '<rootDir>/../../contracts/src/$1/index.ts',
        '^(\\.{1,2}/.*)\\.js$': '$1',
    },
};
```

Key points:

- **`moduleNameMapper`** resolves workspace packages (`@ever-works/plugin`, `@ever-works/contracts`) directly to their TypeScript source files. This avoids needing to build those packages before running tests.
- The `.js` extension mapper handles ESM-style imports that reference `.js` but resolve to `.ts` source.
- `ts-jest` is used for TypeScript transformation with diagnostic code `151002` suppressed (related to isolated module warnings).
- Test files must match the `*.spec.ts` pattern.

## Vitest Configuration (Plugins)

Each plugin has a `vitest.config.ts`:

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        globals: true,
        include: ['src/**/*.{test,spec}.ts'],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json', 'html'],
        },
    },
});
```

Vitest provides faster execution for the smaller, self-contained plugin packages and supports ESM natively.

## Test Philosophy

The testing approach prioritizes:

1. **Unit tests for business logic** -- Services, selectors, and utility functions are tested in isolation with mocked dependencies.
2. **NestJS Testing Module** -- Services that rely on dependency injection use `@nestjs/testing` to create properly wired test modules.
3. **Mocked external services** -- Git operations, AI calls, and database queries are mocked at the facade/repository boundary.
4. **Pure function tests** -- Algorithms like pair selection, slug generation, and data transformation are tested as pure functions without any framework scaffolding.

## Build Before Test

Some packages require workspace dependencies to be built before tests can run. If you encounter resolution errors:

```bash
pnpm build          # Build all packages from root
pnpm test           # Then run tests
```

The `moduleNameMapper` in Jest resolves most workspace imports to source, but transitive dependencies may still require builds.

## Coverage

Generate coverage reports for the agent package:

```bash
cd packages/agent
pnpm test:cov
```

Coverage output goes to `packages/agent/coverage/` and includes:

- `text` -- console summary
- `json` -- machine-readable data
- `html` -- browsable HTML report

Coverage collection is configured to include all `.ts` and `.js` files under `src/`.
