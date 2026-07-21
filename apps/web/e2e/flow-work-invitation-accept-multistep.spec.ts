import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * flow-work-invitation-accept-multistep.spec.ts
 *
 * The Work invitation → accept → member lifecycle driven as MULTI-STEP,
 * multi-actor journeys, focused squarely on the state TRANSITIONS that the
 * existing invitation/member specs do NOT own:
 *
 *   1. POST-ACCEPT role MUTATION ladders — a claimed member is promoted
 *      (viewer→editor→manager) and demoted (manager→editor→viewer) by the
 *      owner, and its live capability + `work.userRole` are re-checked at
 *      EVERY rung against the real write/manage endpoints.
 *   2. RE-GRANT cycles — a member is removed / self-leaves, is fully locked
 *      out, then is re-invited and REJOINS with a brand-new member row; a
 *      still-pending SECOND token re-adds a removed member (with its baked
 *      role), while a CONSUMED token stays consumed forever (even after the
 *      grant it created was revoked).
 *   3. CONCURRENCY — two users race the SAME token, and one user races TWO
 *      tokens; exactly one membership results either way (tryAccept is
 *      atomic PENDING→ACCEPTED).
 *   4. TOKEN-BEARER semantics + inviter-independence — the claim token is a
 *      BEARER credential, not email-bound (a different registered user than
 *      the invited email may claim it), and an invitation OUTLIVES the
 *      removal of the manager who issued it (invitedBy still points at the
 *      now-removed inviter).
 *   5. COEXISTENCE — the tokenised-claim path and the synchronous
 *      POST /members direct-add path produce equivalent, independently
 *      role-gated member rows on one work; removing one never disturbs the
 *      others.
 *
 * ── WHY THIS IS ADDITIVE (not a duplicate) ──────────────────────────────────
 *   flow-work-invite-accept-rbac.spec.ts pins the per-role CAPABILITY MATRIX
 *   at a FIXED role. flow-work-invitations-deep / flow-work-invitation-tokens
 *   pin the invitation CRUD + token replay/preview contract. flow-work-
 *   member-removal pins removal authz + idempotency. flow-work-members-rbac-deep
 *   pins PUT/GET-one/invite-error/IDOR. flow-work-collab-concurrent-edit pins
 *   ONE downgrade direction through the ACTIVITY FEED. NONE of them walks a
 *   role UP-and-DOWN ladder re-checking capability at each rung, exercises
 *   the removal→re-invite→REJOIN cycle, races the accept endpoint, asserts
 *   the token is bearer-not-email-bound, or asserts an invitation survives its
 *   inviter's removal. That transition-centric ground is what this file owns.
 *
 * ── PROBED CONTRACT (live @ 127.0.0.1:3100, controllers/services, 2026-07-21) ─
 *   ISSUE   POST /api/works/:workId/invitations  (>= MANAGER; owner-claim = OWNER)
 *     201 → { id, workId, role, email|null, status:"pending", tokenExpiresAt,
 *             createdAt, invitedById, metadata, claimUrl }. claimUrl embeds the
 *             raw 64-hex-char token ONCE; subsequent reads never re-expose it.
 *   ACCEPT  POST /api/claim/accept  (AUTH; @Throttle 10/60s/IP)
 *     Body { token } (MinLength 32 → shorter is a 400 DTO error, not 404).
 *     Member role → 200 { invitationId, workId, role, transferStatus:"not_required" }
 *       and atomically flips PENDING→ACCEPTED + inserts a WorkMember row.
 *     Re-accept of a CONSUMED token → 400 invitation_already_accepted (even after
 *       the resulting membership was removed). Already-a-member + a DIFFERENT
 *       pending token → 400 already_a_member. Owner self-claim → 400
 *       claimant_is_already_owner. Race: exactly one 200; loser 400
 *       (invitation_already_accepted | invitation_state_changed).
 *     The token is a BEARER credential: the invitation's `email` is advisory —
 *       any authenticated user holding the token becomes the member.
 *   MEMBERS
 *     GET  /api/works/:id/members            → { status, members[], owner } (owner is
 *                                               a SIBLING field, never inside members[]).
 *     POST /api/works/:id/members            → direct-add an EXISTING user: 201
 *                                               { status:"success", member } (invitedBy =
 *                                               caller). Unregistered email → 404
 *                                               { status:"error", message:"User not found" }.
 *     GET  /api/works/:id/members/:memberId  → member DTO; unknown / non-uuid id → 404
 *                                               "Member not found".
 *     PUT  /api/works/:id/members/:memberId  → change role (>= MANAGER). Same role is an
 *                                               idempotent 200. role∈{viewer,editor,manager}
 *                                               else 400 ["Role must be one of: ..."].
 *                                               Missing role → 400. Unknown member → 404.
 *     DELETE /api/works/:id/members/:memberId → 200 { status, message }. Unknown → 404.
 *     POST /api/works/:id/members/leave      → self-departure 200; CREATOR → 400
 *                                               "Work creator cannot leave the work";
 *                                               NON-member → 403.
 *   CAPABILITY GATES (WorkOwnershipService, owner=4>manager=3>editor=2>viewer=1):
 *     GET /works/:id (any member) 200 + work.userRole = caller role; PATCH /works/:id
 *     (>= editor); GET+POST /invitations (>= manager). Non-member → 403. No auth → 401.
 *
 * ── GOTCHAS RESPECTED ───────────────────────────────────────────────────────
 *   - Every actor is a FRESH registerUserViaAPI() (Date.now-unique) on the shared
 *     in-memory DB; ids asserted via toContain / not.toContain, never global counts,
 *     except within a freshly-created work whose member set starts empty (safe).
 *   - createWorkViaAPI always sends a non-empty `description` (the create DTO requires it).
 *   - Race outcomes tolerate either winner; the loser message is one of a small set.
 *   - No mail is required: issuance emits an event but e2e SMTP fails — we assert the
 *     API contract (claimUrl returned), never a delivered message.
 */

