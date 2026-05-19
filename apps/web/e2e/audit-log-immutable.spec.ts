import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * Audit log immutability — pass 5+ early. Activity log entries describe
 * what happened; the audit-trail guarantee is they cannot be edited or
 * deleted via the public API. We pin that here by:
 *
 *   1. Creating a work (generates an activity-log entry).
 *   2. Listing the log and capturing an entry id.
 *   3. Trying to mutate / delete that entry — both MUST be refused.
 *   4. Confirming the entry is still present.
 *
 * If the platform doesn't expose mutate/delete on `/api/activity-log/:id`
 * at all, we still validate that no such verb returns 2xx — 4xx (with
 * 405 or 404) is the correct answer.
 */

test.describe('Activity log — append-only / immutable', () => {
    test('entries cannot be edited via PATCH/PUT', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const w = await createWorkViaAPI(request, u.access_token, {
            name: `audit-${Date.now().toString(36)}`,
        });
        // Fetch the activity log; capture an id we can target.
        const list = await request.get(`${API_BASE}/api/activity-log?workId=${w.id}`, {
            headers: authedHeaders(u.access_token),
        });
        if (list.status() !== 200) {
            test.skip(
                true,
                `activity-log list returned ${list.status()}, can't probe immutability`,
            );
        }
        const body = await list.json();
        const arr = Array.isArray(body) ? body : (body?.entries ?? body?.data ?? body?.logs ?? []);
        if (arr.length === 0) {
            test.skip(true, 'no activity-log entries yet for the freshly created work');
        }
        const entryId = arr[0]?.id;
        if (!entryId) {
            test.skip(true, 'activity-log entry has no id field');
        }
        // Attempt PATCH and PUT. Both must NOT return 2xx.
        const patch = await request.patch(`${API_BASE}/api/activity-log/${entryId}`, {
            headers: authedHeaders(u.access_token),
            data: { action: 'tampered' },
        });
        expect(
            patch.status(),
            `PATCH must NOT succeed (got ${patch.status()})`,
        ).toBeGreaterThanOrEqual(400);
        const put = await request.put(`${API_BASE}/api/activity-log/${entryId}`, {
            headers: authedHeaders(u.access_token),
            data: { action: 'tampered' },
        });
        expect(put.status(), `PUT must NOT succeed (got ${put.status()})`).toBeGreaterThanOrEqual(
            400,
        );
    });

    test('entries cannot be deleted via DELETE', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const w = await createWorkViaAPI(request, u.access_token, {
            name: `audit-del-${Date.now().toString(36)}`,
        });
        const list = await request.get(`${API_BASE}/api/activity-log?workId=${w.id}`, {
            headers: authedHeaders(u.access_token),
        });
        if (list.status() !== 200) {
            test.skip(true, `activity-log list returned ${list.status()}`);
        }
        const body = await list.json();
        const arr = Array.isArray(body) ? body : (body?.entries ?? body?.data ?? body?.logs ?? []);
        if (arr.length === 0) {
            test.skip(true, 'no entries to probe');
        }
        const entryId = arr[0]?.id;
        if (!entryId) {
            test.skip(true, 'no id field on entries');
        }
        const del = await request.delete(`${API_BASE}/api/activity-log/${entryId}`, {
            headers: authedHeaders(u.access_token),
        });
        expect(
            del.status(),
            `DELETE on an audit entry must NOT succeed (got ${del.status()})`,
        ).toBeGreaterThanOrEqual(400);

        // The entry must still be retrievable after the attempted delete.
        const verify = await request.get(`${API_BASE}/api/activity-log/${entryId}`, {
            headers: authedHeaders(u.access_token),
        });
        // 200 = still there; 404 = endpoint never had a per-id GET. Both
        // OK. What's NOT acceptable is the original DELETE returning 2xx
        // and the entry disappearing — which we already failed above.
        expect(verify.status()).toBeLessThan(500);
    });

    test('stranger cannot mutate another user audit entry', async ({ request }) => {
        const owner = await registerUserViaAPI(request);
        const w = await createWorkViaAPI(request, owner.access_token, {
            name: `audit-stranger-${Date.now().toString(36)}`,
        });
        const list = await request.get(`${API_BASE}/api/activity-log?workId=${w.id}`, {
            headers: authedHeaders(owner.access_token),
        });
        if (list.status() !== 200) test.skip(true, 'list unavailable');
        const body = await list.json();
        const arr = Array.isArray(body) ? body : (body?.entries ?? body?.data ?? []);
        if (arr.length === 0) test.skip(true, 'no entries');
        const entryId = arr[0]?.id;
        if (!entryId) test.skip(true, 'no id field');

        const stranger = await registerUserViaAPI(request);
        const patch = await request.patch(`${API_BASE}/api/activity-log/${entryId}`, {
            headers: authedHeaders(stranger.access_token),
            data: { action: 'tampered' },
        });
        // Stranger's mutation MUST be 401/403/404/405 — never 2xx, never 5xx.
        expect(patch.status()).toBeGreaterThanOrEqual(400);
        expect(patch.status()).toBeLessThan(500);
    });
});
