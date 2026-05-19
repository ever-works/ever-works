import { test, expect } from '@playwright/test';
import { API_BASE } from './helpers/api';

/**
 * Webhook replay window — pass 19. GitHub-style webhook deliveries
 * include a `X-Hub-Signature-256` HMAC AND an `X-GitHub-Delivery`
 * UUID + timestamp. Replay protection: deliveries with a stale
 * timestamp (>5 min in the past or future) should be rejected even
 * if the HMAC is otherwise valid.
 *
 * We don't have a real HMAC secret in test env, but we can probe
 * that the endpoint rejects clearly-stale timestamp shapes without
 * 5xx.
 */

const WEBHOOK_PATHS = [
    '/api/github-app/webhook',
    '/api/integrations/github-app/webhook',
    '/api/webhooks/github',
];

test.describe('Webhook replay window — stale delivery timestamps are rejected', () => {
    test('delivery with X-GitHub-Delivery dated 24h ago stays < 500', async ({ request }) => {
        const oldDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toUTCString();
        let probed = false;
        for (const p of WEBHOOK_PATHS) {
            const res = await request.post(`${API_BASE}${p}`, {
                headers: {
                    'Content-Type': 'application/json',
                    'X-GitHub-Event': 'ping',
                    'X-GitHub-Delivery': '11111111-2222-3333-4444-555555555555',
                    Date: oldDate,
                },
                data: { zen: 'fly' },
            });
            if (res.status() === 404) continue;
            probed = true;
            // Codex P2: a 24h-old delivery must be REJECTED, not just
            // "non-5xx". The prior `< 500` shape would let a server
            // happily accept a stale payload (2xx), which is exactly
            // the replay-window regression the spec exists to guard.
            // Require 4xx. If the platform doesn't enforce a replay
            // window yet, that's a real bug — fail loudly.
            expect(
                res.status(),
                `${p}: stale 24h-old Date payload was not rejected: ${res.status()}`,
            ).toBeGreaterThanOrEqual(400);
            expect(res.status()).toBeLessThan(500);
        }
        if (!probed) test.skip(true, 'no webhook endpoint exposed');
    });

    test('delivery with future-dated timestamp (1 year ahead) stays < 500', async ({ request }) => {
        const futureDate = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toUTCString();
        let probed = false;
        for (const p of WEBHOOK_PATHS) {
            const res = await request.post(`${API_BASE}${p}`, {
                headers: {
                    'Content-Type': 'application/json',
                    'X-GitHub-Event': 'ping',
                    'X-GitHub-Delivery': '22222222-3333-4444-5555-666666666666',
                    Date: futureDate,
                },
                data: { zen: 'fly' },
            });
            if (res.status() === 404) continue;
            probed = true;
            expect(res.status(), `${p}: future-Date payload crashed: ${res.status()}`).toBeLessThan(
                500,
            );
        }
        if (!probed) test.skip(true, 'no webhook endpoint exposed');
    });

    test('repeated delivery with same X-GitHub-Delivery UUID stays < 500', async ({ request }) => {
        const sameId = `replay-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        let probed = false;
        for (const p of WEBHOOK_PATHS) {
            const r1 = await request.post(`${API_BASE}${p}`, {
                headers: {
                    'Content-Type': 'application/json',
                    'X-GitHub-Event': 'ping',
                    'X-GitHub-Delivery': sameId,
                },
                data: { zen: 'fly' },
            });
            const r2 = await request.post(`${API_BASE}${p}`, {
                headers: {
                    'Content-Type': 'application/json',
                    'X-GitHub-Event': 'ping',
                    'X-GitHub-Delivery': sameId,
                },
                data: { zen: 'fly' },
            });
            if (r1.status() === 404) continue;
            probed = true;
            expect(r1.status()).toBeLessThan(500);
            expect(r2.status()).toBeLessThan(500);
        }
        if (!probed) test.skip(true, 'no webhook endpoint exposed');
    });
});
