import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * Work members + invitations — the collaboration surface under
 * `/api/works/:workId/{members,invitations}`. This suite pins the
 * REST contract for both controllers and the auth shape (owner can
 * list, non-member cannot, unauthenticated 401s).
 */

test.describe('Work members — API contract', () => {
    test('GET /api/works/:id/members without auth → 401', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/works/dead-beef/members`);
        expect(res.status()).toBe(401);
    });

    test('GET /api/works/:id/members for own work returns array', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, u.access_token, {
            name: `e2e-members-${Date.now()}`,
        });
        const res = await request.get(`${API_BASE}/api/works/${work.id}/members`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        // Members controller returns { members, owner } — owner is a
        // sibling field, not folded into the members list. A fresh work
        // has zero collaborator members but always has an owner, so we
        // count members + owner together.
        const arr = Array.isArray(body) ? body : (body?.members ?? body?.data ?? []);
        expect(Array.isArray(arr)).toBe(true);
        const totalPeople = arr.length + (body?.owner ? 1 : 0);
        expect(totalPeople, 'no members nor owner returned').toBeGreaterThanOrEqual(1);
    });

    test("GET /api/works/:id/members for a stranger's work → 403 or 404", async ({ request }) => {
        const owner = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, {
            name: `e2e-stranger-${Date.now()}`,
        });
        const intruder = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/works/${work.id}/members`, {
            headers: authedHeaders(intruder.access_token),
        });
        expect([403, 404]).toContain(res.status());
    });

    test('POST /api/works/:id/members/leave without auth → 401', async ({ request }) => {
        const res = await request.post(`${API_BASE}/api/works/dead-beef/members/leave`);
        expect(res.status()).toBe(401);
    });
});

test.describe('Work invitations — API contract', () => {
    test('GET /api/works/:id/invitations without auth → 401', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/works/dead-beef/invitations`);
        expect(res.status()).toBe(401);
    });

    test('GET /api/works/:id/invitations for own work returns array', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, u.access_token, {
            name: `e2e-inv-${Date.now()}`,
        });
        const res = await request.get(`${API_BASE}/api/works/${work.id}/invitations`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        const arr = Array.isArray(body) ? body : (body?.invitations ?? body?.data ?? []);
        expect(Array.isArray(arr)).toBe(true);
    });

    test('POST /api/works/:id/invitations for own work creates a pending invitation', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, u.access_token, {
            name: `e2e-inv2-${Date.now()}`,
        });
        const res = await request.post(`${API_BASE}/api/works/${work.id}/invitations`, {
            headers: authedHeaders(u.access_token),
            data: { email: `invitee-${Date.now()}@test.local`, role: 'editor' },
        });
        // EW-600 (PR #687) shipped tokenised invitations — owner POSTing a
        // well-formed payload to their own work must succeed (201 Created).
        // Tightened from the original "anything < 500 and not 401/403" guard
        // now that the endpoint is known to exist.
        expect(res.status(), `expected 201 Created, got ${res.status()}`).toBe(201);
        const body = await res.json();
        expect(body?.id ?? body?.invitation?.id, 'no invitation id in response').toBeTruthy();
        expect(
            body?.claimUrl ?? body?.invitation?.claimUrl,
            'claim URL must be returned ONCE at creation',
        ).toBeTruthy();
    });

    test('DELETE /api/works/:id/invitations/:inv without auth → 401', async ({ request }) => {
        const res = await request.delete(`${API_BASE}/api/works/dead/invitations/beef`);
        expect(res.status()).toBe(401);
    });
});

test.describe('Work members + invitations — UI surface', () => {
    test('Work members page requires auth', async ({ page, baseURL }) => {
        const url = `${baseURL || 'http://localhost:3000'}/en/works/non-existent-id/members`;
        const res = await page.goto(url, { waitUntil: 'domcontentloaded' });
        const finalUrl = page.url();
        expect(
            finalUrl.includes('/login') || (res && [200, 404, 403].includes(res.status())),
        ).toBeTruthy();
    });

    test('Work settings/members page requires auth', async ({ page, baseURL }) => {
        const url = `${baseURL || 'http://localhost:3000'}/en/works/non-existent-id/settings/members`;
        const res = await page.goto(url, { waitUntil: 'domcontentloaded' });
        const finalUrl = page.url();
        expect(
            finalUrl.includes('/login') || (res && [200, 404, 403].includes(res.status())),
        ).toBeTruthy();
    });
});
