import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * Sort + filter — pass 6. List endpoints should accept `?sort=` and
 * `?status=` / `?actionType=` query parameters without crashing. Even
 * if the server silently ignores unknown sort keys, it must NEVER
 * 5xx on a malformed sort value.
 */

test.describe('Sort + filter — query parameters do not 5xx', () => {
    test('GET /api/works?sort=name responds < 500', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        await createWorkViaAPI(request, u.access_token, {
            name: `sort-${Date.now().toString(36)}`,
        });
        const res = await request.get(`${API_BASE}/api/works?sort=name`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBeLessThan(500);
    });

    test('GET /api/works?sort=-createdAt (descending) responds < 500', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/works?sort=-createdAt`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBeLessThan(500);
    });

    test('GET /api/works with bogus sort key (?sort=injected;DROP) responds < 500', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(
            `${API_BASE}/api/works?sort=${encodeURIComponent('injected;DROP TABLE works')}`,
            { headers: authedHeaders(u.access_token) },
        );
        // Must reject (4xx) or ignore (200 with default sort). Never 5xx,
        // never execute the SQL — which we can't verify directly here,
        // but a non-5xx means at minimum the input wasn't blindly
        // interpolated into a query that the DB couldn't parse.
        expect(res.status()).toBeLessThan(500);
    });

    test('GET /api/activity-log?status=success responds < 500', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/activity-log?status=success`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBeLessThan(500);
    });

    test('GET /api/activity-log?actionType=work-generated responds < 500', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/activity-log?actionType=work-generated`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBeLessThan(500);
    });

    test('GET /api/works?status=bogus-status responds < 500', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/works?status=definitely-not-a-status`, {
            headers: authedHeaders(u.access_token),
        });
        // Bogus enum value should be 400/422 (validation) or 200 (ignored).
        // Never 5xx.
        expect(res.status()).toBeLessThan(500);
    });
});
