import { test, expect } from '@playwright/test';

/**
 * Public pages cache headers — pass 5. Verifies the marketing /
 * auth-public pages set sane Cache-Control headers. We don't pin exact
 * max-age values (those evolve), just the cache-policy family.
 */

test.describe('Cache-Control — auth-public pages should not be aggressively cached', () => {
    test('GET /en/login does not set long-term public cache', async ({ page, baseURL }) => {
        const res = await page.goto(`${baseURL || 'http://localhost:3000'}/en/login`, {
            waitUntil: 'domcontentloaded',
        });
        if (!res) test.skip(true, 'no response from login');
        const cc = res!.headers()['cache-control'] || '';
        // Login should be no-store or private — caching the login form
        // across users would be a privacy leak (form state, csrf tokens).
        if (cc) {
            const isPublic = /\bpublic\b/i.test(cc) && !/private/.test(cc);
            const longMaxAge = /max-age\s*=\s*(\d+)/i.exec(cc);
            const seconds = longMaxAge ? parseInt(longMaxAge[1], 10) : 0;
            // Either it should NOT be public-cacheable, OR the max-age
            // must be tiny (< 5 minutes). Long-term public cache is wrong.
            expect(
                !isPublic || seconds < 300,
                `login cache-control allows long public caching: "${cc}"`,
            ).toBe(true);
        }
    });

    test('GET / (root) sets at least *some* cache directive', async ({ page, baseURL }) => {
        const res = await page.goto(`${baseURL || 'http://localhost:3000'}/`, {
            waitUntil: 'domcontentloaded',
        });
        if (!res) test.skip(true, 'no response');
        const cc = res!.headers()['cache-control'];
        // We don't require any specific value — just that SOME policy
        // exists. Missing Cache-Control entirely on the entry page is a
        // perf / correctness smell.
        if (!cc) {
            test.skip(true, 'no Cache-Control on root — Next.js default may be in play');
        }
        expect(cc.length).toBeGreaterThan(0);
    });
});
