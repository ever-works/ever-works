import { test, expect } from '@playwright/test';

/**
 * Accept-Language tolerance on public pages — when a browser sends a
 * locale that the platform doesn't ship, the page must still render
 * (fallback locale) and never 5xx. Combined with the en-locale
 * default, this is a common source of subtle middleware regressions.
 */

const UNSUPPORTED_OR_EDGE_LOCALES = [
	'xx',
	'qq-QQ',
	'klingon',
	'',
	'*',
	'en;q=0',
	'en;q=invalid',
	'fr-CA, en;q=0.9, de;q=0.8',
	'zz, ',
	'en-US, en;q=0.9, fr;q=0.8, de;q=0.7, it;q=0.6, pt;q=0.5, ru;q=0.4',
];

test.describe('Accept-Language tolerance', () => {
	for (const lang of UNSUPPORTED_OR_EDGE_LOCALES) {
		test(`home page renders with Accept-Language="${lang}"`, async ({ browser }) => {
			const context = await browser.newContext({
				locale: 'en-US',
				extraHTTPHeaders: { 'Accept-Language': lang },
			});
			const page = await context.newPage();
			try {
				const response = await page.goto('/', { waitUntil: 'domcontentloaded' });
				expect(response, `lang=${lang}`).not.toBeNull();
				expect(response!.status(), `status for lang=${lang}`).toBeLessThan(500);
				await expect(page.locator('body')).toBeVisible();
			} finally {
				await context.close();
			}
		});
	}
});
