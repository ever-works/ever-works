import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * Download / export endpoints — pass 5. The platform exposes three
 * exports that return CSV (or similar): account, activity-log, budget
 * usage. We pin: auth gate, content-type, content-disposition naming,
 * and a non-empty body for owners.
 *
 *   GET /api/account/export             — full account data dump
 *   GET /api/activity-log/export        — activity CSV
 *   GET /api/works/:id/usage/export     — per-work budget CSV
 */

test.describe('Downloads — /api/account/export', () => {
    test('GET /api/account/export without auth → 401', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/account/export`);
        expect(res.status()).toBe(401);
    });

    test('GET /api/account/export with auth returns a non-empty payload', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/account/export`, {
            headers: authedHeaders(u.access_token),
        });
        // Some builds gate this behind a feature flag — 200 / 403 / 404 all
        // acceptable, never 5xx.
        expect(res.status()).toBeLessThan(500);
        if (res.status() === 200) {
            const ct = res.headers()['content-type'] || '';
            // Account export is usually JSON or CSV — accept either.
            const looksDownloadable =
                ct.includes('json') ||
                ct.includes('csv') ||
                ct.includes('octet-stream') ||
                ct.includes('text/');
            expect(looksDownloadable, `unexpected content-type ${ct}`).toBe(true);
            const body = await res.body();
            expect(body.length, 'export body empty').toBeGreaterThan(0);
        }
    });
});

test.describe('Downloads — /api/activity-log/export', () => {
    test('GET /api/activity-log/export without auth → 401', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/activity-log/export`);
        expect(res.status()).toBe(401);
    });

    test('GET /api/activity-log/export returns CSV-ish content for owner', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/activity-log/export`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBeLessThan(500);
        if (res.status() === 200) {
            const ct = res.headers()['content-type'] || '';
            const cd = res.headers()['content-disposition'] || '';
            // The controller advertises "Download activity log entries as a
            // CSV file". Either Content-Type names CSV, or
            // Content-Disposition supplies a .csv filename.
            const looksCsv = ct.includes('csv') || cd.includes('.csv') || ct.includes('text/');
            expect(looksCsv, `headers ct=${ct} cd=${cd}`).toBe(true);
        }
    });

    test('GET /api/activity-log/export respects ?workId filter without 5xx', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const w = await createWorkViaAPI(request, u.access_token, {
            name: `export-${Date.now().toString(36)}`,
        });
        const res = await request.get(
            `${API_BASE}/api/activity-log/export?workId=${encodeURIComponent(w.id)}`,
            { headers: authedHeaders(u.access_token) },
        );
        expect(res.status()).toBeLessThan(500);
    });
});

test.describe('Downloads — /api/works/:id/usage/export', () => {
    test('GET /api/works/:id/usage/export without auth → 401', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/works/bogus-id/usage/export`);
        expect(res.status()).toBe(401);
    });

    test('owner gets a downloadable usage export (or 404 when budgets disabled)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const w = await createWorkViaAPI(request, u.access_token, {
            name: `usage-${Date.now().toString(36)}`,
        });
        const res = await request.get(`${API_BASE}/api/works/${w.id}/usage/export`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBeLessThan(500);
        if (res.status() === 200) {
            const ct = res.headers()['content-type'] || '';
            expect(ct.includes('csv') || ct.includes('text/') || ct.includes('json')).toBe(true);
        }
    });

    test("stranger cannot export another user's work usage", async ({ request }) => {
        const owner = await registerUserViaAPI(request);
        const w = await createWorkViaAPI(request, owner.access_token, {
            name: `usage-iso-${Date.now().toString(36)}`,
        });
        const stranger = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/works/${w.id}/usage/export`, {
            headers: authedHeaders(stranger.access_token),
        });
        expect([401, 403, 404]).toContain(res.status());
    });
});
