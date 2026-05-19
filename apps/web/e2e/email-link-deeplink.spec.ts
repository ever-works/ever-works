import { test, expect } from '@playwright/test';
import { API_BASE } from './helpers/api';

/**
 * Email-link deep-link — pass 20. Magic links, verify-email links,
 * and password-reset links sent in transactional emails should:
 *  - use https in production-shape URLs
 *  - carry an opaque token query parameter (not a guessable id)
 *  - never include the user's password in any form
 *
 * We can't intercept the actual email — but we can probe the
 * endpoints that GENERATE these links (forgot-password,
 * send-verification) and inspect the response shape for leaked
 * link/token values.
 */

test.describe("Email link deep-link — generation endpoints don't leak credentials", () => {
    test('POST /api/auth/forgot-password response never echoes the password', async ({
        request,
    }) => {
        const res = await request.post(`${API_BASE}/api/auth/forgot-password`, {
            data: {
                email: `forgot-${Date.now().toString(36)}@test.local`,
            },
        });
        expect(res.status()).toBeLessThan(500);
        const body = await res.text();
        // The response must NOT contain the literal "password" with
        // a value next to it. Allow the WORD "password" (e.g.,
        // "password reset email sent") but not any cred shape.
        expect(
            /"password"\s*:\s*"[^"]+"/.test(body),
            'forgot-password response leaked a password field value',
        ).toBe(false);
        // Also no plaintext token shapes returned directly to client.
        // (Tokens belong only in the emailed link.)
        expect(
            /"token"\s*:\s*"[A-Za-z0-9_-]{20,}"/.test(body),
            'forgot-password response leaked token directly in body — should be email-only',
        ).toBe(false);
    });

    test("POST /api/auth/send-verification response doesn't leak the verification token", async ({
        request,
    }) => {
        const res = await request.post(`${API_BASE}/api/auth/send-verification`, {
            data: { email: `verify-${Date.now().toString(36)}@test.local` },
        });
        expect(res.status()).toBeLessThan(500);
        const body = await res.text();
        expect(
            /"token"\s*:\s*"[A-Za-z0-9_-]{20,}"/.test(body),
            'send-verification response leaked token directly in body',
        ).toBe(false);
    });

    test('reset-password endpoint rejects non-https deep-link tokens (or skip)', async ({
        request,
    }) => {
        // Probe with empty + bogus tokens — both 4xx, never 5xx.
        const bogusTokens = ['', 'http://evil.example/leak-token', 'javascript:void(0)'];
        for (const t of bogusTokens) {
            const res = await request.post(`${API_BASE}/api/auth/reset-password`, {
                data: {
                    token: t,
                    password: 'Brand1New#Pass-secure',
                    newPassword: 'Brand1New#Pass-secure',
                },
            });
            expect(
                res.status(),
                `bogus token "${t.slice(0, 30)}" crashed: ${res.status()}`,
            ).toBeLessThan(500);
            expect(res.status()).toBeGreaterThanOrEqual(400);
        }
    });
});
