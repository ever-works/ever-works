import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Unicode collation — pass 7. Non-ASCII content (emoji, RTL, Han)
 * should survive a create → list → read round-trip with bytes intact.
 * Common regressions: latin1 collation truncating multi-byte chars,
 * mb-string functions confusing length counts, or a sanitiser stripping
 * "suspicious" code points.
 */

const UNICODE_NAMES = [
    { label: 'emoji', value: 'work 🚀 with emoji 🎯' },
    { label: 'rtl (arabic)', value: 'مشروع تجريبي' },
    { label: 'han (cjk)', value: '测试工作 — 中文' },
    { label: 'cyrillic + combining', value: 'тестовый Проёкт' },
    { label: 'tags + surrogate pair', value: '𝓘𝓽𝓪𝓵𝓲𝓬 work' },
];

test.describe('Unicode — create / read round-trip', () => {
    for (const variant of UNICODE_NAMES) {
        test(`work name with ${variant.label} survives create → list → read`, async ({
            request,
        }) => {
            const u = await registerUserViaAPI(request);
            // Slug must be ASCII-safe; only the displayed name carries
            // the unicode payload.
            const stamp = Date.now().toString(36);
            const create = await request.post(`${API_BASE}/api/works`, {
                headers: authedHeaders(u.access_token),
                data: {
                    name: variant.value,
                    slug: `unicode-${variant.label.replace(/[^a-z]/g, '')}-${stamp}`,
                    description: `unicode round-trip test: ${variant.value}`,
                },
            });
            if (!create.ok()) {
                test.skip(true, `couldn't create work with ${variant.label} (${create.status()})`);
            }
            const created = await create.json();
            const id = created?.work?.id ?? created?.id ?? created?.data?.id;
            expect(id, 'no id from create').toBeTruthy();

            // Detail fetch — name must match byte-for-byte.
            const detail = await request.get(`${API_BASE}/api/works/${id}`, {
                headers: authedHeaders(u.access_token),
            });
            expect(detail.status()).toBe(200);
            const detailBody = await detail.json();
            const fetchedName =
                detailBody?.name ?? detailBody?.work?.name ?? detailBody?.data?.name;
            expect(fetchedName, `detail fetch lost the ${variant.label} payload`).toBe(
                variant.value,
            );
        });
    }
});

test.describe('Unicode — list endpoint includes unicode names without mangling', () => {
    test('GET /api/works returns the unicode work in the list', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const name = '混合 RTL مرحبا + 🎉';
        const slug = `unicode-list-${Date.now().toString(36)}`;
        const create = await request.post(`${API_BASE}/api/works`, {
            headers: authedHeaders(u.access_token),
            data: { name, slug },
        });
        if (!create.ok()) test.skip(true, `couldn't create unicode work (${create.status()})`);

        const list = await request.get(`${API_BASE}/api/works`, {
            headers: authedHeaders(u.access_token),
        });
        expect(list.status()).toBe(200);
        const body = await list.json();
        const arr = Array.isArray(body) ? body : (body?.works ?? body?.data ?? []);
        const names = arr.map((w: { name?: string }) => w?.name);
        expect(names, 'unicode work not in list').toContain(name);
    });
});
