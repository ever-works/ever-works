import { defineConfig, devices } from '@playwright/test';

/**
 * EW-641 Phase 1B/d row 19a — Playwright config for the web e2e
 * acceptance suite (`apps/web-e2e`).
 *
 * Lean by design at the bootstrap stage:
 *  - Single browser project (`chromium`) until the KB suite (A12-A17)
 *    is stable. Cross-browser coverage is a v2 concern.
 *  - `baseURL` is env-driven (`PLAYWRIGHT_BASE_URL`) so the same suite
 *    runs against `pnpm dev` locally (`http://localhost:3000`) and a
 *    preview deployment in CI (`https://<branch>.vercel.app`).
 *  - No `webServer` block — the operator is responsible for starting
 *    `pnpm dev` (or the CI runner spins up the platform); the test
 *    runner doesn't fork node processes. Less moving parts at this
 *    stage; row 19b adds an opt-in `webServer` once the suite needs
 *    deterministic startup.
 *  - Retries match the standard pattern (2 in CI, 0 locally) so flake
 *    in shared infra doesn't gate the merge.
 */

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000';

export default defineConfig({
	testDir: './tests',
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
	workers: process.env.CI ? 1 : undefined,
	reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],

	use: {
		baseURL,
		// Capture a trace + screenshot the first time a flake retries, so
		// CI artifacts have something to look at without paying the
		// overhead on every run.
		trace: 'on-first-retry',
		screenshot: 'only-on-failure'
	},

	projects: [
		{
			name: 'chromium',
			use: { ...devices['Desktop Chrome'] }
		}
	]
});
