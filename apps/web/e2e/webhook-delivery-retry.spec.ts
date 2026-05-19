import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Webhook delivery / retry — pass 9. Outbound webhook deliveries are
 * fire-and-forget but they must be observable: each delivery should
 * appear in a deliveries list (or events log) and failed deliveries
 * should be retried with backoff.
 *
 * We don't have a real receiver to verify backoff timing, but we can
 * pin: subscription CRUD + delivery list endpoints respond sanely.
 */

const SUBSCRIPTION_PATHS = [
    '/api/webhooks',
    '/api/webhook-subscriptions',
    '/api/integrations/webhooks',
];

const DELIVERIES_SUFFIXES = ['/deliveries', '/events', '/logs', '/history'];

test.describe('Webhook subscriptions — CRUD probe', () => {
    test('POST subscription with bogus URL is rejected with 4xx', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        let found = false;
        for (const path of SUBSCRIPTION_PATHS) {
            const res = await request.post(`${API_BASE}${path}`, {
                headers: authedHeaders(u.access_token),
                data: {
                    url: 'not-a-url',
                    events: ['*'],
                },
            });
            if (res.status() === 404) continue;
            found = true;
            // Codex P2: previous `< 500` check would let a 2xx accept of
            // "not-a-url" silently pass — the EXACT validation regression
            // this test is meant to catch. URL validation MUST reject
            // with 4xx (typically 400/422). Never 2xx, never 5xx.
            expect(res.status()).toBeGreaterThanOrEqual(400);
            expect(res.status()).toBeLessThan(500);
            return;
        }
        if (!found) test.skip(true, 'no webhook subscription endpoint exposed');
    });

    test('POST subscription with javascript: URL is rejected (SSRF guard)', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        let found = false;
        for (const path of SUBSCRIPTION_PATHS) {
            const res = await request.post(`${API_BASE}${path}`, {
                headers: authedHeaders(u.access_token),
                data: {
                    url: 'javascript:alert(1)',
                    events: ['work.created'],
                },
            });
            if (res.status() === 404) continue;
            found = true;
            // MUST be 4xx — accepting javascript: as a destination is a
            // catastrophic protocol guard failure.
            expect(res.status()).toBeGreaterThanOrEqual(400);
            expect(res.status()).toBeLessThan(500);
            return;
        }
        if (!found) test.skip(true, 'no webhook subscription endpoint exposed');
    });
});

test.describe('Webhook deliveries — list + status', () => {
    test('GET /<subscription>/deliveries responds < 500 for owner', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        let found = false;
        for (const base of SUBSCRIPTION_PATHS) {
            for (const suffix of DELIVERIES_SUFFIXES) {
                const res = await request.get(`${API_BASE}${base}${suffix}`, {
                    headers: authedHeaders(u.access_token),
                });
                if (res.status() === 404) continue;
                found = true;
                expect(res.status()).toBeLessThan(500);
                return;
            }
        }
        if (!found) test.skip(true, 'no deliveries endpoint exposed');
    });

    test('GET deliveries from an unauthenticated request → 401/403', async ({ request }) => {
        let found = false;
        for (const base of SUBSCRIPTION_PATHS) {
            for (const suffix of DELIVERIES_SUFFIXES) {
                const res = await request.get(`${API_BASE}${base}${suffix}`);
                if (res.status() === 404) continue;
                found = true;
                expect([401, 403]).toContain(res.status());
                return;
            }
        }
        if (!found) test.skip(true, 'no deliveries endpoint exposed');
    });
});
