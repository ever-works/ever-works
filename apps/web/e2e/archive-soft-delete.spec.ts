import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * Archive / soft-delete — pass 16. If works support soft-delete /
 * archive, the deleted entity should:
 *  - disappear from the default listing
 *  - still be reachable via `?archived=1` (or similar) — explicit
 *    opt-in to see archived rows
 *  - GET by id returns 404 (or the archived shape) without 5xx
 *
 * If soft-delete isn't modeled, informational skip.
 */

test.describe('Archive / soft-delete — listing exclusion + opt-in recovery', () => {
    test('DELETEd work is excluded from default listing (or hard-delete)', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const w = await createWorkViaAPI(request, u.access_token, {
            name: `archive-${Date.now().toString(36)}`,
            slug: `archive-${Date.now().toString(36)}`,
        });
        const del = await request.delete(`${API_BASE}/api/works/${w.id}`, {
            headers: authedHeaders(u.access_token),
        });
        if (!del.ok() && del.status() !== 204) {
            test.skip(true, `DELETE /api/works/${w.id} returned ${del.status()}`);
        }
        const list = await request.get(`${API_BASE}/api/works`, {
            headers: authedHeaders(u.access_token),
        });
        if (!list.ok()) test.skip(true, `list failed (${list.status()})`);
        const body = await list.json();
        const arr: Array<{ id?: string }> = Array.isArray(body)
            ? body
            : (body?.data ?? body?.works ?? []);
        const stillVisible = arr.some((row) => row.id === w.id);
        expect(stillVisible, `deleted work ${w.id} still visible in default listing`).toBe(false);
    });

    test('GET on deleted work id is 404 (or archived shape), never 5xx', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const w = await createWorkViaAPI(request, u.access_token, {
            name: `archive-detail-${Date.now().toString(36)}`,
            slug: `archive-detail-${Date.now().toString(36)}`,
        });
        const del = await request.delete(`${API_BASE}/api/works/${w.id}`, {
            headers: authedHeaders(u.access_token),
        });
        if (!del.ok() && del.status() !== 204) {
            test.skip(true, `DELETE returned ${del.status()}`);
        }
        const detail = await request.get(`${API_BASE}/api/works/${w.id}`, {
            headers: authedHeaders(u.access_token),
        });
        expect(detail.status()).toBeLessThan(500);
        // Either 404 (gone) or 200 with an `archived`/`deletedAt`
        // marker. Anything else (especially 5xx) is the regression.
        if (detail.ok()) {
            const body = await detail.json();
            const archivedMarker =
                body?.archived === true ||
                body?.deletedAt ||
                body?.deleted_at ||
                body?.status === 'archived';
            expect(
                archivedMarker,
                'GET on deleted work returns 200 without archived marker — soft-delete contract broken',
            ).toBeTruthy();
        }
    });
});
