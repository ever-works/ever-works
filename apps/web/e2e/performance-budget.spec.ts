import { test, expect } from '@playwright/test';

/**
 * Performance budget — pass 5+. Coarse load-time SLO checks on the
 * landing page and the login page. We're not aiming for Lighthouse
 * accuracy — just a safety net so a regression that doubles the JS
 * bundle lights up here before it reaches users.
 *
 * Numbers are intentionally loose because CI runners vary. The point is
 * "is the page rendering in the same order of magnitude as it used to",
 * not "is it sub-200ms."
 */

const SLOW_PAGE_BUDGET_MS = 15_000;
const SLOW_TTFB_BUDGET_MS = 5_000;

async function measurePage(page: import('@playwright/test').Page, url: string) {
    const navStart = Date.now();
    const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
    const elapsed = Date.now() - navStart;
    const ttfb = response
        ? await page.evaluate(() => {
              const nav = performance.getEntriesByType('navigation')[0] as
                  | PerformanceNavigationTiming
                  | undefined;
              if (!nav) return null;
              return Math.max(0, nav.responseStart - nav.requestStart);
          })
        : null;
    return { status: response?.status() ?? 0, elapsed, ttfb };
}

test.describe('Performance budget — coarse load times', () => {
    test('login page loads within budget', async ({ page, baseURL }) => {
        const url = `${baseURL || 'http://localhost:3000'}/en/login`;
        const m = await measurePage(page, url);
        expect(m.status, `unexpected status ${m.status}`).toBeLessThan(500);
        expect(
            m.elapsed,
            `login page took ${m.elapsed}ms > budget ${SLOW_PAGE_BUDGET_MS}ms`,
        ).toBeLessThan(SLOW_PAGE_BUDGET_MS);
        if (typeof m.ttfb === 'number') {
            expect(m.ttfb, `login TTFB ${m.ttfb}ms`).toBeLessThan(SLOW_TTFB_BUDGET_MS);
        }
    });

    test('register page loads within budget', async ({ page, baseURL }) => {
        const url = `${baseURL || 'http://localhost:3000'}/en/register`;
        const m = await measurePage(page, url);
        expect(m.status).toBeLessThan(500);
        expect(m.elapsed).toBeLessThan(SLOW_PAGE_BUDGET_MS);
    });

    test('static asset count on login is reasonable (< 200 requests)', async ({
        page,
        baseURL,
    }) => {
        let requestCount = 0;
        page.on('request', () => {
            requestCount++;
        });
        await page.goto(`${baseURL || 'http://localhost:3000'}/en/login`, {
            waitUntil: 'networkidle',
        });
        // If we're suddenly making 500 requests on login, we've shipped a
        // bug. 200 is a deliberately loose ceiling — adjust downwards
        // when the page is stable.
        expect(
            requestCount,
            `login made ${requestCount} requests — bundle / waterfall bloat?`,
        ).toBeLessThan(200);
    });
});
