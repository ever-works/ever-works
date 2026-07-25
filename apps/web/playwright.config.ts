import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright E2E test configuration for Ever Works web app.
 *
 * Expects:
 *  - API running on http://localhost:3100 (pnpm dev:api)
 *  - Web running on http://localhost:3000 (pnpm dev:web)
 *
 * Or use `webServer` below to auto-start them.
 */
export default defineConfig({
    testDir: './e2e',
    outputDir: './e2e/test-results',
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 2 : 0,
    // Intra-shard parallelism. The full suite is ~1670 tests / 90 min on
    // 1 worker; the e2e workflow shards across the GitHub matrix
    // (see .github/workflows/e2e.yml — each shard owns its own API +
    // in-memory sqlite, so cross-shard state isolation is perfect).
    // Within a shard, tests share one DB / one logged-in storageState,
    // so workers > 1 must be set carefully. PLAYWRIGHT_WORKERS lets a
    // shard opt into parallel workers (the workflow defaults to 1 →
    // safe baseline; bump per-shard once we audit shared-state specs).
    workers: process.env.PLAYWRIGHT_WORKERS
        ? Number(process.env.PLAYWRIGHT_WORKERS)
        : process.env.CI
          ? 1
          : undefined,
    reporter: process.env.CI ? 'github' : 'html',
    // First-hit dashboard routes hit Next.js dev-mode compilation (~10–15s
    // each), and several spec files chain multiple such hits. 30s (Playwright
    // default) leaves no headroom and produces "T" (timeout) bursts across
    // the profile/settings sweep in CI. 90s removes the cold-compile cliff
    // while keeping genuine hangs surfaced reasonably fast.
    //
    // CI gets more: each shard runs ONE API against an in-memory sqlite for the
    // shard's whole lifetime, so the DB accumulates rows as the shard proceeds
    // and later tests see progressively slower queries. As the suite grows, the
    // heaviest data-backed UI specs drift past 90s late in a shard and fail with
    // a timeout whose visible symptom is downstream noise ("Request context
    // disposed", "frame was detached") rather than the real cause. 150s absorbs
    // that drift; a genuine hang still surfaces well inside the job budget.
    timeout: process.env.CI ? 150_000 : 90_000,

    use: {
        baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3000',
        trace: 'on-first-retry',
        screenshot: 'only-on-failure',
        locale: 'en',
        // Per-worker throttle bucket: the whole shard runs from one machine IP,
        // so platform-bearer per-IP throttles (activity-log ingest, etc.) get
        // saturated by CROSS-worker load. A stable per-worker key lets the API's
        // UserAwareThrottlerGuard isolate each worker (non-prod only), while a
        // single worker's intentional burst still trips its own bucket. Stamped
        // on every request the suite makes (config is loaded per worker process,
        // so TEST_WORKER_INDEX resolves to this worker's index).
        extraHTTPHeaders: {
            'x-e2e-throttle-key': `w${process.env.TEST_WORKER_INDEX ?? '0'}`,
        },
    },

    projects: [
        // Setup project: creates authenticated state used by other tests
        {
            name: 'setup',
            testMatch: /global-setup\.ts/,
        },
        {
            name: 'chromium',
            // The unauth-specific tests must NOT run with stored auth state —
            // they assert things like "/works redirects to login" which is
            // only true when the user is signed out.
            testIgnore:
                /\/(auth|navigation|password-reset|user-journey|works-public|works-api|api-public-contract|notifications|accessibility|seo-meta|error-pages|error-page-contract|website-templates|subscriptions|conversations|git-providers|forms-validation|i18n-locales|i18n-fallback|internationalization-rtl|screenshot-and-deploy|health-meta|performance-budget|responsive-viewports|error-recovery-unauth|keyboard-navigation|print-styles|public-pages-cache|screenshots-visual|chat-api|chat-api-streaming|chat-api-events|csp-strict|web-vitals|pwa-offline|accessibility-axe-deep|sentry-error-reporting|mobile-touch|webrtc-permissions|bundle-size-budget|service-worker-update|polyfill-presence|xss-html-encoding|device-fingerprinting-opt-out|redirect-prevention|tls-version-header|referrer-policy-redirects|static-asset-fingerprint|feature-detect-storage|feature-detect-cookies-blocked|feature-detect-fetch-throws|geo-redirect-respect-pref|password-paste-allowed|iframe-sandbox|magic-link-ui)\.spec\.ts$/,
            use: {
                ...devices['Desktop Chrome'],
                storageState: './e2e/.auth/user.json',
            },
            dependencies: ['setup'],
        },
        // Unauthenticated tests (no storageState dependency)
        {
            name: 'chromium-no-auth',
            testMatch:
                /\/(auth|navigation|password-reset|user-journey|works-public|works-api|api-public-contract|notifications|accessibility|seo-meta|error-pages|error-page-contract|website-templates|subscriptions|conversations|git-providers|forms-validation|i18n-locales|i18n-fallback|internationalization-rtl|screenshot-and-deploy|health-meta|performance-budget|responsive-viewports|error-recovery-unauth|keyboard-navigation|print-styles|public-pages-cache|screenshots-visual|chat-api|chat-api-streaming|chat-api-events|csp-strict|web-vitals|pwa-offline|accessibility-axe-deep|sentry-error-reporting|mobile-touch|webrtc-permissions|bundle-size-budget|service-worker-update|polyfill-presence|xss-html-encoding|device-fingerprinting-opt-out|redirect-prevention|tls-version-header|referrer-policy-redirects|static-asset-fingerprint|feature-detect-storage|feature-detect-cookies-blocked|feature-detect-fetch-throws|geo-redirect-respect-pref|password-paste-allowed|iframe-sandbox|magic-link-ui)\.spec\.ts$/,
            use: {
                ...devices['Desktop Chrome'],
            },
        },
    ],

    /* Optionally auto-start dev servers. Uncomment if you want Playwright to manage them. */
    // webServer: [
    // 	{
    // 		command: 'pnpm dev:api',
    // 		url: 'http://localhost:3100/api',
    // 		reuseExistingServer: !process.env.CI,
    // 		cwd: '../..',
    // 		timeout: 30_000,
    // 	},
    // 	{
    // 		command: 'pnpm dev:web',
    // 		url: 'http://localhost:3000',
    // 		reuseExistingServer: !process.env.CI,
    // 		cwd: '../..',
    // 		timeout: 30_000,
    // 	},
    // ],
});
