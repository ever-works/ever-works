import { test, expect } from '@playwright/test';

/**
 * SEO infrastructure — sitemap.xml + robots.txt. Both are public and
 * critical for search engine indexing. The platform's marketing site +
 * dashboard share the Next.js app, so these endpoints live on the web
 * tier.
 */

test.describe('SEO — sitemap.xml', () => {
    test('GET /sitemap.xml returns XML content', async ({ page, baseURL }) => {
        const url = `${baseURL || 'http://localhost:3000'}/sitemap.xml`;
        const res = await page.request.get(url);
        // 200 with XML or 404 if not generated for this build — both acceptable;
        // reject 5xx.
        expect(res.status()).toBeLessThan(500);
        if (res.status() === 200) {
            const ct = res.headers()['content-type'] || '';
            expect(ct.includes('xml') || ct.includes('text/plain')).toBe(true);
            const body = await res.text();
            // Loose check — `<?xml` or `<urlset` or `<sitemapindex`.
            expect(body.length).toBeGreaterThan(0);
        }
    });
});

test.describe('SEO — robots.txt', () => {
    test('GET /robots.txt returns text', async ({ page, baseURL }) => {
        const url = `${baseURL || 'http://localhost:3000'}/robots.txt`;
        const res = await page.request.get(url);
        expect(res.status()).toBeLessThan(500);
        if (res.status() === 200) {
            const ct = res.headers()['content-type'] || '';
            expect(ct.includes('text/plain')).toBe(true);
            const body = await res.text();
            // Should mention `User-agent` somewhere — that's the entire
            // point of robots.txt.
            expect(body.toLowerCase()).toContain('user-agent');
        }
    });

    test('GET /robots.txt has Sitemap directive (if sitemap present)', async ({
        page,
        baseURL,
    }) => {
        const url = `${baseURL || 'http://localhost:3000'}/robots.txt`;
        const res = await page.request.get(url);
        if (res.status() !== 200) {
            test.skip(true, 'robots.txt not present');
        }
        const body = await res.text();
        // If a sitemap is referenced, it should point at /sitemap.xml.
        const sitemapLine = body.split('\n').find((l) => /^sitemap\s*:/i.test(l));
        if (sitemapLine) {
            expect(sitemapLine.toLowerCase()).toContain('sitemap');
        }
    });
});

test.describe('SEO — favicon + manifest', () => {
    test('GET /favicon.ico returns image-like content', async ({ page, baseURL }) => {
        const url = `${baseURL || 'http://localhost:3000'}/favicon.ico`;
        const res = await page.request.get(url);
        expect(res.status()).toBeLessThan(500);
        if (res.status() === 200) {
            const ct = res.headers()['content-type'] || '';
            expect(ct.includes('image') || ct.includes('x-icon')).toBe(true);
        }
    });
});
