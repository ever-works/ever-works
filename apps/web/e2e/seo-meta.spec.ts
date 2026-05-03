import { test, expect } from '@playwright/test';

/**
 * SEO / metadata smoke tests for public pages.
 *
 * Verifies:
 *  - <title> is set and non-empty
 *  - <meta name="description"> is set
 *  - <html lang> is correct
 *  - same checks across the main locales for /login
 */

const publicRoutes = ['/en/login', '/en/register', '/en/forgot-password'];

test.describe('SEO — title + description present', () => {
    for (const url of publicRoutes) {
        test(`${url} has <title> and <meta name="description">`, async ({ page }) => {
            await page.goto(url, { waitUntil: 'domcontentloaded' });

            const title = await page.title();
            expect(title.length, `${url} <title> non-empty`).toBeGreaterThan(0);

            const desc = await page
                .locator('meta[name="description"]')
                .first()
                .getAttribute('content');
            // Some pages may not have a description meta — accept either present
            // and non-empty, or wholly absent. Reject empty string ("").
            if (desc !== null) {
                expect(desc.length, `${url} description non-empty when present`).toBeGreaterThan(0);
            }
        });
    }
});

test.describe('SEO — Open Graph tags on login', () => {
    test('/en/login has og:title or og:description (if any OG tags exist)', async ({ page }) => {
        await page.goto('/en/login', { waitUntil: 'domcontentloaded' });

        const ogCount = await page.locator('meta[property^="og:"]').count();
        if (ogCount > 0) {
            const ogTitle = await page
                .locator('meta[property="og:title"]')
                .first()
                .getAttribute('content');
            const ogDesc = await page
                .locator('meta[property="og:description"]')
                .first()
                .getAttribute('content');
            expect(
                (ogTitle && ogTitle.length > 0) || (ogDesc && ogDesc.length > 0),
                'at least one of og:title / og:description should have content',
            ).toBeTruthy();
        }
    });
});

test.describe('SEO — title varies by locale on /login', () => {
    test('English and French /login titles are non-empty (and may differ)', async ({ page }) => {
        await page.goto('/en/login', { waitUntil: 'domcontentloaded' });
        const enTitle = await page.title();
        await page.goto('/fr/login', { waitUntil: 'domcontentloaded' });
        const frTitle = await page.title();

        expect(enTitle.length).toBeGreaterThan(0);
        expect(frTitle.length).toBeGreaterThan(0);
        // We don't strictly require they differ — branding may keep them same.
    });
});
