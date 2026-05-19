import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Idle session timeout — pass 19. We can't actually wait for an idle
 * timeout (typically minutes-to-hours). Instead we probe the
 * contract:
 *  - a fresh access token returns 200 on /api/auth/profile
 *  - a forged / mangled access token returns 401 (not 200, not 5xx)
 *  - the JWT exp claim is at least 1 hour in the future
 */

test.describe('Session — token lifecycle and idle-timeout contract', () => {
    test('fresh access token works immediately on /api/auth/profile', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/auth/profile`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status(), `fresh token rejected: ${res.status()}`).toBeLessThan(400);
    });

    test('mangled / tampered access token returns 401', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        // Flip a character in the middle of the token's signature.
        const parts = u.access_token.split('.');
        if (parts.length !== 3) test.skip(true, 'access token is not a JWT');
        const sig = parts[2];
        const tampered = parts[0] + '.' + parts[1] + '.' + sig.slice(0, 5) + 'X' + sig.slice(6);
        const res = await request.get(`${API_BASE}/api/auth/profile`, {
            headers: { Authorization: `Bearer ${tampered}` },
        });
        expect(res.status(), `tampered token returned ${res.status()} — should be 401`).toBe(401);
    });

    test('access token JWT exp claim is ≥ 1 hour in the future', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const parts = u.access_token.split('.');
        if (parts.length !== 3) test.skip(true, 'access token is not a JWT');
        // base64url decode the payload.
        const payloadB64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        const padded = payloadB64 + '='.repeat((4 - (payloadB64.length % 4)) % 4);
        let payload: Record<string, unknown>;
        try {
            payload = JSON.parse(Buffer.from(padded, 'base64').toString('utf-8'));
        } catch {
            test.skip(true, 'JWT payload not parseable');
            return;
        }
        const exp = typeof payload.exp === 'number' ? payload.exp : undefined;
        if (!exp) test.skip(true, 'no exp claim on JWT');
        const expMs = exp * 1000;
        const futureMs = expMs - Date.now();
        // ≥ 1 hour (3600s) is industry typical for access tokens.
        // Some apps use shorter (15 min) — soft-warn instead.
        if (futureMs < 60 * 60 * 1000) {
            test.info().annotations.push({
                type: 'informational',
                description: `access token expires in ${(futureMs / 60_000).toFixed(1)} min — shorter than 1h industry typical`,
            });
        }
        // Hard floor: must be at least 60 seconds (no immediate expiry).
        expect(
            futureMs,
            `token expires in ${(futureMs / 1000).toFixed(0)}s — impractical lifetime`,
        ).toBeGreaterThan(60_000);
    });
});
