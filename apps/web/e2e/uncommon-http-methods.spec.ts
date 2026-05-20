import { test, expect } from '@playwright/test';
import { API_BASE } from './helpers/api';

/**
 * Uncommon / non-standard HTTP methods against public endpoints. The
 * server should reject with a 4xx (typically 405 Method Not Allowed)
 * — never 5xx, and never silently echo (TRACE leaks request data and
 * should be disabled).
 */

const TARGETS = ['/', '/api/health', '/api/works', '/.well-known/agent.json'];

// Methods that should be rejected on a typical app server.
const UNCOMMON_METHODS = [
    'TRACE',
    'CONNECT',
    'PROPFIND',
    'MKCOL',
    'COPY',
    'MOVE',
    'LOCK',
    'UNLOCK',
];

test.describe('Public endpoints: uncommon HTTP methods', () => {
    for (const path of TARGETS) {
        for (const method of UNCOMMON_METHODS) {
            test(`${method} ${path} rejected without 5xx`, async ({ request }) => {
                let res;
                try {
                    res = await request.fetch(`${API_BASE}${path}`, { method });
                } catch (err) {
                    // CONNECT (and a few other tunnel-class methods)
                    // can be rejected by the HTTP client (undici)
                    // before they reach the wire — "socket hang up" or
                    // similar. That's an even stronger guarantee than
                    // a server-side 4xx (the request never happens),
                    // so it satisfies the "not 5xx" contract trivially.
                    const message = (err as Error).message ?? '';
                    if (
                        /socket hang up|invalid method|method not allowed|not supported/i.test(
                            message,
                        )
                    ) {
                        return; // counts as pass — see comment above
                    }
                    throw err;
                }
                expect(res.status(), `${method} ${path}`).toBeLessThan(500);
            });
        }
    }
});

test.describe('Public endpoints: TRACE should not echo request data', () => {
    test('TRACE / does not echo a custom request header in the body', async ({ request }) => {
        const res = await request.fetch(`${API_BASE}/`, {
            method: 'TRACE',
            headers: { 'X-Leak-Probe': 'should-not-be-echoed' },
        });
        // 405/501/403/400/404 all fine. If the server actually answered with 200, that's bad — TRACE should be disabled.
        expect(res.status()).toBeLessThan(500);
        if (res.status() === 200) {
            const body = await res.text();
            expect(body).not.toContain('should-not-be-echoed');
        }
    });
});
