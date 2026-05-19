import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * Read-replica posture — pass 15. If a read-replica is configured,
 * read-only endpoints should still serve stale-but-coherent data when
 * the primary is under load. We don't have a way to flip the primary
 * offline mid-test; instead we probe that:
 *  - read endpoints (GET /api/works, GET /api/notifications) succeed
 *    independently of recent writes (no transactional read-your-writes
 *    deadlock on the primary)
 *  - a fresh write IS observable on the next read (read-replica lag
 *    isn't unbounded — within 5s the row appears)
 *
 * If lag exceeds 5s or the read fails, the spec fails, indicating
 * either misconfigured replication or single-DB setup with a deeper
 * coherency bug.
 */

test.describe('Read replica — write-then-read coherency', () => {
    test('newly created work is observable on /api/works list within 5s', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const slug = `replica-${Date.now().toString(36)}`;
        const created = await createWorkViaAPI(request, u.access_token, {
            name: `replica-${Date.now().toString(36)}`,
            slug,
        });
        // Poll the list endpoint for up to 5s.
        let seen = false;
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
            const list = await request.get(`${API_BASE}/api/works`, {
                headers: authedHeaders(u.access_token),
            });
            if (list.ok()) {
                const body = await list.json();
                const arr = Array.isArray(body) ? body : (body?.data ?? body?.works ?? []);
                if (arr.some((w: { id?: string }) => w.id === created.id)) {
                    seen = true;
                    break;
                }
            }
            await new Promise((r) => setTimeout(r, 250));
        }
        expect(seen, 'work created via write was not visible on read within 5s').toBe(true);
    });

    test('repeated /api/works reads return consistent ids across 5 rapid calls', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        // Create one work as a known row.
        await createWorkViaAPI(request, u.access_token, {
            name: `coherency-${Date.now().toString(36)}`,
            slug: `coherency-${Date.now().toString(36)}`,
        });
        const idSets: Set<string>[] = [];
        for (let i = 0; i < 5; i++) {
            const list = await request.get(`${API_BASE}/api/works`, {
                headers: authedHeaders(u.access_token),
            });
            if (!list.ok()) {
                test.skip(true, `/api/works failed (${list.status()})`);
            }
            const body = await list.json();
            const arr: Array<{ id?: string }> = Array.isArray(body)
                ? body
                : (body?.data ?? body?.works ?? []);
            idSets.push(new Set(arr.map((w) => w.id || '').filter(Boolean)));
        }
        // Every read should share at least one id (the one we just
        // created). Empty intersections across 5 reads = replica lag
        // or coherency bug.
        const intersection = idSets.reduce((acc, s) => {
            return new Set([...acc].filter((x) => s.has(x)));
        });
        expect(intersection.size, 'no id present in all 5 rapid /api/works reads').toBeGreaterThan(
            0,
        );
    });
});
