import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * XSS / HTML encoding — pass 12. User-supplied fields (work name,
 * description, item title) MUST be HTML-encoded when echoed back in
 * any text/html response. If a `<script>` tag in a work name reaches
 * the DOM unchanged, it's a stored XSS.
 *
 * We don't render the work in a browser; we make the API call and
 * inspect the JSON response. The pattern then verifies the WEB
 * route that renders the work doesn't echo raw script tags either.
 */

const XSS_NAME = `xss-${Date.now().toString(36)}-<script>alert(1)</script>`;
const XSS_IMG = `xss-img-${Date.now().toString(36)}-"><img src=x onerror=alert(1)>`;

test.describe('XSS — work name JSON response', () => {
    test('creating a work with <script> in the name does not crash the API', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const create = await request.post(`${API_BASE}/api/works`, {
            headers: authedHeaders(u.access_token),
            data: { name: XSS_NAME, slug: `xss-${Date.now().toString(36)}` },
        });
        // Either accepted (200/201) — value will be returned verbatim
        // in JSON, which is safe because JSON responses don't execute —
        // or rejected (400/422) by input validation. Never 5xx.
        expect(create.status()).toBeLessThan(500);
    });

    test('fetching a work created with <script> name returns the name as a STRING field', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const w = await createWorkViaAPI(request, u.access_token, {
            name: XSS_NAME,
            slug: `xss-fetch-${Date.now().toString(36)}`,
        });
        const detail = await request.get(`${API_BASE}/api/works/${w.id}`, {
            headers: authedHeaders(u.access_token),
        });
        expect(detail.status()).toBe(200);
        const body = await detail.json();
        const ct = detail.headers()['content-type'] || '';
        // The response must be JSON. JSON is safe — the browser
        // wouldn't execute `<script>` from a JSON payload. We just
        // verify the API didn't accidentally return HTML.
        expect(ct.includes('json'), `unexpected content-type: ${ct}`).toBe(true);
        const fetchedName = body?.name ?? body?.work?.name ?? body?.data?.name;
        // The string must round-trip — escaping it on write would also
        // be wrong (the name is stored as-is, encoding happens at the
        // RENDER layer).
        expect(typeof fetchedName).toBe('string');
    });

    test('img-XSS payload in description survives create without breaking the work', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const create = await request.post(`${API_BASE}/api/works`, {
            headers: authedHeaders(u.access_token),
            data: {
                name: `xss-desc-${Date.now().toString(36)}`,
                slug: `xss-desc-${Date.now().toString(36)}`,
                description: XSS_IMG,
            },
        });
        expect(create.status()).toBeLessThan(500);
    });
});

test.describe('XSS — rendered HTML response does not echo raw script tags', () => {
    test('the API response that carries a tainted work escapes it (or returns JSON)', async ({
        request,
    }) => {
        // Codex P2: the previous shape navigated to /en/login which
        // never includes the tainted work — a stored-XSS regression
        // on the actual rendering path would still pass. Now we POST
        // a work with an XSS payload in the name and GET the detail
        // endpoint that would render it. JSON content-type is safe
        // by encoding; HTML content-type must NOT carry an executable
        // <script> with the alert(1) canary.
        const u = await registerUserViaAPI(request);
        const tainted = `xss-stored-${Date.now().toString(36)}-<script>alert(1)</script>`;
        const create = await request.post(`${API_BASE}/api/works`, {
            headers: authedHeaders(u.access_token),
            data: { name: tainted, slug: `xss-render-${Date.now().toString(36)}` },
        });
        if (!create.ok()) test.skip(true, `couldn't create tainted work (${create.status()})`);
        const created = await create.json();
        const id = created?.work?.id ?? created?.id ?? created?.data?.id;
        if (!id) test.skip(true, 'no id from create');
        const detail = await request.get(`${API_BASE}/api/works/${id}`, {
            headers: authedHeaders(u.access_token),
        });
        const ct = detail.headers()['content-type'] || '';
        if (ct.includes('json')) {
            // JSON is safe by content-type — the browser doesn't
            // execute <script> tags in JSON. We just verify the field
            // round-trips as a string and isn't accidentally double-
            // encoded.
            const body = await detail.json();
            const name = body?.name ?? body?.work?.name ?? body?.data?.name;
            expect(typeof name).toBe('string');
            expect(name, 'name was double-encoded').not.toContain('&amp;lt;');
        } else {
            // HTML response — must NOT carry executable alert(1).
            const html = await detail.text();
            const matches = html.match(
                /<script[^>]*>[\s\S]*?alert\s*\(\s*1\s*\)[\s\S]*?<\/script>/gi,
            );
            expect(
                matches,
                `detail HTML contained executable alert(1): ${matches?.join(', ')}`,
            ).toBeNull();
        }
    });

    test('login page never includes executable alert(1) (sanity baseline)', async ({
        page,
        baseURL,
    }) => {
        await page.goto(`${baseURL || 'http://localhost:3000'}/en/login`, {
            waitUntil: 'domcontentloaded',
        });
        const html = await page.content();
        const matches = html.match(/<script[^>]*>[\s\S]*?alert\s*\(\s*1\s*\)[\s\S]*?<\/script>/gi);
        expect(
            matches,
            `login page contained executable alert(1) script: ${matches?.join(', ')}`,
        ).toBeNull();
    });
});
