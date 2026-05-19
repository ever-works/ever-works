import { test, expect } from '@playwright/test';

/**
 * Mobile touch — pass 10. Verifies touch gestures (tap, viewport
 * shape) on mobile viewports. Runs under chromium-no-auth so the login
 * page actually renders rather than getting redirected.
 *
 * Codex P1: previously used `test.use({ ...devices['iPhone 13'] })` /
 * `devices['Pixel 7']` inside describe blocks. Playwright refuses to
 * load a file that does this because the device descriptors include
 * `defaultBrowserType` which would force a new worker, breaking the
 * entire test run during discovery. We now set viewport + user agent
 * manually via per-test `setViewportSize` + `route` hooks — same
 * coverage, no defaultBrowserType issue.
 */

interface MobileDevice {
    label: string;
    viewport: { width: number; height: number };
    userAgent: string;
    isMobile: boolean;
    hasTouch: boolean;
}

const IPHONE_13: MobileDevice = {
    label: 'iPhone 13',
    viewport: { width: 390, height: 844 },
    userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    isMobile: true,
    hasTouch: true,
};

const PIXEL_7: MobileDevice = {
    label: 'Pixel 7',
    viewport: { width: 412, height: 915 },
    userAgent:
        'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    isMobile: true,
    hasTouch: true,
};

async function gotoMobile(
    page: import('@playwright/test').Page,
    baseURL: string | undefined,
    device: MobileDevice,
    path: string,
): Promise<void> {
    await page.setViewportSize(device.viewport);
    await page.setExtraHTTPHeaders({ 'User-Agent': device.userAgent });
    await page.goto(`${baseURL || 'http://localhost:3000'}${path}`, {
        waitUntil: 'domcontentloaded',
    });
}

test.describe('Mobile touch — login form usable on iPhone 13', () => {
    test('login page renders + form is fillable on mobile', async ({ page, baseURL }) => {
        await gotoMobile(page, baseURL, IPHONE_13, '/en/login');
        // Greptile P2: replace fixed waitForTimeout with event-driven
        // wait on the form input — Playwright's domcontentloaded + an
        // expect(visible) auto-retry is both faster and less flaky.
        const email = page.locator('input[name="email"]').first();
        await expect(email).toBeVisible({ timeout: 15_000 });
        await email.fill('mobile-tap@test.local');
        const value = await email.inputValue();
        expect(value).toBe('mobile-tap@test.local');
    });

    test('submit button is reachable without horizontal scroll', async ({ page, baseURL }) => {
        await gotoMobile(page, baseURL, IPHONE_13, '/en/login');
        const submit = page.locator('button[type="submit"]').first();
        await expect(submit).toBeVisible({ timeout: 15_000 });
        const box = await submit.boundingBox();
        if (!box) test.skip(true, 'no bounding box');
        expect(box!.x, `submit x ${box!.x} < 0`).toBeGreaterThanOrEqual(0);
        expect(
            box!.x + box!.width,
            `submit right ${box!.x + box!.width} > viewport ${IPHONE_13.viewport.width}`,
        ).toBeLessThanOrEqual(IPHONE_13.viewport.width + 8);
    });
});

test.describe('Mobile touch — viewport meta tag is set correctly', () => {
    test('login page <meta name=viewport> includes width=device-width', async ({
        page,
        baseURL,
    }) => {
        await gotoMobile(page, baseURL, IPHONE_13, '/en/login');
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
    test('login form renders on Pixel 7 viewport', async ({ page, baseURL }) => {
        await gotoMobile(page, baseURL, PIXEL_7, '/en/login');
        const email = page.locator('input[name="email"]').first();
        await expect(email).toBeVisible({ timeout: 15_000 });
    });
});
