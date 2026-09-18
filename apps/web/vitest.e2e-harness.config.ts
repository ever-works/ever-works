import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration for the App Works acceptance harness **itself**
 * (APW-13 golden paths, P0 task T4).
 *
 * Why a second config exists at all: `vitest.config.ts` includes only
 * `src/**\/*.unit.spec.{ts,tsx}` (plan §11, `APW-13-golden-paths/plan.md`),
 * and that run must not be widened — the harness lives under `e2e/`, which the
 * web unit suite deliberately does not own. The two suites therefore share a
 * runner but never a file set.
 *
 * Scope of this run:
 *   - `e2e/helpers/__tests__/**\/*.unit.spec.ts` — the harness helpers
 *     (`app-works`, `app-works-poll`, `app-works-live`, `github-estate`,
 *     `k8s-assert`, `canary-sink`, `app-works-evidence`).
 *   - `e2e/fakes/**\/__tests__/*.unit.spec.ts` — the fake GitHub server and
 *     its recorded-fixture contract test.
 *
 * `environment: 'node'` because every file above drives a Node HTTP server, a
 * `kubectl` subprocess stub or a fetch stub — none of them touch the DOM, and
 * the jsdom setup file in `vitest.setup.ts` (jest-dom matchers, matchMedia
 * stubs) would only add a React/jsdom dependency this suite does not have.
 *
 * Run it with: `pnpm --filter ever-works-web test:e2e-harness [nameFilter]`
 * (`vitest run -c vitest.e2e-harness.config.ts`). The `[nameFilter]` argument
 * is a positional test-name filter, which is how the P0 tasks invoke it —
 * e.g. `test:e2e-harness app-works-poll`.
 */
export default defineConfig({
    test: {
        // Mirrors `vitest.config.ts`: the fake's git round-trip shells out to
        // `git`, which is slower than a typical unit test under the concurrent
        // turbo load the repository already budgets 30s for.
        testTimeout: 30000,
        hookTimeout: 30000,
        environment: 'node',
        globals: true,
        include: [
            'e2e/helpers/__tests__/**/*.unit.spec.ts',
            'e2e/fakes/**/__tests__/*.unit.spec.ts',
        ],
    },
});
