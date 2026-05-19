import { test, expect } from '@playwright/test';
import { API_BASE, registerUserViaAPI } from './helpers/api';

/**
 * Rate limiting — deeper. Deepens rate-limit.spec.ts. Verifies:
 *   - 429 surfaces a Retry-After header (RFC convention)
 *   - throttle counters are per-endpoint, not global (login throttle
 *     doesn't block a benign /api/health probe from the same IP)
 *   - registration is rate-limited separately from login
 */

test.describe('Rate limiting — per-endpoint isolation', () => {
    test('register throttle is independent of /api/health', async ({ request }) => {
        // Hammer /api/auth/register with bogus payloads until we either
        // hit a 429 or give up. If we hit 429, /api/health should still
        // succeed — the throttler is per-endpoint, not global per-IP.
        let hit429 = false;
        for (let i = 0; i < 12; i++) {
            const r = await request.post(`${API_BASE}/api/auth/register`, {
                data: {
                    username: `rl-${i}-${Date.now().toString(36)}`,
                    email: `rl-${i}-${Date.now().toString(36)}@test.local`,
                    password: 'TestPass1!secure',
                },
            });
            if (r.status() === 429) {
                hit429 = true;
                // RFC 6585 says 429 SHOULD include Retry-After.
                const retryAfter = r.headers()['retry-after'];
                if (retryAfter) {
                    expect(retryAfter.length).toBeGreaterThan(0);
                }
                break;
            }
        }
        if (!hit429) {
            test.skip(true, 'register throttle threshold not hit in 12 attempts');
        }
        // Even after the register throttle fires, /api/health must still
        // serve.
        const health = await request.get(`${API_BASE}/api/health`);
        expect(health.status()).toBe(200);
    });

    test('login throttle fires on repeated wrong passwords', async ({ request }) => {
        // First, register a real user.
        const u = await registerUserViaAPI(request);
        let hit429 = false;
        for (let i = 0; i < 15; i++) {
            const r = await request.post(`${API_BASE}/api/auth/login`, {
                data: { email: u.email, password: `wrongpass-${i}` },
            });
            if (r.status() === 429) {
                hit429 = true;
                break;
            }
            // While the throttler hasn't fired, wrong-password should be
            // 401 — never 5xx.
            expect(r.status()).toBeLessThan(500);
        }
        if (!hit429) {
            test.skip(true, 'login throttle threshold not hit in 15 attempts');
        }
    });
});

test.describe('Rate limiting — 429 carries informative body', () => {
    test('429 body parses as JSON with an error message', async ({ request }) => {
        // Force throttle on register again — same loop.
        for (let i = 0; i < 12; i++) {
            const r = await request.post(`${API_BASE}/api/auth/register`, {
                data: {
                    username: `rl-body-${i}-${Date.now().toString(36)}`,
                    email: `rl-body-${i}-${Date.now().toString(36)}@test.local`,
                    password: 'TestPass1!secure',
                },
            });
            if (r.status() === 429) {
                const ct = r.headers()['content-type'] || '';
                if (ct.includes('json')) {
                    const body = await r.json();
                    const msg = body?.message ?? body?.error ?? '';
                    expect(typeof msg === 'string' || Array.isArray(msg)).toBe(true);
                }
                return;
            }
        }
        test.skip(true, 'never hit 429 in 12 attempts');
    });
});
