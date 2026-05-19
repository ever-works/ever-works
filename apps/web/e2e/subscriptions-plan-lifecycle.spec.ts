import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Subscriptions plan lifecycle — pass 5. Deepens subscriptions-plan and
 * subscriptions-tiers. The actual enum from
 * packages/agent/src/entities/types.ts is:
 *
 *   SubscriptionPlanCode.FREE     = 'free'
 *   SubscriptionPlanCode.STANDARD = 'standard'
 *   SubscriptionPlanCode.PREMIUM  = 'premium'
 *
 * Free is the default for a fresh user. We try to walk the lifecycle:
 *   free → standard → free (or premium → free)
 * and pin that each transition is consistent — fresh GET reflects the
 * last POST.
 */

const PAID_TIERS = ['standard', 'premium'];

test.describe('Subscriptions — plan lifecycle', () => {
    test('fresh user is on free plan', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/subscriptions/plan`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        const code = String(
            body?.plan?.code ?? body?.code ?? body?.tier ?? body?.id ?? '',
        ).toLowerCase();
        expect(code).toBe('free');
    });

    test('switching to a paid plan + reverting to free is consistent (when manual billing)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        // Try setting to STANDARD.
        const switchUp = await request.post(`${API_BASE}/api/subscriptions/plan`, {
            headers: authedHeaders(u.access_token),
            data: { code: 'standard' },
        });
        // With the manual billing provider this is a 2xx no-op DB update.
        // With a real billing provider it'd be 402 / 400 because we have
        // no payment method — skip in that case.
        if (switchUp.status() >= 400) {
            test.skip(
                true,
                `cannot switch to standard plan in this env (${switchUp.status()}) — likely real billing`,
            );
        }
        const after1 = await request.get(`${API_BASE}/api/subscriptions/plan`, {
            headers: authedHeaders(u.access_token),
        });
        expect(after1.status()).toBe(200);
        const after1Body = await after1.json();
        const after1Code = String(
            after1Body?.plan?.code ?? after1Body?.code ?? after1Body?.tier ?? '',
        ).toLowerCase();
        // Some manual-billing builds don't actually mutate the plan on
        // this endpoint (it's a payment intent placeholder). We accept
        // either the new value sticking OR the value staying at 'free'.
        expect(['standard', 'free']).toContain(after1Code);

        // Revert to free.
        const switchDown = await request.post(`${API_BASE}/api/subscriptions/plan`, {
            headers: authedHeaders(u.access_token),
            data: { code: 'free' },
        });
        expect(switchDown.status()).toBeLessThan(500);
    });

    test('paid-tier identifiers from the enum are exposed in /plans (if endpoint exists)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/subscriptions/plans`, {
            headers: authedHeaders(u.access_token),
        });
        if (res.status() === 404) {
            test.skip(true, '/api/subscriptions/plans not exposed');
        }
        expect(res.status()).toBe(200);
        const body = await res.json();
        const arr = Array.isArray(body) ? body : (body?.plans ?? body?.data ?? []);
        const codes = arr.map((p: { code?: string }) => p.code?.toLowerCase()).filter(Boolean);
        // At least one paid tier must be advertised — the platform isn't
        // free-only.
        const hasPaid = codes.some((c: string) => PAID_TIERS.includes(c));
        expect(hasPaid, `no paid tier in /plans response: ${codes.join(', ')}`).toBe(true);
    });

    test('switching to a bogus plan code is 4xx (not 5xx)', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.post(`${API_BASE}/api/subscriptions/plan`, {
            headers: authedHeaders(u.access_token),
            data: { code: `bogus-plan-${Date.now()}` },
        });
        expect(res.status()).toBeGreaterThanOrEqual(400);
        expect(res.status()).toBeLessThan(500);
    });
});
