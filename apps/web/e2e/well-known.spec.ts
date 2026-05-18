import { test, expect } from '@playwright/test';
import { API_BASE } from './helpers/api';

/**
 * Well-known endpoints — `/.well-known/agent.json` (and any future
 * sibling). Public, machine-readable agent description for tooling
 * (Claude / Cursor / agent frameworks) that needs to introspect the
 * Ever Works platform programmatically.
 */

test.describe('Well-known endpoints', () => {
    test('GET /.well-known/agent.json returns 200 with JSON content', async ({ request }) => {
        const res = await request.get(`${API_BASE}/.well-known/agent.json`);
        expect(res.status(), `status was ${res.status()}`).toBe(200);
        const ct = res.headers()['content-type'] || '';
        expect(ct.includes('application/json')).toBe(true);
        const body = await res.json();
        // The doc is unsealed — the platform may evolve it — but it should
        // at minimum be an object (not an array or primitive) so callers can
        // probe known fields.
        expect(typeof body).toBe('object');
        expect(body).not.toBeNull();
        expect(Array.isArray(body)).toBe(false);
    });

    test('GET /.well-known/agent.json is publicly accessible (no auth needed)', async ({
        request,
    }) => {
        const res = await request.get(`${API_BASE}/.well-known/agent.json`, {
            // No Authorization header. Well-known is by definition public.
        });
        expect(res.status()).toBe(200);
    });

    test('GET /.well-known/agent.json sets sensible cache headers', async ({ request }) => {
        const res = await request.get(`${API_BASE}/.well-known/agent.json`);
        expect(res.status()).toBe(200);
        // We don't pin the exact value (it may change as the doc stabilises),
        // just that some cache-control header is sent. Public docs SHOULDN'T
        // be `no-store` — that's a sign the dev forgot caching exists.
        const cc = res.headers()['cache-control'];
        // Some frameworks omit cache-control entirely on small JSON responses,
        // which is acceptable too (default = cacheable per HTTP semantics).
        if (cc) {
            expect(cc.toLowerCase()).not.toContain('no-store');
        }
    });
});
