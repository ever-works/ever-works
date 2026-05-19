import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Connection pool leak — pass 14. A common backend bug is forgetting
 * to release a DB connection back to the pool. After N requests the
 * pool is exhausted and the API starts returning 503/504/timeouts.
 *
 * We hammer a handful of authenticated endpoints sequentially and
 * verify the success rate stays high. We're not measuring latency —
 * just that nothing 5xxs from pool starvation.
 */

test.describe('Connection pool — 50 sequential requests do not exhaust DB', () => {
    test('50 GETs against /api/auth/profile stay < 500 with high success rate', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        let ok = 0;
        let bad = 0;
        for (let i = 0; i < 50; i++) {
            const res = await request.get(`${API_BASE}/api/auth/profile`, {
                headers: authedHeaders(u.access_token),
            });
            const status = res.status();
            if (status >= 500) {
                bad++;
            } else {
                ok++;
            }
        }
        // ≥ 96% (48/50) should succeed without a 5xx. The remaining
        // small budget accounts for transient retries — not pool
        // exhaustion patterns.
        expect(ok, `${bad}/50 requests returned 5xx — pool may be leaking`).toBeGreaterThanOrEqual(
            48,
        );
    });

    test("parallel bursts against /api/health don't accumulate 5xx", async ({ request }) => {
        const promises: Promise<number>[] = [];
        for (let i = 0; i < 20; i++) {
            promises.push(request.get(`${API_BASE}/api/health`).then((r) => r.status()));
        }
        const statuses = await Promise.all(promises);
        const fivexx = statuses.filter((s) => s >= 500).length;
        expect(
            fivexx,
            `${fivexx}/20 parallel /api/health requests 5xx — likely pool issue`,
        ).toBeLessThanOrEqual(1);
    });
});
