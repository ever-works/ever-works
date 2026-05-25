import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Account-wide usage — PR II added the `/api/me/usage/account-wide`
 * endpoint that backs the Dashboard's Month-Spend tile. Returns the
 * same `OwnerBudgetSummary` envelope as the per-Mission / per-Idea
 * budget endpoints, with `ownerType="account"`.
 */

test.describe('Account-wide usage — API contract', () => {
    test('GET /api/me/usage/account-wide without auth → 401', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/me/usage/account-wide`);
        expect(res.status()).toBe(401);
    });

    test('GET /api/me/usage/account-wide for a fresh user returns an envelope with zero spend', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/me/usage/account-wide`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status(), `body=${await res.text()}`).toBe(200);
        const body = await res.json();

        // Shape check — these fields back the BudgetSummaryCard /
        // Month-Spend tile. Any rename would break the dashboard render.
        expect(typeof body.currentSpendCents).toBe('number');
        expect(body.currentSpendCents).toBe(0);
        expect(typeof body.currency).toBe('string');
        expect(body.currency.length).toBeGreaterThan(0);
        expect(typeof body.allowOverage).toBe('boolean');
        expect(typeof body.blocked).toBe('boolean');
        // periodStart + periodEnd should be present as ISO strings
        expect(typeof body.periodStart).toBe('string');
        expect(typeof body.periodEnd).toBe('string');
    });
});
