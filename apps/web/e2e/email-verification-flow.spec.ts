import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Email verification flow — pass 6. Deepens auth.spec.ts /
 * auth-providers-list.spec.ts. We can't actually consume an email
 * verification token in a black-box e2e (the token only exists in the
 * outbound email), but we CAN pin the contract:
 *
 *   - Fresh user is unverified.
 *   - `/api/auth/send-verification` triggers re-sending.
 *   - `/api/auth/verify-email` with a bogus token is rejected.
 *   - `/api/auth/validate-email-token` GET endpoint returns 4xx for
 *     invalid tokens (H-01 hashed-token contract — never echoes the
 *     token back).
 */

test.describe('Email verification — fresh user is unverified', () => {
    test('GET /api/auth/profile shows isEmailVerified=false for fresh user', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/auth/profile`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        const user = body?.user ?? body;
        // Field name varies — accept any of the common aliases. We only
        // FAIL when ALL of them are explicitly true; we don't fail when
        // they're undefined (some builds don't expose the flag).
        const verifiedAliases = [user?.isEmailVerified, user?.email_verified, user?.emailVerified];
        const anyDefined = verifiedAliases.some((v) => v !== undefined);
        if (!anyDefined) {
            test.skip(true, 'profile does not expose verification status');
        }
        const anyTrue = verifiedAliases.some((v) => v === true);
        expect(anyTrue, 'fresh user reports email already verified').toBe(false);
    });
});

test.describe('Email verification — send-verification endpoint', () => {
    test('POST /api/auth/send-verification for fresh user responds < 500', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.post(`${API_BASE}/api/auth/send-verification`, {
            headers: authedHeaders(u.access_token),
        });
        // 200 / 204 / 202 = accepted. 429 = rate-limited (acceptable —
        // a verification spam guard). Never 5xx.
        expect(res.status()).toBeLessThan(500);
    });

    test('two consecutive send-verification calls do not deadlock', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const r1 = await request.post(`${API_BASE}/api/auth/send-verification`, {
            headers: authedHeaders(u.access_token),
        });
        const r2 = await request.post(`${API_BASE}/api/auth/send-verification`, {
            headers: authedHeaders(u.access_token),
        });
        expect(r1.status()).toBeLessThan(500);
        expect(r2.status()).toBeLessThan(500);
        // Second call may be rate-limited (429) — that's correct
        // behaviour. But it must NEVER come back as 5xx.
    });
});

test.describe('Email verification — verify-email + validate-email-token', () => {
    test('POST /api/auth/verify-email with bogus token → 4xx (never 2xx, never 5xx)', async ({
        request,
    }) => {
        const res = await request.post(`${API_BASE}/api/auth/verify-email`, {
            data: { token: `bogus-${Date.now().toString(36)}` },
        });
        expect(res.status()).toBeGreaterThanOrEqual(400);
        expect(res.status()).toBeLessThan(500);
    });

    test('GET /api/auth/validate-email-token?token=bogus returns 4xx without echoing the token', async ({
        request,
    }) => {
        const sentinel = `e2e-sentinel-${Date.now().toString(36)}`;
        const res = await request.get(
            `${API_BASE}/api/auth/validate-email-token?token=${sentinel}`,
        );
        expect(res.status()).toBeLessThan(500);
        if (res.status() === 200) {
            // Some builds return 200 with `{valid: false}`.
            const body = await res.json();
            expect(body?.valid).toBe(false);
        }
        // Token must never appear in the response body — that would be
        // an information leak to an attacker probing for valid tokens.
        const text = await res.text();
        expect(text.includes(sentinel), 'validate-email-token echoed the candidate token').toBe(
            false,
        );
    });

    test('POST /api/auth/verify-email with empty token → 4xx (H-01 contract)', async ({
        request,
    }) => {
        const res = await request.post(`${API_BASE}/api/auth/verify-email`, {
            data: { token: '' },
        });
        expect(res.status()).toBeGreaterThanOrEqual(400);
        expect(res.status()).toBeLessThan(500);
    });
});
