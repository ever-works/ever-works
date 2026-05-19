import { test, expect } from '@playwright/test';

/**
 * Device fingerprinting opt-out — pass 12. When a user sets the
 * `Do-Not-Track: 1` or Sec-GPC: 1 header, third-party analytics
 * SDKs must respect the preference (no PostHog / GA / Sentry capture).
 *
 * We don't enforce that every SDK has a specific opt-out — we pin
 * that NO 3rd-party fingerprinting/analytics request fires on the
 * /en/login page when DNT=1.
 */

const ANALYTICS_HOSTS = [
    /posthog\.com/i,
    /\bclarity\.ms/i,
    /\bgoogle-analytics\.com/i,
    /\bgooglesyndication\.com/i,
    /\bdoubleclick\.net/i,
    /\bsegment\.io/i,
    /\bamplitude\.com/i,
    /\bmixpanel\.com/i,
    /\bfullstory\.com/i,
    /\bhotjar\.com/i,
];

test.describe('DNT / GPC honored — login page without consent', () => {
    test('with DNT=1 + GPC=1, no analytics request fires on /en/login', async ({
        browser,
        baseURL,
    }) => {
        const context = await browser.newContext({
            extraHTTPHeaders: {
                DNT: '1',
                'Sec-GPC': '1',
            },
        });
        const page = await context.newPage();
        const analyticsHits: string[] = [];
        page.on('request', (req) => {
            const url = req.url();
            if (ANALYTICS_HOSTS.some((h) => h.test(url))) {
                analyticsHits.push(url);
            }
        });
        await page.goto(`${baseURL || 'http://localhost:3000'}/en/login`, {
            waitUntil: 'networkidle',
        });
        await context.close();
        expect(
            analyticsHits,
            `analytics requests fired despite DNT/GPC: ${analyticsHits.slice(0, 3).join(', ')}`,
        ).toEqual([]);
    });

    test('without DNT, page renders (sanity)', async ({ page, baseURL }) => {
        await page.goto(`${baseURL || 'http://localhost:3000'}/en/login`, {
            waitUntil: 'domcontentloaded',
        });
        // We don't fail when analytics DO fire here — we just verify
        // the page works without DNT set. The opt-out test above is
        // the actual privacy check.
        const heading = page.locator('h1, h2').first();
        await expect(heading).toBeVisible({ timeout: 10_000 });
    });
});
