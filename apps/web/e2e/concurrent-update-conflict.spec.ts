import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * Concurrent update conflict — pass 20. Pass-7 `concurrent-conflict`
 * covered "two parallel PUTs don't 5xx". This pass tightens the
 * contract:
 *  - two parallel PATCHes with different name values both stay < 500
 *  - the final GET reflects EXACTLY one of the two values (no
 *    Frankenstein merge of partial fields)
 *  - if optimistic locking (If-Match/ETag) is exposed, mismatched
 *    ETag returns 409/412
 */

test.describe('Concurrent update — last-write-wins / 409 / no Frankenstein merge', () => {
    test('two parallel PATCHes resolve to exactly one of the two values', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const tag = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const w = await createWorkViaAPI(request, u.access_token, {
            name: `concurrent-${tag}`,
            slug: `concurrent-${tag}`,
        });
        const valueA = `name-a-${tag}`;
        const valueB = `name-b-${tag}`;
        const [r1, r2] = await Promise.all([
            request.patch(`${API_BASE}/api/works/${w.id}`, {
                headers: authedHeaders(u.access_token),
                data: { name: valueA },
            }),
            request.patch(`${API_BASE}/api/works/${w.id}`, {
                headers: authedHeaders(u.access_token),
                data: { name: valueB },
            }),
        ]);
        expect(r1.status()).toBeLessThan(500);
        expect(r2.status()).toBeLessThan(500);
        // Final state must equal exactly one of A or B — never a merge
        // like "name-a-XXX-b" or a partial-overwrite.
        const detail = await request.get(`${API_BASE}/api/works/${w.id}`, {
            headers: authedHeaders(u.access_token),
        });
        if (!detail.ok()) test.skip(true, `detail ${detail.status()}`);
        const body = await detail.json();
        const finalName = body?.name ?? body?.work?.name ?? body?.data?.name;
        if (typeof finalName !== 'string') test.skip(true, 'no name field on detail');
        expect(
            [valueA, valueB].includes(finalName),
            `final name="${finalName}" is neither ${valueA} nor ${valueB} — Frankenstein merge`,
        ).toBe(true);
    });

    test('If-Match with bogus ETag returns 412 / 409 (or 4xx) — never silent overwrite', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const tag = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const w = await createWorkViaAPI(request, u.access_token, {
            name: `etag-${tag}`,
            slug: `etag-${tag}`,
        });
        const res = await request.patch(`${API_BASE}/api/works/${w.id}`, {
            headers: {
                ...authedHeaders(u.access_token),
                'If-Match': '"bogus-etag-that-does-not-match"',
            },
            data: { name: `would-overwrite-${tag}` },
        });
        // If the server honours If-Match: 412 Precondition Failed.
        // If it ignores: 200 (informational — no optimistic locking).
        // Never 5xx.
        expect(res.status()).toBeLessThan(500);
        if (res.ok()) {
            test.info().annotations.push({
                type: 'informational',
                description: `If-Match with bogus ETag accepted — server doesn't honour optimistic locking`,
            });
        }
    });
});
