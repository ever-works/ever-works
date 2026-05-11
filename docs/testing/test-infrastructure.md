---
id: test-infrastructure
title: Test Infrastructure & Fixtures
sidebar_label: Test Infrastructure
sidebar_position: 3
---

# Test Infrastructure & Fixtures

This page covers the shared testing infrastructure, fixture patterns, CI test execution, and debugging strategies used across the Ever Works platform.

## Test Helpers and Factories

### Entity Factories

Tests frequently need mock entities (works, users, plugins). The convention is to define factory functions at the top of test files or in shared helper modules:

```typescript
// Factory for mock items
function makeItem(slug: string, category: string, opts: Partial<ItemData> = {}): ItemData {
	return {
		name: slug.charAt(0).toUpperCase() + slug.slice(1),
		description: `Description of ${slug}`,
		source_url: `https://${slug}.example.com`,
		category,
		slug,
		tags: [],
		...opts
	};
}

// Factory for mock works
function makeWork(overrides: Partial<Work> = {}): Work {
	return {
		id: 'dir-123',
		name: 'Test Work',
		slug: 'test-work',
		description: 'A test work',
		userId: 'user-123',
		gitProvider: 'github',
		getRepoOwner: () => 'test-owner',
		getDataRepo: () => 'test-work-data',
		getMainRepo: () => 'test-work',
		...overrides
	} as Work;
}
```

### Mock Service Patterns

The agent package uses consistent patterns for mocking NestJS services:

```typescript
// Partial mock with only the methods needed
const createMockService = <T>(methods: Partial<Record<keyof T, jest.Mock>>): jest.Mocked<T> =>
	methods as unknown as jest.Mocked<T>;

// Usage
const gitFacade = createMockService<GitFacadeService>({
	cloneOrPull: jest.fn(),
	push: jest.fn()
});
```

## NestJS Testing Module

The `@nestjs/testing` package provides `Test.createTestingModule()` for constructing isolated DI containers:

```typescript
const module: TestingModule = await Test.createTestingModule({
	providers: [
		// The service under test (real implementation)
		MyService,
		// Mocked dependencies
		{ provide: SomeDependency, useValue: mockDependency },
		{ provide: AnotherDependency, useFactory: () => createMock() }
	]
}).compile();

const service = module.get<MyService>(MyService);
```

### Module Init

If the service implements `OnModuleInit`, you may need to trigger it:

```typescript
const module = await Test.createTestingModule({ ... }).compile();
await module.init();  // Triggers OnModuleInit lifecycle hooks
```

## Fixture Data

### Static Fixtures

For tests that require consistent data (YAML configs, markdown content, JSON schemas), place fixture files alongside tests:

```
__tests__/
  fixtures/
    sample-config.yml
    sample-readme.md
  my-service.spec.ts
```

Load fixtures in tests:

```typescript
import { readFileSync } from 'fs';
import { join } from 'path';

const fixture = readFileSync(join(__dirname, 'fixtures', 'sample-readme.md'), 'utf-8');
```

### Dynamic Fixtures

Use factory functions for entities that need unique IDs or timestamps:

```typescript
let counter = 0;
function uniqueItem(category: string): ItemData {
	counter++;
	return makeItem(`item-${counter}`, category);
}
```

## CI Test Execution

### Commands

In CI environments, tests are typically run with:

```bash
pnpm build          # Build all packages first (resolves workspace deps)
pnpm test           # Run all test suites
```

For parallelism, Turborepo can orchestrate per-package test execution:

```bash
turbo test --filter=@ever-works/agent
turbo test --filter=ever-works-api
```

### Environment Requirements

- **Node.js >= 20** is required for all test suites.
- **pnpm** must be used as the package manager.
- No external services (database, Redis) are required for agent unit tests -- all external dependencies are mocked.

### Pre-test Build

Some test suites depend on built workspace packages. The Jest `moduleNameMapper` maps `@ever-works/plugin` and `@ever-works/contracts` to source files, but transitive dependencies may still need compilation:

```bash
turbo build --filter=@ever-works/plugin --filter=@ever-works/contracts
```

## Coverage Reports

### Agent Package Coverage

```bash
cd packages/agent
pnpm test:cov
```

Output:

- **Console** -- summary table showing statement, branch, function, and line coverage.
- **`coverage/`** -- work containing JSON data and an HTML report.

### Plugin Coverage

Each plugin's Vitest config includes coverage via the `v8` provider:

```bash
cd packages/plugins/openai
npx vitest run --coverage
```

## Debugging Tests

### Running a Single Test

```bash
# Agent (Jest) -- match by file path pattern
cd packages/agent
npx jest --testPathPattern='plugin-registry'

