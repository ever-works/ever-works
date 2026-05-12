import { test, expect } from '@playwright/test';
import { API_BASE, registerUserViaAPI, authedHeaders } from './helpers/api';

/**
 * EW-533 — CSV/Excel item import + export route contract.
 *
 * Smoke-tests the auth gate and the predictable error branches for the
 * six routes added by EW-533. We don't drive the wizard through the UI
 * here (the modal needs a real cloned data repo to exercise validate +
 * execute); that lives in the directory-web-template prior-art e2e
 * suite already.
 *
 * For routes scoped to a `:id` work, we use a synthetic UUID so the
 * route resolves auth + ownership but bottoms out in 404 / 403. The
 * goal is "the route is mounted, the gate fires, and the error code
 * is what we declared in the spec" — not full happy-path coverage.
 */

const FAKE_WORK_ID = '00000000-0000-0000-0000-000000000000';

test.describe('EW-533 — export routes (auth + format gating)', () => {
    test('GET /api/works/:id/export-items/settings without auth → 401', async ({ request }) => {
        const res = await request.get(
            `${API_BASE}/api/works/${FAKE_WORK_ID}/export-items/settings`,
        );
        expect(res.status()).toBe(401);
    });

    test('GET /api/works/:id/export-items without auth → 401', async ({ request }) => {
        const res = await request.get(
            `${API_BASE}/api/works/${FAKE_WORK_ID}/export-items?format=csv`,
        );
        expect(res.status()).toBe(401);
    });

    test('GET /api/works/:id/export-items with bad format → 400', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(
            `${API_BASE}/api/works/${FAKE_WORK_ID}/export-items?format=json`,
            { headers: authedHeaders(u.access_token) },
        );
        // 400 from our format guard, OR 4xx from upstream ownership check.
        // Either way: not 500, and not 200.
        expect(res.status(), `unexpected status ${res.status()}`).toBeGreaterThanOrEqual(400);
        expect(res.status()).toBeLessThan(500);
        expect(res.status()).not.toBe(200);
    });

    test('GET /api/works/:id/export-items/settings with auth + non-existent id → 4xx, not 5xx', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(
            `${API_BASE}/api/works/${FAKE_WORK_ID}/export-items/settings`,
            { headers: authedHeaders(u.access_token) },
        );
        expect(res.status(), `expected 4xx, got ${res.status()}`).toBeGreaterThanOrEqual(400);
        expect(res.status()).toBeLessThan(500);
    });
});

test.describe('EW-533 — import routes (auth + format gating)', () => {
    test('GET /api/works/:id/import-items/settings without auth → 401', async ({ request }) => {
        const res = await request.get(
            `${API_BASE}/api/works/${FAKE_WORK_ID}/import-items/settings`,
        );
        expect(res.status()).toBe(401);
    });

    test('GET /api/works/:id/import-items/sample without auth → 401', async ({ request }) => {
        const res = await request.get(
            `${API_BASE}/api/works/${FAKE_WORK_ID}/import-items/sample?format=csv`,
        );
        expect(res.status()).toBe(401);
    });

    test('POST /api/works/:id/import-items/validate without auth → 401', async ({ request }) => {
        const res = await request.post(
            `${API_BASE}/api/works/${FAKE_WORK_ID}/import-items/validate`,
            { multipart: {} },
        );
        expect(res.status()).toBe(401);
    });

    test('POST /api/works/:id/import-items without auth → 401', async ({ request }) => {
        const res = await request.post(
            `${API_BASE}/api/works/${FAKE_WORK_ID}/import-items`,
            { data: { rows: [] } },
        );
        expect(res.status()).toBe(401);
    });

    test('GET /api/works/:id/import-items/sample with bad format → 4xx', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(
            `${API_BASE}/api/works/${FAKE_WORK_ID}/import-items/sample?format=json`,
            { headers: authedHeaders(u.access_token) },
        );
        expect(res.status(), `unexpected status ${res.status()}`).toBeGreaterThanOrEqual(400);
        expect(res.status()).toBeLessThan(500);
    });

    test('POST /api/works/:id/import-items without rows → 4xx', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.post(
            `${API_BASE}/api/works/${FAKE_WORK_ID}/import-items`,
            { headers: authedHeaders(u.access_token), data: {} },
        );
        // 400 from our body-shape guard, or upstream ownership 4xx.
        expect(res.status(), `unexpected status ${res.status()}`).toBeGreaterThanOrEqual(400);
        expect(res.status()).toBeLessThan(500);
    });

    test('GET /api/works/:id/import-items/settings with auth + non-existent id → 4xx, not 5xx', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(
            `${API_BASE}/api/works/${FAKE_WORK_ID}/import-items/settings`,
            { headers: authedHeaders(u.access_token) },
        );
        expect(res.status(), `expected 4xx, got ${res.status()}`).toBeGreaterThanOrEqual(400);
        expect(res.status()).toBeLessThan(500);
    });
});
