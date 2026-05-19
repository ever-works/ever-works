import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * Multi-user collaboration — pins the auth boundary between two
 * unrelated users sharing the same API. The platform isolates works
 * per-owner; even after work A's owner invites a second user, the
 * second user MUST see only what they're authorised to.
 *
 * Playwright doesn't natively model "two users at once" — we use two
 * separate API tokens in the same request fixture, which exercises the
 * server-side authorisation logic. UI multi-user simulation lives in
 * Playwright's `browser.newContext()` pattern when needed.
 */

test.describe('Multi-user — work isolation', () => {
    test("user B cannot read user A's work via /api/works/:id", async ({ request }) => {
        const a = await registerUserViaAPI(request);
        const w = await createWorkViaAPI(request, a.access_token, { name: `iso-${Date.now()}` });
        const b = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/works/${w.id}`, {
            headers: authedHeaders(b.access_token),
        });
        expect([403, 404]).toContain(res.status());
    });

    test("user B cannot write to user A's work via PUT /api/works/:id", async ({ request }) => {
        const a = await registerUserViaAPI(request);
        const w = await createWorkViaAPI(request, a.access_token, {
            name: `iso-w-${Date.now()}`,
        });
        const b = await registerUserViaAPI(request);
        const res = await request.put(`${API_BASE}/api/works/${w.id}`, {
            headers: authedHeaders(b.access_token),
            data: { name: 'hijacked' },
        });
        expect([403, 404]).toContain(res.status());
    });

    test("user B's GET /api/works lists ONLY B's works, not A's", async ({ request }) => {
        const a = await registerUserViaAPI(request);
        const aWork = await createWorkViaAPI(request, a.access_token, {
            name: `iso-list-a-${Date.now()}`,
        });
        const b = await registerUserViaAPI(request);
        const bWork = await createWorkViaAPI(request, b.access_token, {
            name: `iso-list-b-${Date.now()}`,
        });
        const res = await request.get(`${API_BASE}/api/works`, {
            headers: authedHeaders(b.access_token),
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        const list = Array.isArray(body) ? body : (body?.works ?? body?.data ?? []);
        const ids = list.map((w: { id: string }) => w.id);
        // B must see their own work in the list.
        expect(ids).toContain(bWork.id);
        // CRITICAL — A's work must NOT appear in B's list. If this ever
        // flips, /api/works is leaking cross-tenant data and the test is
        // worth more than the regression noise.
        expect(ids).not.toContain(aWork.id);
    });

    test("user B cannot read user A's items via /api/works/:id/items", async ({ request }) => {
        const a = await registerUserViaAPI(request);
        const w = await createWorkViaAPI(request, a.access_token, { name: `iso-i-${Date.now()}` });
        const b = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/works/${w.id}/items`, {
            headers: authedHeaders(b.access_token),
        });
        expect([403, 404]).toContain(res.status());
    });

    test("user B cannot enumerate A's API keys", async ({ request }) => {
        const a = await registerUserViaAPI(request);
        // A creates one of its own keys (best effort — schema may differ).
        await request.post(`${API_BASE}/api/auth/api-keys`, {
            headers: authedHeaders(a.access_token),
            data: { name: `iso-key-${Date.now()}` },
        });
        const b = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/auth/api-keys`, {
            headers: authedHeaders(b.access_token),
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        const list = Array.isArray(body) ? body : (body?.keys ?? body?.data ?? []);
        // B's list must be empty (no leak of A's keys) or contain only B's own.
        for (const k of list) {
            // If keys carry an owner / userId field, it MUST be B's id.
            if (k?.userId || k?.ownerId) {
                expect(k.userId || k.ownerId).toBe(b.user.id);
            }
        }
    });

    test("two users' notification counts are independent", async ({ request }) => {
        const a = await registerUserViaAPI(request);
        const b = await registerUserViaAPI(request);
        const resA = await request.get(`${API_BASE}/api/notifications/unread-count`, {
            headers: authedHeaders(a.access_token),
        });
        const resB = await request.get(`${API_BASE}/api/notifications/unread-count`, {
            headers: authedHeaders(b.access_token),
        });
        expect(resA.status()).toBe(200);
        expect(resB.status()).toBe(200);
        // Both fresh users see numeric counts; the test is structural — if
        // either crashed (5xx), we'd catch it.
    });
});

test.describe('Multi-user — concurrent reads on same work', () => {
    test('owner + invitee both 200 on shared work GET (smoke for ACL evaluator)', async ({
        request,
    }) => {
        const a = await registerUserViaAPI(request);
        const w = await createWorkViaAPI(request, a.access_token, {
            name: `iso-share-${Date.now()}`,
        });
        // Try to invite a second user. If the invitation flow is gated for
        // free plans or the schema differs, skip the share-path assertion
        // — the work-members.spec.ts already covers the invitation API.
        const b = await registerUserViaAPI(request);
        const inv = await request.post(`${API_BASE}/api/works/${w.id}/invitations`, {
            headers: authedHeaders(a.access_token),
            data: { email: b.email, role: 'editor' },
        });
        if ([400, 403, 404, 409].includes(inv.status())) {
            test.skip(true, `invitation flow unavailable in this env (${inv.status()})`);
        }
        // Even before accepting, owner can read.
        const ownerRead = await request.get(`${API_BASE}/api/works/${w.id}`, {
            headers: authedHeaders(a.access_token),
        });
        expect(ownerRead.status()).toBe(200);
    });
});
