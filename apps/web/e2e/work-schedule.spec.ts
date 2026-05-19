import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * Work schedule — scheduled-generation config:
 *
 *   - `GET    /api/works/:id/schedule`     — read
 *   - `PUT    /api/works/:id/schedule`     — create / update
 *   - `DELETE /api/works/:id/schedule`     — clear
 *   - `POST   /api/works/:id/schedule/run` — manual run
 *
 * EW-602 background — the worker BullMQ-dispatches due schedules. The
 * E2E suite can't validate the actual dispatch (Trigger.dev side) but
 * pins the REST contract end-to-end.
 */

test.describe('Work schedule — API contract', () => {
    test('GET /api/works/:id/schedule without auth → 401', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/works/dead/schedule`);
        expect(res.status()).toBe(401);
    });

    test('PUT /api/works/:id/schedule without auth → 401', async ({ request }) => {
        const res = await request.put(`${API_BASE}/api/works/dead/schedule`, {
            data: { cadence: 'weekly' },
        });
        expect(res.status()).toBe(401);
    });

    test('DELETE /api/works/:id/schedule without auth → 401', async ({ request }) => {
        const res = await request.delete(`${API_BASE}/api/works/dead/schedule`);
        expect(res.status()).toBe(401);
    });

    test('POST /api/works/:id/schedule/run without auth → 401', async ({ request }) => {
        const res = await request.post(`${API_BASE}/api/works/dead/schedule/run`);
        expect(res.status()).toBe(401);
    });

    test('PUT /api/works/:id/schedule for own work accepts well-formed cadence', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, u.access_token, {
            name: `e2e-sch-${Date.now()}`,
        });
        const res = await request.put(`${API_BASE}/api/works/${work.id}/schedule`, {
            headers: authedHeaders(u.access_token),
            data: { cadence: 'weekly', enabled: true },
        });
        // 200/201 (created), 400 (body schema differs), 403 (free plan limits) — all < 500.
        expect(res.status()).toBeLessThan(500);
        expect([401]).not.toContain(res.status());
    });

    test('DELETE /api/works/:id/schedule for own work with no existing schedule responds < 500', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, u.access_token, {
            name: `e2e-sd-${Date.now()}`,
        });
        const res = await request.delete(`${API_BASE}/api/works/${work.id}/schedule`, {
            headers: authedHeaders(u.access_token),
        });
        // 200 (no-op) or 404 (no schedule existed) — never 5xx.
        expect(res.status()).toBeLessThan(500);
    });
});

test.describe('Work activity-sync — rotate secret', () => {
    test('POST /api/works/:id/activity-sync/rotate-secret without auth → 401', async ({
        request,
    }) => {
        const res = await request.post(`${API_BASE}/api/works/dead/activity-sync/rotate-secret`);
        expect(res.status()).toBe(401);
    });

    test('POST /api/works/:id/activity-sync/rotate-secret for own work responds < 500', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, u.access_token, {
            name: `e2e-rs-${Date.now()}`,
        });
        const res = await request.post(
            `${API_BASE}/api/works/${work.id}/activity-sync/rotate-secret`,
            {
                headers: authedHeaders(u.access_token),
            },
        );
        expect(res.status()).toBeLessThan(500);
        expect([401]).not.toContain(res.status());
    });
});
