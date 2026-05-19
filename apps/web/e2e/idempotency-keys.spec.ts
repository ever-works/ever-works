import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Idempotency keys — pass 14. POST requests that mutate state are
 * meant to be idempotent when carrying an `Idempotency-Key` header.
 * The platform may or may not implement this — when it does, a retry
 * with the same key returns the same response (and doesn't create a
 * duplicate).
 *
 * We try creating a work twice with the same Idempotency-Key. If the
 * platform honors it, we get one resource (status 200/201) on the
 * first call and a 200 / 201 / 409 on the second. If the platform
 * ignores the header, we may get two distinct rows — that's a
 * not-yet-implemented signal, not a crash.
 */

test.describe('Idempotency — repeated POST with same key', () => {
    test('POST /api/works with Idempotency-Key returns coherent response on retry', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const key = `idem-${Date.now().toString(36)}`;
        const payload = {
            name: `idem-${Date.now().toString(36)}`,
            slug: `idem-${Date.now().toString(36)}`,
        };
        const first = await request.post(`${API_BASE}/api/works`, {
            headers: { ...authedHeaders(u.access_token), 'Idempotency-Key': key },
            data: payload,
        });
        // First call must succeed if we're going to assert anything.
        if (!first.ok()) {
            test.skip(true, `first POST failed (${first.status()}) — can't test idempotency`);
        }
        const second = await request.post(`${API_BASE}/api/works`, {
            headers: { ...authedHeaders(u.access_token), 'Idempotency-Key': key },
            data: payload,
        });
        // Second call must NOT crash. Acceptable statuses:
        // - 200/201 (idempotent replay returning the same resource)
        // - 409 (conflict — slug duplicate, also coherent)
        // - 422 (validation rejecting duplicate slug)
        // - 4xx generally — the server rejected the duplicate cleanly
        expect(second.status(), `idempotent retry crashed with ${second.status()}`).toBeLessThan(
            500,
        );
    });

    test('Idempotency-Key without value does not crash the API', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.post(`${API_BASE}/api/works`, {
            headers: { ...authedHeaders(u.access_token), 'Idempotency-Key': '' },
            data: {
                name: `idem-empty-${Date.now().toString(36)}`,
                slug: `idem-empty-${Date.now().toString(36)}`,
            },
        });
        // Empty key should either be rejected (4xx) or ignored (success).
        // It should NEVER cause a 5xx.
        expect(res.status()).toBeLessThan(500);
    });
});
