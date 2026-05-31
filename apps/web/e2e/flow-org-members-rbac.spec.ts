import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';

/**
 * Work members + RBAC — cross-feature integration flows.
 *
 * Where the existing member specs in this directory (member-invitation-happy-path,
 * invitation-token-single-use, multi-user-invitation, work-members) pin the
 * /members and /invitations controllers piecewise, THIS suite drives the access
 * model end-to-end against the WORK RESOURCE ITSELF — `GET /api/works/:id`, which
 * routes through `WorkOwnershipService.ensureAccess` and is the real gate every
 * collaborator hits. Each flow asserts the observable RBAC outcome at every step:
 * who can read the work, what role the work payload reports, and who is locked out.
 *
 * Contract verified against the live stack (sqlite in-memory — the CI driver)
 * before these assertions were written:
 *
 *   POST /api/works/:id/invitations  (owner/manager) → 201 InvitationResponseDto
 *        { id, workId, role, email, status:'pending', tokenExpiresAt, createdAt,
 *          invitedById, metadata, claimUrl }  — raw token embedded in claimUrl ONCE.
 *   GET  /api/claim/preview?token=…   (PUBLIC, throttled, read-only) → 200
 *        { workName, role, expiresAt, expectedProviderUsername, sourceUrl }.
 *   POST /api/claim/accept            (authed, single-use) → 200
 *        { invitationId, workId, role, transferStatus:'not_required' }.
 *   GET  /api/works/:id               (authed) →
 *        200 { status:'success', work:{ …, userRole } } for creator OR any member,
 *        403 'You do not have permission to access this work' for a non-member,
 *        404 for an unknown (valid-UUID) work.
 *   GET  /api/works/:id/members       (manager+) → 200
 *        { status:'success', members:[{ id, userId, username, email, role, … }], owner }.
 *   DELETE /api/works/:id/members/:memberId → 200 { status:'success', message }.
 *
 * Single-use & error shapes (verified live):
 *   - 2nd accept of a consumed token → 400 'invitation_already_accepted'.
 *   - preview of a consumed token    → 400 'invitation_already_accepted'.
 *   - accepted invitation drops out of listPending (count returns to 0).
 *   - unknown token                  → 404 'invitation_not_found' (preview & accept).
 *   - double-remove of a member id   → 404 'Member not found'.
 *
 * Roles: owner > manager > editor > viewer (WorkMemberRole). Role casing is lower
 * in the JSON ('editor'); we normalise defensively anyway.
 *
 * Isolation: every flow runs on FRESH registerUserViaAPI() users + a fresh work,
 * never the shared seeded user, so the in-memory DB stays clean for sibling specs.
 * The one UI assertion (flow 1) uses the seeded storageState only to read.
 */

const ACCESS_DENIED = [401, 403, 404];

