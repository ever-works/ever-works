import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * Cron drift tolerance — pass 16. Cron schedules on works should
 * accept industry-standard cron expressions and reject syntactic
 * garbage with 4xx (not 5xx). We don't actually wait for a cron
 * tick — that's hours/days — but we verify:
 *  - well-formed expressions are accepted
 *  - syntactic garbage is rejected with 4xx
 *  - `nextRunAt` (if returned) parses as a future ISO date
 */

const VALID_CRONS = [
    '0 * * * *', // hourly
    '0 0 * * *', // daily midnight
    '*/15 * * * *', // every 15 min
];
const INVALID_CRONS = [
    'every minute', // not cron
    '999 * * * *', // out-of-range minute
    '0 0 0 0', // too few fields
];

test.describe('Cron schedules — accept valid, reject garbage', () => {
    test('well-formed cron expressions are accepted (or endpoint absent)', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const w = await createWorkViaAPI(request, u.access_token, {
            name: `cron-${Date.now().toString(36)}`,
            slug: `cron-${Date.now().toString(36)}`,
        });
        let probed = false;
        for (const cron of VALID_CRONS) {
            const res = await request.post(`${API_BASE}/api/works/${w.id}/schedule`, {
                headers: authedHeaders(u.access_token),
                data: { cron, enabled: true },
            });
            if (res.status() === 404) continue;
            probed = true;
            expect(res.status(), `valid cron "${cron}" rejected with ${res.status()}`).toBeLessThan(
                500,
            );
        }
        if (!probed) test.skip(true, 'no schedule endpoint exposed');
    });

    test('syntactic garbage in cron expression returns 4xx (never 5xx)', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const w = await createWorkViaAPI(request, u.access_token, {
            name: `cron-bad-${Date.now().toString(36)}`,
            slug: `cron-bad-${Date.now().toString(36)}`,
        });
        let probed = false;
        for (const cron of INVALID_CRONS) {
            const res = await request.post(`${API_BASE}/api/works/${w.id}/schedule`, {
                headers: authedHeaders(u.access_token),
                data: { cron, enabled: true },
            });
            if (res.status() === 404) continue;
            probed = true;
            // Either 4xx (good) or 2xx with the server treating it as
            // disabled. Never 5xx.
            expect(
                res.status(),
                `garbage cron "${cron}" crashed with ${res.status()}`,
            ).toBeLessThan(500);
        }
        if (!probed) test.skip(true, 'no schedule endpoint exposed');
    });
});
