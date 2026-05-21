import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Webhook redelivery — EW-634. The delivery worker exposes
 * `POST /api/webhooks/deliveries/:id/redeliver` for re-enqueueing a
 * previous delivery. We exercise:
 *
 *  - the listing endpoint is auth-gated and JSON-shaped
 *  - redeliver on a bogus delivery id is 4xx (NOT 5xx) — the controller
 *    masks not-found-or-not-yours as 404 to avoid enumeration
 *  - redeliver against a real delivery (created via the test-fire path)
 *    returns 202 + a fresh delivery id
 */

const WEBHOOKS_BASE = '/api/webhooks';
const DELIVERIES_PATH = `${WEBHOOKS_BASE}/deliveries`;

test.describe('Webhooks — delivery listing + redeliver', () => {
    test('deliveries listing endpoint exists, is auth-gated, returns a list shape', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const unauth = await request.get(`${API_BASE}${DELIVERIES_PATH}`);
        expect([401, 403]).toContain(unauth.status());

        const owner = await request.get(`${API_BASE}${DELIVERIES_PATH}`, {
            headers: authedHeaders(u.access_token),
        });
        expect(owner.status()).toBe(200);
        const ct = owner.headers()['content-type'] || '';
        expect(ct).toMatch(/json/i);
        const body = await owner.json();
        expect(Array.isArray(body.deliveries)).toBe(true);
    });

    test('redeliver endpoint on a bogus delivery id is 4xx (not 5xx)', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        // Valid UUID shape so ParseUUIDPipe passes — the not-found-or-
        // not-yours mask happens inside the service.
        const bogusId = '00000000-0000-4000-8000-000000000000';
        const res = await request.post(`${API_BASE}${DELIVERIES_PATH}/${bogusId}/redeliver`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBeGreaterThanOrEqual(400);
        expect(res.status()).toBeLessThan(500);
    });

    test('redeliver against a real delivery enqueues a fresh attempt', async ({ request }) => {
        const u = await registerUserViaAPI(request);

        // Bootstrap: subscription + test-fire so we have a known delivery id.
        const created = await request.post(`${API_BASE}${WEBHOOKS_BASE}`, {
            headers: authedHeaders(u.access_token),
            data: { url: 'https://webhook.invalid.ever.works/redeliver-target' },
        });
        expect(created.status()).toBe(201);
        const { subscription } = await created.json();
        const fired = await request.post(`${API_BASE}${WEBHOOKS_BASE}/${subscription.id}/test`, {
            headers: authedHeaders(u.access_token),
        });
        expect(fired.status()).toBe(200);
        const { deliveryId } = await fired.json();
        expect(typeof deliveryId).toBe('string');

        const redelivery = await request.post(
            `${API_BASE}${DELIVERIES_PATH}/${deliveryId}/redeliver`,
            { headers: authedHeaders(u.access_token) },
        );
        expect(redelivery.status()).toBe(202);
        const body = await redelivery.json();
        expect(body.enqueued).toBe(true);
        expect(typeof body.deliveryId).toBe('string');
        expect(body.deliveryId).not.toBe(deliveryId);
    });
});
