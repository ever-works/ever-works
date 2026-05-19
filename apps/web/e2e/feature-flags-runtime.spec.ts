import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Feature flags — pass 9. The platform exposes runtime flags via
 * `/api/config` (or similar). We verify:
 *   - Public flags are reachable without auth (no PII inside)
 *   - Authenticated users get a richer flag set
 *   - The response is stable across repeat calls in the same window
 */

const CONFIG_PATHS = [
    '/api/config',
    '/api/feature-flags',
    '/api/flags',
    '/api/config/features',
    '/api/public/config',
];

test.describe('Feature flags — config endpoint', () => {
    test('one config endpoint exists and returns a JSON object', async ({ request }) => {
        let found: { path: string; body: unknown } | null = null;
        for (const path of CONFIG_PATHS) {
            const res = await request.get(`${API_BASE}${path}`);
            if (res.status() === 404) continue;
            if (res.status() < 500) {
                const ct = res.headers()['content-type'] || '';
                if (ct.includes('json')) {
                    found = { path, body: await res.json().catch(() => null) };
                    break;
                }
            }
        }
        if (!found) test.skip(true, 'no config / feature-flags endpoint exposed');
        expect(typeof found!.body).toBe('object');
    });

    test('config response is stable across two consecutive calls', async ({ request }) => {
        let path: string | null = null;
        for (const candidate of CONFIG_PATHS) {
            const res = await request.get(`${API_BASE}${candidate}`);
            if (res.status() === 200) {
                path = candidate;
                break;
            }
        }
        if (!path) test.skip(true, 'no public config endpoint');
        const r1 = await request.get(`${API_BASE}${path}`);
        const r2 = await request.get(`${API_BASE}${path}`);
        expect(r1.status()).toBe(200);
        expect(r2.status()).toBe(200);
        const b1 = await r1.json();
        const b2 = await r2.json();
        // Top-level keys must match — flags shouldn't disappear mid-poll.
        expect(Object.keys(b1).sort().join(',')).toBe(Object.keys(b2).sort().join(','));
    });

    test('public config does NOT leak server-side env vars (DATABASE_URL, JWT_SECRET, etc.)', async ({
        request,
    }) => {
        let body: unknown = null;
        for (const path of CONFIG_PATHS) {
            const res = await request.get(`${API_BASE}${path}`);
            if (res.status() === 200) {
                body = await res.json();
                break;
            }
        }
        if (!body) test.skip(true, 'no public config endpoint');
        const flat = JSON.stringify(body).toLowerCase();
        const FORBIDDEN_KEYS = [
            'database_url',
            'jwt_secret',
            'session_secret',
            'aws_secret_access_key',
            'stripe_secret',
            'openai_api_key',
            'github_client_secret',
            'redis_password',
        ];
        for (const key of FORBIDDEN_KEYS) {
            expect(flat.includes(key), `public config leaked ${key}`).toBe(false);
        }
    });
});

test.describe('Feature flags — authed response', () => {
    test('authenticated user sees same or more keys than unauthenticated', async ({ request }) => {
        let path: string | null = null;
        for (const candidate of CONFIG_PATHS) {
            const res = await request.get(`${API_BASE}${candidate}`);
            if (res.status() === 200) {
                path = candidate;
                break;
            }
        }
        if (!path) test.skip(true, 'no public config endpoint');
        const unauth = await request.get(`${API_BASE}${path}`);
        const unauthKeys = new Set(Object.keys(await unauth.json()));
        const u = await registerUserViaAPI(request);
        const authed = await request.get(`${API_BASE}${path}`, {
            headers: authedHeaders(u.access_token),
        });
        if (authed.status() !== 200) test.skip(true, `authed config returned ${authed.status()}`);
        const authedKeys = new Set(Object.keys(await authed.json()));
        // Every unauth key should still be present for authed users.
        for (const k of unauthKeys) {
            expect(authedKeys.has(k), `authed response dropped public key ${k}`).toBe(true);
        }
    });
});
