import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Feature flag runtime toggle — pass 15. The platform exposes a
 * config / feature-flags surface (typically `/api/config` or
 * `/api/feature-flags`). We don't have admin-toggle capability in the
 * black-box test env, but we can verify:
 *  - the flags endpoint returns a stable JSON shape across calls
 *  - the keys exposed are non-secret (no DB_URL / JWT_SECRET leaks)
 *  - repeated calls return the same flag values within a single
 *    request burst (no per-request randomness)
 */

const FLAG_PATHS = ['/api/config', '/api/feature-flags', '/api/flags'];
const SECRET_KEY_PATTERN =
    /(DATABASE_URL|JWT_SECRET|REDIS_URL|SMTP_PASS|SESSION_SECRET|OAUTH_CLIENT_SECRET|API_KEY)/i;

test.describe('Feature flags — runtime surface', () => {
    test('one of the candidate flag endpoints exposes a stable JSON config', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        let foundPath: string | null = null;
        let body: Record<string, unknown> = {};
        for (const p of FLAG_PATHS) {
            const res = await request.get(`${API_BASE}${p}`, {
                headers: authedHeaders(u.access_token),
            });
            if (!res.ok()) continue;
            const ct = res.headers()['content-type'] || '';
            if (!ct.includes('json')) continue;
            const candidate = await res.json().catch(() => null);
            if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
                foundPath = p;
                body = candidate;
                break;
            }
        }
        if (!foundPath) {
            test.skip(true, 'no config/feature-flag JSON endpoint exposed');
        }
        // No secret-shaped keys may leak through.
        const keys = Object.keys(body).join(' ');
        const leaked = SECRET_KEY_PATTERN.exec(keys);
        expect(leaked, `feature flag payload leaked secret-shaped key: ${leaked?.[0]}`).toBeNull();
        // Hit it twice — same JSON.
        const r1 = await request.get(`${API_BASE}${foundPath}`, {
            headers: authedHeaders(u.access_token),
        });
        const r2 = await request.get(`${API_BASE}${foundPath}`, {
            headers: authedHeaders(u.access_token),
        });
        const j1 = JSON.stringify(await r1.json());
        const j2 = JSON.stringify(await r2.json());
        expect(j1, 'feature flag payload drifted between consecutive calls').toBe(j2);
    });

    test('unauth probe to flag endpoint is auth-gated or returns reduced payload', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        let authedKeys = 0;
        let unauthedKeys = 0;
        for (const p of FLAG_PATHS) {
            const a = await request.get(`${API_BASE}${p}`, {
                headers: authedHeaders(u.access_token),
            });
            const ua = await request.get(`${API_BASE}${p}`);
            if (a.ok() && (a.headers()['content-type'] || '').includes('json')) {
                const body = await a.json();
                if (body && typeof body === 'object' && !Array.isArray(body)) {
                    authedKeys = Math.max(authedKeys, Object.keys(body).length);
                }
            }
            if (ua.ok() && (ua.headers()['content-type'] || '').includes('json')) {
                const body = await ua.json();
                if (body && typeof body === 'object' && !Array.isArray(body)) {
                    unauthedKeys = Math.max(unauthedKeys, Object.keys(body).length);
                }
            }
        }
        if (authedKeys === 0) {
            test.skip(true, 'no flag endpoint found');
        }
        // Unauthed should expose ≤ authed key count (no leak of
        // admin-only flags to anonymous).
        expect(
            unauthedKeys,
            `unauthed flag payload exposes more keys (${unauthedKeys}) than authed (${authedKeys})`,
        ).toBeLessThanOrEqual(authedKeys);
    });
});
