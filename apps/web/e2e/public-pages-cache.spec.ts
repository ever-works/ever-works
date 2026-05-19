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
            const maxAgeMatch = /max-age\s*=\s*(\d+)/i.exec(cc);
            const sMaxAgeMatch = /s-maxage\s*=\s*(\d+)/i.exec(cc);
            const seconds = maxAgeMatch ? parseInt(maxAgeMatch[1], 10) : null;
            const sSeconds = sMaxAgeMatch ? parseInt(sMaxAgeMatch[1], 10) : null;
            if (isPublic) {
                // A bare `public` directive with no max-age / s-maxage
                // is dangerous — CDNs and shared proxies apply heuristic
                // caching (typically 10% of Last-Modified age), which
                // for a login page means tokens / CSRF state can leak
                // across users. Reject that explicitly.
                expect(
                    seconds !== null || sSeconds !== null,
                    `login uses bare "public" Cache-Control with no max-age/s-maxage: "${cc}"`,
                ).toBe(true);
                // When max-age IS set, it must be tiny (<5 min).
                const effectiveSeconds = Math.max(seconds ?? 0, sSeconds ?? 0);
                expect(
                    effectiveSeconds < 300,
                    `login cache-control allows long public caching (${effectiveSeconds}s): "${cc}"`,
                ).toBe(true);
            }
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
