import { test, expect } from '@playwright/test';
import { API_BASE } from './helpers/api';

/**
 * Circuit breaker state — pass 17. Downstream-dependent endpoints
 * should expose per-dependency health. When a downstream is in `open`
 * (tripped) state, the root /api/health should still return < 500 —
 * the breaker is supposed to fast-fail without cascading.
 *
 * We probe a few likely health sub-paths. If none exists, skip.
 */

const SUBSYSTEM_PATHS = [
    '/api/health/db',
    '/api/health/redis',
    '/api/health/queue',
    '/api/health/cache',
];

test.describe('Circuit breaker — subsystem health endpoints + cascade containment', () => {
    test('/api/health root returns < 500 even when subsystem health probes fail', async ({
        request,
    }) => {
        // Baseline.
        const root = await request.get(`${API_BASE}/api/health`);
        expect(root.status()).toBeLessThan(500);
        // Hammer subsystem-specific health 5x each.
        for (const p of SUBSYSTEM_PATHS) {
            for (let i = 0; i < 5; i++) {
                const res = await request.get(`${API_BASE}${p}`);
                // 4xx, 503, 200 all acceptable. 502/504 / Node crash
                // would be the bug.
                expect(
                    [502, 504].includes(res.status()),
                    `${p} returned bad-gateway-shape: ${res.status()}`,
                ).toBe(false);
            }
        }
        // Root should still be healthy.
        const after = await request.get(`${API_BASE}/api/health`);
        expect(after.status()).toBeLessThan(500);
    });

    test('subsystem health endpoints (when exposed) carry a status field', async ({ request }) => {
        let probed = false;
        for (const p of SUBSYSTEM_PATHS) {
            const res = await request.get(`${API_BASE}${p}`);
            if (res.status() === 404) continue;
            const ct = res.headers()['content-type'] || '';
            if (!ct.includes('json')) continue;
            probed = true;
            const body = await res.json().catch(() => null);
            if (!body || typeof body !== 'object') continue;
            // Shape sanity: most health-check libraries return a
            // `status` field that's one of {ok, up, healthy, degraded,
            // down, fail}.
            const status =
                (body as Record<string, unknown>).status ?? (body as Record<string, unknown>).state;
            if (typeof status === 'string') {
                expect(
                    /(ok|up|healthy|degraded|down|fail|open|closed|half[-_]?open)/i.test(status),
                    `${p} status not recognised shape: "${status}"`,
                ).toBe(true);
            }
        }
        if (!probed) test.skip(true, 'no subsystem health endpoints exposed as JSON');
    });
});
