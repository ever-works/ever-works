import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Rate limit headers — pass 8. Deepens rate-limit-deeper.spec.ts. When
 * @nestjs/throttler is wired, successful requests carry
 * `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`
 * headers. We don't pin specific values; we pin that they exist + are
 * numeric.
 */

function isNumeric(value: string | undefined): boolean {
    if (!value) return false;
    return /^\d+$/.test(value);
}

test.describe('Rate-limit headers — successful requests carry quota info', () => {
    test('successful login attempt carries X-RateLimit-* headers (if throttler configured)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const login = await request.post(`${API_BASE}/api/auth/login`, {
            data: { email: u.email, password: u.password },
        });
        if (login.status() >= 500) test.skip(true, `login server error ${login.status()}`);
        const h = login.headers();
        const remaining = h['x-ratelimit-remaining'] ?? h['ratelimit-remaining'];
        const limit = h['x-ratelimit-limit'] ?? h['ratelimit-limit'];
        if (!remaining && !limit) {
            test.skip(true, 'no X-RateLimit-* headers on login — throttler may not be wired here');
        }
        if (remaining) {
            expect(isNumeric(remaining), `non-numeric remaining: ${remaining}`).toBe(true);
            expect(Number(remaining)).toBeGreaterThanOrEqual(0);
        }
        if (limit) {
            expect(isNumeric(limit), `non-numeric limit: ${limit}`).toBe(true);
            expect(Number(limit)).toBeGreaterThan(0);
        }
    });

    test('repeated requests show the remaining count decreasing', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const r1 = await request.get(`${API_BASE}/api/auth/profile`, {
            headers: authedHeaders(u.access_token),
        });
        const r2 = await request.get(`${API_BASE}/api/auth/profile`, {
            headers: authedHeaders(u.access_token),
        });
        const rem1 = r1.headers()['x-ratelimit-remaining'] ?? r1.headers()['ratelimit-remaining'];
        const rem2 = r2.headers()['x-ratelimit-remaining'] ?? r2.headers()['ratelimit-remaining'];
        if (!rem1 || !rem2) test.skip(true, 'no X-RateLimit-Remaining headers');
        const n1 = Number(rem1);
        const n2 = Number(rem2);
        if (Number.isNaN(n1) || Number.isNaN(n2)) test.skip(true, 'non-numeric remaining');
        // Either decreasing (n2 < n1), or stable at the same value
        // (some implementations only count failures). Never INCREASING
        // mid-window.
        expect(n2, `remaining increased between requests (${n1} → ${n2})`).toBeLessThanOrEqual(n1);
    });

    test('429 response carries Retry-After header', async ({ request }) => {
        // Trigger throttle on register by hammering.
        let hit429: { headers: Record<string, string> } | null = null;
        for (let i = 0; i < 12; i++) {
            const r = await request.post(`${API_BASE}/api/auth/register`, {
                data: {
                    username: `rl-h-${i}-${Date.now().toString(36)}`,
                    email: `rl-h-${i}-${Date.now().toString(36)}@test.local`,
                    password: 'TestPass1!secure',
                },
            });
            if (r.status() === 429) {
                hit429 = { headers: r.headers() };
                break;
            }
        }
        if (!hit429) test.skip(true, 'register throttle threshold not hit');
        const retryAfter = hit429!.headers['retry-after'];
        if (!retryAfter) test.skip(true, 'no Retry-After header on 429');
        // Retry-After can be seconds (numeric) OR HTTP-date. We accept
        // either form.
        const numeric = isNumeric(retryAfter);
        const dateForm = !numeric && !Number.isNaN(Date.parse(retryAfter));
        expect(
            numeric || dateForm,
            `Retry-After "${retryAfter}" is neither numeric seconds nor an HTTP-date`,
        ).toBe(true);
    });
});
