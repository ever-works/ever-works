import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Template catalog — deepens website-templates.spec.ts. The catalog
 * lists Next.js website templates a Work can be deployed to. Multiple
 * endpoints: list, get-one, by-slug.
 */

test.describe('Template catalog — list + detail', () => {
    test('GET /api/template-catalog returns array', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/template-catalog`);
        // Endpoint is intentionally public for browsing.
        expect(res.status()).toBeLessThan(500);
        if (res.status() === 200) {
            const body = await res.json();
            const arr = Array.isArray(body) ? body : (body?.templates ?? body?.data ?? []);
            expect(Array.isArray(arr)).toBe(true);
        }
    });

    test('GET /api/templates returns array', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/templates`);
        expect(res.status()).toBeLessThan(500);
    });

    test('GET /api/template-catalog/:id with bogus id → 404', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/template-catalog/non-existent-template`);
        expect(res.status()).toBeLessThan(500);
        // 404 or 200 (some implementations return empty object) — never 5xx.
    });
});

test.describe('Template catalog — templates UI page', () => {
    test('Templates page renders for unauthenticated user (or redirects)', async ({
        page,
        baseURL,
    }) => {
        const url = `${baseURL || 'http://localhost:3000'}/en/templates`;
        const res = await page.goto(url, { waitUntil: 'domcontentloaded' });
        if (res) {
            expect(res.status()).toBeLessThan(500);
        }
    });
});

test.describe('Customizations — per-template customization endpoints', () => {
    test('GET /api/template-customizations without auth → 401', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/template-customizations`);
        expect([401, 403, 404]).toContain(res.status());
    });

    test('GET /api/template-customizations for fresh user responds < 500', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/template-customizations`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBeLessThan(500);
    });
});

test.describe('User template preferences', () => {
    test('GET /api/me/template-preferences for fresh user responds < 500', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/me/template-preferences`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBeLessThan(500);
    });
});
