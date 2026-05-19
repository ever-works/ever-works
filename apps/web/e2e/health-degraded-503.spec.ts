import { test, expect } from '@playwright/test';
import { API_BASE } from './helpers/api';

/**
 * Health degraded 503 — pass 18. Pass-17 `circuit-breaker-state`
 * covered cascade containment. This pass tightens the contract:
 *  - root /api/health is the liveness probe — should stay 200 OK
 *    even when a non-critical dependency is unhealthy
 *  - subsystem-specific /api/health/<dep> may return 503 when the
 *    dep is degraded — that's the readiness signal
 *  - the two endpoints decouple liveness from readiness (k8s probes)
 */

test.describe('Health endpoints — liveness vs readiness decoupling', () => {
    test('root /api/health returns 200 (liveness probe)', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/health`);
        expect(res.status(), `/api/health liveness probe got ${res.status()}`).toBe(200);
    });

    test('subsystem health endpoints (when exposed) use 200 OR 503 (never 5xx/2xx-other)', async ({
        request,
    }) => {
        const candidates = [
            '/api/health/db',
            '/api/health/redis',
            '/api/health/queue',
            '/api/health/cache',
            '/api/health/storage',
        ];
        let probed = false;
        for (const p of candidates) {
            const res = await request.get(`${API_BASE}${p}`);
            if (res.status() === 404) continue;
            probed = true;
            // 200 = healthy, 503 = degraded/unavailable. 500/501/504 =
            // bug (these are "I crashed" not "the dep is down").
            const acceptableStatuses = [200, 503];
            expect(
                acceptableStatuses.includes(res.status()),
                `${p} returned non-canonical status ${res.status()} (expected 200 or 503)`,
            ).toBe(true);
        }
        if (!probed) test.skip(true, 'no subsystem health endpoints exposed');
    });

    test('hammering health 10x consecutively never drifts from 200', async ({ request }) => {
        for (let i = 0; i < 10; i++) {
            const res = await request.get(`${API_BASE}/api/health`);
            expect(
                res.status(),
                `/api/health iter ${i} got ${res.status()} — liveness should be stable`,
            ).toBe(200);
        }
    });
});
