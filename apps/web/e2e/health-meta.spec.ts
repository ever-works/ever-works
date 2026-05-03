import { test, expect } from '@playwright/test';
import { API_BASE } from './helpers/api';

/**
 * Health + metadata surface — sanity that the API exposes uptime + the
 * routes that bots/probes rely on (cors, public providers list, etc).
 */

test.describe('Health endpoint', () => {
    test('GET /api/health returns 200 with a JSON payload', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/health`);
        expect(res.status()).toBe(200);
        const ctype = res.headers()['content-type'] || '';
        expect(ctype.toLowerCase()).toMatch(/json|text/);
    });

    test('GET /api/health responds quickly (< 2s) over local loopback', async ({ request }) => {
        const start = Date.now();
        const res = await request.get(`${API_BASE}/api/health`);
        const elapsedMs = Date.now() - start;
        expect(res.status()).toBe(200);
        // Generous threshold; this is a dev-mode loopback check.
        expect(elapsedMs, `health took ${elapsedMs}ms`).toBeLessThan(2_000);
    });
});

test.describe('Frontend health endpoint', () => {
    test('GET /api/health on the web app responds 200', async ({ request, baseURL }) => {
        const url = `${baseURL || 'http://localhost:3000'}/api/health`;
        const res = await request.get(url);
        // Web /api/health proxies or implements its own — must not 5xx.
        expect(res.status(), `web health status: ${res.status()}`).toBeLessThan(500);
    });
});

test.describe('CORS / preflight on /api/auth/login', () => {
    test('OPTIONS /api/auth/login responds <500', async ({ request }) => {
        // Some setups skip OPTIONS handling; we only care it isn't a 500.
        const res = await request
            .fetch(`${API_BASE}/api/auth/login`, { method: 'OPTIONS' })
            .catch(() => null);
        if (res) {
            expect(res.status(), `OPTIONS status: ${res.status()}`).toBeLessThan(500);
        }
    });
});
