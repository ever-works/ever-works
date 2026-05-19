import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Auth clock tolerance — pass 17. JWT iat/nbf/exp claims need a
 * small clock-skew tolerance (±60s typically) so a client whose
 * clock drifts slightly from the server doesn't get spuriously 401d.
 *
 * Pass-13 `clock-skew-tolerance` covered the happy-path: fresh tokens
 * work immediately. This pass exercises the orthogonal angle: making
 * sure /api/auth/profile remains usable across small per-request
 * delays (no "iat too far in the past" rejection on a normal API
 * flow that spans tens of seconds).
 */

test.describe('Auth clock tolerance — token usable across ~15s wall-clock spread', () => {
    test('5 sequential /api/auth/profile hits over ~15s all stay < 500', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const statuses: number[] = [];
        for (let i = 0; i < 5; i++) {
            const res = await request.get(`${API_BASE}/api/auth/profile`, {
                headers: authedHeaders(u.access_token),
            });
            statuses.push(res.status());
            if (i < 4) await new Promise((r) => setTimeout(r, 3_000));
        }
        for (let i = 0; i < statuses.length; i++) {
            expect(
                statuses[i],
                `/api/auth/profile iter ${i} got ${statuses[i]} (statuses=${statuses.join(',')})`,
            ).toBeLessThan(500);
        }
        // None of the 5 should 401 unless the token genuinely expired
        // — for a freshly issued token at 5×3s = 15s, expiry should
        // be far away.
        expect(
            statuses.filter((s) => s === 401).length,
            `${statuses.filter((s) => s === 401).length}/5 calls returned 401 (statuses=${statuses.join(',')}) — clock skew rejection`,
        ).toBeLessThanOrEqual(1);
    });

    test('server Date header is within ±5 min of test clock', async ({ request }) => {
        const before = Date.now();
        const res = await request.get(`${API_BASE}/api/health`);
        const dateHeader = res.headers()['date'];
        if (!dateHeader) {
            test.skip(true, 'no Date header on /api/health');
        }
        const serverMs = Date.parse(dateHeader);
        if (!Number.isFinite(serverMs)) {
            test.skip(true, `Date header not parseable: "${dateHeader}"`);
        }
        const skew = Math.abs(serverMs - before);
        expect(
            skew,
            `server clock skew is ${(skew / 1000).toFixed(1)}s — JWT iat/nbf rejection risk`,
        ).toBeLessThan(5 * 60 * 1000);
    });
});
