import { test, expect } from '@playwright/test';
import { API_BASE } from './helpers/api';

/**
 * Webhook payload truncation — pass 18. Webhook inbound endpoints
 * must:
 *  - reject extremely large payloads (>5 MB) with 4xx, not 5xx
 *  - accept small payloads with HMAC intact
 *  - never crash on payloads that exceed the body parser limit
 */

const WEBHOOK_PATHS = [
    '/api/github-app/webhook',
    '/api/integrations/github-app/webhook',
    '/api/webhooks/github',
];

test.describe('Webhook payload — extreme size rejected, small accepted', () => {
    test('5 MB payload to webhook endpoint stays < 500', async ({ request }) => {
        // 5 MB of JSON-looking bytes.
        const huge = 'x'.repeat(5 * 1024 * 1024);
        const payload = JSON.stringify({ event: 'large', blob: huge });
        let probed = false;
        for (const p of WEBHOOK_PATHS) {
            const res = await request.post(`${API_BASE}${p}`, {
                headers: {
                    'Content-Type': 'application/json',
                    'X-GitHub-Event': 'installation',
                    'X-GitHub-Delivery': '00000000-0000-0000-0000-000000000000',
                },
                data: payload,
            });
            if (res.status() === 404) continue;
            probed = true;
            expect(res.status(), `${p}: 5MB payload crashed with ${res.status()}`).toBeLessThan(
                500,
            );
            // Best practice: 413 Payload Too Large. Acceptable: 400,
            // 401 (signature missing), 422. Never 5xx.
        }
        if (!probed) test.skip(true, 'no webhook endpoint exposed');
    });

    test('small payload without signature returns 4xx (auth/validation gate)', async ({
        request,
    }) => {
        let probed = false;
        for (const p of WEBHOOK_PATHS) {
            const res = await request.post(`${API_BASE}${p}`, {
                headers: { 'Content-Type': 'application/json' },
                data: { event: 'ping', payload: { zen: 'fly' } },
            });
            if (res.status() === 404) continue;
            probed = true;
            // Webhooks without HMAC must NOT be silently accepted.
            expect(
                res.status(),
                `${p}: unsigned small payload returned ${res.status()} — should be 4xx`,
            ).toBeGreaterThanOrEqual(400);
            expect(res.status()).toBeLessThan(500);
        }
        if (!probed) test.skip(true, 'no webhook endpoint exposed');
    });
});
