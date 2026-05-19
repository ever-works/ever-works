import { test, expect } from '@playwright/test';

/**
 * Bundle size budget — pass 12. Measure the aggregate transfer size
 * of `_next/static/*` chunks loaded on the login page first-load. We
 * don't pin specific kilobytes (frameworks evolve), but we DO pin a
 * generous ceiling that catches 10x regressions.
 *
 * Budget: 5 MB total transfer for static assets. A typical Next.js
 * app loads ~500KB–1MB. 5MB = a regression where someone bundled the
 * entire 39-plugin registry by accident.
 */

const STATIC_BUDGET_BYTES = 5 * 1024 * 1024;
const JS_FILE_COUNT_CEILING = 100;

// Bundle-size budgets only apply to production builds (`next start`). The
// dev server (`next dev`, used by CI's e2e workflow) ships an unminified
// React + unsplit chunks, which legitimately exceeds the budget by 10x.
const SKIP_REASON =
    'bundle-size budgets only meaningful against `next start` (NODE_ENV=production)';
const IS_PROD_BUILD = process.env.NODE_ENV === 'production';

test.describe('Bundle size — first-load static assets', () => {
    test.skip(!IS_PROD_BUILD, SKIP_REASON);

    test('login page _next/static aggregate transfer is under budget', async ({
        page,
        baseURL,
    }) => {
        let totalBytes = 0;
        let jsFileCount = 0;
        page.on('response', async (res) => {
            const url = res.url();
            if (!/\/_next\/static\//.test(url)) return;
            try {
                const headers = res.headers();
                const cl = headers['content-length'];
                if (cl) {
                    totalBytes += parseInt(cl, 10);
                } else {
                    // Some servers don't send content-length on streamed
                    // responses; read the body to measure.
                    const body = await res.body().catch(() => null);
                    if (body) totalBytes += body.length;
                }
                if (url.endsWith('.js') || url.endsWith('.mjs')) {
                    jsFileCount++;
                }
            } catch {
                // ignore failed reads — likely aborted requests
            }
        });
        await page.goto(`${baseURL || 'http://localhost:3000'}/en/login`, {
            waitUntil: 'networkidle',
        });
        if (totalBytes === 0) {
            test.skip(true, 'no _next/static responses captured — likely cached');
        }
        expect(
            totalBytes,
            `_next/static aggregate ${(totalBytes / 1024 / 1024).toFixed(2)} MB > budget ${STATIC_BUDGET_BYTES / 1024 / 1024} MB`,
        ).toBeLessThan(STATIC_BUDGET_BYTES);
        expect(
            jsFileCount,
            `loaded ${jsFileCount} JS chunks > ceiling ${JS_FILE_COUNT_CEILING}`,
        ).toBeLessThan(JS_FILE_COUNT_CEILING);
    });

    test('no single JS chunk exceeds 2 MB', async ({ page, baseURL }) => {
        // Mutated by the response listener — `let` per team style rule.
        let oversized: Array<{ url: string; bytes: number }> = [];
        page.on('response', async (res) => {
            const url = res.url();
            if (!/\/_next\/static\/.*\.(js|mjs)$/.test(url)) return;
            const cl = res.headers()['content-length'];
            const bytes = cl
                ? parseInt(cl, 10)
                : await res
                      .body()
                      .then((b) => b.length)
                      .catch(() => 0);
            if (bytes > 2 * 1024 * 1024) {
                oversized.push({ url: url.split('/').pop() ?? url, bytes });
            }
        });
        await page.goto(`${baseURL || 'http://localhost:3000'}/en/login`, {
            waitUntil: 'networkidle',
        });
        expect(oversized, `oversized chunks: ${JSON.stringify(oversized)}`).toEqual([]);
    });
});
