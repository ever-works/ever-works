import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Slug collisions — pass 7. Two works in the same user namespace must
 * not share the same slug. The server must either:
 *   - 409 the second create
 *   - Auto-disambiguate (e.g. append `-2`)
 *
 * Across DIFFERENT users, slugs may or may not be scoped — we don't
 * pin a policy, just that the response is sane.
 */

test.describe('Slug collision — same-owner namespace', () => {
    test('creating two works with identical slug → 409 OR auto-disambiguated', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const slug = `dup-${Date.now().toString(36)}`;
        const r1 = await request.post(`${API_BASE}/api/works`, {
            headers: authedHeaders(u.access_token),
            data: { name: 'First with this slug', slug },
        });
        expect(r1.status()).toBeGreaterThanOrEqual(200);
        expect(r1.status()).toBeLessThan(300);
        const w1 = await r1.json();
        const id1 = w1?.work?.id ?? w1?.id ?? w1?.data?.id;
        const slug1 = w1?.work?.slug ?? w1?.slug ?? w1?.data?.slug ?? slug;
        expect(id1, 'first create returned no id').toBeTruthy();

        const r2 = await request.post(`${API_BASE}/api/works`, {
            headers: authedHeaders(u.access_token),
            data: { name: 'Second with same slug', slug },
        });
        // Acceptable outcomes:
        //   - 409 / 422: same-slug rejection
        //   - 201 / 200 with a DIFFERENT slug in the response (disambiguated)
        // NOT acceptable:
        //   - 5xx
        //   - 2xx with the SAME slug (would shadow the first)
        expect(r2.status()).toBeLessThan(500);
        if (r2.status() >= 400) {
            // Rejection — fine.
            return;
        }
        const w2 = await r2.json();
        const id2 = w2?.work?.id ?? w2?.id ?? w2?.data?.id;
        const slug2 = w2?.work?.slug ?? w2?.slug ?? w2?.data?.slug;
        expect(id2, 'second create returned no id').toBeTruthy();
        // If both succeeded, slugs MUST be different.
        expect(slug2, 'duplicate slug accepted unchanged').not.toBe(slug1);
    });
});

test.describe('Slug collision — cross-owner namespace', () => {
    test('two different users with same slug → both succeed (or both get scoped slugs)', async ({
        request,
    }) => {
        const slug = `cross-${Date.now().toString(36)}`;
        const a = await registerUserViaAPI(request);
        const b = await registerUserViaAPI(request);
        const r1 = await request.post(`${API_BASE}/api/works`, {
            headers: authedHeaders(a.access_token),
            data: { name: 'A work', slug },
        });
        const r2 = await request.post(`${API_BASE}/api/works`, {
            headers: authedHeaders(b.access_token),
            data: { name: 'B work', slug },
        });
        // Both must NOT be 5xx. We accept either:
        //   - Both 2xx (per-user namespace)
        //   - B's 409 (global slug uniqueness)
        expect(r1.status()).toBeLessThan(500);
        expect(r2.status()).toBeLessThan(500);
        const ok1 = r1.status() < 300;
        const ok2 = r2.status() < 300;
        // At least one must have succeeded (otherwise the slug is
        // unmintable for anyone).
        expect(ok1 || ok2).toBe(true);
    });
});

test.describe('Slug rename — happy path', () => {
    test('PUT /api/works/:id changing slug responds < 500', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const stamp = Date.now().toString(36);
        const create = await request.post(`${API_BASE}/api/works`, {
            headers: authedHeaders(u.access_token),
            data: { name: `rename ${stamp}`, slug: `before-${stamp}` },
        });
        expect(create.ok()).toBe(true);
        const created = await create.json();
        const id = created?.work?.id ?? created?.id ?? created?.data?.id;
        const rename = await request.put(`${API_BASE}/api/works/${id}`, {
            headers: authedHeaders(u.access_token),
            data: { slug: `after-${stamp}` },
        });
        expect(rename.status()).toBeLessThan(500);
    });
});
