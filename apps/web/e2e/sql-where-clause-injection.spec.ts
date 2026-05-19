import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * SQL where-clause injection — pass 12. Deepens search-fts /
 * sort-filter. We pin that common SQL-injection payloads in query
 * parameters never produce a 5xx (parser crash) or a 200 that leaks
 * cross-tenant rows.
 */

const PAYLOADS = [
    "1' OR '1'='1",
    "' OR 1=1 --",
    "'; DROP TABLE works; --",
    '1; SELECT * FROM users;',
    '1 UNION SELECT password FROM users',
    "1' AND SLEEP(5)--",
    "%' OR '%'='",
    '1)) UNION SELECT NULL--',
];

const PARAM_KEYS = ['search', 'status', 'actionType', 'sort', 'filter', 'q'];

test.describe('SQL injection — query parameters', () => {
    for (const payload of PAYLOADS) {
        for (const key of PARAM_KEYS) {
            test(`/api/works?${key}=<sqli> responds < 500 (${payload.slice(0, 30)})`, async ({
                request,
            }) => {
                const u = await registerUserViaAPI(request);
                const res = await request.get(
                    `${API_BASE}/api/works?${key}=${encodeURIComponent(payload)}`,
                    { headers: authedHeaders(u.access_token) },
                );
                // 200 (input filtered / parameterised) or 400/422
                // (validation) are fine. 5xx = parser crash. Never OK.
                expect(
                    res.status(),
                    `payload="${payload}" param="${key}" got ${res.status()}`,
                ).toBeLessThan(500);
            });
        }
    }

    test('UNION-style payload does not return cross-tenant rows', async ({ request }) => {
        // Seed work owned by A. Then have B inject UNION to try to read
        // A's row. The list must still be filtered to B's own works.
        const a = await registerUserViaAPI(request);
        const aWorkName = `union-target-${Date.now().toString(36)}`;
        const aCreate = await request.post(`${API_BASE}/api/works`, {
            headers: authedHeaders(a.access_token),
            data: { name: aWorkName, slug: aWorkName },
        });
        expect(aCreate.ok()).toBe(true);

        const b = await registerUserViaAPI(request);
        const injection = "' UNION SELECT id, name FROM works --";
        const res = await request.get(
            `${API_BASE}/api/works?search=${encodeURIComponent(injection)}`,
            { headers: authedHeaders(b.access_token) },
        );
        expect(res.status()).toBeLessThan(500);
        if (res.status() !== 200) return; // bot may reject the payload
        const body = await res.json();
        const arr = Array.isArray(body) ? body : (body?.works ?? body?.data ?? []);
        const names = arr.map((w: { name?: string }) => w?.name ?? '');
        // A's work must NOT appear in B's list — regardless of payload.
        expect(names, `UNION injection leaked A's work to B`).not.toContain(aWorkName);
    });
});

test.describe('SQL injection — POST body fields', () => {
    test('POST /api/works with SQLi-shaped name does not 5xx', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        for (const payload of PAYLOADS.slice(0, 3)) {
            const res = await request.post(`${API_BASE}/api/works`, {
                headers: authedHeaders(u.access_token),
                data: { name: payload, slug: `sqli-${Date.now().toString(36)}` },
            });
            // Validation may reject (400). Acceptance is also fine —
            // the name will be stored as a literal string with bind
            // parameters. Never 5xx.
            expect(res.status()).toBeLessThan(500);
        }
    });
});
