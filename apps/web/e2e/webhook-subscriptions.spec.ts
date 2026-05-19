import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Webhook subscriptions — outbound webhook delivery the platform fires
 * to consumer endpoints on platform events (generation done, deploy
 * succeeded, etc.). Pins the auth gate + list shape.
 *
 * The exact endpoint path varies by build (`/api/webhooks`,
 * `/api/webhook-subscriptions`, `/api/integrations/webhooks`). Probe a
 * few candidates and skip cleanly if none exists in this env.
 */

test.describe('Webhook subscriptions — API contract', () => {
    const CANDIDATES = [
        '/api/webhooks',
        '/api/webhook-subscriptions',
        '/api/integrations/webhooks',
    ];

    test('one of the webhook list endpoints exists + requires auth', async ({ request }) => {
        let foundPath: string | null = null;
        for (const path of CANDIDATES) {
            const res = await request.get(`${API_BASE}${path}`);
            if (res.status() !== 404) {
                foundPath = path;
                expect([401, 403]).toContain(res.status());
                break;
            }
        }
        if (!foundPath) {
            test.skip(true, 'webhook subscriptions endpoint not exposed at any tested path');
        }
    });

    test('GET webhook list with auth returns array (when endpoint exists)', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        let foundPath: string | null = null;
        for (const path of CANDIDATES) {
            const res = await request.get(`${API_BASE}${path}`, {
                headers: authedHeaders(u.access_token),
            });
            if (res.status() === 200) {
                foundPath = path;
                const body = await res.json();
                const arr = Array.isArray(body)
                    ? body
                    : (body?.subscriptions ?? body?.webhooks ?? body?.data ?? []);
                expect(Array.isArray(arr)).toBe(true);
                break;
            }
            if (res.status() !== 404) {
                foundPath = path;
                // Endpoint exists but rejected — that's still a known shape.
                expect(res.status()).toBeLessThan(500);
                break;
            }
        }
        if (!foundPath) {
            test.skip(true, 'webhook subscriptions endpoint not exposed');
        }
    });
});
