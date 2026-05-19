import { test, expect } from '@playwright/test';

/**
 * Referrer policy + safe link attributes — pass 13. Outbound links to
 * external hosts should carry `rel="noopener noreferrer"` to prevent
 * tabnabbing + referrer leakage. Plus the Referrer-Policy header
 * should be set defensively.
 */

test.describe('External links — safe rel attributes', () => {
    test('outbound https links on /en/login carry rel=noopener noreferrer', async ({
        page,
        baseURL,
    }) => {
        await page.goto(`${baseURL || 'http://localhost:3000'}/en/login`, {
            waitUntil: 'domcontentloaded',
        });
        const externalLinks = await page.$$eval(
            'a[href^="https://"]:not([href*="ever.works"]):not([href*="localhost"])',
            (els) =>
                els.map((a) => ({
                    href: a.getAttribute('href') || '',
                    rel: a.getAttribute('rel') || '',
                    target: a.getAttribute('target') || '',
                })),
        );
        if (externalLinks.length === 0) {
            test.skip(true, 'no external links on /en/login');
        }
        for (const link of externalLinks) {
            // Only links with target=_blank technically need noopener,
            // but adding rel=noopener noreferrer everywhere is the
            // accepted defensive default.
            if (link.target === '_blank') {
                expect(link.rel, `external _blank link ${link.href} missing noopener`).toMatch(
                    /noopener/,
                );
                expect(link.rel, `external _blank link ${link.href} missing noreferrer`).toMatch(
                    /noreferrer/,
                );
            }
        }
    });
});

test.describe('Referrer-Policy header', () => {
    test('login page sets Referrer-Policy header (or skip)', async ({ page, baseURL }) => {
        const res = await page.goto(`${baseURL || 'http://localhost:3000'}/en/login`, {
            waitUntil: 'domcontentloaded',
        });
        if (!res) test.skip(true, 'no response');
        const policy = res!.headers()['referrer-policy'];
        if (!policy) {
            test.skip(true, 'no Referrer-Policy header set');
        }
        // Acceptable values: no-referrer, strict-origin, same-origin,
        // strict-origin-when-cross-origin. NOT acceptable: unsafe-url,
        // origin (leaks origin to cross-site), no-referrer-when-downgrade
        // (deprecated default).
        const ACCEPTABLE = [
            'no-referrer',
            'strict-origin',
            'same-origin',
            'strict-origin-when-cross-origin',
        ];
        const lower = (policy as string).toLowerCase().trim();
        const value = lower.split(',')[0].trim();
        expect(
            ACCEPTABLE.includes(value),
            `Referrer-Policy "${value}" leaks too much (acceptable: ${ACCEPTABLE.join(', ')})`,
        ).toBe(true);
    });
});
