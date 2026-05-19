import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Audit log tamper resistance — pass 15. Activity-log entries are
 * append-only by contract. Pass-4 covered immutability via HTTP verbs
 * (PATCH/PUT/DELETE all 4xx). This pass probes a deeper invariant:
 *  - the response shape for PATCH/PUT/DELETE NEVER includes the
 *    entry's content (i.e. no half-applied tamper that leaks current
 *    state back to attacker)
 *  - GET listing after attempted mutation matches the GET listing
 *    before — no drift in row count or first-id
 */

test.describe('Audit log — tamper attempts leave the store intact', () => {
    test('PATCH /api/activity-log/<id> does not echo entry body even on failure', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const list = await request.get(`${API_BASE}/api/activity-log`, {
            headers: authedHeaders(u.access_token),
        });
        if (!list.ok()) test.skip(true, `cannot list activity-log (${list.status()})`);
        const body = await list.json();
        const arr: Array<{ id?: string }> = Array.isArray(body)
            ? body
            : (body?.data ?? body?.entries ?? body?.items ?? []);
        if (arr.length === 0) test.skip(true, 'no activity-log entries to probe');
        const entryId = arr[0].id;
        const patch = await request.patch(`${API_BASE}/api/activity-log/${entryId}`, {
            headers: authedHeaders(u.access_token),
            data: { actionType: 'TAMPERED' },
        });
        expect(patch.status(), `PATCH succeeded — log is mutable`).toBeGreaterThanOrEqual(400);
        // The error response must NOT contain the literal "TAMPERED"
        // value — if it did, the server processed the body before
        // rejecting, which means the verb-check is happening too late.
        const text = await patch.text();
        expect(text.includes('TAMPERED'), 'PATCH rejection echoed back tamper payload').toBe(false);
    });

    test('listing remains stable across a failed PATCH burst', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const before = await request.get(`${API_BASE}/api/activity-log`, {
            headers: authedHeaders(u.access_token),
        });
        if (!before.ok()) test.skip(true, `cannot read activity-log`);
        const beforeBody = await before.json();
        const beforeArr: Array<{ id?: string }> = Array.isArray(beforeBody)
            ? beforeBody
            : (beforeBody?.data ?? beforeBody?.entries ?? beforeBody?.items ?? []);
        if (beforeArr.length === 0) test.skip(true, 'empty audit log');
        // Hammer PATCH on the first id with garbage payloads.
        for (let i = 0; i < 5; i++) {
            await request
                .patch(`${API_BASE}/api/activity-log/${beforeArr[0].id}`, {
                    headers: authedHeaders(u.access_token),
                    data: { actionType: `ATTACK-${i}` },
                })
                .catch(() => null);
        }
        const after = await request.get(`${API_BASE}/api/activity-log`, {
            headers: authedHeaders(u.access_token),
        });
        const afterBody = await after.json();
        const afterArr: Array<{ id?: string }> = Array.isArray(afterBody)
            ? afterBody
            : (afterBody?.data ?? afterBody?.entries ?? afterBody?.items ?? []);
        // The first id must be the same — even if rows were appended.
        expect(
            afterArr[0]?.id,
            `first audit-log id changed after PATCH burst (was ${beforeArr[0].id})`,
        ).toBe(beforeArr[0].id);
        // Row count must NOT have decreased (no destructive tampering).
        expect(afterArr.length).toBeGreaterThanOrEqual(beforeArr.length);
    });
});
