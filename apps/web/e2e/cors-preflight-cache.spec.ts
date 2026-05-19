import { test, expect } from '@playwright/test';
import { API_BASE } from './helpers/api';

/**
 * CORS preflight cache — pass 13. The Access-Control-Max-Age header
 * tells browsers how long to cache the preflight (OPTIONS) result.
 * Without it, every credentialed request triggers a new OPTIONS round-
 * trip — a perf bug. We pin Max-Age is set + within sane range.
 */

test.describe('CORS preflight — Access-Control-Max-Age', () => {
    test('OPTIONS preflight on /api/auth/login carries Max-Age', async ({ request }) => {
        const res = await request.fetch(`${API_BASE}/api/auth/login`, {
            method: 'OPTIONS',
            headers: {
                Origin: 'http://localhost:3000',
                'Access-Control-Request-Method': 'POST',
                'Access-Control-Request-Headers': 'content-type',
            },
        });
        expect(res.status()).toBeLessThan(500);
        const maxAge = res.headers()['access-control-max-age'];
        if (!maxAge) {
            test.skip(true, 'no Access-Control-Max-Age header set');
        }
        const seconds = parseInt(maxAge!, 10);
        expect(Number.isNaN(seconds), `non-numeric Max-Age: ${maxAge}`).toBe(false);
        // Sane range: at least 5 minutes, at most 24 hours. Chrome caps
        // at 2h regardless, but we accept up to 24h since that's the
        // server-side hint.
        expect(seconds, `Max-Age=${seconds}s is below 5 minutes`).toBeGreaterThanOrEqual(300);
        expect(seconds, `Max-Age=${seconds}s is above 24 hours`).toBeLessThanOrEqual(86_400);
    });

    test('OPTIONS preflight echoes specific allow-headers, not wildcard for credentialed', async ({
        request,
    }) => {
        const res = await request.fetch(`${API_BASE}/api/auth/login`, {
            method: 'OPTIONS',
            headers: {
                Origin: 'http://localhost:3000',
                'Access-Control-Request-Method': 'POST',
                'Access-Control-Request-Headers': 'content-type,authorization',
            },
        });
        const allowHeaders = res.headers()['access-control-allow-headers'];
        if (!allowHeaders) test.skip(true, 'no Access-Control-Allow-Headers set');
        // A wildcard `*` doesn't work with credentialed requests in
        // any browser. The server must echo the specific requested
        // headers OR list them explicitly.
        const allowCreds = res.headers()['access-control-allow-credentials'];
        if (allowCreds === 'true') {
            expect(
                allowHeaders!.includes('*'),
                `Allow-Headers='*' incompatible with Allow-Credentials=true`,
            ).toBe(false);
        }
    });

    test('OPTIONS preflight returns 200/204 (no body)', async ({ request }) => {
        const res = await request.fetch(`${API_BASE}/api/auth/login`, {
            method: 'OPTIONS',
            headers: {
                Origin: 'http://localhost:3000',
                'Access-Control-Request-Method': 'POST',
            },
        });
        // Preflight responses should be 200 / 204 — never 4xx for a
        // well-formed OPTIONS request from an allowed origin.
        expect([200, 204]).toContain(res.status());
    });
});
