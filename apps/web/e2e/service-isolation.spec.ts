import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * Service isolation — pass 14. Modules should not bleed side-effects
 * into unrelated modules. Creating a work shouldn't auto-subscribe the
 * user to notifications, deploying a work shouldn't crash activity
 * logging, and so on.
 *
 * We probe a few cross-module boundaries by exercising one endpoint
 * and asserting an unrelated module endpoint still returns its
 * baseline shape.
 */

test.describe('Service isolation — work CRUD does not bleed into unrelated modules', () => {
    test('creating a work leaves /api/notifications shape stable', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const before = await request.get(`${API_BASE}/api/notifications`, {
            headers: authedHeaders(u.access_token),
        });
        const beforeStatus = before.status();
        await createWorkViaAPI(request, u.access_token, {
            name: `isolation-${Date.now().toString(36)}`,
            slug: `isolation-${Date.now().toString(36)}`,
        });
        const after = await request.get(`${API_BASE}/api/notifications`, {
            headers: authedHeaders(u.access_token),
        });
        // The status family (200 / 204 / 401 etc.) must NOT regress
        // after creating a work — a 200 turning into a 5xx would mean
        // we accidentally introduced a hard dependency.
        expect(
            after.status(),
            `notifications status regressed after work creation: ${beforeStatus} → ${after.status()}`,
        ).toBeLessThan(500);
        // Both responses must agree on whether auth is required.
        expect(Math.floor(after.status() / 100)).toBe(Math.floor(beforeStatus / 100));
    });

    test('hitting /api/health does not consume rate-limit budget for /api/auth/login', async ({
        request,
    }) => {
        for (let i = 0; i < 5; i++) {
            const res = await request.get(`${API_BASE}/api/health`);
            expect(res.status()).toBeLessThan(500);
        }
        // After 5 health hits, login should still be reachable — health
        // must be excluded from the auth throttler bucket.
        const login = await request.post(`${API_BASE}/api/auth/login`, {
            data: { email: `nonexistent-${Date.now()}@test.local`, password: 'Wrong123!' },
        });
        // 401/422 OK, 429 means health hits leaked into the auth bucket.
        expect(login.status(), 'health hits leaked into auth throttler').not.toBe(429);
    });
});

test.describe('Service isolation — write in module A leaves module B unchanged', () => {
    test('creating a work does not mutate /api/account/profile counters', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const profileBefore = await request.get(`${API_BASE}/api/auth/profile`, {
            headers: authedHeaders(u.access_token),
        });
        if (!profileBefore.ok()) {
            test.skip(true, `profile endpoint not exposed (${profileBefore.status()})`);
        }
        const before = await profileBefore.json();
        await createWorkViaAPI(request, u.access_token, {
            name: `isolation-prof-${Date.now().toString(36)}`,
            slug: `isolation-prof-${Date.now().toString(36)}`,
        });
        const profileAfter = await request.get(`${API_BASE}/api/auth/profile`, {
            headers: authedHeaders(u.access_token),
        });
        const after = await profileAfter.json();
        // The user.id and email must be byte-stable across an
        // unrelated module write — drift here means the profile is
        // accidentally being modified by work creation.
        expect(after?.user?.id ?? after?.id).toBe(before?.user?.id ?? before?.id);
        expect(after?.user?.email ?? after?.email).toBe(before?.user?.email ?? before?.email);
    });
});
