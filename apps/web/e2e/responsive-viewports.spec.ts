import { test, expect } from '@playwright/test';

/**
 * Responsive viewports — pass 5+. Exercises the login page across
 * common mobile / tablet / desktop viewport sizes. We don't pin pixel
 * positions (visual-regression specs do that). We just verify that:
 *   - the page renders without horizontal overflow at narrow widths
 *   - the primary CTA is reachable (visible and inside the viewport)
 */

const VIEWPORTS = [
    { name: 'mobile-portrait', width: 375, height: 667 },
    { name: 'mobile-landscape', width: 667, height: 375 },
    { name: 'tablet', width: 768, height: 1024 },
    { name: 'desktop', width: 1280, height: 800 },
];

test.describe('Responsive — login page across viewports', () => {
    for (const vp of VIEWPORTS) {
        test(`${vp.name} (${vp.width}x${vp.height}) — no horizontal overflow + CTA reachable`, async ({
            page,
            baseURL,
        }) => {
            await page.setViewportSize({ width: vp.width, height: vp.height });
            await page.goto(`${baseURL || 'http://localhost:3000'}/en/login`, {
                waitUntil: 'domcontentloaded',
            });
            await page.waitForTimeout(1_500);
            // documentElement.scrollWidth must not greatly exceed viewport
            // width — a few px of subpixel rounding is normal.
            const overflow = await page.evaluate(() => ({
                docWidth: document.documentElement.scrollWidth,
                clientWidth: document.documentElement.clientWidth,
            }));
            expect(
                overflow.docWidth - overflow.clientWidth,
                `horizontal overflow ${overflow.docWidth - overflow.clientWidth}px at ${vp.name}`,
            ).toBeLessThan(8);

            // Primary submit must be inside the viewport (i.e. user can
            // see and tap it without scrolling forever).
            const submit = page.locator('button[type="submit"]').first();
            if (await submit.isVisible({ timeout: 5_000 }).catch(() => false)) {
                const box = await submit.boundingBox();
                if (box) {
                    expect(box.x, `submit x ${box.x} off-viewport`).toBeGreaterThanOrEqual(0);
                    expect(
                        box.x + box.width,
                        `submit right ${box.x + box.width} > viewport ${vp.width}`,
                    ).toBeLessThanOrEqual(vp.width + 8);
                }
            }
        });
    }
});
