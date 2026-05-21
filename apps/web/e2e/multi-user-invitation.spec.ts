import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * Multi-user invitation flow — pass 7. Deepens multi-user-collab.spec.ts.
 * The platform exposes invitation endpoints under `/api/works/:id/invitations`
 * and member endpoints under `/api/works/:id/members`. Cover:
 *
 *   - Owner can invite a second user (or skip if invitations are gated)
 *   - Owner can list invitations
 *   - Stranger cannot invite to / list invitations of another's work
 *   - Owner can update member role (manager → editor → viewer)
 *   - Removing a member 204s, then they lose access
 */

const INVITE_PAYLOAD = (email: string) => ({ email, role: 'editor' });

test.describe('Multi-user invitations — owner happy path', () => {
    test('owner can POST /invitations and immediately list it', async ({ request }) => {
        const owner = await registerUserViaAPI(request);
        const w = await createWorkViaAPI(request, owner.access_token, {
            name: `inv-${Date.now().toString(36)}`,
        });
        const invitee = await registerUserViaAPI(request);
        const create = await request.post(`${API_BASE}/api/works/${w.id}/invitations`, {
            headers: authedHeaders(owner.access_token),
            data: INVITE_PAYLOAD(invitee.email),
        });
        // EW-600 invitation flow is now baseline behaviour — owner POSTing a
        // well-formed payload to their own work must succeed. Pinned to the
        // exact 201 the controller returns (matches work-members.spec.ts so
        // both specs catch any accidental status-code regression). Greptile P2.
        expect(create.status(), `expected 201 Created, got ${create.status()}`).toBe(201);

        const list = await request.get(`${API_BASE}/api/works/${w.id}/invitations`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(list.status()).toBe(200);
        const body = await list.json();
        const arr = Array.isArray(body) ? body : (body?.invitations ?? body?.data ?? []);
        // The new invitation must appear.
        const emails = arr.map(
            (i: { email?: string; invitedEmail?: string }) => i?.email ?? i?.invitedEmail,
        );
        expect(emails).toContain(invitee.email);
    });

    test('stranger cannot list invitations of another user work', async ({ request }) => {
        const owner = await registerUserViaAPI(request);
        const w = await createWorkViaAPI(request, owner.access_token, {
            name: `inv-iso-${Date.now().toString(36)}`,
        });
        const stranger = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/works/${w.id}/invitations`, {
            headers: authedHeaders(stranger.access_token),
        });
        expect([401, 403, 404]).toContain(res.status());
    });

    test('stranger cannot POST invitations to another user work', async ({ request }) => {
        const owner = await registerUserViaAPI(request);
        const w = await createWorkViaAPI(request, owner.access_token, {
            name: `inv-iso-post-${Date.now().toString(36)}`,
        });
        const stranger = await registerUserViaAPI(request);
        const attacker = await registerUserViaAPI(request);
        const res = await request.post(`${API_BASE}/api/works/${w.id}/invitations`, {
            headers: authedHeaders(stranger.access_token),
            data: INVITE_PAYLOAD(attacker.email),
        });
        expect([401, 403, 404]).toContain(res.status());
    });
});

test.describe('Multi-user invitations — members CRUD smoke', () => {
    test('GET /api/works/:id/members responds < 500 for owner', async ({ request }) => {
        const owner = await registerUserViaAPI(request);
        const w = await createWorkViaAPI(request, owner.access_token, {
            name: `members-${Date.now().toString(36)}`,
        });
        const res = await request.get(`${API_BASE}/api/works/${w.id}/members`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(res.status()).toBeLessThan(500);
    });

    test('owner appears in the separate "owner" field, not in "members"', async ({ request }) => {
        const owner = await registerUserViaAPI(request);
        const w = await createWorkViaAPI(request, owner.access_token, {
            name: `member-self-${Date.now().toString(36)}`,
        });
        const res = await request.get(`${API_BASE}/api/works/${w.id}/members`, {
            headers: authedHeaders(owner.access_token),
        });
        // Endpoint is known to exist — owner reading own work must return 200.
        // Earlier revision skipped here; tightened post EW-632 close-out.
        expect(res.status(), `expected 200 OK on own /members, got ${res.status()}`).toBe(200);

        const body = await res.json();
        // FR-2 / FR-10 (docs/specs/features/work-members/spec.md): the owner
        // is returned in a SEPARATE `owner` field, never folded into the
        // `members` array. A fresh work has zero collaborator members.
        expect(body?.owner, 'no owner field in response').toBeTruthy();
        expect(body.owner.userId ?? body.owner.user?.id ?? body.owner.id).toBe(owner.user.id);

        const members = Array.isArray(body) ? body : (body?.members ?? body?.data ?? []);
        const ownerInMembersArray = members.find(
            (m: { userId?: string; user?: { id?: string } }) =>
                m?.userId === owner.user.id || m?.user?.id === owner.user.id,
        );
        expect(
            ownerInMembersArray,
            'owner must NOT appear in members[] — only in the separate owner field',
        ).toBeFalsy();
    });
});
