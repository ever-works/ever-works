import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * Slow-route pagination guard — pass 9. A user with many works /
 * activity-log entries must still get responses in a reasonable time.
 * We seed 25+ works and verify `/api/works` doesn't take > 30 seconds
 * — that's far above any healthy SLO but catches the "full table
 * scan with no LIMIT" regression class.
 */

const SEED_COUNT = 25;
const SLOW_RESPONSE_BUDGET_MS = 30_000;

test.describe('Slow-route — large dataset still responds within budget', () => {
    test(`/api/works with ${SEED_COUNT} owned works responds within ${SLOW_RESPONSE_BUDGET_MS}ms`, async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        // Seed serially so we don't overwhelm the API's throttler.
        const stamp = Date.now().toString(36);
        for (let i = 0; i < SEED_COUNT; i++) {
            const res = await createWorkViaAPI(request, u.access_token, {
                name: `slow-${stamp}-${i.toString().padStart(2, '0')}`,
                slug: `slow-${stamp}-${i.toString().padStart(2, '0')}`,
            });
            if (!res.id) {
                test.skip(true, 'seed work creation failed; cannot measure');
            }
        }
        const start = Date.now();
        const list = await request.get(`${API_BASE}/api/works`, {
            headers: authedHeaders(u.access_token),
        });
        const elapsed = Date.now() - start;
        expect(list.status()).toBe(200);
        expect(
            elapsed,
            `/api/works with ${SEED_COUNT} rows took ${elapsed}ms — slower than ${SLOW_RESPONSE_BUDGET_MS}ms`,
        ).toBeLessThan(SLOW_RESPONSE_BUDGET_MS);
    });

    test(`/api/notifications under load responds within ${SLOW_RESPONSE_BUDGET_MS}ms`, async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        // Hammer create-work to generate notification events.
        const stamp = Date.now().toString(36);
        for (let i = 0; i < 10; i++) {
            await createWorkViaAPI(request, u.access_token, {
                name: `notif-load-${stamp}-${i}`,
                slug: `notif-load-${stamp}-${i}`,
            });
        }
        const start = Date.now();
        const res = await request.get(`${API_BASE}/api/notifications`, {
            headers: authedHeaders(u.access_token),
        });
        const elapsed = Date.now() - start;
        expect(res.status()).toBe(200);
        expect(elapsed, `/api/notifications took ${elapsed}ms`).toBeLessThan(
            SLOW_RESPONSE_BUDGET_MS,
        );
    });

    test('repeated /api/works calls do not degrade response time non-linearly', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        // Seed a moderate number of works.
        const stamp = Date.now().toString(36);
        for (let i = 0; i < 5; i++) {
            await createWorkViaAPI(request, u.access_token, {
                name: `degrade-${stamp}-${i}`,
                slug: `degrade-${stamp}-${i}`,
            });
        }
        const timings: number[] = [];
        for (let i = 0; i < 3; i++) {
            const start = Date.now();
            const res = await request.get(`${API_BASE}/api/works`, {
                headers: authedHeaders(u.access_token),
            });
            timings.push(Date.now() - start);
            expect(res.status()).toBe(200);
        }
        // Last call should not be more than 5x the first — that would
        // indicate per-call connection leak or cache thrash.
        const ratio = timings[timings.length - 1] / Math.max(1, timings[0]);
        expect(
            ratio,
            `degradation ratio ${ratio.toFixed(2)}x: timings=${timings.join(', ')}`,
        ).toBeLessThan(5);
    });
});
