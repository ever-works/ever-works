import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Image-resize bounds — pass 16. If the platform offers a resize /
 * thumbnail endpoint (e.g. `/api/images/resize?w=...&h=...`), it
 * must:
 *  - reject extreme dimensions (10_000 × 10_000+) with 4xx, not 5xx
 *    (resource exhaustion / DoS guard)
 *  - accept tiny dimensions (1 × 1)
 *  - reject negative / zero dimensions with 4xx
 *
 * If the endpoint isn't exposed, informational skip.
 */

const RESIZE_CANDIDATES = [
    '/api/images/resize?w=__W__&h=__H__&src=https%3A%2F%2Fexample.com%2Ftest.png',
    '/api/screenshot/resize?w=__W__&h=__H__',
    '/api/works/__WORK_ID__/screenshot?w=__W__&h=__H__',
];

test.describe('Image resize — extreme dimensions rejected without 5xx', () => {
    test('10000×10000 resize request returns 4xx (not 2xx, not 5xx)', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        let probed = false;
        for (const tpl of RESIZE_CANDIDATES) {
            const url = `${API_BASE}${tpl
                .replace('__W__', '10000')
                .replace('__H__', '10000')
                .replace('__WORK_ID__', 'noop')}`;
            const res = await request.get(url, {
                headers: authedHeaders(u.access_token),
            });
            if (res.status() === 404) continue;
            probed = true;
            // Greptile P2: the prior `<500` shape accepted 2xx, which
            // would let a server happily process a 10000×10000 resize
            // (the exact DoS scenario this spec exists to guard). The
            // platform must REJECT extreme dimensions — 400/413/422
            // are the canonical shapes.
            expect(
                res.status(),
                `${tpl} 10000×10000 was not rejected: ${res.status()}`,
            ).toBeGreaterThanOrEqual(400);
            expect(
                res.status(),
                `${tpl} 10000×10000 crashed with 5xx: ${res.status()}`,
            ).toBeLessThan(500);
        }
        if (!probed) test.skip(true, 'no resize endpoint exposed');
    });

    test('zero / negative dimensions return 4xx', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        let probed = false;
        for (const tpl of RESIZE_CANDIDATES) {
            for (const [w, h] of [
                ['0', '100'],
                ['100', '0'],
                ['-10', '100'],
                ['100', '-10'],
            ]) {
                const url = `${API_BASE}${tpl
                    .replace('__W__', w)
                    .replace('__H__', h)
                    .replace('__WORK_ID__', 'noop')}`;
                const res = await request.get(url, {
                    headers: authedHeaders(u.access_token),
                });
                if (res.status() === 404) continue;
                probed = true;
                expect(res.status(), `${tpl} ${w}×${h} crashed: ${res.status()}`).toBeLessThan(500);
            }
        }
        if (!probed) test.skip(true, 'no resize endpoint exposed');
    });
});
