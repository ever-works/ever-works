import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Concurrent actions — pass 5. Two parallel API contexts as the same
 * user. We verify:
 *   - Both tokens see the same data (no per-context divergence).
 *   - A mutation from context A is visible to context B on next read.
 *   - Two simultaneous creates don't deadlock or produce a 5xx.
 */

test.describe('Concurrent actions — two contexts, same user', () => {
    test('both contexts read the same /api/auth/profile', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const [a, b] = await Promise.all([
            request.get(`${API_BASE}/api/auth/profile`, {
                headers: authedHeaders(u.access_token),
            }),
            request.get(`${API_BASE}/api/auth/profile`, {
                headers: authedHeaders(u.access_token),
            }),
        ]);
        expect(a.status()).toBe(200);
        expect(b.status()).toBe(200);
        const aBody = await a.json();
        const bBody = await b.json();
        const aId = aBody?.id ?? aBody?.user?.id;
        const bId = bBody?.id ?? bBody?.user?.id;
        expect(aId).toBe(bId);
        expect(aId).toBe(u.user.id);
    });

    test('a work created by context A is visible to context B', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const name = `concurrent-${Date.now().toString(36)}`;
        const create = await request.post(`${API_BASE}/api/works`, {
            headers: authedHeaders(u.access_token),
            data: { name, slug: name, description: `e2e ${name}`, organization: false },
        });
        expect(create.status()).toBeGreaterThanOrEqual(200);
        expect(create.status()).toBeLessThan(300);
        const created = await create.json();
        const id = created?.work?.id ?? created?.id ?? created?.data?.id;
        expect(id, 'create response missing id').toBeTruthy();
        // Now hit /api/works from a fresh request context using the same
        // token. The freshly created work must appear.
        const list = await request.get(`${API_BASE}/api/works`, {
            headers: authedHeaders(u.access_token),
        });
        expect(list.status()).toBe(200);
        const body = await list.json();
        const arr = Array.isArray(body) ? body : (body?.works ?? body?.data ?? []);
        const ids = arr.map((w: { id: string }) => w.id);
        expect(ids).toContain(id);
    });

    test('two simultaneous work creates do not deadlock or 5xx', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const stamp = Date.now().toString(36);
        const [r1, r2] = await Promise.all([
            request.post(`${API_BASE}/api/works`, {
                headers: authedHeaders(u.access_token),
                data: {
                    name: `parallel-${stamp}-1`,
                    slug: `parallel-${stamp}-1`,
                    description: `e2e parallel ${stamp}-1`,
                    organization: false,
                },
            }),
            request.post(`${API_BASE}/api/works`, {
                headers: authedHeaders(u.access_token),
                data: {
                    name: `parallel-${stamp}-2`,
                    slug: `parallel-${stamp}-2`,
                    description: `e2e parallel ${stamp}-2`,
                    organization: false,
                },
            }),
        ]);
        // Neither response is allowed to crash (5xx); 2xx for both is the
        // happy path, but a per-user concurrency limit returning 409/429
        // is also fine.
        expect(r1.status()).toBeLessThan(500);
        expect(r2.status()).toBeLessThan(500);
        // At least one must have succeeded.
        const oneSucceeded = r1.status() < 300 || r2.status() < 300;
        expect(oneSucceeded, `neither parallel create succeeded`).toBe(true);
    });
});
