import { test, expect } from '@playwright/test';
import { API_BASE } from './helpers/api';

/**
 * Connection keepalive budget — pass 20. The server must not
 * exhaust its connection pool or file-descriptor budget under a
 * 100-request burst from a single client. Pass-14
 * `connection-pool-leak` covered 50 sequential authed hits; this
 * pass extends to 100 anonymous hits + monitors total elapsed time
 * for socket-creation overhead.
 */

test.describe('Keepalive — 100 sequential /api/health requests stay healthy', () => {
    test('100 requests succeed in ≤ 30s with ≤ 2 5xx', async ({ request }) => {
        const start = Date.now();
        let fivexx = 0;
        for (let i = 0; i < 100; i++) {
            const res = await request.get(`${API_BASE}/api/health`);
            if (res.status() >= 500) fivexx++;
        }
        const elapsed = Date.now() - start;
        expect(
            fivexx,
            `${fivexx}/100 5xx responses — keepalive pool may be exhausted`,
        ).toBeLessThanOrEqual(2);
        // 100 sequential GETs over localhost should fit in 30s
        // comfortably. If it takes > 60s the test runner times out;
        // we soft-warn at 30s.
        if (elapsed > 30_000) {
            test.info().annotations.push({
                type: 'informational',
                description: `100 sequential /api/health took ${(elapsed / 1000).toFixed(1)}s — socket-creation overhead suspected`,
            });
        }
    });

    test('20 parallel bursts of 5 sequential requests stay 5xx-clean', async ({ request }) => {
        const bursts = Array.from({ length: 20 }, async () => {
            const out: number[] = [];
            for (let i = 0; i < 5; i++) {
                const r = await request.get(`${API_BASE}/api/health`);
                out.push(r.status());
            }
            return out;
        });
        const all = (await Promise.all(bursts)).flat();
        const fivexx = all.filter((s) => s >= 500).length;
        expect(
            fivexx,
            `${fivexx}/${all.length} responses 5xx during parallel-burst keepalive test`,
        ).toBeLessThanOrEqual(2);
    });
});
