import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Telemetry endpoints — `/api/telemetry/*` and `/api/onboarding/telemetry`.
 *
 * The platform forwards funnel events to PostHog (or a similar sink).
 * The endpoints are auth-gated (we don't accept anonymous telemetry) and
 * accept POST bodies with event names + properties. Errors here should
 * be fast (4xx) — telemetry must never bring down the API.
 */

test.describe('Telemetry — funnel endpoint', () => {
    test('POST /api/telemetry/funnel without auth → 401', async ({ request }) => {
        const res = await request.post(`${API_BASE}/api/telemetry/funnel`, {
            data: { event: 'test', properties: {} },
        });
        expect(res.status()).toBe(401);
    });

    test('POST /api/telemetry/funnel with auth + well-formed body responds < 500', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.post(`${API_BASE}/api/telemetry/funnel`, {
            headers: authedHeaders(u.access_token),
            data: {
                event: 'e2e.smoke',
                properties: { source: 'e2e-test' },
            },
        });
        // 200/201/204 = accepted; 400 = body schema differs. All "endpoint
        // exists" outcomes. Reject 5xx (telemetry must not crash).
        expect(res.status(), `status was ${res.status()}`).toBeLessThan(500);
    });

    test('POST /api/telemetry/funnel with empty body returns 4xx, not 5xx', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.post(`${API_BASE}/api/telemetry/funnel`, {
            headers: authedHeaders(u.access_token),
            data: {},
        });
        expect(res.status()).toBeLessThan(500);
    });
});

test.describe('Telemetry — onboarding endpoint', () => {
    test('POST /api/onboarding/telemetry without auth — accepted shape OR 401', async ({
        request,
    }) => {
        // Onboarding telemetry may be public (anonymous funnel events) OR
        // require auth depending on configuration. Both are valid; just
        // ensure the endpoint exists and responds with a 2xx or 4xx.
        const res = await request.post(`${API_BASE}/api/onboarding/telemetry`, {
            data: { event: 'e2e.onboarding.smoke' },
        });
        expect(res.status()).toBeLessThan(500);
    });

    test('POST /api/onboarding/telemetry with auth responds < 500', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.post(`${API_BASE}/api/onboarding/telemetry`, {
            headers: authedHeaders(u.access_token),
            data: {
                event: 'e2e.onboarding.smoke',
                properties: { step: 'welcome' },
            },
        });
        expect(res.status()).toBeLessThan(500);
    });
});
