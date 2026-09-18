import { defineConfig, devices } from '@playwright/test';

/**
 * App Works acceptance-lane configuration (APW-13 P0 task T12,
 * `docs/specs/features/app-works/APW-13-golden-paths/plan.md` §8.1).
 *
 * This is deliberately not part of `playwright.config.ts`. That suite tests *the
 * code at a commit* against a local stack, sharded, in parallel, with retries.
 * The lanes here test *a running installation* — a dev or stage deployment, a
 * kind cluster, or the fake GitHub — one at a time, with **no retries** (a flaky
 * acceptance run is itself the finding) and a per-test budget measured in tens
 * of minutes, because a Cal.diy Build alone is allowed 65 of them.
 *
 * It is also the only config that runs `flow-app-works-live-*` and
 * `flow-app-works-kind-*`: `playwright.config.ts` excludes both prefixes from
 * its two sharded projects, so the PR suite never schedules a 45-minute test.
 *
 * Usage:
 *
 *     # PR lane — deterministic, against the local stack and the fake GitHub
 *     cd apps/web && EVER_WORKS_E2E_FAKES=1 npx playwright test -c playwright.app-works.config.ts flow-app-works-kind-
 *
 *     # Live lane — dev or stage only, gated by the seven interlocks
 *     cd apps/web && APW_E2E_LIVE=1 APW_E2E_RUN_ID=<id> \
 *       npx playwright test -c playwright.app-works.config.ts flow-app-works-live-
 *
 *     # What will run, without running it
 *     cd apps/web && npx playwright test -c playwright.app-works.config.ts --list
 */

/** 45 min per test: the plan's budget for a single golden-path step (plan §8.1). */
const PER_TEST_TIMEOUT_MS = 45 * 60_000;

/**
 * The web origin a lane drives. `APW_E2E_ALLOWED_BASE_URLS` is the *gate*
 * (interlock 1, plan §8.5); this is only where the browser is pointed, and the
 * setup project refuses to start when the two disagree.
 */
const baseURL =
    process.env.APW_E2E_WEB_URL || process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3000';

export default defineConfig({
    testDir: './e2e',
    outputDir: './e2e/test-results/app-works',
    // Only the two acceptance prefixes. Everything else in `e2e/` belongs to the
    // sharded suite (or to the harness's own vitest run), and is not collected.
    testMatch: /flow-app-works-(live|kind)-.*\.spec\.ts$/,
    // Never retry: plan §8.1 sets `retries: 0`, and a flaky live run is the
    // signal, not noise to be absorbed.
    retries: 0,
    // One worker. The plan's one-App-Work-at-a-time guarantee (spec FR-44, S15)
    // is what keeps two scenarios from fighting over the same cluster quota.
    workers: 1,
    fullyParallel: false,
    forbidOnly: true,
    timeout: PER_TEST_TIMEOUT_MS,
    // A live marker probe, a Build status and a Deployment readiness read all
    // poll; the default 5 s expectation timeout is shorter than one poll cycle.
    expect: { timeout: 30_000 },
    reporter: process.env.CI ? [['github'], ['list']] : [['list']],
    use: {
        baseURL,
        // Keep the trace of a failed 45-minute scenario; a passing one is not
        // worth the artifact size.
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
        video: 'off',
        locale: 'en',
        // A lane may run against a stage installation in front of a
        // self-signed or internal certificate. This is a test-only browser
        // context; it never changes what the platform serves.
        ignoreHTTPSErrors: process.env.APW_E2E_ALLOW_INSECURE_TLS === '1',
        // Same per-worker throttle bucket as the sharded suite, so a lane's
        // deliberate burst trips its own bucket rather than someone else's.
        extraHTTPHeaders: { 'x-e2e-throttle-key': 'apw-app-works' },
    },
    projects: [
        {
            // The interlocks, the throwaway account, the GitHub connection
            // assertion and the estate file — all before a scenario runs, so a
            // misconfigured lane fails as a named refusal (S10/S19) instead of
            // as a 400 deep inside the first fork call (plan §8.8).
            name: 'app-works-setup',
            testMatch: /app-works-live\.setup\.ts$/,
        },
        {
            name: 'app-works-live',
            testMatch: /flow-app-works-live-.*\.spec\.ts$/,
            dependencies: ['app-works-setup'],
            use: { ...devices['Desktop Chrome'] },
        },
        {
            // The kind lane needs no GitHub connection — it runs against the
            // fake — so it does not depend on the setup project.
            name: 'app-works-kind',
            testMatch: /flow-app-works-kind-.*\.spec\.ts$/,
            use: { ...devices['Desktop Chrome'] },
        },
    ],
});
