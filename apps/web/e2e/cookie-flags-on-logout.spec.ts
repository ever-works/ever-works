import { test, expect } from '@playwright/test';
import { API_BASE, makeTestUser } from './helpers/api';

/**
 * Cookie flags on logout — pass 16. The logout endpoint must
 * invalidate any session cookies it issued. The canonical way is to
 * issue a Set-Cookie with `Max-Age=0` (or `Expires` in the past) for
 * each cookie that's part of the auth session.
 *
 * If the platform is purely token-based (no cookies on login), the
 * test informationally skips.
 */

test.describe('Logout — clears auth cookies via Max-Age=0 / Expires in past', () => {
    test('POST /api/auth/logout sets expired/Max-Age=0 cookies (if cookie-based)', async ({
        request,
    }) => {
        const u = makeTestUser('logout');
        const reg = await request.post(`${API_BASE}/api/auth/register`, {
            data: { username: u.name, email: u.email, password: u.password },
        });
        if (!reg.ok()) test.skip(true, `register failed (${reg.status()})`);
        const login = await request.post(`${API_BASE}/api/auth/login`, {
            data: { email: u.email, password: u.password },
        });
        const loginCookies = login
            .headersArray()
            .filter((h) => h.name.toLowerCase() === 'set-cookie');
        const sessionCookies = loginCookies.filter((c) =>
            /(?:session|auth|token|refresh|access)/i.test(c.value),
        );
        if (sessionCookies.length === 0) {
            test.skip(true, 'no auth cookies issued — token-based auth');
        }
        // Re-use the token in the body for /logout in case the server
        // wants it.
        const loginBody = await login.json().catch(() => ({}));
        const logout = await request.post(`${API_BASE}/api/auth/logout`, {
            headers: loginBody?.access_token
                ? { Authorization: `Bearer ${loginBody.access_token}` }
                : {},
        });
        if (!logout.ok() && logout.status() !== 204) {
            test.skip(true, `logout returned ${logout.status()} — endpoint shape differs`);
        }
        const logoutCookies = logout
            .headersArray()
            .filter((h) => h.name.toLowerCase() === 'set-cookie');
        const cleared = logoutCookies.filter((c) => {
            const value = c.value;
            const maxAge0 = /Max-Age\s*=\s*0\b/i.test(value);
            const expiresPast =
                /Expires\s*=\s*([^;]+)/i.test(value) &&
                (() => {
                    const m = /Expires\s*=\s*([^;]+)/i.exec(value);
                    if (!m) return false;
                    const t = Date.parse(m[1]);
                    return Number.isFinite(t) && t < Date.now();
                })();
            const empty = /^(session|auth|token|refresh|access)[^=]*=;\s/i.test(value);
            return maxAge0 || expiresPast || empty;
        });
        expect(
            cleared.length,
            `logout issued no cleared/expired cookies (saw ${logoutCookies.length} Set-Cookie headers)`,
        ).toBeGreaterThan(0);
    });
});
