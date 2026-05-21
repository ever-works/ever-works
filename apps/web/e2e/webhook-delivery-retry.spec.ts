import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Webhook delivery — retry semantics + deliveries listing — EW-634.
 *
 * After the delivery worker landed (EW-634), `/api/webhooks/deliveries`
 * is the canonical listing endpoint and `POST /api/webhooks/:id/test`
 * synchronously fires a probe delivery. These checks exercise the
 * full producer-side path without depending on a real receiver:
 *
 *  - Subscription CRUD is gated by URL validation (no SSRF, no bogus URLs).
 *  - The deliveries listing endpoint is reachable + auth-gated + JSON.
 *  - The test-fire endpoint records a delivery row whose outcome bucket
 *    is one of the documented non-2xx values when the URL is unreachable.
 */

const WEBHOOKS_BASE = '/api/webhooks';
const DELIVERIES_PATH = `${WEBHOOKS_BASE}/deliveries`;

const VALID_OUTCOMES = new Set([
    'success',
    'client_error',
    'server_error',
    'timeout',
    'redirect_refused',
    'payload_too_large',
    'ssrf_blocked',
]);

test.describe('Webhook subscriptions — CRUD probe', () => {
    test('POST subscription with bogus URL is rejected with 4xx', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.post(`${API_BASE}${WEBHOOKS_BASE}`, {
            headers: authedHeaders(u.access_token),
            data: { url: 'not-a-url' },
        });
        expect(res.status()).toBeGreaterThanOrEqual(400);
        expect(res.status()).toBeLessThan(500);
    });

    test('POST subscription with javascript: URL is rejected (SSRF guard)', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.post(`${API_BASE}${WEBHOOKS_BASE}`, {
            headers: authedHeaders(u.access_token),
            data: { url: 'javascript:alert(1)' },
        });
        expect(res.status()).toBeGreaterThanOrEqual(400);
        expect(res.status()).toBeLessThan(500);
    });
});

test.describe('Webhook deliveries — list + status', () => {
    test('GET /api/webhooks/deliveries is auth-gated and returns a JSON object', async ({
        request,
    }) => {
        const unauth = await request.get(`${API_BASE}${DELIVERIES_PATH}`);
        expect([401, 403]).toContain(unauth.status());

        const u = await registerUserViaAPI(request);
        const authed = await request.get(`${API_BASE}${DELIVERIES_PATH}`, {
            headers: authedHeaders(u.access_token),
        });
        expect(authed.status()).toBe(200);
        const ct = authed.headers()['content-type'] || '';
        expect(ct).toMatch(/json/i);
        const body = await authed.json();
        expect(Array.isArray(body.deliveries)).toBe(true);
    });
});

test.describe('Webhook test-fire — exercises the worker end-to-end', () => {
    test('POST /api/webhooks/:id/test records a delivery with a documented outcome', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);

        // Register a subscription pointed at a URL that will never accept the
        // POST. We don't care what the outcome bucket is exactly — we care
        // that ONE of the documented buckets shows up and that the row
        // appears in the deliveries listing.
        const created = await request.post(`${API_BASE}${WEBHOOKS_BASE}`, {
            headers: authedHeaders(u.access_token),
            data: { url: 'https://webhook.invalid.ever.works/never-resolves' },
        });
        expect(created.status()).toBe(201);
        const { subscription } = await created.json();

        const fired = await request.post(`${API_BASE}${WEBHOOKS_BASE}/${subscription.id}/test`, {
            headers: authedHeaders(u.access_token),
        });
        expect(fired.status()).toBe(200);
        const fireBody = await fired.json();
        expect(VALID_OUTCOMES.has(fireBody.outcome)).toBe(true);
        expect(typeof fireBody.deliveryId).toBe('string');

        // Same delivery shows up in the listing, scoped to the caller.
        const list = await request.get(`${API_BASE}${DELIVERIES_PATH}`, {
            headers: authedHeaders(u.access_token),
        });
        expect(list.status()).toBe(200);
        const { deliveries } = await list.json();
        const hit = (deliveries as Array<{ id: string; subscriptionId: string }>).find(
            (d) => d.id === fireBody.deliveryId,
        );
        expect(hit, 'test-fire delivery missing from deliveries listing').toBeTruthy();
        expect(hit!.subscriptionId).toBe(subscription.id);
    });
});
