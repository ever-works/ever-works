import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * Data sync — idempotency. The actual NestJS route is
 * `POST /api/works/:id/sync` (see apps/api/src/data-sync/data-sync.controller.ts),
 * a manual escape valve that returns the dispatcher's three-gate outcome:
 * `{status: 'enqueued'|'skipped'|'failed', ...}`. The contract is that
 * repeated calls don't deadlock and don't 5xx; the dispatcher decides
 * whether to actually re-run.
 */

test.describe('Data sync — force-sync endpoint contract', () => {
    test('POST /api/works/:id/sync without auth → 401', async ({ request }) => {
        const res = await request.post(`${API_BASE}/api/works/non-existent/sync`);
        expect(res.status()).toBe(401);
    });

    test('POST /api/works/:id/sync for owner returns the three-gate outcome shape', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const w = await createWorkViaAPI(request, u.access_token, {
            name: `sync-${Date.now().toString(36)}`,
        });
        const res = await request.post(`${API_BASE}/api/works/${w.id}/sync`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBeLessThan(500);
        if (res.status() === 202 || res.status() === 200) {
            const body = await res.json();
            // Stable envelope: { status: 'enqueued' | 'skipped' | 'failed', ... }
            expect(['enqueued', 'skipped', 'failed']).toContain(body?.status);
        }
    });

    test('repeated POST /api/works/:id/sync stays in the same status family', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const w = await createWorkViaAPI(request, u.access_token, {
            name: `sync-repeat-${Date.now().toString(36)}`,
        });
        const r1 = await request.post(`${API_BASE}/api/works/${w.id}/sync`, {
            headers: authedHeaders(u.access_token),
        });
        const r2 = await request.post(`${API_BASE}/api/works/${w.id}/sync`, {
            headers: authedHeaders(u.access_token),
        });
        expect(r1.status()).toBeLessThan(500);
        expect(r2.status()).toBeLessThan(500);
        const fam1 = Math.floor(r1.status() / 100);
        const fam2 = Math.floor(r2.status() / 100);
        expect(fam1, `r1=${r1.status()} r2=${r2.status()} families diverged`).toBe(fam2);
    });

    test("stranger cannot force-sync another user's work", async ({ request }) => {
        const owner = await registerUserViaAPI(request);
        const w = await createWorkViaAPI(request, owner.access_token, {
            name: `sync-iso-${Date.now().toString(36)}`,
        });
        const stranger = await registerUserViaAPI(request);
        const res = await request.post(`${API_BASE}/api/works/${w.id}/sync`, {
            headers: authedHeaders(stranger.access_token),
        });
        // Stranger gets 401/403/404 — never 2xx, never 5xx.
        expect(res.status()).toBeGreaterThanOrEqual(400);
        expect(res.status()).toBeLessThan(500);
    });
});
