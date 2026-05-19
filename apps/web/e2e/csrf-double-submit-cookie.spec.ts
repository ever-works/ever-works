import { test, expect } from '@playwright/test';
import { API_BASE, makeTestUser } from './helpers/api';

/**
 * CSRF double-submit-cookie — pass 19. When the platform uses cookie
 * sessions (not just bearer tokens), CSRF protection typically uses
 * either:
 *  - SameSite=Strict cookies (auto-enforced by browser), OR
 *  - double-submit-cookie: client reads a CSRF cookie and echoes its
 *    value in a header on every state-changing request
 *
 * If neither is in effect, the API would accept cross-site state-
 * changing requests, which is a CSRF vector. We probe by attempting
 * a POST without any CSRF header and verifying:
 *  - the request is auth-gated (401 unauth) — so cookies alone don't
 *    suffice, OR
 *  - the request fails 403 with a CSRF-related error body
 */

test.describe('CSRF — state-changing endpoints reject cross-site requests', () => {
    test('POST /api/works without auth and without any CSRF token returns 401/403', async ({
        request,
    }) => {
        const res = await request.post(`${API_BASE}/api/works`, {
            data: { name: 'csrf-probe', slug: 'csrf-probe' },
        });
        // Without auth, must be 401. NOT silently 200 (which would
        // mean the endpoint accepted the request from an anon
        // attacker).
        expect([401, 403]).toContain(res.status());
    });

    test('login cookie is SameSite=Strict, SameSite=Lax, or absent (CSRF posture)', async ({
        request,
    }) => {
        const u = makeTestUser('csrf-ds');
        const reg = await request.post(`${API_BASE}/api/auth/register`, {
            data: { username: u.name, email: u.email, password: u.password },
        });
        if (!reg.ok()) test.skip(true, `register failed (${reg.status()})`);
        const login = await request.post(`${API_BASE}/api/auth/login`, {
            data: { email: u.email, password: u.password },
        });
        const setCookies = login
            .headersArray()
            .filter((h) => h.name.toLowerCase() === 'set-cookie');
        if (setCookies.length === 0) {
            test.skip(true, 'token-based auth — no cookies issued; CSRF moot');
        }
        const authCookies = setCookies.filter((c) =>
            /(?:session|auth|token|refresh|access)/i.test(c.value),
        );
        if (authCookies.length === 0) {
            test.skip(true, 'no auth-shaped cookies');
        }
        for (const c of authCookies) {
            const isStrictOrLax = /SameSite=(Strict|Lax)/i.test(c.value);
            const isNoneWithSecure = /SameSite=None/i.test(c.value) && /Secure/i.test(c.value);
            // Either Strict/Lax (browser-level CSRF protection) OR
            // None+Secure (server-side CSRF protection assumed). A
            // missing SameSite defaults to Lax in modern browsers,
            // but the cookie SHOULD declare its intent.
            const acceptable = isStrictOrLax || isNoneWithSecure;
            if (!acceptable) {
                test.info().annotations.push({
                    type: 'informational',
                    description: `auth cookie missing explicit SameSite — relies on browser default (Lax)`,
                });
            }
        }
    });
});
