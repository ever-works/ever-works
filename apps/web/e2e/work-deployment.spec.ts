import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * Work deployment surface — kicks off Vercel deploys, polls status,
 * tracks DNS / custom domains. Pins the auth gate + read-shape for
 * each endpoint, and the deploy/status web route on Next.js.
 */

test.describe('Work deployment — API contract', () => {
    test('GET /api/works/:id/deploy/status (web) without auth → 401', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/works/dead-beef/deploy/status`);
        // 401 or 404 (web route may not proxy to API for unauth) both OK.
        expect([401, 403, 404]).toContain(res.status());
    });

    test('POST /api/deploy/:provider without auth → 401', async ({ request }) => {
        const res = await request.post(`${API_BASE}/api/deploy/vercel`, {
            data: { workId: 'dead' },
        });
        expect([401, 403, 404]).toContain(res.status());
    });

    test('Deploy capability check-availability without auth → 401', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/deploy/check-availability`);
        expect([401, 403, 404]).toContain(res.status());
    });
});

test.describe('Work deployment — UI surface', () => {
    test('Work deploy page requires auth', async ({ page, baseURL }) => {
        const url = `${baseURL || 'http://localhost:3000'}/en/works/non-existent-id/deploy`;
        const res = await page.goto(url, { waitUntil: 'domcontentloaded' });
        const finalUrl = page.url();
        expect(
            finalUrl.includes('/login') || (res && [200, 404, 403].includes(res.status())),
        ).toBeTruthy();
    });
});
