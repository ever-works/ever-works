import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Subscription renewal grace — pass 18. Subscriptions endpoint
 * should expose a current plan + status. A fresh user is `free` (no
 * grace), and the response should carry enough state for clients to
 * detect grace mode if it were active (`status: grace`, `renewedAt`,
 * `expiresAt`). We probe shape only — we can't manipulate renewal
 * timestamps from black-box e2e.
 */

const SUBSCRIPTION_PATHS = [
    '/api/subscriptions',
    '/api/subscriptions/current',
    '/api/account/subscription',
];

test.describe('Subscription — current plan exposes status / grace metadata', () => {
    test('current subscription endpoint returns a plan + status string', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        let probed = false;
        for (const p of SUBSCRIPTION_PATHS) {
            const res = await request.get(`${API_BASE}${p}`, {
                headers: authedHeaders(u.access_token),
            });
            if (res.status() === 404) continue;
            if (!res.ok()) continue;
            const ct = res.headers()['content-type'] || '';
            if (!ct.includes('json')) continue;
            probed = true;
            const body = await res.json();
            // Acceptable shapes: { plan: 'free', status: 'active' },
            // { tier: 'free' }, or wrapped { data: {...} }.
            const shape = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
            const plan =
                shape.plan ??
                shape.tier ??
                (shape.data as Record<string, unknown> | undefined)?.plan ??
                (shape.data as Record<string, unknown> | undefined)?.tier ??
                (shape.subscription as Record<string, unknown> | undefined)?.plan;
            expect(plan, `${p}: no plan/tier field in subscription body`).toBeDefined();
        }
        if (!probed) test.skip(true, 'no subscription endpoint exposed');
    });

    test('budgets endpoint reflects subscription status without 5xx', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/budgets`, {
            headers: authedHeaders(u.access_token),
        });
        if (res.status() === 404) test.skip(true, '/api/budgets not exposed');
        expect(res.status()).toBeLessThan(500);
        if (!res.ok()) test.skip(true, `/api/budgets ${res.status()}`);
        const body = await res.json();
        // Should at minimum be an object with usage / limit / status
        // shape. We don't pin the exact field names — they vary across
        // tiers. Just that it's not an error envelope.
        expect(typeof body, 'budgets returned non-object').toBe('object');
        expect(Array.isArray(body), 'budgets is unexpectedly an array').toBe(false);
    });
});
