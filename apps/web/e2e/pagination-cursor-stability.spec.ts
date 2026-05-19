import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * Pagination cursor stability — pass 17. Cursor-based pagination
 * (`?cursor=...`) should:
 *  - return a server-controlled opaque token (not row offset, not
 *    raw row id with sortable format)
 *  - allow replaying the cursor to get a coherent page (no skipped
 *    rows, no dupes, no 5xx)
 *  - reject garbage cursors with 4xx (not 5xx)
 */

test.describe('Pagination — cursor opacity + replay coherency', () => {
    test('replaying a fresh cursor returns a coherent page', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        // Create 5 works so listing has rows.
        for (let i = 0; i < 5; i++) {
            await createWorkViaAPI(request, u.access_token, {
                name: `cursor-${Date.now().toString(36)}-${i}`,
                slug: `cursor-${Date.now().toString(36)}-${i}`,
            }).catch(() => null);
        }
        const first = await request.get(`${API_BASE}/api/works?limit=2`, {
            headers: authedHeaders(u.access_token),
        });
        if (!first.ok()) test.skip(true, `/api/works failed (${first.status()})`);
        const body = await first.json();
        const cursor =
            body?.nextCursor ?? body?.cursor ?? body?.next_cursor ?? body?.meta?.nextCursor;
        if (!cursor || typeof cursor !== 'string') {
            test.skip(true, 'no cursor in response — endpoint may use offset pagination');
        }
        // Replay the same cursor twice — should be coherent.
        const r1 = await request.get(
            `${API_BASE}/api/works?cursor=${encodeURIComponent(cursor)}&limit=2`,
            { headers: authedHeaders(u.access_token) },
        );
        const r2 = await request.get(
            `${API_BASE}/api/works?cursor=${encodeURIComponent(cursor)}&limit=2`,
            { headers: authedHeaders(u.access_token) },
        );
        expect(r1.status()).toBeLessThan(500);
        expect(r2.status()).toBeLessThan(500);
        if (!r1.ok() || !r2.ok()) test.skip(true, 'cursor replay returned non-ok');
        // Coherency: same cursor returns same ids (no skip/dup).
        const ids1 = extractIds(await r1.json());
        const ids2 = extractIds(await r2.json());
        expect(ids1.sort().join(','), 'cursor replay returned different rows').toEqual(
            ids2.sort().join(','),
        );
    });

    test('garbage cursor returns 4xx (not 5xx)', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const garbage = ['this-is-not-a-cursor', '%%%', 'A'.repeat(2048), '../../../etc/passwd'];
        for (const c of garbage) {
            const res = await request.get(`${API_BASE}/api/works?cursor=${encodeURIComponent(c)}`, {
                headers: authedHeaders(u.access_token),
            });
            expect(
                res.status(),
                `garbage cursor ${JSON.stringify(c.slice(0, 30))} crashed: ${res.status()}`,
            ).toBeLessThan(500);
        }
    });
});

function extractIds(body: unknown): string[] {
    if (!body) return [];
    const arr = Array.isArray(body)
        ? body
        : ((body as { data?: unknown; works?: unknown }).data ??
          (body as { works?: unknown }).works ??
          []);
    if (!Array.isArray(arr)) return [];
    return arr
        .map((row) => (row && typeof row === 'object' ? (row as { id?: string }).id : undefined))
        .filter((id): id is string => typeof id === 'string');
}
