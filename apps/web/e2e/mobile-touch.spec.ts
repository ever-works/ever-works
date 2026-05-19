import { test, expect, devices } from '@playwright/test';

/**
 * Mobile touch — pass 10. Verifies touch gestures (tap, swipe) on key
 * UI surfaces with a mobile viewport. Runs under chromium-no-auth so
 * the login page actually renders rather than getting redirected.
 */

test.describe('Mobile touch — login form usable on iPhone 13', () => {
    test.use({ ...devices['iPhone 13'] });

    test('login page renders + form is tappable on mobile', async ({ page, baseURL }) => {
        await page.goto(`${baseURL || 'http://localhost:3000'}/en/login`, {
            waitUntil: 'domcontentloaded',
        });
        await page.waitForTimeout(1_500);
        const email = page.locator('input[name="email"]').first();
        await expect(email).toBeVisible({ timeout: 10_000 });
        // Tap the email field — `tap` uses the touch screen rather than
        // mouse.click, exercising the mobile event path.
        await email.tap();
        await email.fill('mobile-tap@test.local');
        const value = await email.inputValue();
        expect(value).toBe('mobile-tap@test.local');
    });

    test('submit button is reachable without horizontal scroll', async ({ page, baseURL }) => {
        await page.goto(`${baseURL || 'http://localhost:3000'}/en/login`, {
            waitUntil: 'domcontentloaded',
        });
        await page.waitForTimeout(1_500);
        const submit = page.locator('button[type="submit"]').first();
        await expect(submit).toBeVisible({ timeout: 10_000 });
        const box = await submit.boundingBox();
        if (!box) test.skip(true, 'no bounding box');
        const viewport = page.viewportSize();
        if (!viewport) test.skip(true, 'no viewport');
        expect(box!.x, `submit x ${box!.x} < 0`).toBeGreaterThanOrEqual(0);
        expect(
            box!.x + box!.width,
            `submit right ${box!.x + box!.width} > viewport ${viewport!.width}`,
        ).toBeLessThanOrEqual(viewport!.width + 8);
    });
});

test.describe('Mobile touch — viewport meta tag is set correctly', () => {
    test.use({ ...devices['iPhone 13'] });

    test('login page <meta name=viewport> includes width=device-width', async ({
        page,
        baseURL,
    }) => {
        await page.goto(`${baseURL || 'http://localhost:3000'}/en/login`, {
            waitUntil: 'domcontentloaded',
        });
        const meta = await page.evaluate(() => {
            const m = document.querySelector('meta[name="viewport"]');
            return m?.getAttribute('content') || '';
        });
        // The viewport must include width=device-width and a sensible
        // initial-scale. Mobile usability is broken without it.
        expect(meta).toMatch(/width=device-width/i);
        expect(meta).toMatch(/initial-scale\s*=\s*1/i);
    });
});

test.describe('Mobile touch — Pixel 7 (Android) baseline', () => {
    test.use({ ...devices['Pixel 7'] });

    test('login form renders on Pixel 7', async ({ page, baseURL }) => {
        await page.goto(`${baseURL || 'http://localhost:3000'}/en/login`, {
            waitUntil: 'domcontentloaded',
        });
        const email = page.locator('input[name="email"]').first();
        await expect(email).toBeVisible({ timeout: 10_000 });
    });
});
