import { test, expect } from '@playwright/test';
import { API_BASE, makeTestUser } from './helpers/api';

/**
 * Secure-cookies on HTTPS — pass 14. Session / auth cookies set by
 * the platform must carry `Secure` (only sent over HTTPS) and
 * `HttpOnly` (no JS access) when running behind https. Over plain
 * http we skip, since `Secure` would prevent the cookie from being
 * sent at all in dev.
 */

test.describe('Cookies — Secure + HttpOnly attributes', () => {
    test('login response sets HttpOnly on auth cookies', async ({ request }) => {
        const u = makeTestUser('cookie');
        // Register so login has something to authenticate against.
        const reg = await request.post(`${API_BASE}/api/auth/register`, {
            data: { username: u.name, email: u.email, password: u.password },
        });
        if (!reg.ok()) test.skip(true, `register failed (${reg.status()})`);
        const res = await request.post(`${API_BASE}/api/auth/login`, {
            data: { email: u.email, password: u.password },
        });
        const setCookies = res.headersArray().filter((h) => h.name.toLowerCase() === 'set-cookie');
        if (setCookies.length === 0) {
            test.skip(true, 'login does not set cookies — token-only auth');
        }
        // For every Set-Cookie that looks like a session/auth cookie,
        // HttpOnly should be set.
        const authCookies = setCookies.filter((c) =>
            /(?:session|auth|token|refresh|access)/i.test(c.value),
        );
        if (authCookies.length === 0) {
            test.skip(true, 'no auth-shaped cookies set by login');
        }
        for (const c of authCookies) {
            expect(
                /HttpOnly/i.test(c.value),
                `auth cookie missing HttpOnly: ${c.value.slice(0, 80)}`,
            ).toBe(true);
        }
    });

    test('over HTTPS, auth cookies carry Secure attribute', async ({ request }) => {
        if (!API_BASE.startsWith('https://')) {
            test.skip(true, 'API_BASE is http — Secure attribute would block cookies in dev');
        }
        const u = makeTestUser('cookie-https');
        const reg = await request.post(`${API_BASE}/api/auth/register`, {
            data: { username: u.name, email: u.email, password: u.password },
        });
        if (!reg.ok()) test.skip(true, `register failed (${reg.status()})`);
        const res = await request.post(`${API_BASE}/api/auth/login`, {
            data: { email: u.email, password: u.password },
        });
        const setCookies = res.headersArray().filter((h) => h.name.toLowerCase() === 'set-cookie');
        const authCookies = setCookies.filter((c) =>
            /(?:session|auth|token|refresh|access)/i.test(c.value),
        );
        if (authCookies.length === 0) {
            test.skip(true, 'no auth-shaped cookies on this env');
        }
        for (const c of authCookies) {
            expect(
                /Secure/i.test(c.value),
                `auth cookie missing Secure on https: ${c.value.slice(0, 80)}`,
            ).toBe(true);
        }
    });

    test('SameSite is set to Lax or Strict (CSRF defense)', async ({ request }) => {
        const u = makeTestUser('cookie-samesite');
        const reg = await request.post(`${API_BASE}/api/auth/register`, {
            data: { username: u.name, email: u.email, password: u.password },
        });
        if (!reg.ok()) test.skip(true, `register failed (${reg.status()})`);
        const res = await request.post(`${API_BASE}/api/auth/login`, {
            data: { email: u.email, password: u.password },
        });
        const setCookies = res.headersArray().filter((h) => h.name.toLowerCase() === 'set-cookie');
        const authCookies = setCookies.filter((c) =>
            /(?:session|auth|token|refresh|access)/i.test(c.value),
        );
        if (authCookies.length === 0) {
            test.skip(true, 'no auth cookies set');
        }
        for (const c of authCookies) {
            // Greptile P2: SameSite=None without Secure is invalid —
            // RFC 6265bis says browsers must downgrade to Lax or reject
            // it. Require either SameSite=Lax/Strict, OR
            // SameSite=None + Secure as the only acceptable combos.
            const laxOrStrict = /SameSite=(Lax|Strict)/i.test(c.value);
            const noneWithSecure = /SameSite=None/i.test(c.value) && /Secure/i.test(c.value);
            expect(
                laxOrStrict || noneWithSecure,
                `auth cookie has unsafe SameSite/Secure combo: ${c.value.slice(0, 120)}`,
            ).toBe(true);
        }
    });
});
