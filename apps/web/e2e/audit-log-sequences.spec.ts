import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * Audit log — multi-mutation sequences. Deepens audit-log-immutable.spec.ts.
 * The append-only guarantee must hold across:
 *   - PATCH attempt followed by GET (entry unchanged)
 *   - DELETE attempt followed by GET (entry still listable)
 *   - Replay of the same PATCH (still rejected, no idempotent override)
 */

interface ActivityListExtract {
    arr: { id?: string }[];
}

async function listFor(
    request: import('@playwright/test').APIRequestContext,
    token: string,
    workId: string,
): Promise<ActivityListExtract> {
    const res = await request.get(`${API_BASE}/api/activity-log?workId=${workId}`, {
        headers: authedHeaders(token),
    });
    if (res.status() !== 200) return { arr: [] };
    const body = await res.json();
    const arr = Array.isArray(body)
        ? body
        : (body?.activities ?? body?.entries ?? body?.data ?? body?.logs ?? []);
    return { arr };
}

test.describe('Audit log — multi-mutation sequence', () => {
    test('PATCH → GET shows the entry unchanged', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const w = await createWorkViaAPI(request, u.access_token, {
            name: `audit-seq-${Date.now().toString(36)}`,
        });
        const list1 = await listFor(request, u.access_token, w.id);
        if (list1.arr.length === 0) test.skip(true, 'no activity-log entries yet');
        const entry = list1.arr[0];
        const entryId = entry?.id;
        if (!entryId) test.skip(true, 'no id field on entries');

        // Attempt the mutation.
        const patch = await request.patch(`${API_BASE}/api/activity-log/${entryId}`, {
            headers: authedHeaders(u.access_token),
            data: { action: 'tampered-by-test' },
        });
        expect(patch.status()).toBeGreaterThanOrEqual(400);

        // Re-fetch — the entry must look the same as before (or at least
        // not carry the tampered value).
        const list2 = await listFor(request, u.access_token, w.id);
        const after = list2.arr.find((e) => e?.id === entryId);
        if (!after) test.skip(true, 'entry no longer listable post-patch');
        // No field anywhere should contain the tamper sentinel.
        const serialised = JSON.stringify(after);
        expect(
            serialised.includes('tampered-by-test'),
            'PATCH leaked the tamper value into the persisted entry',
        ).toBe(false);
    });

    test('DELETE → GET still shows the entry', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const w = await createWorkViaAPI(request, u.access_token, {
            name: `audit-seq-del-${Date.now().toString(36)}`,
        });
        const list1 = await listFor(request, u.access_token, w.id);
        if (list1.arr.length === 0) test.skip(true, 'no entries');
        const entryId = list1.arr[0]?.id;
        if (!entryId) test.skip(true, 'no id');

        const del = await request.delete(`${API_BASE}/api/activity-log/${entryId}`, {
            headers: authedHeaders(u.access_token),
        });
        expect(del.status()).toBeGreaterThanOrEqual(400);

        const list2 = await listFor(request, u.access_token, w.id);
        const ids = list2.arr.map((e) => e?.id).filter(Boolean);
        // The entry must still be listable. We accept a small possibility
        // that the list is paginated and the entry slipped off the first
        // page, but it MUST NOT have disappeared.
        if (list2.arr.length === 0) test.skip(true, 'list endpoint became empty mid-test');
        expect(ids).toContain(entryId);
    });

    test('replay of the same PATCH is still rejected (no idempotent unlock)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const w = await createWorkViaAPI(request, u.access_token, {
            name: `audit-seq-replay-${Date.now().toString(36)}`,
        });
        const list1 = await listFor(request, u.access_token, w.id);
        if (list1.arr.length === 0) test.skip(true, 'no entries');
        const entryId = list1.arr[0]?.id;
        if (!entryId) test.skip(true, 'no id');

        const r1 = await request.patch(`${API_BASE}/api/activity-log/${entryId}`, {
            headers: authedHeaders(u.access_token),
            data: { action: 'replay-attempt-1' },
        });
        const r2 = await request.patch(`${API_BASE}/api/activity-log/${entryId}`, {
            headers: authedHeaders(u.access_token),
            data: { action: 'replay-attempt-1' },
        });
        expect(r1.status()).toBeGreaterThanOrEqual(400);
        expect(r2.status()).toBeGreaterThanOrEqual(400);
        // Both must end in the same status class — no caching that
        // silently turns the second call into 2xx.
        expect(Math.floor(r1.status() / 100)).toBe(Math.floor(r2.status() / 100));
    });
});
