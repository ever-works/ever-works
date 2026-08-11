import { defineConfig, devices } from '@playwright/test';

/**
 * Post-deploy smoke suite — runs against a REAL deployed environment.
 *
 * This is deliberately not part of `playwright.config.ts`. That suite starts a
 * local API and Next.js server and tests *the code at a commit*. This one tests
 * *a running deployment*, which is a different question: it is the only place
 * config drift shows up — ingress rules, env vars, the `/api` prefix, a service
 * that came back unhealthy after a rollout.
 *
 * It exists because on 2026-08-09 a deploy went out where every health check was
 * green, `/api/version` reported the new SHA, and registration was nonetheless
 * impossible: the API served `/terms/required` while the web asked for
 * `/api/terms/required`, so the signup form rendered with a disabled checkbox.
 * Nothing that ran against a local stack could have seen it, because locally
 * both halves were built from the same config.
 *
 * Usage:
 *   SMOKE_BASE_URL=https://appstage.ever.works \
 *   SMOKE_API_URL=https://apistage.ever.works \
 *   npx playwright test -c playwright.smoke.config.ts
 *
 * Writes: one throwaway account per run against the target environment's
 * database (approved for stage). Nothing else mutates state.
 */
const baseURL = process.env.SMOKE_BASE_URL || 'http://localhost:3000';

export default defineConfig({
    testDir: './e2e-smoke',
    // A smoke suite that takes longer than a rollout is not a smoke suite.
    timeout: 90_000,
    expect: { timeout: 20_000 },
    // Never retry into a false green: a flaky smoke run against production is
    // itself the signal. One retry absorbs a pod mid-rollout, no more.
    retries: 1,
    workers: 2,
    fullyParallel: true,
    forbidOnly: true,
    reporter: process.env.CI ? [['github'], ['list']] : [['list']],
    use: {
        baseURL,
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
        locale: 'en',
        ignoreHTTPSErrors: false,
        // Some edges (Cloudflare) treat default automation agents differently
        // from browsers; keep the request shape boring.
        userAgent:
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 ever-works-smoke',
    },
    projects: [{ name: 'smoke', use: { ...devices['Desktop Chrome'] } }],
});
