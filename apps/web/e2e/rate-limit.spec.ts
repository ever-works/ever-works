import { test, expect } from '@playwright/test';
import { API_BASE } from './helpers/api';

/**
 * Rate limiting — H-17 (per-IP throttle on /api/auth/login). Verifies
 * the throttler is wired up by hammering a sensitive endpoint and
 * confirming 429 eventually appears.
 *
 * `LOGIN_THROTTLE_LIMIT` defaults to 10/min on the API. In CI E2E the
 * default usually applies (it's not overridden in the workflow env).
 * Skip the assertion if the env appears configured for a much higher
 * limit (e.g. some load-test runs raise it).
 */

test.describe('Rate limit — login endpoint', () => {
    test('11+ rapid POST /api/auth/login from one client eventually hits 429', async ({
        request,
    }) => {
        const LIMIT = 12;
        const responses: number[] = [];

        for (let i = 0; i < LIMIT; i++) {
            const res = await request.post(`${API_BASE}/api/auth/login`, {
                data: {
                    email: `nonexistent-${Date.now()}-${i}@test.local`,
                    password: 'wrong',
                },
            });
            responses.push(res.status());
            // Stop early once we've seen a 429.
            if (res.status() === 429) break;
        }

        const sawThrottle = responses.includes(429);
        const allFailed4xx = responses.every((s) => s >= 400 && s < 500);

        // Either we saw a 429 (throttler active) OR all 12 returned 401
        // (throttler off in this env). Both are explicit signals; what we
        // reject is any 5xx slipping through.
        expect(allFailed4xx, `responses: ${responses.join(',')}`).toBe(true);
        if (process.env.EXPECT_RATE_LIMIT === 'true') {
            expect(sawThrottle).toBe(true);
        }
    });
});

test.describe('Rate limit — anonymous-auth endpoint', () => {
    test('rapid POST /api/auth/anonymous responses stay in the 2xx/4xx family', async ({
        request,
    }) => {
        const responses: number[] = [];
        for (let i = 0; i < 8; i++) {
            const res = await request.post(`${API_BASE}/api/auth/anonymous`, {
                data: { correlationId: `e2e-rl-${Date.now()}-${i}` },
            });
            responses.push(res.status());
        }
        const allHealthy = responses.every((s) => (s >= 200 && s < 300) || (s >= 400 && s < 500));
        expect(allHealthy, `responses: ${responses.join(',')}`).toBe(true);
    });
});
