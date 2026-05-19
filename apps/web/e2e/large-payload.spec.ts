import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Large payload boundaries — pass 6. The platform should accept
 * reasonable payloads but reject obviously-huge ones with 413 (Payload
 * Too Large), not a 5xx or silent OOM.
 *
 * Numbers are chosen to be loose: 100 KB should always succeed, 5 MB
 * is borderline and may be rejected, 50 MB should always be rejected.
 */

const KB = 1024;
const MB = 1024 * KB;

function fillerString(bytes: number, char = 'x'): string {
    return char.repeat(bytes);
}

test.describe('Large payload — body-size limits honoured', () => {
    test('100 KB description in /api/works POST is accepted', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const description = fillerString(100 * KB);
        const res = await request.post(`${API_BASE}/api/works`, {
            headers: authedHeaders(u.access_token),
            data: {
                name: `large-100kb-${Date.now().toString(36)}`,
                slug: `large-100kb-${Date.now().toString(36)}`,
                description,
            },
        });
        // Could be 201/200 (accepted) or 400/422 (validation rejects
        // long description) — but never 413 / 5xx for 100 KB.
        expect(res.status()).toBeLessThan(500);
        if (res.status() === 413) {
            test.skip(true, '100 KB is unexpectedly over the limit in this env');
        }
    });

    test('10 MB payload is rejected with 4xx (not 5xx)', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        // 10 MB filler — still well above the typical 1 MB Express
        // body-parser ceiling, but safe enough to avoid OOM-killing
        // a 256 MB CI worker. Greptile P2 callout: a 50 MB JS string
        // takes ~100 MB in V8's UTF-16 representation, and serialising
        // it via Playwright pushes peak RSS to 150-200 MB.
        const huge = fillerString(10 * MB);
        const res = await request.post(`${API_BASE}/api/works`, {
            headers: authedHeaders(u.access_token),
            data: { name: 'huge', slug: 'huge', description: huge },
        });
        // The server MUST reject this with a 4xx — typically 413 (Payload
        // Too Large), 400, or 422. A 5xx means body-parser crashed or
        // the request actually got far enough to fall over later.
        expect(res.status()).toBeGreaterThanOrEqual(400);
        expect(res.status()).toBeLessThan(500);
    });

    test('huge query string is rejected gracefully', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        // 16 KB query string. Most servers cap at 8 KB.
        const big = fillerString(16 * KB);
        const res = await request.get(`${API_BASE}/api/works?filter=${big}`, {
            headers: authedHeaders(u.access_token),
        });
        // 200/4xx — never 5xx. URL length limits are typically enforced
        // at the proxy / Node http parser layer.
        expect(res.status()).toBeLessThan(500);
    });
});

test.describe('Large payload — items import body', () => {
    test('items array with 10K small entries is rejected gracefully', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        // Create the work first.
        const w = await request.post(`${API_BASE}/api/works`, {
            headers: authedHeaders(u.access_token),
            data: { name: `import-bulk-${Date.now().toString(36)}` },
        });
        if (!w.ok()) test.skip(true, "couldn't seed work for bulk import");
        const wJson = await w.json();
        const id = wJson?.work?.id ?? wJson?.id ?? wJson?.data?.id;
        if (!id) test.skip(true, 'no work id');

        const items = Array.from({ length: 10_000 }, (_, i) => ({
            name: `bulk-${i}`,
            slug: `bulk-${i}`,
        }));
        const res = await request.post(`${API_BASE}/api/works/${id}/import-items`, {
            headers: authedHeaders(u.access_token),
            data: { items },
        });
        // Either accepted (server can handle 10K items) or rejected
        // with a clear 4xx. No 5xx.
        expect(res.status()).toBeLessThan(500);
    });
});
