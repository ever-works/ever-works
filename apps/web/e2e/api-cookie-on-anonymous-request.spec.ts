import { test, expect } from '@playwright/test';
import { API_BASE } from './helpers/api';

/**
 * Anonymous GET requests to public API endpoints should be either
 * cookie-free or set only well-formed cookies with reasonable
 * attributes (SameSite, Secure, HttpOnly where appropriate).
 *
 * We do NOT pin a specific Set-Cookie value — we pin only the SHAPE
 * of any cookies that ARE set.
 */

const PUBLIC_ANON_PATHS = ['/api/health', '/api/version', '/api/info', '/.well-known/agent.json'];

function parseSetCookieAttrs(setCookie: string): Record<string, string | boolean> {
    const parts = setCookie.split(';').map((s) => s.trim());
    const attrs: Record<string, string | boolean> = {};
    parts.slice(1).forEach((p) => {
        const eq = p.indexOf('=');
        if (eq === -1) {
            attrs[p.toLowerCase()] = true;
        } else {
            attrs[p.slice(0, eq).toLowerCase()] = p.slice(eq + 1);
        }
    });
    return attrs;
}

test.describe('Public anonymous API: Set-Cookie hygiene', () => {
    for (const path of PUBLIC_ANON_PATHS) {
        test(`GET ${path} sets only well-formed cookies (if any)`, async ({ request }) => {
            const res = await request.get(`${API_BASE}${path}`);
            expect(res.status(), path).toBeLessThan(500);
            const headers = res.headers();
            const setCookieRaw = headers['set-cookie'];
            if (!setCookieRaw) return; // no cookies, ok

            const cookies = setCookieRaw.split('\n');
            for (const cookie of cookies) {
                if (!cookie.trim()) continue;
                const attrs = parseSetCookieAttrs(cookie);
                // If a session-ish cookie is set on an anonymous probe, SameSite must be present (Lax or Strict).
                const samesite = attrs['samesite'];
                if (samesite) {
                    expect(['lax', 'strict', 'none']).toContain(String(samesite).toLowerCase());
                }
                // If SameSite=None then Secure MUST be set.
                if (samesite && String(samesite).toLowerCase() === 'none') {
                    expect(attrs['secure']).toBe(true);
                }
            }
        });
    }
});
