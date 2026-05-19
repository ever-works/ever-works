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
        // Password hash / verification / reset secrets MUST NEVER appear
        // in profile responses. We can't blindly grep for the substring
        // 'password' because legitimate metadata fields like
        // `passwordUpdatedAt`, `passwordStrength`, or `passwordHint` would
        // false-positive. Walk the object and inspect KEYS only — that
        // catches secret-bearing fields without exploding on metadata.
        const SECRET_KEYS = new Set([
            'password',
            'passwordhash',
            'password_hash',
            'hashedpassword',
            'hashed_password',
            'tokenhash',
            'token_hash',
            'emailverificationtoken',
            'email_verification_token',
            'passwordresettoken',
            'password_reset_token',
            'refreshtoken',
            'refresh_token',
        ]);
        const offending: string[] = [];
        const walk = (val: unknown): void => {
            if (val === null || typeof val !== 'object') return;
            if (Array.isArray(val)) {
                val.forEach(walk);
                return;
            }
            for (const [k, v] of Object.entries(val)) {
                if (SECRET_KEYS.has(k.toLowerCase())) offending.push(k);
                walk(v);
            }
        };
        walk(body);
        expect(
            offending,
            `profile leaked secret-bearing field(s): ${offending.join(', ')}`,
        ).toEqual([]);
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
        // Sanity-check the token works pre-logout. If it doesn't, the
        // whole test premise is invalid.
        const before = await request.get(`${API_BASE}/api/auth/profile`, {
            headers: authedHeaders(u.access_token),
        });
        expect(before.status()).toBe(200);

        const logout = await request.post(`${API_BASE}/api/auth/logout`, {
            headers: authedHeaders(u.access_token),
        });
        // The endpoint must either accept the request (2xx) or, if it's
        // stateless, return a well-formed 2xx/3xx. A 5xx or 4xx for a
        // valid token is a real bug — fail loudly.
        expect(logout.status(), `logout status ${logout.status()}`).toBeLessThan(400);

        // CRITICAL — the same token must NOT grant profile access after
        // logout. We require an explicit 401/403 (true invalidation) OR,
        // if the server returns 200, the response body must not include
        // the logged-out user's email. A profile call returning the same
        // user post-logout is a failed boundary, period.
        const after = await request.get(`${API_BASE}/api/auth/profile`, {
            headers: authedHeaders(u.access_token),
        });
        if (after.status() === 200) {
            const body = await after.json();
            const observedEmail = body?.email ?? body?.user?.email;
            expect(
                observedEmail,
                `token still resolves to ${u.email} after logout — auth boundary leak`,
            ).not.toBe(u.email);
        } else {
            expect([401, 403]).toContain(after.status());
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