/** Pull the single-use claim token out of an invitation create response. */
function tokenFromInvitation(body: unknown): string {
    const claimUrl =
        (body as { claimUrl?: string })?.claimUrl ??
        (body as { invitation?: { claimUrl?: string } })?.invitation?.claimUrl ??
        '';
    const match = String(claimUrl).match(/\/claim\/([^/?#]+)/);
    return match?.[1] ?? '';
}

/** Defensive unwrap of the members-list response (matches sibling-spec idiom). */
function membersOf(body: unknown): Array<Record<string, unknown>> {
    if (Array.isArray(body)) return body as Array<Record<string, unknown>>;
    const b = body as { members?: unknown[]; data?: unknown[] };
    return (b?.members ?? b?.data ?? []) as Array<Record<string, unknown>>;
}

/** Owner issues a member-role invitation and returns the single-use token. */
async function issueInvitation(
    request: APIRequestContext,
    ownerToken: string,
    workId: string,
    email: string,
    role: 'manager' | 'editor' | 'viewer' = 'editor',
): Promise<string> {
    const res = await request.post(`${API_BASE}/api/works/${workId}/invitations`, {
        headers: authedHeaders(ownerToken),
        data: { email, role },
    });
    expect(res.status(), `invitation create failed: ${res.status()} ${await res.text()}`).toBe(201);
    const token = tokenFromInvitation(await res.json());
    expect(token, 'no token embedded in claimUrl').toBeTruthy();
    expect(token.length, 'claim token suspiciously short').toBeGreaterThanOrEqual(32);
    return token;
}

/** GET /api/works/:id as a given user; returns { status, body }. */
async function getWorkAs(request: APIRequestContext, token: string, workId: string) {
    const res = await request.get(`${API_BASE}/api/works/${workId}`, {
        headers: authedHeaders(token),
    });
    return { status: res.status(), body: await res.json().catch(() => null) };
}

test.describe('Work members + RBAC — resource access end-to-end', () => {
    test('invite → accept grants work-resource read with role; non-member is locked out', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const invitee = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const tag = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const work = await createWorkViaAPI(request, owner.access_token, {
            name: `rbac-access-${tag}`,
            slug: `rbac-access-${tag}`,
        });

        // STEP 1 — before any invitation, the invitee is a non-member: reading
        // the work resource itself is forbidden with the exact ownership message.
        const before = await getWorkAs(request, invitee.access_token, work.id);
        expect(before.status, 'pre-invite invitee must be denied the work').toBe(403);
        expect(String(before.body?.message)).toContain('do not have permission');

        // STEP 2 — owner issues a tokenised editor invitation.
        const token = await issueInvitation(
            request,
            owner.access_token,
            work.id,
            invitee.email,
            'editor',
        );

        // STEP 3 — the public claim preview describes the invitation without
        // consuming it (this is what the claim landing page renders).
        const preview = await request.get(
            `${API_BASE}/api/claim/preview?token=${encodeURIComponent(token)}`,
        );
        expect(preview.status(), 'claim preview must be public + readable').toBe(200);
        const previewBody = await preview.json();
        expect(String(previewBody.role).toLowerCase()).toBe('editor');
        expect(previewBody.workName).toContain('rbac-access');

        // STEP 4 — the invitee accepts; the token is consumed and a WorkMember
        // row is created. transferStatus is 'not_required' for member roles.
        const accept = await request.post(`${API_BASE}/api/claim/accept`, {
            headers: authedHeaders(invitee.access_token),
            data: { token },
        });
        expect(accept.status(), `accept failed: ${accept.status()} ${await accept.text()}`).toBe(
            200,
        );
        const acceptBody = await accept.json();
        expect(acceptBody.workId).toBe(work.id);
        expect(String(acceptBody.role).toLowerCase()).toBe('editor');
        expect(String(acceptBody.transferStatus)).toBe('not_required');

        // STEP 5 — the invitee can now read the WORK RESOURCE itself, and the
        // payload reports their effective role. This is the real RBAC payoff
        // the sibling specs (which only check /members) don't exercise.
        const afterAccept = await getWorkAs(request, invitee.access_token, work.id);
        expect(afterAccept.status, 'new member must be able to read the work').toBe(200);
        expect(afterAccept.body?.status).toBe('success');
        expect(afterAccept.body?.work?.id).toBe(work.id);
        expect(String(afterAccept.body?.work?.userRole).toLowerCase()).toBe('editor');

        // STEP 6 — the owner sees themselves as OWNER on the same resource
        // (creator is implicitly owner, no member row required).
        const ownerView = await getWorkAs(request, owner.access_token, work.id);
        expect(ownerView.status).toBe(200);
        expect(String(ownerView.body?.work?.userRole).toLowerCase()).toBe('owner');

        // STEP 7 — a completely uninvolved fresh user is still locked out: no
        // invitation, no membership ⇒ 403 on the work resource AND 403/404 on
        // the members list (managers+ only).
        const strangerWork = await getWorkAs(request, stranger.access_token, work.id);
        expect(strangerWork.status, 'stranger must not read the work').toBe(403);
        const strangerMembers = await request.get(`${API_BASE}/api/works/${work.id}/members`, {
            headers: authedHeaders(stranger.access_token),
        });
        expect(ACCESS_DENIED).toContain(strangerMembers.status());

        // STEP 8 — the owner's members list now contains the invitee with the
        // accepted role; the owner appears in the separate `owner` field, never
        // folded into members[].
        const list = await request.get(`${API_BASE}/api/works/${work.id}/members`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(list.status()).toBe(200);
        const listBody = await list.json();
        const members = membersOf(listBody);
        const inviteeRow = members.find(
            (m) =>
                m.userId === invitee.user.id || (m.user as { id?: string })?.id === invitee.user.id,
        );
        expect(inviteeRow, `invitee ${invitee.email} missing from members[]`).toBeTruthy();
        expect(String(inviteeRow!.role).toLowerCase()).toBe('editor');
        const ownerId = (listBody?.owner?.userId ?? listBody?.owner?.id) as string | undefined;
        expect(ownerId, 'owner must be in the separate owner field').toBe(owner.user.id);
        const ownerInMembers = members.find(
            (m) => m.userId === owner.user.id || (m.user as { id?: string })?.id === owner.user.id,
        );
        expect(ownerInMembers, 'owner must NOT appear inside members[]').toBeFalsy();
    });

    test('the seeded UI user can read works they own but is 403 on a stranger work', async ({
        page,
        request,
        baseURL,
    }) => {
        // Cross-feature check using the authenticated UI session (storageState).
        // The seeded user logs in via API for a bearer token (login DTO is
        // whitelisted to {email,password} — passing `name` would 400), creates a
        // work, and confirms the SAME token that drives the UI can read it. A
        // separate fresh user's work must stay 403 for the seeded user.
        const seeded = loadSeededTestUser();
        const login = await request.post(`${API_BASE}/api/auth/login`, {
            data: { email: seeded.email, password: seeded.password },
        });
        expect(login.status(), `seeded login failed: ${await login.text()}`).toBe(200);
        const { access_token: seededToken } = await login.json();
        expect(seededToken, 'no token for seeded user').toBeTruthy();

        const tag = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const ownWork = await createWorkViaAPI(request, seededToken, {
            name: `rbac-seeded-${tag}`,
            slug: `rbac-seeded-${tag}`,
        });
        const own = await getWorkAs(request, seededToken, ownWork.id);
        expect(own.status, 'seeded user must read their own work').toBe(200);
        expect(String(own.body?.work?.userRole).toLowerCase()).toBe('owner');

        // A fresh stranger's work is invisible to the seeded user.
        const other = await registerUserViaAPI(request);
        const otherWork = await createWorkViaAPI(request, other.access_token, {
            name: `rbac-other-${tag}`,
            slug: `rbac-other-${tag}`,
        });
        const denied = await getWorkAs(request, seededToken, otherWork.id);
        expect(denied.status, 'seeded user must not read a stranger work').toBe(403);

        // Targeted UI touch-point: the authenticated dashboard renders for the
        // seeded session (the storageState cookie is honoured server-side). We
        // assert we are NOT bounced to /login — proving the RBAC session that
        // the API token mirrors is live in the browser too. The slug-scoped
        // work page is Phase-7-pending, so we anchor on the stable /works route.
        await page.context().addCookies([
            {
                name: 'sidebar-collapsed',
                value: '0',
                url: new URL(baseURL || 'http://localhost:3000').origin,
            },
            {
                name: 'chat-panel-open',
                value: '0',
                url: new URL(baseURL || 'http://localhost:3000').origin,
            },
        ]);
        await page.goto('/works', { waitUntil: 'domcontentloaded' });
        await expect.poll(() => page.url(), { timeout: 30_000 }).not.toContain('/login');
    });
});

test.describe('Work members + RBAC — invitation tokens are single-use', () => {
    test('a token redeems exactly once; replay + post-consume preview are rejected', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const invitee = await registerUserViaAPI(request);
        const tag = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const work = await createWorkViaAPI(request, owner.access_token, {
            name: `rbac-single-${tag}`,
            slug: `rbac-single-${tag}`,
        });

        const token = await issueInvitation(
            request,
            owner.access_token,
            work.id,
            invitee.email,
            'editor',
        );

        // The invitation is listed as pending exactly once before consumption.
        const pendingBefore = await request.get(`${API_BASE}/api/works/${work.id}/invitations`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(pendingBefore.status()).toBe(200);
        const pendingBeforeBody = await pendingBefore.json();
        const pendingEmails = (pendingBeforeBody.invitations ?? pendingBeforeBody.data ?? []).map(
            (i: { email?: string }) => i.email,
        );
        expect(pendingEmails).toContain(invitee.email);

        // First redeem: succeeds and grants the work.
        const first = await request.post(`${API_BASE}/api/claim/accept`, {
            headers: authedHeaders(invitee.access_token),
            data: { token },
        });
        expect(first.status(), `first accept must succeed: ${await first.text()}`).toBe(200);
        const granted = await getWorkAs(request, invitee.access_token, work.id);
        expect(granted.status, 'member must read the work after first accept').toBe(200);

        // Second redeem of the SAME token: rejected with the used/expired
        // contract (400 'invitation_already_accepted') — never a silent dup
        // member, never a 5xx.
        const second = await request.post(`${API_BASE}/api/claim/accept`, {
            headers: authedHeaders(invitee.access_token),
            data: { token },
        });
        expect(
            second.status(),
            `replayed token returned ${second.status()} — token is not single-use`,
        ).toBe(400);
        const secondBody = await second.json();
        expect(String(secondBody.message)).toContain('already_accepted');

        // Even the public, read-only preview rejects a consumed token (the
        // claim landing page would show "already accepted", not the details).
        const previewAfter = await request.get(
            `${API_BASE}/api/claim/preview?token=${encodeURIComponent(token)}`,
        );
        expect(previewAfter.status(), 'consumed token must not preview').toBe(400);
        expect(String((await previewAfter.json()).message)).toContain('already_accepted');

        // The consumed invitation has dropped out of the pending list.
        const pendingAfter = await request.get(`${API_BASE}/api/works/${work.id}/invitations`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(pendingAfter.status()).toBe(200);
        const pendingAfterEmails = ((await pendingAfter.json()).invitations ?? []).map(
            (i: { email?: string }) => i.email,
        );
        expect(pendingAfterEmails, 'accepted invite must leave the pending list').not.toContain(
            invitee.email,
        );

        // A token that was NEVER issued is unknown to both endpoints (404),
        // distinct from the "consumed" 400 above — proves the single-use state
        // is real, not just a blanket reject.
        const bogus = 'f'.repeat(64);
        const unknownPreview = await request.get(`${API_BASE}/api/claim/preview?token=${bogus}`);
        expect(unknownPreview.status()).toBe(404);
        const unknownAccept = await request.post(`${API_BASE}/api/claim/accept`, {
            headers: authedHeaders(invitee.access_token),
            data: { token: bogus },
        });
        expect(unknownAccept.status()).toBe(404);
        expect(String((await unknownAccept.json()).message)).toContain('not_found');
    });
});

test.describe('Work members + RBAC — removal revokes access', () => {
    test('removing a member revokes the work + members list and is idempotent-safe', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const member = await registerUserViaAPI(request);
        const tag = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const work = await createWorkViaAPI(request, owner.access_token, {
            name: `rbac-remove-${tag}`,
            slug: `rbac-remove-${tag}`,
        });

        // Add the member end-to-end (invite → accept) so we exercise the real
        // path, then confirm they have access to the work resource.
        const token = await issueInvitation(
            request,
            owner.access_token,
            work.id,
            member.email,
            'editor',
        );
        const accept = await request.post(`${API_BASE}/api/claim/accept`, {
            headers: authedHeaders(member.access_token),
            data: { token },
        });
        expect(accept.status(), `accept failed: ${await accept.text()}`).toBe(200);

        const accessBefore = await getWorkAs(request, member.access_token, work.id);
        expect(accessBefore.status, 'member should read the work pre-removal').toBe(200);
        expect(String(accessBefore.body?.work?.userRole).toLowerCase()).toBe('editor');

        // Resolve the member-row id from the owner's members list.
        const listBefore = await request.get(`${API_BASE}/api/works/${work.id}/members`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(listBefore.status()).toBe(200);
        const membersBefore = membersOf(await listBefore.json());
        const memberRow = membersBefore.find(
            (m) =>
                m.userId === member.user.id || (m.user as { id?: string })?.id === member.user.id,
        );
        expect(memberRow, 'member not present before removal').toBeTruthy();
        const memberId = (memberRow!.id ?? memberRow!.userId) as string;

        // Owner removes the member → 200 with the success envelope.
        const remove = await request.delete(
            `${API_BASE}/api/works/${work.id}/members/${memberId}`,
            {
                headers: authedHeaders(owner.access_token),
            },
        );
        expect(remove.status(), `member removal failed: ${await remove.text()}`).toBe(200);
        const removeBody = await remove.json();
        expect(removeBody.status).toBe('success');

        // The removed user has lost access to the work RESOURCE itself (403),
        // settling async — poll to ride out any read-replica/cache lag.
        await expect
            .poll(async () => (await getWorkAs(request, member.access_token, work.id)).status, {
                timeout: 15_000,
                message: 'removed member must lose work access',
            })
            .toBe(403);

        // …and they are gone from the owner's members list.
        const listAfter = await request.get(`${API_BASE}/api/works/${work.id}/members`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(listAfter.status()).toBe(200);
        const membersAfter = membersOf(await listAfter.json());
        const stillThere = membersAfter.find(
            (m) =>
                m.userId === member.user.id || (m.user as { id?: string })?.id === member.user.id,
        );
        expect(stillThere, 'removed user must not appear in members[]').toBeFalsy();

        // The members controller is also locked to the ex-member now (only
        // managers+ may list), and removing the same member id again is a clean
        // 404 'Member not found' — no double-delete crash, no 5xx.
        const exMemberList = await request.get(`${API_BASE}/api/works/${work.id}/members`, {
            headers: authedHeaders(member.access_token),
        });
        expect(ACCESS_DENIED).toContain(exMemberList.status());

        const removeAgain = await request.delete(
            `${API_BASE}/api/works/${work.id}/members/${memberId}`,
            { headers: authedHeaders(owner.access_token) },
        );
        expect(removeAgain.status(), 'double-remove must be a clean 404').toBe(404);
        expect(String((await removeAgain.json()).message)).toContain('not found');
    });
});