interface InvitationResponse {
    id: string;
    workId: string;
    role: string;
    email: string | null;
    status: string;
    tokenExpiresAt: string;
    createdAt: string;
    invitedById: string;
    metadata: Record<string, unknown> | null;
    claimUrl?: string;
}

interface MemberDto {
    id: string;
    userId: string;
    username: string;
    email: string;
    avatar?: string | null;
    role: string;
    invitedBy?: { id: string; username: string };
    createdAt: string;
}

interface MembersResponse {
    status: string;
    members: MemberDto[];
    owner: { id: string; username: string; email: string; avatar?: string };
}

const PERM_DENIED = 'You do not have the required permission level for this action';
const NOT_A_MEMBER = 'You do not have permission to access this work';

function uniqueSuffix(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Issue a tokenised member-role invitation; returns the DTO + the raw claim token. */
async function issueInvitation(
    request: APIRequestContext,
    token: string,
    workId: string,
    body: { email: string; role: 'viewer' | 'editor' | 'manager'; expiresInDays?: number },
): Promise<{ dto: InvitationResponse; claimToken: string }> {
    const res = await request.post(`${API_BASE}/api/works/${workId}/invitations`, {
        headers: authedHeaders(token),
        data: body,
    });
    expect(res.status(), `issue invite body=${await res.text().catch(() => '')}`).toBe(201);
    const dto = (await res.json()) as InvitationResponse;
    expect(dto.status, 'fresh invite is pending').toBe('pending');
    expect(dto.role, 'echoed role').toBe(body.role);
    expect(dto.claimUrl, 'claimUrl returned ONCE at creation').toBeTruthy();
    const claimToken = dto.claimUrl!.split('/').pop()!;
    expect(claimToken.length, 'raw token is 64 hex chars').toBe(64);
    return { dto, claimToken };
}

async function acceptClaim(
    request: APIRequestContext,
    token: string,
    claimToken: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await request.post(`${API_BASE}/api/claim/accept`, {
        headers: authedHeaders(token),
        data: { token: claimToken },
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status(), body };
}

/** Convenience: issue a member-role invite as `ownerToken` and immediately accept it as `claimant`. */
async function inviteAndAccept(
    request: APIRequestContext,
    ownerToken: string,
    workId: string,
    claimant: { email: string; token: string },
    role: 'viewer' | 'editor' | 'manager',
): Promise<void> {
    const { claimToken } = await issueInvitation(request, ownerToken, workId, {
        email: claimant.email,
        role,
    });
    const accepted = await acceptClaim(request, claimant.token, claimToken);
    expect(accepted.status, `accept ${role} body=${JSON.stringify(accepted.body)}`).toBe(200);
    expect(accepted.body.role, 'accept echoes baked role').toBe(role);
    expect(accepted.body.transferStatus, 'member accept is not a transfer').toBe('not_required');
}

async function listMembers(
    request: APIRequestContext,
    token: string,
    workId: string,
): Promise<MembersResponse> {
    const res = await request.get(`${API_BASE}/api/works/${workId}/members`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), 'list members').toBe(200);
    return (await res.json()) as MembersResponse;
}

async function memberRowFor(
    request: APIRequestContext,
    ownerToken: string,
    workId: string,
    userId: string,
): Promise<MemberDto | undefined> {
    const roster = await listMembers(request, ownerToken, workId);
    return roster.members.find((m) => m.userId === userId);
}

async function getWork(
    request: APIRequestContext,
    token: string,
    workId: string,
): Promise<{ status: number; userRole?: string; body: Record<string, unknown> }> {
    const res = await request.get(`${API_BASE}/api/works/${workId}`, {
        headers: authedHeaders(token),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const work = (body.work ?? body) as { userRole?: string };
    return { status: res.status(), userRole: work?.userRole, body };
}

async function patchWork(
    request: APIRequestContext,
    token: string,
    workId: string,
    data: Record<string, unknown>,
): Promise<number> {
    const res = await request.patch(`${API_BASE}/api/works/${workId}`, {
        headers: authedHeaders(token),
        data,
    });
    return res.status();
}

async function putRole(
    request: APIRequestContext,
    token: string,
    workId: string,
    memberId: string,
    role: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await request.put(`${API_BASE}/api/works/${workId}/members/${memberId}`, {
        headers: authedHeaders(token),
        data: { role },
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status(), body };
}

async function removeMember(
    request: APIRequestContext,
    token: string,
    workId: string,
    memberId: string,
): Promise<number> {
    const res = await request.delete(`${API_BASE}/api/works/${workId}/members/${memberId}`, {
        headers: authedHeaders(token),
    });
    return res.status();
}

async function listInvitationsStatus(
    request: APIRequestContext,
    token: string,
    workId: string,
): Promise<number> {
    const res = await request.get(`${API_BASE}/api/works/${workId}/invitations`, {
        headers: authedHeaders(token),
    });
    return res.status();
}

test.describe('Work invitation → accept → member lifecycle (multi-step transitions)', () => {
    // ─────────────────────────────────────────────────────────────────────────
    // GROUP 1 — POST-ACCEPT ROLE MUTATION LADDERS
    // ─────────────────────────────────────────────────────────────────────────

    test('1) escalation ladder: viewer→editor→manager re-grants capability + userRole at each rung', async ({
        request,
    }) => {
        const s = uniqueSuffix();
        const owner = await registerUserViaAPI(request);
        const member = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, { name: `esc ${s}` });

        // Enter as a VIEWER via the claim path.
        await inviteAndAccept(
            request,
            owner.access_token,
            work.id,
            { email: member.email, token: member.access_token },
            'viewer',
        );
        const row = await memberRowFor(request, owner.access_token, work.id, member.user.id);
        expect(row, 'viewer member row exists').toBeTruthy();

        // RUNG 0 — viewer: reads yes, PATCH no, manage-members no. userRole = viewer.
        const asViewer = await getWork(request, member.access_token, work.id);
        expect(asViewer.status).toBe(200);
        expect(asViewer.userRole, 'userRole reflects viewer').toBe('viewer');
        expect(
            await patchWork(request, member.access_token, work.id, { description: `v ${s}` }),
        ).toBe(403);
        expect(await listInvitationsStatus(request, member.access_token, work.id)).toBe(403);

        // RUNG 1 — owner promotes viewer→EDITOR: PATCH flips 403→200, manage still denied.
        const toEditor = await putRole(request, owner.access_token, work.id, row!.id, 'editor');
        expect(toEditor.status, 'promote to editor').toBe(200);
        expect((toEditor.body.member as MemberDto).role).toBe('editor');
        expect((await getWork(request, member.access_token, work.id)).userRole).toBe('editor');
        expect(
            await patchWork(request, member.access_token, work.id, { description: `e ${s}` }),
            'editor may now PATCH',
        ).toBe(200);
        expect(
            await listInvitationsStatus(request, member.access_token, work.id),
            'editor still cannot manage members',
        ).toBe(403);

        // RUNG 2 — owner promotes editor→MANAGER: manage-members flips 403→200 (can list + issue).
        const toManager = await putRole(request, owner.access_token, work.id, row!.id, 'manager');
        expect(toManager.status, 'promote to manager').toBe(200);
        expect((await getWork(request, member.access_token, work.id)).userRole).toBe('manager');
        expect(
            await listInvitationsStatus(request, member.access_token, work.id),
            'manager may now list invitations',
        ).toBe(200);
        // A manager can now issue an invitation of its own — full delegated authority.
        const delegated = await request.post(`${API_BASE}/api/works/${work.id}/invitations`, {
            headers: authedHeaders(member.access_token),
            data: { email: `delegate-${s}@test.local`, role: 'viewer' },
        });
        expect(delegated.status(), 'manager may now issue invitations').toBe(201);
    });

    test('2) de-escalation ladder: manager→editor→viewer strips capability at each rung, read retained', async ({
        request,
    }) => {
        const s = uniqueSuffix();
        const owner = await registerUserViaAPI(request);
        const member = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, { name: `deesc ${s}` });

        await inviteAndAccept(
            request,
            owner.access_token,
            work.id,
            { email: member.email, token: member.access_token },
            'manager',
        );
        const row = (await memberRowFor(request, owner.access_token, work.id, member.user.id))!;

        // RUNG 0 — manager: manage + edit both allowed.
        expect(await listInvitationsStatus(request, member.access_token, work.id)).toBe(200);
        expect(
            await patchWork(request, member.access_token, work.id, { description: `m ${s}` }),
        ).toBe(200);

        // RUNG 1 — demote manager→EDITOR: loses manage, keeps edit + read.
        expect((await putRole(request, owner.access_token, work.id, row.id, 'editor')).status).toBe(
            200,
        );
        expect((await getWork(request, member.access_token, work.id)).userRole).toBe('editor');
        expect(
            await listInvitationsStatus(request, member.access_token, work.id),
            'ex-manager loses manage-members',
        ).toBe(403);
        expect(
            await patchWork(request, member.access_token, work.id, { description: `e2 ${s}` }),
            'editor keeps edit',
        ).toBe(200);

        // RUNG 2 — demote editor→VIEWER: loses edit, still reads work + roster.
        expect((await putRole(request, owner.access_token, work.id, row.id, 'viewer')).status).toBe(
            200,
        );
        expect((await getWork(request, member.access_token, work.id)).userRole).toBe('viewer');
        expect(
            await patchWork(request, member.access_token, work.id, { description: `v2 ${s}` }),
            'demoted viewer cannot edit',
        ).toBe(403);
        const stillReads = await getWork(request, member.access_token, work.id);
        expect(stillReads.status, 'demoted viewer still reads the work').toBe(200);
        const roster = await listMembers(request, member.access_token, work.id);
        expect(
            roster.members.some((m) => m.userId === member.user.id && m.role === 'viewer'),
            'viewer sees itself in the roster at its current role',
        ).toBe(true);
    });

    test('3) same-role PUT is an idempotent no-op; a real change round-trips into the roster', async ({
        request,
    }) => {
        const s = uniqueSuffix();
        const owner = await registerUserViaAPI(request);
        const member = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, { name: `noop ${s}` });

        await inviteAndAccept(
            request,
            owner.access_token,
            work.id,
            { email: member.email, token: member.access_token },
            'editor',
        );
        const row = (await memberRowFor(request, owner.access_token, work.id, member.user.id))!;

        // Setting the SAME role is a 200 no-op — the row id + createdAt + role are stable.
        const noop = await putRole(request, owner.access_token, work.id, row.id, 'editor');
        expect(noop.status, 'same-role PUT is 200').toBe(200);
        const after = noop.body.member as MemberDto;
        expect(after.id, 'row id unchanged').toBe(row.id);
        expect(after.role, 'role unchanged').toBe('editor');
        expect(after.createdAt, 'createdAt unchanged').toBe(row.createdAt);

        // A genuine change round-trips into BOTH the PUT response and a fresh roster read.
        const changed = await putRole(request, owner.access_token, work.id, row.id, 'manager');
        expect((changed.body.member as MemberDto).role).toBe('manager');
        const refreshed = await memberRowFor(request, owner.access_token, work.id, member.user.id);
        expect(refreshed?.role, 'roster reflects the new role').toBe('manager');
        expect(refreshed?.id, 'the member row id is stable across role changes').toBe(row.id);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // GROUP 2 — RE-GRANT CYCLES (remove / leave → locked out → rejoin)
    // ─────────────────────────────────────────────────────────────────────────

    test('4) remove → locked out → member row 404 → re-invite via token → REJOIN with a fresh row', async ({
        request,
    }) => {
        const s = uniqueSuffix();
        const owner = await registerUserViaAPI(request);
        const member = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, { name: `regrant ${s}` });

        await inviteAndAccept(
            request,
            owner.access_token,
            work.id,
            { email: member.email, token: member.access_token },
            'editor',
        );
        const firstRow = (await memberRowFor(
            request,
            owner.access_token,
            work.id,
            member.user.id,
        ))!;

        // Owner removes the member.
        expect(await removeMember(request, owner.access_token, work.id, firstRow.id)).toBe(200);

        // The ex-member is fully locked out; its old row is now 404.
        const locked = await getWork(request, member.access_token, work.id);
        expect(locked.status, 'ex-member GET work → 403').toBe(403);
        expect(locked.body.message).toBe(NOT_A_MEMBER);
        const oldRow = await request.get(
            `${API_BASE}/api/works/${work.id}/members/${firstRow.id}`,
            { headers: authedHeaders(owner.access_token) },
        );
        expect(oldRow.status(), 'removed member row is 404').toBe(404);
        const rosterAfterRemove = await listMembers(request, owner.access_token, work.id);
        expect(
            rosterAfterRemove.members.map((m) => m.userId),
            'removed user is gone from the roster',
        ).not.toContain(member.user.id);

        // Re-invite via a FRESH token, at a DIFFERENT role, and rejoin.
        await inviteAndAccept(
            request,
            owner.access_token,
            work.id,
            { email: member.email, token: member.access_token },
            'viewer',
        );
        const secondRow = (await memberRowFor(
            request,
            owner.access_token,
            work.id,
            member.user.id,
        ))!;
        expect(secondRow.role, 'rejoined at the new role').toBe('viewer');
        expect(secondRow.id, 'rejoin mints a brand-new member row').not.toBe(firstRow.id);
        expect(
            (await getWork(request, member.access_token, work.id)).status,
            'access restored',
        ).toBe(200);
    });

    test('5) self-leave → locked out → creator cannot leave → re-invite → rejoin', async ({
        request,
    }) => {
        const s = uniqueSuffix();
        const owner = await registerUserViaAPI(request);
        const member = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, { name: `leave ${s}` });

        await inviteAndAccept(
            request,
            owner.access_token,
            work.id,
            { email: member.email, token: member.access_token },
            'editor',
        );

        // The member LEAVES of its own accord.
        const leave = await request.post(`${API_BASE}/api/works/${work.id}/members/leave`, {
            headers: authedHeaders(member.access_token),
        });
        expect(leave.status(), 'self-leave succeeds').toBe(200);
        expect((await leave.json()).message).toBe('Successfully left the work');
        expect(
            (await getWork(request, member.access_token, work.id)).status,
            'after leaving, access is revoked',
        ).toBe(403);

        // The CREATOR structurally cannot leave — must transfer or delete instead.
        const ownerLeave = await request.post(`${API_BASE}/api/works/${work.id}/members/leave`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(ownerLeave.status(), 'creator leave is refused').toBe(400);
        expect((await ownerLeave.json()).message).toBe('Work creator cannot leave the work');

        // A NON-member cannot leave what they never joined (403, not 404).
        const strangerLeave = await request.post(`${API_BASE}/api/works/${work.id}/members/leave`, {
            headers: authedHeaders(stranger.access_token),
        });
        expect(strangerLeave.status(), 'non-member leave → 403').toBe(403);
        expect((await strangerLeave.json()).message).toBe(NOT_A_MEMBER);

        // Re-invite the departed member; they rejoin cleanly.
        await inviteAndAccept(
            request,
            owner.access_token,
            work.id,
            { email: member.email, token: member.access_token },
            'manager',
        );
        expect((await getWork(request, member.access_token, work.id)).userRole).toBe('manager');
    });

    test('6) two pre-issued tokens: already_a_member while joined; a still-pending token re-adds after removal', async ({
        request,
    }) => {
        const s = uniqueSuffix();
        const owner = await registerUserViaAPI(request);
        const member = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, { name: `twotok ${s}` });

        // Issue TWO tokens for the same person up front (distinct pending invites).
        const t1 = await issueInvitation(request, owner.access_token, work.id, {
            email: member.email,
            role: 'editor',
        });
        const t2 = await issueInvitation(request, owner.access_token, work.id, {
            email: member.email,
            role: 'manager',
        });
        expect(t1.claimToken, 'the two tokens are distinct').not.toBe(t2.claimToken);

        // Accept T1 → editor member. The SECOND token is now refused: already_a_member.
        expect((await acceptClaim(request, member.access_token, t1.claimToken)).status).toBe(200);
        const dup = await acceptClaim(request, member.access_token, t2.claimToken);
        expect(dup.status, 'already-a-member cannot claim a second token').toBe(400);
        expect(dup.body.message).toBe('already_a_member');
        expect(
            (await memberRowFor(request, owner.access_token, work.id, member.user.id))?.role,
            'role stays editor — the refused second claim changed nothing',
        ).toBe('editor');

        // Owner removes the member. T2 was never consumed → it is STILL pending.
        const row = (await memberRowFor(request, owner.access_token, work.id, member.user.id))!;
        expect(await removeMember(request, owner.access_token, work.id, row.id)).toBe(200);

        // Now the still-pending T2 re-adds the member with ITS baked role (manager).
        const readd = await acceptClaim(request, member.access_token, t2.claimToken);
        expect(readd.status, 'still-pending token re-adds a removed member').toBe(200);
        expect(readd.body.role, 're-added with the second token baked role').toBe('manager');
        expect(
            (await memberRowFor(request, owner.access_token, work.id, member.user.id))?.role,
        ).toBe('manager');

        // In contrast, T1 was CONSUMED — re-accepting it stays 400 forever, even post-removal.
        const consumed = await acceptClaim(request, member.access_token, t1.claimToken);
        expect(consumed.status, 'a consumed token is never re-usable').toBe(400);
        expect(consumed.body.message).toBe('invitation_already_accepted');
    });

    // ─────────────────────────────────────────────────────────────────────────
    // GROUP 3 — CONCURRENCY (tryAccept is atomic PENDING→ACCEPTED)
    // ─────────────────────────────────────────────────────────────────────────

    test('7) two users race the SAME token: exactly one becomes a member, the loser is refused', async ({
        request,
    }) => {
        const s = uniqueSuffix();
        const owner = await registerUserViaAPI(request);
        const userA = await registerUserViaAPI(request);
        const userB = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, { name: `race1 ${s}` });

        const { claimToken } = await issueInvitation(request, owner.access_token, work.id, {
            email: userA.email,
            role: 'editor',
        });

        // Fire both accepts concurrently.
        const [ra, rb] = await Promise.all([
            acceptClaim(request, userA.access_token, claimToken),
            acceptClaim(request, userB.access_token, claimToken),
        ]);

        const statuses = [ra.status, rb.status].sort();
        expect(statuses, 'exactly one 200 winner, one 4xx loser').toEqual([200, 400]);
        const loser = ra.status === 400 ? ra : rb;
        expect(
            ['invitation_already_accepted', 'invitation_state_changed'],
            'loser gets a race-loss message',
        ).toContain(loser.body.message);

        // The roster gained EXACTLY ONE of the two racers (never both).
        const roster = await listMembers(request, owner.access_token, work.id);
        const joined = roster.members.filter(
            (m) => m.userId === userA.user.id || m.userId === userB.user.id,
        );
        expect(joined.length, 'a single token mints a single membership').toBe(1);
    });

    test('8) one user races TWO distinct tokens for the same work: only one membership results', async ({
        request,
    }) => {
        const s = uniqueSuffix();
        const owner = await registerUserViaAPI(request);
        const member = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, { name: `race2 ${s}` });

        const t1 = await issueInvitation(request, owner.access_token, work.id, {
            email: member.email,
            role: 'editor',
        });
        const t2 = await issueInvitation(request, owner.access_token, work.id, {
            email: member.email,
            role: 'viewer',
        });

        const [r1, r2] = await Promise.all([
            acceptClaim(request, member.access_token, t1.claimToken),
            acceptClaim(request, member.access_token, t2.claimToken),
        ]);

        // Exactly one accept wins. The other is refused — either cleanly
        // (already_a_member / race-loss → 400) or, if both requests slipped past
        // the pre-insert membership check, the Unique(workId,userId) constraint
        // rejects the second insert (409/500). Whatever the loser code, the
        // invariant below is the real contract: never TWO memberships.
        const oks = [r1, r2].filter((r) => r.status === 200);
        const losers = [r1, r2].filter((r) => r.status !== 200);
        expect(oks.length, 'exactly one accept wins').toBe(1);
        expect(losers.length, 'exactly one accept is refused').toBe(1);
        expect(
            [400, 409, 500],
            'loser is a refusal or a constraint rejection, never a second success',
        ).toContain(losers[0].status);

        // The user has exactly one member row (the unique (workId,userId) constraint holds).
        const roster = await listMembers(request, owner.access_token, work.id);
        expect(
            roster.members.filter((m) => m.userId === member.user.id).length,
            'a user holds at most one membership per work',
        ).toBe(1);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // GROUP 4 — BEARER SEMANTICS + INVITER INDEPENDENCE
    // ─────────────────────────────────────────────────────────────────────────

    test('9) the claim token is a BEARER credential, not email-bound: a different user may claim it', async ({
        request,
    }) => {
        const s = uniqueSuffix();
        const owner = await registerUserViaAPI(request);
        const invitedByEmail = await registerUserViaAPI(request);
        const actualClaimant = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, { name: `bearer ${s}` });

        // The invite names invitedByEmail, but a DIFFERENT authenticated user claims the token.
        const { dto, claimToken } = await issueInvitation(request, owner.access_token, work.id, {
            email: invitedByEmail.email,
            role: 'editor',
        });
        expect(dto.email, 'invite records the advisory recipient email').toBe(invitedByEmail.email);

        const accepted = await acceptClaim(request, actualClaimant.access_token, claimToken);
        expect(accepted.status, 'the token bearer becomes the member').toBe(200);

        const roster = await listMembers(request, owner.access_token, work.id);
        const userIds = roster.members.map((m) => m.userId);
        expect(userIds, 'the ACTUAL claimant is the member').toContain(actualClaimant.user.id);
        expect(userIds, 'the invited-by-email user is NOT auto-added').not.toContain(
            invitedByEmail.user.id,
        );
        // The invited-by-email user therefore still has no access.
        expect(
            (await getWork(request, invitedByEmail.access_token, work.id)).status,
            'the named-but-not-claimant user has no membership',
        ).toBe(403);
    });

    test('10) an invitation OUTLIVES its inviter: a manager-issued invite still claims after the manager is removed', async ({
        request,
    }) => {
        const s = uniqueSuffix();
        const owner = await registerUserViaAPI(request);
        const manager = await registerUserViaAPI(request);
        const invitee = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, { name: `outlive ${s}` });

        // Owner promotes `manager`, who then issues an invitation to `invitee`.
        await inviteAndAccept(
            request,
            owner.access_token,
            work.id,
            { email: manager.email, token: manager.access_token },
            'manager',
        );
        const inv = await issueInvitation(request, manager.access_token, work.id, {
            email: invitee.email,
            role: 'viewer',
        });
        expect(inv.dto.invitedById, 'invite is attributed to the manager').toBe(manager.user.id);

        // Owner REMOVES the manager BEFORE the invite is claimed.
        const managerRow = (await memberRowFor(
            request,
            owner.access_token,
            work.id,
            manager.user.id,
        ))!;
        expect(await removeMember(request, owner.access_token, work.id, managerRow.id)).toBe(200);

        // The pending invite still claims — and invitedBy points at the now-removed manager.
        const accepted = await acceptClaim(request, invitee.access_token, inv.claimToken);
        expect(accepted.status, 'invite survives its inviter removal').toBe(200);
        const inviteeRow = await memberRowFor(
            request,
            owner.access_token,
            work.id,
            invitee.user.id,
        );
        expect(inviteeRow?.role).toBe('viewer');
        expect(inviteeRow?.invitedBy?.id, 'invitedBy still references the removed manager').toBe(
            manager.user.id,
        );
        // The removed manager itself is gone from the roster.
        expect(
            (await listMembers(request, owner.access_token, work.id)).members.map((m) => m.userId),
            'the removed manager is not in the roster',
        ).not.toContain(manager.user.id);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // GROUP 5 — COEXISTENCE OF THE TWO MEMBERSHIP SURFACES + ISOLATION
    // ─────────────────────────────────────────────────────────────────────────

    test('11) token-claim and direct POST /members coexist: equivalent, independently role-gated rows', async ({
        request,
    }) => {
        const s = uniqueSuffix();
        const owner = await registerUserViaAPI(request);
        const viaClaim = await registerUserViaAPI(request);
        const viaDirect = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, { name: `coexist ${s}` });

        // Surface A — tokenised claim → editor.
        await inviteAndAccept(
            request,
            owner.access_token,
            work.id,
            { email: viaClaim.email, token: viaClaim.access_token },
            'editor',
        );

        // Surface B — synchronous direct-add of an EXISTING user → viewer (no token, 201).
        const direct = await request.post(`${API_BASE}/api/works/${work.id}/members`, {
            headers: authedHeaders(owner.access_token),
            data: { email: viaDirect.email, role: 'viewer' },
        });
        expect(direct.status(), 'direct-add of a registered user is 201').toBe(201);
        const directBody = await direct.json();
        expect(directBody.member.role).toBe('viewer');
        expect(directBody.member.invitedBy.id, 'direct-add attributes the owner').toBe(
            owner.user.id,
        );

        // Direct-adding an UNREGISTERED email is a generic 404 (no user-enumeration leak).
        const ghost = await request.post(`${API_BASE}/api/works/${work.id}/members`, {
            headers: authedHeaders(owner.access_token),
            data: { email: `nobody-${s}@test.local`, role: 'viewer' },
        });
        expect(ghost.status(), 'unregistered direct-add → 404').toBe(404);
        expect((await ghost.json()).message).toBe('User not found');

        // Both members coexist in the roster and each is gated by its OWN role.
        const roster = await listMembers(request, owner.access_token, work.id);
        const ids = roster.members.map((m) => m.userId);
        expect(ids, 'claim member present').toContain(viaClaim.user.id);
        expect(ids, 'direct member present').toContain(viaDirect.user.id);
        expect(
            await patchWork(request, viaClaim.access_token, work.id, { description: `claim ${s}` }),
            'the editor (via claim) can edit',
        ).toBe(200);
        expect(
            await patchWork(request, viaDirect.access_token, work.id, {
                description: `direct ${s}`,
            }),
            'the viewer (via direct-add) cannot edit',
        ).toBe(403);
    });

    test('12) removing one member never disturbs the others: a 3-role roster stays intact minus the evicted row', async ({
        request,
    }) => {
        const s = uniqueSuffix();
        const owner = await registerUserViaAPI(request);
        const viewer = await registerUserViaAPI(request);
        const editor = await registerUserViaAPI(request);
        const manager = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, { name: `trio ${s}` });

        await inviteAndAccept(
            request,
            owner.access_token,
            work.id,
            { email: viewer.email, token: viewer.access_token },
            'viewer',
        );
        await inviteAndAccept(
            request,
            owner.access_token,
            work.id,
            { email: editor.email, token: editor.access_token },
            'editor',
        );
        await inviteAndAccept(
            request,
            owner.access_token,
            work.id,
            { email: manager.email, token: manager.access_token },
            'manager',
        );

        // All three coexist at their exact roles; owner stays a sibling, never in members[].
        const before = await listMembers(request, owner.access_token, work.id);
        const roleOf = (uid: string) => before.members.find((m) => m.userId === uid)?.role;
        expect(roleOf(viewer.user.id)).toBe('viewer');
        expect(roleOf(editor.user.id)).toBe('editor');
        expect(roleOf(manager.user.id)).toBe('manager');
        expect(
            before.members.map((m) => m.userId),
            'owner is not folded into members[]',
        ).not.toContain(owner.user.id);
        expect(before.owner.id).toBe(owner.user.id);

        // Owner evicts ONLY the editor.
        const editorRow = before.members.find((m) => m.userId === editor.user.id)!;
        expect(await removeMember(request, owner.access_token, work.id, editorRow.id)).toBe(200);

        // The viewer + manager are entirely unaffected — still present, still at their roles + capabilities.
        const after = await listMembers(request, owner.access_token, work.id);
        const afterIds = after.members.map((m) => m.userId);
        expect(afterIds, 'evicted editor is gone').not.toContain(editor.user.id);
        expect(afterIds, 'viewer survives the eviction').toContain(viewer.user.id);
        expect(afterIds, 'manager survives the eviction').toContain(manager.user.id);
        expect((await getWork(request, viewer.access_token, work.id)).userRole).toBe('viewer');
        expect(
            await listInvitationsStatus(request, manager.access_token, work.id),
            'the surviving manager retains manage-members',
        ).toBe(200);
        expect(
            (await getWork(request, editor.access_token, work.id)).status,
            'the evicted editor is locked out',
        ).toBe(403);
    });

    test('13) a manager may evict a PEER but not the creator; a demoted ex-manager instantly loses eviction power', async ({
        request,
    }) => {
        const s = uniqueSuffix();
        const owner = await registerUserViaAPI(request);
        const manager = await registerUserViaAPI(request);
        const peer = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, { name: `evict ${s}` });

        await inviteAndAccept(
            request,
            owner.access_token,
            work.id,
            { email: manager.email, token: manager.access_token },
            'manager',
        );
        await inviteAndAccept(
            request,
            owner.access_token,
            work.id,
            { email: peer.email, token: peer.access_token },
            'editor',
        );

        // The creator/owner is not a members[] row — targeting them with a random uuid is a 404,
        // and there is structurally no member id under which the manager could remove the creator.
        const ghostOwnerRemoval = await removeMember(
            request,
            manager.access_token,
            work.id,
            '00000000-0000-4000-8000-000000000000',
        );
        expect(ghostOwnerRemoval, 'manager cannot remove a non-existent (owner) member row').toBe(
            404,
        );

        // The manager CAN evict its peer editor.
        const peerRow = (await memberRowFor(request, owner.access_token, work.id, peer.user.id))!;
        expect(await removeMember(request, manager.access_token, work.id, peerRow.id)).toBe(200);
        expect(
            (await getWork(request, peer.access_token, work.id)).status,
            'evicted peer is locked out',
        ).toBe(403);

        // Owner demotes the manager to viewer → eviction power evaporates immediately.
        const managerRow = (await memberRowFor(
            request,
            owner.access_token,
            work.id,
            manager.user.id,
        ))!;
        expect(
            (await putRole(request, owner.access_token, work.id, managerRow.id, 'viewer')).status,
        ).toBe(200);
        // Re-add a fresh victim to attempt eviction against.
        const victim = await registerUserViaAPI(request);
        await inviteAndAccept(
            request,
            owner.access_token,
            work.id,
            { email: victim.email, token: victim.access_token },
            'editor',
        );
        const victimRow = (await memberRowFor(
            request,
            owner.access_token,
            work.id,
            victim.user.id,
        ))!;
        expect(
            await removeMember(request, manager.access_token, work.id, victimRow.id),
            'a demoted (now viewer) ex-manager can no longer evict',
        ).toBe(403);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // GROUP 6 — VALIDATION + AUTH BOUNDARIES ON THE MUTATION SURFACE
    // ─────────────────────────────────────────────────────────────────────────

    test('14) PUT role validation: unassignable owner/creator role, empty body, unknown + non-uuid member id', async ({
        request,
    }) => {
        const s = uniqueSuffix();
        const owner = await registerUserViaAPI(request);
        const member = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, { name: `putval ${s}` });

        await inviteAndAccept(
            request,
            owner.access_token,
            work.id,
            { email: member.email, token: member.access_token },
            'editor',
        );
        const row = (await memberRowFor(request, owner.access_token, work.id, member.user.id))!;

        // owner / creator are NOT assignable member roles → 400 with the array message.
        for (const bad of ['owner', 'creator']) {
            const res = await putRole(request, owner.access_token, work.id, row.id, bad);
            expect(res.status, `PUT role=${bad} → 400`).toBe(400);
            expect(JSON.stringify(res.body.message)).toContain('Role must be one of');
        }

        // Empty body (missing role) → 400.
        const empty = await request.put(`${API_BASE}/api/works/${work.id}/members/${row.id}`, {
            headers: authedHeaders(owner.access_token),
            data: {},
        });
        expect(empty.status(), 'missing role → 400').toBe(400);

        // Unknown + non-uuid member ids both resolve to 404 "Member not found"
        // (the members route has no ParseUUIDPipe; a missing row is a clean 404).
        const unknown = await putRole(
            request,
            owner.access_token,
            work.id,
            '00000000-0000-4000-8000-000000000000',
            'viewer',
        );
        expect(unknown.status, 'unknown member id → 404').toBe(404);
        expect(unknown.body.message).toBe('Member not found');
        const nonUuid = await putRole(request, owner.access_token, work.id, 'not-a-uuid', 'viewer');
        expect(nonUuid.status, 'non-uuid member id → 404 (no ParseUUIDPipe on members)').toBe(404);

        // The real member row is untouched by every rejected mutation above.
        expect(
            (await memberRowFor(request, owner.access_token, work.id, member.user.id))?.role,
            'role survived the invalid PUTs',
        ).toBe('editor');
    });

    test('15) a member cannot self-escalate: an editor PUT-ing its own row to manager is 403', async ({
        request,
    }) => {
        const s = uniqueSuffix();
        const owner = await registerUserViaAPI(request);
        const member = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, { name: `selfesc ${s}` });

        await inviteAndAccept(
            request,
            owner.access_token,
            work.id,
            { email: member.email, token: member.access_token },
            'editor',
        );
        const row = (await memberRowFor(request, owner.access_token, work.id, member.user.id))!;

        // The editor attempts to promote ITSELF → denied (PUT needs >= manager).
        const selfPromote = await putRole(request, member.access_token, work.id, row.id, 'manager');
        expect(selfPromote.status, 'editor cannot self-escalate').toBe(403);
        expect(selfPromote.body.message).toBe(PERM_DENIED);
        // And cannot evict itself out of existence via the manage surface either.
        expect(
            await removeMember(request, member.access_token, work.id, row.id),
            'editor cannot self-remove via the manage endpoint',
        ).toBe(403);
        // The role is unchanged; the member is still an editor.
        expect(
            (await memberRowFor(request, owner.access_token, work.id, member.user.id))?.role,
        ).toBe('editor');
    });

    test('16) unauthenticated boundary sweep: accept / list / get-one / PUT / DELETE / leave all 401', async ({
        request,
    }) => {
        const s = uniqueSuffix();
        const owner = await registerUserViaAPI(request);
        const member = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, { name: `noauth ${s}` });
        await inviteAndAccept(
            request,
            owner.access_token,
            work.id,
            { email: member.email, token: member.access_token },
            'editor',
        );
        const row = (await memberRowFor(request, owner.access_token, work.id, member.user.id))!;
        const validToken = 'a'.repeat(64);

        const accept = await request.post(`${API_BASE}/api/claim/accept`, {
            data: { token: validToken },
        });
        expect(accept.status(), 'anon accept → 401').toBe(401);

        const list = await request.get(`${API_BASE}/api/works/${work.id}/members`);
        expect(list.status(), 'anon list members → 401').toBe(401);

        const one = await request.get(`${API_BASE}/api/works/${work.id}/members/${row.id}`);
        expect(one.status(), 'anon get-one member → 401').toBe(401);

        const put = await request.put(`${API_BASE}/api/works/${work.id}/members/${row.id}`, {
            data: { role: 'viewer' },
        });
        expect(put.status(), 'anon PUT role → 401').toBe(401);

        const del = await request.delete(`${API_BASE}/api/works/${work.id}/members/${row.id}`);
        expect(del.status(), 'anon DELETE member → 401').toBe(401);

        const leave = await request.post(`${API_BASE}/api/works/${work.id}/members/leave`);
        expect(leave.status(), 'anon leave → 401').toBe(401);

        // None of the anonymous calls mutated anything — the member is still an editor.
        expect(
            (await memberRowFor(request, owner.access_token, work.id, member.user.id))?.role,
            'the roster is untouched by anonymous calls',
        ).toBe('editor');
    });

    test('17) owner self-claim is refused and mints no ghost membership; the pending invite survives', async ({
        request,
    }) => {
        const s = uniqueSuffix();
        const owner = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, {
            name: `selfclaim ${s}`,
        });

        // The owner issues an invite and tries to claim it themselves.
        const { dto, claimToken } = await issueInvitation(request, owner.access_token, work.id, {
            email: `decoy-${s}@test.local`,
            role: 'editor',
        });
        const selfClaim = await acceptClaim(request, owner.access_token, claimToken);
        expect(selfClaim.status, 'owner cannot self-claim their own work').toBe(400);
        expect(selfClaim.body.message).toBe('claimant_is_already_owner');

        // No membership row was created (a fresh work still has zero members).
        const roster = await listMembers(request, owner.access_token, work.id);
        expect(roster.members.length, 'self-claim mints no member row').toBe(0);

        // The invite is NOT consumed by the failed self-claim — it is still pending + claimable.
        const stillPending = await request.get(`${API_BASE}/api/works/${work.id}/invitations`, {
            headers: authedHeaders(owner.access_token),
        });
        const pending = (await stillPending.json()).invitations as InvitationResponse[];
        expect(
            pending.some((p) => p.id === dto.id && p.status === 'pending'),
            'the invite survives the failed self-claim',
        ).toBe(true);
        // A real other user can then claim that very token.
        const other = await registerUserViaAPI(request);
        expect((await acceptClaim(request, other.access_token, claimToken)).status).toBe(200);
    });

    test('18) accept baked-role fidelity: manager/editor/viewer each mint a WorkMember at the EXACT role', async ({
        request,
    }) => {
        const s = uniqueSuffix();
        const owner = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, { name: `baked ${s}` });

        for (const role of ['manager', 'editor', 'viewer'] as const) {
            const claimant = await registerUserViaAPI(request);
            const { claimToken } = await issueInvitation(request, owner.access_token, work.id, {
                email: claimant.email,
                role,
            });
            const accepted = await acceptClaim(request, claimant.access_token, claimToken);
            expect(accepted.status, `accept ${role}`).toBe(200);
            expect(accepted.body.role, `accept echoes ${role}`).toBe(role);
            const row = await memberRowFor(request, owner.access_token, work.id, claimant.user.id);
            expect(row?.role, `${role} member row minted at the baked role`).toBe(role);
            // The freshly-claimed member reports the same role from its OWN work view.
            expect(
                (await getWork(request, claimant.access_token, work.id)).userRole,
                `work.userRole for ${role}`,
            ).toBe(role);
        }

        // All three distinct roles now coexist on the one work alongside the sibling owner.
        const roster = await listMembers(request, owner.access_token, work.id);
        const roles = roster.members.map((m) => m.role).sort();
        expect(roles, 'three distinct member roles coexist').toEqual([
            'editor',
            'manager',
            'viewer',
        ]);
        expect(roster.owner.id).toBe(owner.user.id);
    });
});
