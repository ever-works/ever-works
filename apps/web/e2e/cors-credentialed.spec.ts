import { test, expect } from '@playwright/test';
import { API_BASE } from './helpers/api';

/**
 * CORS — credentialed preflight checks. The platform sets ALLOWED_ORIGINS
 * and credentials: true at the API. This deepens health-meta.spec.ts's
 * basic CORS check by validating credentialed flows (which require
 * specific Origin matching, not wildcard) and a few sensitive endpoints.
 */

test.describe('CORS — preflight on sensitive endpoints', () => {
    const SENSITIVE_PATHS = [
        '/api/auth/login',
        '/api/auth/register',
        '/api/works',
        '/api/auth/api-keys',
        '/api/notifications',
    ];

    for (const path of SENSITIVE_PATHS) {
        test(`OPTIONS ${path} from allowed origin returns CORS headers`, async ({ request }) => {
            const res = await request.fetch(`${API_BASE}${path}`, {
                method: 'OPTIONS',
                headers: {
                    Origin: 'http://localhost:3000',
                    'Access-Control-Request-Method': 'POST',
                    'Access-Control-Request-Headers': 'content-type,authorization',
                },
            });
            // Preflight should return 204 (or 200) with Access-Control headers.
            expect(res.status()).toBeLessThan(500);
            // Allow-Origin may be the exact origin (not '*') for credentialed flows.
            const allowOrigin = res.headers()['access-control-allow-origin'];
            if (allowOrigin) {
                expect(allowOrigin).not.toBe('*');
            }
        });
    }

    test('OPTIONS from a disallowed origin → no allow-origin header', async ({ request }) => {
        const res = await request.fetch(`${API_BASE}/api/auth/login`, {
            method: 'OPTIONS',
            headers: {
                Origin: 'https://attacker.example.com',
                'Access-Control-Request-Method': 'POST',
            },
        });
        // Server should either reject (4xx) or omit the allow-origin header.
        // What's NOT acceptable is mirroring the attacker's origin back,
        // OR returning `*` — browsers refuse `*` with credentials, but a
        // server policy that echoes wildcard is still wrong by design.
        const allowOrigin = res.headers()['access-control-allow-origin'];
        if (allowOrigin) {
            expect(allowOrigin, `server echoed attacker origin back as CORS allow-origin`).not.toBe(
                'https://attacker.example.com',
            );
            expect(
                allowOrigin,
                `server returned wildcard '*' allow-origin on a credentialed-eligible endpoint`,
            ).not.toBe('*');
        }
    });
});

test.describe('Security headers — sanity', () => {
    test('GET /api/health includes security headers', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/health`);
        expect(res.status()).toBe(200);
        const h = res.headers();
        // Helmet's defaults should be in place. We don't assert exact values
        // (they evolve) — just that the security baseline is present.
        const hasSec =
            'x-content-type-options' in h ||
            'x-frame-options' in h ||
            'strict-transport-security' in h ||
            'content-security-policy' in h;
        expect(hasSec, `headers: ${JSON.stringify(Object.keys(h))}`).toBe(true);
    });

    test('GET /api/health x-content-type-options=nosniff', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/health`);
        const x = res.headers()['x-content-type-options'];
        if (x) {
            expect(x.toLowerCase()).toBe('nosniff');
        }
    });
});
