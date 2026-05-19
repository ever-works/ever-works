import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Usage quota — pass 10. The subscription system tracks usage against
 * a per-plan quota. We verify:
 *   - `/api/usage` (or per-work usage) returns numeric totals
 *   - Per-work usage requires auth
 *   - Negative / zero usage values are not exposed to the wrong shape
 */

const USAGE_PATHS = [
    '/api/usage',
    '/api/me/usage',
    '/api/subscriptions/usage',
    '/api/budgets/usage',
];

test.describe('Usage quota — endpoint probe', () => {
    test('usage endpoint requires auth (or skip if not exposed)', async ({ request }) => {
        for (const path of USAGE_PATHS) {
            const res = await request.get(`${API_BASE}${path}`);
            if (res.status() === 404) continue;
            expect([401, 403]).toContain(res.status());
            return;
        }
        test.skip(true, 'no usage endpoint exposed');
    });

    test('authed usage endpoint returns numeric shape for fresh user', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        let body: unknown = null;
        for (const path of USAGE_PATHS) {
            const res = await request.get(`${API_BASE}${path}`, {
                headers: authedHeaders(u.access_token),
            });
            if (res.status() === 404) continue;
            expect(res.status()).toBeLessThan(500);
            if (res.status() === 200) {
                body = await res.json();
                break;
            }
        }
        if (!body) test.skip(true, 'no usage endpoint accessible');
        // Walk the response for any numeric usage / quota field.
        const flat = JSON.stringify(body);
        const numericKeys = flat.match(/"([^"]*?)"\s*:\s*(-?\d+(?:\.\d+)?)/g) || [];
        if (numericKeys.length === 0) {
            test.skip(true, 'no numeric fields in usage body');
        }
        // No usage value should be negative for a fresh user.
        for (const m of numericKeys) {
            const valueMatch = m.match(/:\s*(-?\d+(?:\.\d+)?)/);
            if (!valueMatch) continue;
            const value = Number(valueMatch[1]);
            // Costs / usage / counts should be non-negative. Negative
            // values typically indicate a sign-flip bug.
            if (m.toLowerCase().includes('cost') || m.toLowerCase().includes('usage')) {
                expect(value, `negative usage value in: ${m}`).toBeGreaterThanOrEqual(0);
            }
        }
    });
});

test.describe('Quota — exceeded responses', () => {
    test('hitting /api/works create N times for a fresh user stays under 5xx', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        // Hammer create-work — a free-tier user with a quota would
        // eventually 403/429, NOT 5xx. We accept either outcome.
        let saw5xx = false;
        const stamp = Date.now().toString(36);
        for (let i = 0; i < 30; i++) {
            const res = await request.post(`${API_BASE}/api/works`, {
                headers: authedHeaders(u.access_token),
                data: {
                    name: `quota-${stamp}-${i}`,
                    slug: `quota-${stamp}-${i}`,
                },
            });
            if (res.status() >= 500) {
                saw5xx = true;
                break;
            }
            // Stop early if the platform refuses (quota / throttler).
            if (res.status() === 402 || res.status() === 429 || res.status() === 403) break;
        }
        expect(saw5xx, 'hitting create-work N times produced a 5xx').toBe(false);
    });
});
