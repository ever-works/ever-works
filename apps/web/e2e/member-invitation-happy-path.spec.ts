import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * Member invitation — full happy path (EW-632 close-out coverage).
 *
 * Closes the coverage gap implicitly asked for by EW-632 ("E2E coverage
 * for the full invite → accept → role-change → remove flow"). Other specs
 * in this dir pin the API contract piecewise; this one drives the entire
 * collaboration lifecycle end-to-end against the real endpoints:
 *
 *   1. Owner POSTs /api/works/:id/invitations           → tokenised invite created
 *   2. Invitee GETs  /api/claim/preview?token=...       → public, idempotent
 *   3. Invitee POSTs /api/claim/accept (with token)     → consumes token, creates WorkMember
 *   4. Owner GETs    /api/works/:id/members             → invitee present with role=editor
 *   5. Owner PUTs    /api/works/:id/members/:memberId   → editor → viewer demotion
 *   6. Owner DELETEs /api/works/:id/members/:memberId   → member removed
 *   7. Demoted invitee GETs work → 403 (no membership anymore)
 *
 * Real endpoints all shipped via PR #687 (EW-600). Roles are
 * owner > manager > editor > viewer (see WorkMemberRole enum).
 */

test.describe('Member invitation — full lifecycle', () => {
    test('invite → claim → list → role-change → remove', async ({ request }) => {
        const owner = await registerUserViaAPI(request);
        const invitee = await registerUserViaAPI(request);
        const tag = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const w = await createWorkViaAPI(request, owner.access_token, {
            name: `mem-lifecycle-${tag}`,
            slug: `mem-lifecycle-${tag}`,
        });

        // 1. Owner issues the invitation. Returns the raw token ONCE
        //    via the `claimUrl` field.
        const create = await request.post(`${API_BASE}/api/works/${w.id}/invitations`, {
            headers: authedHeaders(owner.access_token),
            data: { email: invitee.email, role: 'editor' },
        });
        expect(create.status(), `invitation create failed: ${create.status()}`).toBe(201);
        const createBody = await create.json();
        const claimUrl = createBody?.claimUrl ?? createBody?.invitation?.claimUrl;
        expect(claimUrl, 'claimUrl must be returned at creation').toBeTruthy();
        const tokenMatch = String(claimUrl).match(/\/claim\/([^/?#]+)/);
        const token = tokenMatch?.[1];
        expect(token, 'no token in claim URL').toBeTruthy();

        // 2. Invitee previews the invitation (PUBLIC; no auth required;
        //    does NOT consume the token). Verifies role + work name.
        const preview = await request.get(
            `${API_BASE}/api/claim/preview?token=${encodeURIComponent(token!)}`,
        );
        expect(preview.status(), `preview failed: ${preview.status()}`).toBe(200);
        const previewBody = await preview.json();
        // Role string casing is not pinned by the spec; normalize for
        // comparison so both lowercase enum strings ('editor') and
        // uppercase enum names ('EDITOR') match. Greptile P1.
        expect(String(previewBody.role).toLowerCase()).toBe('editor');
        expect(previewBody.workName).toContain('mem-lifecycle');

        // 3. Invitee accepts. Token is consumed; a WorkMember row is
        //    created with role=editor.
        const accept = await request.post(`${API_BASE}/api/claim/accept`, {
            headers: authedHeaders(invitee.access_token),
            data: { token },
        });
        expect(accept.status(), `accept failed: ${accept.status()}`).toBeGreaterThanOrEqual(200);
        expect(accept.status()).toBeLessThan(300);
        const acceptBody = await accept.json();
        expect(acceptBody.workId).toBe(w.id);
        expect(String(acceptBody.role).toLowerCase()).toBe('editor');

        // 4. Owner lists members; invitee must now appear with role=editor.
        const list = await request.get(`${API_BASE}/api/works/${w.id}/members`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(list.status()).toBe(200);
        const listBody = await list.json();
        // Defensive unwrap — matches the idiom used by the peer specs in
        // this directory so a future API shape change (plain array vs
        // `{ members: [] }`) doesn't silently surface as "invitee not in
        // members list". Greptile P2.
        const members = Array.isArray(listBody)
            ? listBody
            : (listBody?.members ?? listBody?.data ?? []);
        const inviteeMember = members.find(
            (m: { userId?: string; user?: { id?: string } }) =>
                m?.userId === invitee.user.id || m?.user?.id === invitee.user.id,
        );
        expect(inviteeMember, `invitee ${invitee.email} not in members list`).toBeTruthy();
        expect(String(inviteeMember.role).toLowerCase()).toBe('editor');

        // 5. Owner demotes editor → viewer. Members controller uses PUT
        //    (not PATCH — slight delta from the original EW-632 wording).
        const memberId = inviteeMember.id ?? inviteeMember.userId ?? invitee.user.id;
        const demote = await request.put(`${API_BASE}/api/works/${w.id}/members/${memberId}`, {
            headers: authedHeaders(owner.access_token),
            data: { role: 'viewer' },
        });
        expect(demote.status(), `role update failed: ${demote.status()}`).toBeGreaterThanOrEqual(
            200,
        );
        expect(demote.status()).toBeLessThan(300);

        // Verify the demotion by re-reading the list.
        const list2 = await request.get(`${API_BASE}/api/works/${w.id}/members`, {
            headers: authedHeaders(owner.access_token),
        });
        const list2Body = await list2.json();
        const members2 = Array.isArray(list2Body)
            ? list2Body
            : (list2Body?.members ?? list2Body?.data ?? []);
        const inviteeAfter = members2.find(
            (m: { userId?: string; user?: { id?: string } }) =>
                m?.userId === invitee.user.id || m?.user?.id === invitee.user.id,
        );
        expect(inviteeAfter, 'invitee disappeared after role change').toBeTruthy();
        expect(String(inviteeAfter.role).toLowerCase()).toBe('viewer');

        // 6. Owner removes the member.
        const remove = await request.delete(`${API_BASE}/api/works/${w.id}/members/${memberId}`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(remove.status(), `member removal failed: ${remove.status()}`).toBeGreaterThanOrEqual(
            200,
        );
        expect(remove.status()).toBeLessThan(300);

        // 7. The (now ex-)invitee can no longer read the work's members.
        const accessAfterRemoval = await request.get(`${API_BASE}/api/works/${w.id}/members`, {
            headers: authedHeaders(invitee.access_token),
        });
        expect(
            [401, 403, 404],
            `ex-member must be denied access, got ${accessAfterRemoval.status()}`,
        ).toContain(accessAfterRemoval.status());
    });
});
