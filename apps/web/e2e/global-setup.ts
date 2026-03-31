import { test as setup, expect } from '@playwright/test';
import { TEST_USER } from './helpers/test-user';
import { registerViaAPI } from './helpers/auth';

const authFile = 'e2e/.auth/user.json';

/**
 * Global setup: create a test user and save authenticated browser state.
 *
 * Authenticated tests reuse this state so they don't need to log in individually.
 */
setup('authenticate', async ({ page, baseURL }) => {
	// 1. Register the user via API (fast)
	try {
		await registerViaAPI(baseURL!, TEST_USER);
	} catch {
		// User may already exist from a previous run — try logging in instead
	}

	// 2. Log in via the UI so cookies are properly set by the Next.js server
	await page.goto('/en/login');

	await page.locator('input[name="email"]').fill(TEST_USER.email);
	await page.locator('input[name="password"]').fill(TEST_USER.password);
	await page.locator('button[type="submit"]').click();

	// Wait for successful redirect to dashboard
	await page.waitForURL(/\/(en\/)?(directories|$)/, { timeout: 15_000 });

	// Verify we're authenticated
	await expect(page).not.toHaveURL(/\/login/);

	// 3. Save the browser state (cookies, localStorage)
	await page.context().storageState({ path: authFile });
});