# Plugin (Vitest) -- specify exact file
cd packages/plugins/openai
npx vitest run src/openai.spec.ts
```

### Verbose Output

```bash
npx jest --verbose --testPathPattern='facades'
```

### Watch Mode

```bash
cd packages/agent
pnpm test:watch
```

Watch mode re-runs affected tests on file changes and provides an interactive menu for filtering.

### Debugging with Node Inspector

```bash
node --inspect-brk node_modules/.bin/jest --testPathPattern='my-test' --runInBand
```

Then attach your IDE debugger (VS Code, WebStorm) to the Node.js inspector on port 9229.

### Common Failures and Fixes

| Symptom                                   | Cause                                 | Fix                                                     |
| ----------------------------------------- | ------------------------------------- | ------------------------------------------------------- |
| `Cannot find module '@ever-works/plugin'` | Workspace package not built           | Run `pnpm build` from root                              |
| `TypeError: X is not a function`          | Mock missing a method                 | Add the method to your mock object                      |
| Test passes alone but fails in suite      | Shared mutable state                  | Add `afterEach` cleanup or use `jest.restoreAllMocks()` |
| Timeout on async test                     | Missing `await` or unresolved promise | Check all async paths return/resolve                    |
| `ts-jest` diagnostic errors               | TypeScript strict mode conflicts      | Check `diagnostics.ignoreCodes` in jest config          |

## Test Organization Summary

```
packages/agent/src/
  module-name/
    service.ts
    __tests__/
      service.spec.ts        # Co-located tests (Jest)
      fixtures/              # Optional fixture data

packages/plugins/plugin-name/
  src/
    plugin.ts
    plugin.spec.ts           # Vitest tests alongside source
  vitest.config.ts           # Per-plugin Vitest config

apps/api/src/
  module-name/
    controller.ts
    controller.spec.ts       # Jest, alongside source

apps/web/src/
  components/feature/
    Component.tsx
    Component.unit.spec.tsx  # Vitest + Testing Library (jsdom)
  lib/feature/
    helper.ts
    helper.unit.spec.ts      # Vitest

apps/web/e2e/
  feature.spec.ts            # Playwright (real browser, hits dev API + web)
```

## Web app tests (apps/web)

The web app has two completely separate test runners:

- **Vitest** for pure-function helpers, custom hooks, and component
  logic that doesn't need Next.js. Files use the suffix `.unit.spec.ts`
  / `.unit.spec.tsx`. Lives next to the source.
- **Playwright** for end-to-end flows through the real Next.js + API
  stack. Files use the suffix `.spec.ts` and live under `apps/web/e2e/`.

The two suites never collide because their file globs do not overlap
(`vitest.config.ts > include` matches only `*.unit.spec.{ts,tsx}`;
`playwright.config.ts > testDir` is `./e2e/`).

### Running web tests

```bash
# Vitest — fast, no servers needed (jsdom)
cd apps/web
pnpm test                # one-shot
pnpm test:watch          # watch mode
pnpm test:cov            # with coverage

# Playwright — needs API on :3100 and Web on :3000
cd apps/web
pnpm test:e2e            # headless
pnpm test:e2e:ui         # Playwright UI
pnpm test:e2e:headed     # headed
pnpm test:e2e:debug      # step-debug
```

The Vitest setup file at `apps/web/vitest.setup.ts` stubs
`matchMedia`, `IntersectionObserver`, and `ResizeObserver` so components
that touch them on mount can render in jsdom.

### Writing a Vitest unit spec for a React hook

```typescript
import { describe, expect, it } from 'vitest';
import { __test__ } from './useOnboardingFlow';

const { reduce, computeStepList } = __test__;

describe('reduce', () => {
    it('goNext advances and pushes history', () => {
        const next = reduce(/* … */);
        expect(next.stepIndex).toBe(1);
    });
});
```

The `__test__` export is the standard escape hatch we use for reducer /
helper internals — keeps the public hook API clean while letting tests
target the underlying logic without rendering.

### Writing a Vitest unit spec for a React component

```typescript
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChoiceCard } from './ChoiceCard';

it('calls onSelect on click', async () => {
    const onSelect = vi.fn();
    render(<ChoiceCard /* … */ onSelect={onSelect} />);
    await userEvent.click(screen.getByRole('button'));
    expect(onSelect).toHaveBeenCalledTimes(1);
});
```

### Writing a Playwright spec

See `apps/web/e2e/onboarding-wizard-v2.spec.ts` for a current example.
Specs share the `storageState` produced by `global-setup.ts` (an
authenticated test user with onboarding dismissed); to exercise the
fresh-user path, undismiss via `page.request.patch('/api/onboarding/state')`
in a `beforeEach`.

## CI Workflows

| Workflow | File | Triggers | What it runs |
|---|---|---|---|
| Lint, build, unit + integration tests | `.github/workflows/ci.yml` | every push + every PR to `main` / `develop` / `stage` | `pnpm format:check`, `pnpm build`, `pnpm test` (turbo → all workspace `test` scripts: agent Jest, api Jest, every plugin's Vitest, **and now apps/web Vitest**) |
| Playwright e2e | `.github/workflows/e2e.yml` | push to `develop` / `stage` / `main` + manual `workflow_dispatch` | Boots a dev API + Web, then runs every spec under `apps/web/e2e/` |
| k8s plugin e2e | `.github/workflows/k8s-e2e.yml` | manual + PRs touching `packages/plugins/k8s` | k8s-specific provider tests |

The Playwright workflow is deliberately gated to long-lived branches and
manual dispatch because a full run takes ~30 min on `ubicloud-standard-8`.
For PR-time fast feedback, push to a feature branch and use the
**Run workflow** button on the E2E Tests workflow if you need to verify
something before merge.
