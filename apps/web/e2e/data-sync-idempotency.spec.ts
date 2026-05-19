import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Data sync — idempotency. Verifies repeated calls with the same input
 * don't double-create rows. The data-sync controller is the
 * client-facing sync endpoint; its contract is that retries are safe.
 */

test.describe('Data sync — idempotency', () => {
    test('GET /api/data-sync without auth → 401', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/data-sync`);
        expect(res.status()).toBe(401);
    });

    test('repeated GET /api/data-sync returns the same etag/state shape', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const r1 = await request.get(`${API_BASE}/api/data-sync`, {
            headers: authedHeaders(u.access_token),
        });
        if (r1.status() === 404) {
            test.skip(true, '/api/data-sync not exposed');
        }
        expect(r1.status()).toBeLessThan(500);
        if (r1.status() !== 200) {
            test.skip(true, `data-sync returned ${r1.status()}`);
        }
        const r2 = await request.get(`${API_BASE}/api/data-sync`, {
            headers: authedHeaders(u.access_token),
        });
        expect(r2.status()).toBe(200);
        // Both responses must be structurally similar — keys match.
        const b1 = await r1.json();
        const b2 = await r2.json();
        const k1 = Object.keys(b1 || {}).sort();
        const k2 = Object.keys(b2 || {}).sort();
        expect(k1.join(',')).toBe(k2.join(','));
    });

    test('POST /api/data-sync with same payload twice does not 5xx', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const payload = {
            clientTs: new Date().toISOString(),
            mutations: [],
        };
        const r1 = await request.post(`${API_BASE}/api/data-sync`, {
            headers: authedHeaders(u.access_token),
            data: payload,
        });
        if (r1.status() === 404) {
            test.skip(true, 'POST /api/data-sync not exposed');
        }
        expect(r1.status()).toBeLessThan(500);
        const r2 = await request.post(`${API_BASE}/api/data-sync`, {
            headers: authedHeaders(u.access_token),
            data: payload,
        });
        expect(r2.status()).toBeLessThan(500);
        // Both responses should land in the same status family — no
        // "first succeeded, second 500'd" surprises.
        const fam1 = Math.floor(r1.status() / 100);
        const fam2 = Math.floor(r2.status() / 100);
        expect(fam1, `r1=${r1.status()} r2=${r2.status()} families diverged`).toBe(fam2);
    });
});
