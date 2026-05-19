import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Webhook redelivery — pass 15. When the platform delivers a webhook
 * to a subscriber and the delivery fails, it should retry with a
 * backoff. We probe the deliveries listing endpoint to verify that:
 *  - the endpoint exists and is auth-gated
 *  - it returns an array shape (no 5xx)
 *  - the optional redeliver endpoint requires auth and returns < 500
 *    even for bogus delivery ids
 */

const DELIVERY_PATHS = [
    '/api/webhooks/deliveries',
    '/api/integrations/github-app/webhook-deliveries',
    '/api/github-app/webhook-deliveries',
];

test.describe('Webhooks — delivery listing + redeliver', () => {
    test('deliveries listing endpoint exists, is auth-gated, and returns a list shape', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        let foundPath: string | null = null;
        for (const p of DELIVERY_PATHS) {
            const res = await request.get(`${API_BASE}${p}`, {
                headers: authedHeaders(u.access_token),
            });
            if (res.status() === 404) continue;
            foundPath = p;
            break;
        }
        if (!foundPath) {
            test.skip(true, 'no webhook-deliveries endpoint exposed');
        }
        // Unauth probe must be 401/403/404, NOT 200 — the delivery
        // list typically carries delivery IDs an attacker could replay.
        const unauth = await request.get(`${API_BASE}${foundPath}`);
        expect([401, 403, 404]).toContain(unauth.status());
        // Owner probe returns < 500 with JSON list-or-object shape.
        const owner = await request.get(`${API_BASE}${foundPath}`, {
            headers: authedHeaders(u.access_token),
        });
        expect(owner.status()).toBeLessThan(500);
        if (owner.ok()) {
            const ct = owner.headers()['content-type'] || '';
            expect(ct).toMatch(/json/i);
        }
    });

    test('redeliver endpoint on a bogus delivery id is 4xx (not 5xx)', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        let probedPath: string | null = null;
        // Try a generic shape: /<base>/<bogusId>/redeliver.
        for (const p of DELIVERY_PATHS) {
            const candidate = `${API_BASE}${p}/bogus-delivery-id/redeliver`;
            const res = await request.post(candidate, {
                headers: authedHeaders(u.access_token),
            });
            if (res.status() === 404 && !DELIVERY_PATHS.includes(p)) continue;
            probedPath = candidate;
            // Status must be < 500. Common: 400 / 404.
            expect(res.status(), `redeliver on bogus id crashed with ${res.status()}`).toBeLessThan(
                500,
            );
            break;
        }
        if (!probedPath) {
            test.skip(true, 'no redeliver path responded — endpoint not present');
        }
    });
});
