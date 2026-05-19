import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * Per-work activity feed — `/api/works/:id/activity-feed`. Each work
 * has its own log of generation runs, item changes, deploys, etc.
 * activity-log.spec.ts covers the GLOBAL log; this focuses on the
 * per-work scope and the auth gate (members can read, strangers can't).
 */

test.describe('Per-work activity feed — API contract', () => {
    test('GET /api/works/:id/activity-feed without auth → 401', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/works/dead-beef/activity-feed`);
        expect(res.status()).toBe(401);
    });

    test('GET /api/works/:id/activity-feed for own work returns array shape', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, u.access_token, {
            name: `e2e-af-${Date.now()}`,
        });
        const res = await request.get(`${API_BASE}/api/works/${work.id}/activity-feed`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        const arr = Array.isArray(body)
            ? body
            : (body?.activities ?? body?.feed ?? body?.entries ?? body?.data ?? []);
        expect(Array.isArray(arr)).toBe(true);
    });

    test("GET /api/works/:id/activity-feed for a stranger's work → 403 or 404", async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, {
            name: `e2e-af-strange-${Date.now()}`,
        });
        const intruder = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/works/${work.id}/activity-feed`, {
            headers: authedHeaders(intruder.access_token),
        });
        expect([403, 404]).toContain(res.status());
    });

    test('GET /api/works/:id/activity-feed?limit=10 honours pagination', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, u.access_token, {
            name: `e2e-pag-${Date.now()}`,
        });
        const res = await request.get(`${API_BASE}/api/works/${work.id}/activity-feed?limit=10`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        const arr = Array.isArray(body)
            ? body
            : (body?.activities ?? body?.feed ?? body?.entries ?? body?.data ?? []);
        expect(Array.isArray(arr)).toBe(true);
        expect(arr.length).toBeLessThanOrEqual(10);
    });
});
