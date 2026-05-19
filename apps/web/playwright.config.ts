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
    workers: process.env.CI ? 1 : undefined,
    reporter: process.env.CI ? 'github' : 'html',
    // First-hit dashboard routes hit Next.js dev-mode compilation (~10–15s
    // each), and several spec files chain multiple such hits. 30s (Playwright
    // default) leaves no headroom and produces "T" (timeout) bursts across
    // the profile/settings sweep in CI. 90s removes the cold-compile cliff
    // while keeping genuine hangs surfaced reasonably fast.
    timeout: 90_000,

    use: {
        baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3000',
        trace: 'on-first-retry',
        screenshot: 'only-on-failure',
        locale: 'en',
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
                /\/(auth|navigation|password-reset|user-journey|works-public|works-api|api-public-contract|notifications|accessibility|seo-meta|error-pages|website-templates|subscriptions|conversations|git-providers|forms-validation|i18n-locales|i18n-fallback|screenshot-and-deploy|health-meta|performance-budget|responsive-viewports|error-recovery-unauth|keyboard-navigation|print-styles|public-pages-cache|screenshots-visual)\.spec\.ts$/,
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
                /\/(auth|navigation|password-reset|user-journey|works-public|works-api|api-public-contract|notifications|accessibility|seo-meta|error-pages|website-templates|subscriptions|conversations|git-providers|forms-validation|i18n-locales|i18n-fallback|screenshot-and-deploy|health-meta|performance-budget|responsive-viewports|error-recovery-unauth|keyboard-navigation|print-styles|public-pages-cache|screenshots-visual)\.spec\.ts$/,
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
