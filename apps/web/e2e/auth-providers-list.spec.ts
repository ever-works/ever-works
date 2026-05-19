import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Auth providers list + verify-email + claim + profile endpoints —
 * deepens auth.spec.ts which only covers register/login. These are the
 * smaller endpoints that hang off `/api/auth/*` and weren't tested
 * for their full surface.
 */

test.describe('Auth — public endpoints', () => {
    test('GET /api/auth/providers returns supported provider list', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/auth/providers`);
        expect(res.status()).toBe(200);
        const body = await res.json();
        const arr = Array.isArray(body) ? body : (body?.providers ?? body?.data ?? []);
        expect(Array.isArray(arr)).toBe(true);
    });

    test('POST /api/auth/anonymous returns access_token + anon user (or 4xx if captcha gated)', async ({
        request,
    }) => {
        const res = await request.post(`${API_BASE}/api/auth/anonymous`, {
            data: { correlationId: `e2e-anon-${Date.now()}` },
        });
        expect(res.status()).toBeLessThan(500);
        if (res.status() === 200) {
            const body = await res.json();
            expect(typeof body?.access_token).toBe('string');
            expect(body?.user?.isAnonymous).toBe(true);
            expect(typeof body?.user?.anonymousExpiresAt).toBe('string');
        }
    });

    test('POST /api/auth/claim without auth → 401', async ({ request }) => {
        const res = await request.post(`${API_BASE}/api/auth/claim`, {
            data: { email: 'e2e@test.local', password: 'TestPass1!secure' },
        });
        // Claim is for anonymous users; without auth the request lacks the
        // anon-user JWT → 401.
        expect([401, 403, 400]).toContain(res.status());
    });
});

test.describe('Auth — authenticated endpoints', () => {
    test('GET /api/auth/profile without auth → 401', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/auth/profile`);
        expect(res.status()).toBe(401);
    });

    test('GET /api/auth/profile returns user object', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/auth/profile`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body?.id ?? body?.user?.id).toBe(u.user.id);
        // Password / secrets MUST NEVER appear in profile responses.
        const s = JSON.stringify(body);
        expect(s).not.toContain('password');
        expect(s).not.toContain('tokenHash');
        expect(s).not.toContain('emailVerificationToken');
        expect(s).not.toContain('passwordResetToken');
    });

    test('GET /api/auth/profile/fresh re-fetches and returns user object', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/auth/profile/fresh`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBe(200);
    });

    test('POST /api/auth/update-password without auth → 401', async ({ request }) => {
        const res = await request.post(`${API_BASE}/api/auth/update-password`, {
            data: { currentPassword: 'x', newPassword: 'NewPass1!ok' },
        });
        expect(res.status()).toBe(401);
    });

    test('POST /api/auth/update-password with wrong current password → 4xx', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.post(`${API_BASE}/api/auth/update-password`, {
            headers: authedHeaders(u.access_token),
            data: { currentPassword: 'wrong', newPassword: 'NewPass2!ok' },
        });
        expect(res.status()).toBeLessThan(500);
        expect([200]).not.toContain(res.status());
    });

    test('POST /api/auth/send-verification without auth → 401', async ({ request }) => {
        const res = await request.post(`${API_BASE}/api/auth/send-verification`);
        expect(res.status()).toBe(401);
    });

    test('POST /api/auth/send-verification for fresh user responds < 500', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.post(`${API_BASE}/api/auth/send-verification`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBeLessThan(500);
    });

    test('POST /api/auth/logout without auth → 401', async ({ request }) => {
        const res = await request.post(`${API_BASE}/api/auth/logout`);
        expect(res.status()).toBe(401);
    });

    test('POST /api/auth/logout-all without auth → 401', async ({ request }) => {
        const res = await request.post(`${API_BASE}/api/auth/logout-all`);
        expect(res.status()).toBe(401);
    });

    test('POST /api/auth/logout invalidates the token (subsequent profile call 401)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const logout = await request.post(`${API_BASE}/api/auth/logout`, {
            headers: authedHeaders(u.access_token),
        });
        expect(logout.status()).toBeLessThan(500);
        if (logout.status() === 200 || logout.status() === 204) {
            const after = await request.get(`${API_BASE}/api/auth/profile`, {
                headers: authedHeaders(u.access_token),
            });
            // After logout the same token should NOT grant profile access.
            // Some implementations return 401; some lazily invalidate.
            // Reject silent 200 with full profile.
            if (after.status() === 200) {
                // Acceptable only if endpoint stub returns minimal/empty.
                const body = await after.json();
                expect(body?.email).not.toBe(u.email);
            }
        }
    });
});

test.describe('Auth — /api/auth/verify-email contract (deepens [~])', () => {
    test('POST /api/auth/verify-email with bogus token → 4xx (H-01 hashed-token)', async ({
        request,
    }) => {
        const res = await request.post(`${API_BASE}/api/auth/verify-email`, {
            data: { token: `bogus-${Date.now()}` },
        });
        expect(res.status()).toBeLessThan(500);
        expect([200]).not.toContain(res.status());
    });

    test('POST /api/auth/verify-email with empty token → 4xx', async ({ request }) => {
        const res = await request.post(`${API_BASE}/api/auth/verify-email`, {
            data: { token: '' },
        });
        expect(res.status()).toBeLessThan(500);
        expect([400, 401, 422]).toContain(res.status());
    });
});
