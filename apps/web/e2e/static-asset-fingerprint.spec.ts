import { test, expect } from '@playwright/test';

/**
 * Static asset fingerprint — pass 13. Next.js content-hashes its
 * static asset URLs (e.g. `_next/static/chunks/main-deadbeef.js`). We
 * verify the URLs the page loads carry a hash-shaped segment + that
 * those responses carry long Cache-Control headers (since the URL
 * already busts the cache on content change).
 */

test.describe('Static assets — URL fingerprinting', () => {
    test('_next/static URLs include a hash-shaped segment', async ({ page, baseURL }) => {
        const staticUrls: string[] = [];
        page.on('request', (req) => {
            if (/\/_next\/static\//.test(req.url())) {
                staticUrls.push(req.url());
            }
        });
        await page.goto(`${baseURL || 'http://localhost:3000'}/en/login`, {
            waitUntil: 'networkidle',
        });
        if (staticUrls.length === 0) {
            test.skip(true, 'no _next/static requests captured');
        }
        // Each URL should carry SOMETHING that identifies content:
        // - hash-shaped pathname segment (8+ hex / base64)
        // - OR webpack chunk-name style
        const fingerprintedRatio =
            staticUrls.filter(
                (u) =>
                    /\/[a-f0-9]{8,}/.test(u) ||
                    /\/chunks\/[A-Za-z0-9_-]+-[A-Za-z0-9_-]{4,}\.js/.test(u) ||
                    /_buildManifest|_ssgManifest/.test(u),
            ).length / staticUrls.length;
        expect(
            fingerprintedRatio,
            `only ${(fingerprintedRatio * 100).toFixed(0)}% of static URLs are fingerprinted`,
        ).toBeGreaterThan(0.5);
    });

    test('_next/static responses carry long Cache-Control max-age', async ({ page, baseURL }) => {
        const headers: Array<{ url: string; cc: string }> = [];
        page.on('response', (res) => {
            const url = res.url();
            if (/\/_next\/static\//.test(url)) {
                headers.push({ url, cc: res.headers()['cache-control'] || '' });
            }
        });
        await page.goto(`${baseURL || 'http://localhost:3000'}/en/login`, {
            waitUntil: 'networkidle',
        });
        if (headers.length === 0) {
            test.skip(true, 'no _next/static responses captured');
        }
        // Modern Next.js sets `public, max-age=31536000, immutable`
        // on hashed assets. We accept any max-age >= 1 hour.
        const insufficient = headers.filter((h) => {
            if (!h.cc) return true;
            const m = /max-age\s*=\s*(\d+)/.exec(h.cc);
            if (!m) return true;
            return parseInt(m[1], 10) < 3600;
        });
        // Allow a small tolerance for buildManifest / ssgManifest
        // which historically have shorter TTLs.
        const insufficientRatio = insufficient.length / headers.length;
        expect(
            insufficientRatio,
            `${(insufficientRatio * 100).toFixed(0)}% of static assets lack long Cache-Control`,
        ).toBeLessThan(0.3);
    });
});
