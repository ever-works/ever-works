import { test, expect } from '@playwright/test';
import { API_BASE } from './helpers/api';

/**
 * Password reset — edge cases beyond the happy path covered by
 * password-reset.spec.ts. Pins:
 *
 *   - Bogus token → 4xx (not 5xx)
 *   - Expired token shape (we can't time-travel, but we can validate
 *     the validation endpoint shape).
 *   - Forgot-password is timing-uniform (H-03 hardening) — same wall
 *     time regardless of whether the email exists.
 */

test.describe('Password reset — edge cases', () => {
    test('POST /api/auth/reset-password with bogus token → 4xx (not 5xx)', async ({ request }) => {
        const res = await request.post(`${API_BASE}/api/auth/reset-password`, {
            data: {
                token: 'definitely-not-a-real-token-' + Date.now(),
                newPassword: 'NewPass1!secure',
            },
        });
        expect(res.status()).toBeLessThan(500);
        expect([400, 401, 403, 404, 410, 422]).toContain(res.status());
    });

    test('GET /api/auth/validate-reset-token with bogus token returns valid=false', async ({
        request,
    }) => {
        const res = await request.get(
            `${API_BASE}/api/auth/validate-reset-token?token=bogus-${Date.now()}`,
        );
        expect(res.status()).toBeLessThan(500);
        if (res.status() === 200) {
            const body = await res.json();
            expect(body?.valid).toBe(false);
        }
    });

    test('GET /api/auth/validate-reset-token with empty token returns 4xx (H-01 guard)', async ({
        request,
    }) => {
        const res = await request.get(`${API_BASE}/api/auth/validate-reset-token?token=`);
        expect([400, 422]).toContain(res.status());
    });

    test('POST /api/auth/forgot-password is timing-uniform regardless of existence (H-03)', async ({
        request,
    }) => {
        // Same wall-clock time bucket (within an order of magnitude) for
        // a real-shaped email and an obviously-fake one. We're not testing
        // a tight bound — just that no obvious side-channel exists.
        const t0 = Date.now();
        await request.post(`${API_BASE}/api/auth/forgot-password`, {
            data: { email: `definitely-doesnt-exist-${Date.now()}@test.local` },
        });
        const t1 = Date.now();
        const fakeMs = t1 - t0;

        const t2 = Date.now();
        await request.post(`${API_BASE}/api/auth/forgot-password`, {
            data: { email: 'evereq+test@gmail.com' },
        });
        const t3 = Date.now();
        const realShapedMs = t3 - t2;

        // Order-of-magnitude check. If real existing-email is 10x slower
        // than non-existing, there's an obvious side-channel.
        expect(realShapedMs).toBeLessThan(fakeMs * 10 + 2000);
    });
});

test.describe('Email verification — edge cases', () => {
    test('GET /api/auth/validate-email-token with bogus token returns valid=false', async ({
        request,
    }) => {
        const res = await request.get(
            `${API_BASE}/api/auth/validate-email-token?token=bogus-${Date.now()}`,
        );
        expect(res.status()).toBeLessThan(500);
        if (res.status() === 200) {
            const body = await res.json();
            expect(body?.valid).toBe(false);
        }
    });

    test('GET /api/auth/validate-email-token with empty token returns 4xx (H-01 guard)', async ({
        request,
    }) => {
        const res = await request.get(`${API_BASE}/api/auth/validate-email-token?token=`);
        expect([400, 422]).toContain(res.status());
    });

    test('POST /api/auth/verify-email with bogus token → 4xx', async ({ request }) => {
        const res = await request.post(`${API_BASE}/api/auth/verify-email`, {
            data: { token: 'bogus-' + Date.now() },
        });
        expect(res.status()).toBeLessThan(500);
        expect([200]).not.toContain(res.status());
    });
});
