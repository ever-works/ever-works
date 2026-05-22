import { expect, test } from '@playwright/test';

/**
 * EW-641 Phase 1B/d row 19a — smoke test that proves the Playwright
 * harness wires up before the actual KB acceptance suite (A12-A17,
 * rows 19-24) lands.
 *
 * Deliberately **does not** hit `baseURL` — at the bootstrap stage we
 * don't yet have a deterministic way to spin up the platform in CI,
 * so this stays a pure-harness smoke. Row 19b adds the `webServer`
 * block + a real /-route navigation once we wire up the CI workflow.
 *
 * Why have it at all: `playwright test` exits 0 with no tests, which
 * would silently let a broken config land. One always-green test
 * gives CI a concrete signal that the spec file resolves, the
 * `@playwright/test` API is wired, and the chromium project actually
 * runs.
 */
test.describe('web-e2e harness', () => {
	test('smoke: playwright config + tsconfig resolve and the spec runs', () => {
		// Project name confirms `playwright.config.ts` was picked up.
		expect(test.info().project.name).toBe('chromium');
		// `baseURL` defaults to the dev port when env is unset; otherwise
		// it's whatever `PLAYWRIGHT_BASE_URL` was set to.
		const baseURL = test.info().project.use.baseURL;
		expect(typeof baseURL).toBe('string');
		expect(baseURL).toMatch(/^https?:\/\//);
	});
});
