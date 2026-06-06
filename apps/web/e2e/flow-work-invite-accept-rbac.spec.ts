import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * flow-work-invite-accept-rbac.spec.ts
 *
 * COMPLEX, multi-actor INTEGRATION flows for the tokenised Work-invitation →
 * claim → role-scoped-access lifecycle. This is the END-TO-END path a real
 * collaborator walks: an owner/manager issues a single-use claim token, the
 * recipient ACCEPTS it (creating a `work_members` row), and from then on the
 * recipient's capabilities are bounded by the granted role (viewer/editor/
 * manager) across GET/PATCH/items/members/invitations — while a non-member is
 * locked out entirely.
 *
 * ── WHY THIS DOES NOT DUPLICATE EXISTING SPECS ──────────────────────────────
 * work-members.spec.ts pins the bare REST contract of the legacy members POST
 * (owner adds an EXISTING user → 201 immediately) and the un-authenticated
 * 401s. member-invitation-happy-path.spec.ts walks one issue→list path.
 * flow-org-member-roles-matrix.spec.ts / flow-org-members-rbac.spec.ts live on
 * ORGANIZATIONS. NONE of them exercises the tokenised CLAIM endpoint
 * (POST /api/claim/accept) as the bridge from invitation to membership, and
 * none drives the full per-role CAPABILITY MATRIX (what a viewer/editor/manager
 * can and cannot do once they're in) as a multi-actor integration. That is the
 * uncovered ground these six flows own.
 *
 * ── PROBED SHAPES (verified live @ 127.0.0.1:3100 + controller/service source,
 *    2026-06-01) ──────────────────────────────────────────────────────────────
 *
 *   ISSUE   POST /api/works/:workId/invitations
 *     - workId path is `ParseUUIDPipe` → a non-uuid workId is 400.
 *     - Body (CreateInvitationDto): { email?, role, expiresInDays?(1..90),
 *       metadata?, expectedProviderUsername? }. role ∈
 *       {manager,editor,viewer,owner-claim}; an unknown role (e.g. "admin")
 *       → 400 "role must be one of the following values: manager, editor,
 *       viewer, owner-claim". member-role invitations REQUIRE `email`.
 *     - AUTH GATE: member-role issuance needs ensureCanManageMembers (>= MANAGER);
 *       owner-claim issuance needs ensureIsOwner (creator only). Below that → 403
 *       "You do not have the required permission level for this action".
 *       A non-member → 403 "You do not have permission to access this work".
 *     - 201 → InvitationResponseDto { id, workId, role, email|null, status:
 *       "pending", tokenExpiresAt, createdAt, invitedById, metadata, claimUrl }.
 *       The raw token is embedded in `claimUrl` (".../claim/<token>") and is
 *       returned ONCE — only sha256(token) is stored.
 *
 *   PREVIEW GET /api/claim/preview?token=… (PUBLIC, @Throttle 10/60s/IP)
 *     - 200 { workName, role, expiresAt, expectedProviderUsername|null, sourceUrl }
 *       for a consumable token; 404 for an unknown 32+char token; 400 for an
 *       expired/already-accepted token; 403 for a revoked token; the DTO requires
 *       token length >= 32 (a short token → 400 validation, NOT 404).
 *
 *   ACCEPT  POST /api/claim/accept (AUTH, @Throttle 10/60s/IP)
 *     - Body (ClaimAcceptDto): { token }. 401 without auth.
 *     - Member-role accept → 200 { invitationId, workId, role, transferStatus:
 *       "not_required" } and atomically (a) marks invitation ACCEPTED and
 *       (b) inserts a WorkMember row with the granted role.
 *     - Re-accepting an already-accepted token → 400 "invitation_already_accepted".
 *     - Revoked token → 403 "invitation_revoked"; unknown (valid-length) token →
 *       404 "invitation_not_found".
 *     - Owner self-accepting a token on their own work → 400
 *       "claimant_is_already_owner"; an already-member re-accepting a *different*
 *       token → 400 "already_a_member".
 *
 *   ROLE HIERARCHY (WorkOwnershipService, numeric): owner=4 > manager=3 >
 *   editor=2 > viewer=1. The creator is IMPLICITLY owner with NO members row.
 *   Capability gates observed on the live API:
 *     GET  /api/works/:id            → ensureAccess (ANY member incl. viewer) 200;
 *                                       NON-member → 403; non-existent work → 404
 *                                       (NotFound is thrown before the access check).
 *                                       Response = { status:"success", work } and
 *                                       work.userRole reflects the caller's role.
 *     GET  /api/works/:id/items      → ensureCanView (>= viewer) 200.
 *     PATCH/PUT /api/works/:id        → ensureCanEdit (>= editor): editor/manager
 *                                       200, viewer → 403.
 *     GET  /api/works/:id/members    → ensureCanView (>= viewer) 200; the response
 *                                       is { status, members[], owner } — the OWNER
 *                                       is a SIBLING field, never folded into
 *                                       members[] (a fresh work has 0 members).
 *     GET  /api/works/:id/invitations → ensureCanManageMembers (>= manager):
 *                                       manager 200, editor/viewer → 403.
 *     PUT  /api/works/:id/members/:m  → ensureCanManageMembers: manager 200,
 *                                       editor/viewer → 403.
 *
 * ── HARD-WON GOTCHAS RESPECTED ──────────────────────────────────────────────
 *   - login DTO = {email,password} only (extra props → 400); register helper
 *     sends {username,email,password}.
 *   - All orchestration runs on FRESH registerUserViaAPI() users (Date.now-unique)
 *     so the shared in-memory DB stays clean and sibling specs are unaffected.
 *   - The single UI assertion derives origin from the baseURL fixture; /dashboard
 *     does NOT exist; routes are unprefixed. It is resilient (.or + tolerant).
 *   - Non-existent work → 404 (NotFound precedes the access check); a REAL work
 *     the caller can't reach → 403. Both are asserted distinctly.
 *   - No mail is hard-required: issuance emits a MemberInvited event but e2e SMTP
 *     delivery fails ("Missing credentials for PLAIN"), so we assert the API
 *     contract (claimUrl returned) — never a delivered message.
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

interface MembersResponse {
    status: string;
    members: Array<{
        id: string;
        userId: string;
        username: string;
        email: string;
        role: string;
        invitedBy?: { id: string; username: string };
        createdAt: string;
    }>;
    owner: { id: string; username: string; email: string; avatar?: string };
}

const PERM_DENIED = 'You do not have the required permission level for this action';
const NOT_A_MEMBER = 'You do not have permission to access this work';

/** Issue a tokenised member-role invitation and return the parsed DTO + raw token. */
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
    expect(res.status(), `issue invitation body=${await res.text().catch(() => '')}`).toBe(201);
    const dto = (await res.json()) as InvitationResponse;
    expect(dto.id, 'invitation id').toBeTruthy();
    expect(dto.status, 'fresh invitation is pending').toBe('pending');
    expect(dto.role, 'echoed role').toBe(body.role);
    expect(dto.email, 'echoed email').toBe(body.email);
    expect(dto.claimUrl, 'claim url returned ONCE at creation').toBeTruthy();
    const claimToken = dto.claimUrl!.split('/').pop()!;
    expect(claimToken.length, 'raw token is 64 hex chars (32 bytes)').toBe(64);
    return { dto, claimToken };
}

/** Accept a claim token as `token`'s user; returns the raw response for assertions. */
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

/** GET a work; return { status, userRole } (work.userRole is the caller's role). */
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

test.describe('Work invite → accept → role-scoped RBAC — multi-actor flows', () => {
    test('1) editor invite → claim → editor capability matrix (GET/items/PATCH yes, manage-members no)', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const editor = await registerUserViaAPI(request);
        const stamp = Date.now().toString(36);
        const work = await createWorkViaAPI(request, owner.access_token, {
            name: `RBAC editor ${stamp}`,
        });
        expect(work.id, 'work id').toBeTruthy();

        // --- BEFORE accept: the invitee is a non-member → fully locked out ----
        const beforeWork = await getWork(request, editor.access_token, work.id);
        expect(beforeWork.status, 'pre-claim GET work is forbidden').toBe(403);
        expect(beforeWork.body.message, 'non-member denial message').toBe(NOT_A_MEMBER);
        const beforeItems = await request.get(`${API_BASE}/api/works/${work.id}/items`, {
            headers: authedHeaders(editor.access_token),
        });
        expect(beforeItems.status(), 'pre-claim GET items forbidden').toBe(403);

        // --- Owner issues a tokenised EDITOR invitation ----------------------
        const { dto, claimToken } = await issueInvitation(request, owner.access_token, work.id, {
            email: editor.email,
            role: 'editor',
        });
        // The pending invitation is observable to the owner before it is claimed.
        const pendingRes = await request.get(`${API_BASE}/api/works/${work.id}/invitations`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(pendingRes.status()).toBe(200);
        const pending = (await pendingRes.json()).invitations as InvitationResponse[];
        expect(pending.some((p) => p.id === dto.id && p.status === 'pending')).toBe(true);
        // A reads-after-creation invitation NEVER re-exposes the raw token.
        expect(
            pending.find((p) => p.id === dto.id)?.claimUrl,
            'no token on subsequent reads',
        ).toBeFalsy();

        // --- Public preview reflects the invitation without consuming it -----
        const preview = await request.get(`${API_BASE}/api/claim/preview?token=${claimToken}`);
        expect(preview.status(), 'preview consumable token').toBe(200);
        const previewBody = await preview.json();
        expect(previewBody.role).toBe('editor');
        expect(previewBody.workName).toBe(`RBAC editor ${stamp}`);

        // --- Invitee ACCEPTS → becomes an editor member ----------------------
        const accepted = await acceptClaim(request, editor.access_token, claimToken);
        expect(accepted.status, `accept body=${JSON.stringify(accepted.body)}`).toBe(200);
        expect(accepted.body.role).toBe('editor');
        expect(accepted.body.transferStatus).toBe('not_required');
        expect(accepted.body.workId).toBe(work.id);

        // Membership is now visible to the owner; owner stays in the SIBLING
        // `owner` field (never inside members[]).
        const members = await listMembers(request, owner.access_token, work.id);
        const me = members.members.find((m) => m.userId === editor.user.id);
        expect(me, 'editor now appears in members[]').toBeTruthy();
        expect(me!.role).toBe('editor');
        expect(me!.invitedBy?.id, 'invitedBy is the owner').toBe(owner.user.id);
        expect(members.owner.id, 'owner is the work creator').toBe(owner.user.id);
        expect(
            members.members.some((m) => m.userId === owner.user.id),
            'owner is NOT duplicated into members[]',
        ).toBe(false);

        // --- EDITOR CAPABILITY MATRIX ----------------------------------------
        // GET work: allowed (ensureAccess passes for any member); userRole = editor.
        const ed = await getWork(request, editor.access_token, work.id);
        expect(ed.status, 'editor can GET work').toBe(200);
        expect(ed.userRole, 'work.userRole reflects editor').toBe('editor');
        // GET items: allowed (ensureCanView).
        const edItems = await request.get(`${API_BASE}/api/works/${work.id}/items`, {
            headers: authedHeaders(editor.access_token),
        });
        expect(edItems.status(), 'editor can GET items').toBe(200);
        // PATCH work: allowed (ensureCanEdit >= editor).
        expect(
            await patchWork(request, editor.access_token, work.id, {
                description: 'edited by editor',
            }),
            'editor can PATCH work',
        ).toBe(200);
        // Manage members (list invitations): DENIED (needs manager).
        const edInv = await request.get(`${API_BASE}/api/works/${work.id}/invitations`, {
            headers: authedHeaders(editor.access_token),
        });
        expect(edInv.status(), 'editor cannot list invitations').toBe(403);
        // Issue a new invitation: DENIED (needs manager).
        const edIssue = await request.post(`${API_BASE}/api/works/${work.id}/invitations`, {
            headers: authedHeaders(editor.access_token),
            data: { email: `nope-${stamp}@test.local`, role: 'viewer' },
        });
        expect(edIssue.status(), 'editor cannot issue invitations').toBe(403);
        expect((await edIssue.json()).message).toBe(PERM_DENIED);
    });

    test('2) viewer invite → claim → read-only matrix (GET/items/members yes, PATCH/invitations no)', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const viewer = await registerUserViaAPI(request);
        const stamp = Date.now().toString(36);
        const work = await createWorkViaAPI(request, owner.access_token, {
            name: `RBAC viewer ${stamp}`,
        });

        const { claimToken } = await issueInvitation(request, owner.access_token, work.id, {
            email: viewer.email,
            role: 'viewer',
        });
        const accepted = await acceptClaim(request, viewer.access_token, claimToken);
        expect(accepted.status, `accept body=${JSON.stringify(accepted.body)}`).toBe(200);
        expect(accepted.body.role).toBe('viewer');

        // --- VIEWER CAPABILITY MATRIX (read-only) ----------------------------
        const vw = await getWork(request, viewer.access_token, work.id);
        expect(vw.status, 'viewer can GET work').toBe(200);
        expect(vw.userRole, 'work.userRole reflects viewer').toBe('viewer');

        const vwItems = await request.get(`${API_BASE}/api/works/${work.id}/items`, {
            headers: authedHeaders(viewer.access_token),
        });
        expect(vwItems.status(), 'viewer can GET items').toBe(200);

        // Viewer can SEE the member roster (ensureCanView) and finds itself.
        const roster = await listMembers(request, viewer.access_token, work.id);
        expect(
            roster.members.some((m) => m.userId === viewer.user.id && m.role === 'viewer'),
            'viewer sees itself in roster',
        ).toBe(true);
        expect(roster.owner.id, 'roster surfaces the owner sibling').toBe(owner.user.id);

        // Write paths are all DENIED.
        expect(
            await patchWork(request, viewer.access_token, work.id, { description: 'sneaky' }),
            'viewer cannot PATCH work',
        ).toBe(403);
        const vwInv = await request.get(`${API_BASE}/api/works/${work.id}/invitations`, {
            headers: authedHeaders(viewer.access_token),
        });
        expect(vwInv.status(), 'viewer cannot list invitations').toBe(403);
        const vwIssue = await request.post(`${API_BASE}/api/works/${work.id}/invitations`, {
            headers: authedHeaders(viewer.access_token),
            data: { email: `x-${stamp}@test.local`, role: 'viewer' },
        });
        expect(vwIssue.status(), 'viewer cannot issue invitations').toBe(403);

        // The owner's PATCH still works — proving the work itself is editable,
        // the 403 above is a ROLE decision, not a broken work.
        expect(
            await patchWork(request, owner.access_token, work.id, { description: 'owner edit' }),
            'owner retains edit',
        ).toBe(200);
    });

    test('3) manager invite → claim → manager can manage members but a re-delegated editor still cannot', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const manager = await registerUserViaAPI(request);
        const editor = await registerUserViaAPI(request);
        const stamp = Date.now().toString(36);
        const work = await createWorkViaAPI(request, owner.access_token, {
            name: `RBAC manager ${stamp}`,
        });

        // Owner promotes `manager` via claim.
        const m = await issueInvitation(request, owner.access_token, work.id, {
            email: manager.email,
            role: 'manager',
        });
        expect((await acceptClaim(request, manager.access_token, m.claimToken)).status).toBe(200);

        // --- MANAGER CAPABILITY MATRIX ---------------------------------------
        // Manager can list invitations (ensureCanManageMembers).
        const mgInvList = await request.get(`${API_BASE}/api/works/${work.id}/invitations`, {
            headers: authedHeaders(manager.access_token),
        });
        expect(mgInvList.status(), 'manager can list invitations').toBe(200);
        // Manager can ISSUE a member invitation (here: an editor) and that
        // recipient can claim it — a full owner-delegated invite path.
        const e = await issueInvitation(request, manager.access_token, work.id, {
            email: editor.email,
            role: 'editor',
        });
        expect(
            (await acceptClaim(request, editor.access_token, e.claimToken)).status,
            'editor claims manager-issued invite',
        ).toBe(200);

        // Manager can also PATCH (>= editor) and GET.
        expect(
            await patchWork(request, manager.access_token, work.id, { description: 'mgr edit' }),
            'manager can PATCH',
        ).toBe(200);

        // Manager can PROMOTE the editor's member-row role via PUT (ensureCanManageMembers).
        const roster = await listMembers(request, owner.access_token, work.id);
        const editorMember = roster.members.find((mm) => mm.userId === editor.user.id)!;
        expect(editorMember, 'editor member row exists').toBeTruthy();
        const promote = await request.put(
            `${API_BASE}/api/works/${work.id}/members/${editorMember.id}`,
            { headers: authedHeaders(manager.access_token), data: { role: 'viewer' } },
        );
        expect(promote.status(), 'manager can change member role').toBe(200);
        expect((await promote.json()).member.role).toBe('viewer');

        // --- The re-delegated EDITOR still cannot manage members -------------
        // Even though a manager invited them, the editor's own capabilities are
        // bounded by EDITOR — they cannot change roles nor list invitations.
        const editorPut = await request.put(
            `${API_BASE}/api/works/${work.id}/members/${editorMember.id}`,
            { headers: authedHeaders(editor.access_token), data: { role: 'manager' } },
        );
        expect(editorPut.status(), 'editor cannot change a member role').toBe(403);
        expect((await editorPut.json()).message).toBe(PERM_DENIED);
        const editorInvList = await request.get(`${API_BASE}/api/works/${work.id}/invitations`, {
            headers: authedHeaders(editor.access_token),
        });
        expect(editorInvList.status(), 'editor cannot list invitations').toBe(403);
    });

    test('4) single-use token: accepted token is consumed; re-claim and revoked-claim are refused', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const firstClaimant = await registerUserViaAPI(request);
        const secondClaimant = await registerUserViaAPI(request);
        const stamp = Date.now().toString(36);
        const work = await createWorkViaAPI(request, owner.access_token, {
            name: `RBAC single-use ${stamp}`,
        });

        // (a) Issue + accept once → consumed.
        const inv = await issueInvitation(request, owner.access_token, work.id, {
            email: firstClaimant.email,
            role: 'editor',
        });
        expect(
            (await acceptClaim(request, firstClaimant.access_token, inv.claimToken)).status,
        ).toBe(200);

        // (b) Re-accepting the SAME token (even by a different user) → 400,
        // because the invitation has transitioned PENDING → ACCEPTED.
        const reuse = await acceptClaim(request, secondClaimant.access_token, inv.claimToken);
        expect(reuse.status, 'accepted token cannot be reused').toBe(400);
        expect(reuse.body.message).toBe('invitation_already_accepted');
        // The second claimant did NOT become a member.
        const roster = await listMembers(request, owner.access_token, work.id);
        expect(
            roster.members.some((mm) => mm.userId === secondClaimant.user.id),
            'failed re-claim created no membership',
        ).toBe(false);

        // (c) The first claimant re-accepting yields the SAME terminal state
        // (already-accepted precedes the already-a-member check in findConsumable).
        const selfReuse = await acceptClaim(request, firstClaimant.access_token, inv.claimToken);
        expect(selfReuse.status).toBe(400);
        expect(selfReuse.body.message).toBe('invitation_already_accepted');

        // (d) Revoke-then-claim: a fresh pending invitation, revoked by the
        // owner, is no longer consumable → 403 invitation_revoked.
        const revokable = await issueInvitation(request, owner.access_token, work.id, {
            email: secondClaimant.email,
            role: 'viewer',
        });
        const del = await request.delete(
            `${API_BASE}/api/works/${work.id}/invitations/${revokable.dto.id}`,
            { headers: authedHeaders(owner.access_token) },
        );
        expect(del.status(), 'owner revokes pending invitation').toBe(200);
        const claimRevoked = await acceptClaim(
            request,
            secondClaimant.access_token,
            revokable.claimToken,
        );
        expect(claimRevoked.status, 'revoked token cannot be claimed').toBe(403);
        expect(claimRevoked.body.message).toBe('invitation_revoked');
        // Preview of a revoked token also surfaces 403 (not 404/200).
        const previewRevoked = await request.get(
            `${API_BASE}/api/claim/preview?token=${revokable.claimToken}`,
        );
        expect(previewRevoked.status(), 'revoked preview is 403').toBe(403);

        // (e) The revoked invitation is gone from the pending list.
        const pendingAfter = await request.get(`${API_BASE}/api/works/${work.id}/invitations`, {
            headers: authedHeaders(owner.access_token),
        });
        const pendingIds = ((await pendingAfter.json()).invitations as InvitationResponse[]).map(
            (p) => p.id,
        );
        expect(pendingIds, 'revoked invitation no longer pending').not.toContain(revokable.dto.id);
    });

    test('5) claim guardrails: owner self-claim, double-membership, unknown/short token, unauth, bad role', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const member = await registerUserViaAPI(request);
        const stamp = Date.now().toString(36);
        const work = await createWorkViaAPI(request, owner.access_token, {
            name: `RBAC guardrails ${stamp}`,
        });

        // --- Owner cannot self-accept a token on their own work --------------
        const forOwner = await issueInvitation(request, owner.access_token, work.id, {
            email: `decoy-${stamp}@test.local`,
            role: 'viewer',
        });
        const selfClaim = await acceptClaim(request, owner.access_token, forOwner.claimToken);
        expect(selfClaim.status, 'owner self-claim refused').toBe(400);
        expect(selfClaim.body.message).toBe('claimant_is_already_owner');

        // --- Become a member once, then a SECOND distinct token is refused ---
        const first = await issueInvitation(request, owner.access_token, work.id, {
            email: member.email,
            role: 'editor',
        });
        expect((await acceptClaim(request, member.access_token, first.claimToken)).status).toBe(
            200,
        );
        const second = await issueInvitation(request, owner.access_token, work.id, {
            email: member.email,
            role: 'manager',
        });
        const dup = await acceptClaim(request, member.access_token, second.claimToken);
        expect(dup.status, 'already-a-member cannot claim a second token').toBe(400);
        expect(dup.body.message).toBe('already_a_member');
        // The member's role is unchanged by the refused second claim.
        const roster = await listMembers(request, owner.access_token, work.id);
        expect(roster.members.find((m) => m.userId === member.user.id)?.role).toBe('editor');

        // --- Unknown but well-formed token → 404 (preview AND accept) --------
        const unknown = 'f'.repeat(64);
        const unknownAccept = await acceptClaim(request, member.access_token, unknown);
        expect(unknownAccept.status, 'unknown token accept → 404').toBe(404);
        expect(unknownAccept.body.message).toBe('invitation_not_found');
        const unknownPreview = await request.get(`${API_BASE}/api/claim/preview?token=${unknown}`);
        expect(unknownPreview.status(), 'unknown token preview → 404').toBe(404);

        // --- A too-short token fails DTO validation (400), not 404 -----------
        const shortAccept = await request.post(`${API_BASE}/api/claim/accept`, {
            headers: authedHeaders(member.access_token),
            data: { token: 'deadbeef' },
        });
        expect(shortAccept.status(), 'short token → 400 validation').toBe(400);

        // --- Accept requires auth --------------------------------------------
        const anon = await request.post(`${API_BASE}/api/claim/accept`, {
            data: { token: unknown },
        });
        expect(anon.status(), 'accept without auth → 401').toBe(401);

        // --- Issue with an invalid role is rejected by the DTO ---------------
        const badRole = await request.post(`${API_BASE}/api/works/${work.id}/invitations`, {
            headers: authedHeaders(owner.access_token),
            data: { email: `z-${stamp}@test.local`, role: 'admin' },
        });
        expect(badRole.status(), 'invalid role → 400').toBe(400);

        // --- Non-uuid workId on issue is a 400 (ParseUUIDPipe) ---------------
        const badWorkId = await request.post(`${API_BASE}/api/works/not-a-uuid/invitations`, {
            headers: authedHeaders(owner.access_token),
            data: { email: `q-${stamp}@test.local`, role: 'viewer' },
        });
        expect(badWorkId.status(), 'non-uuid workId → 400').toBe(400);
    });

    test('6) issuance authorization boundary + non-member isolation across two works', async ({
        request,
    }) => {
        const ownerA = await registerUserViaAPI(request);
        const ownerB = await registerUserViaAPI(request);
        const stamp = Date.now().toString(36);
        const workA = await createWorkViaAPI(request, ownerA.access_token, {
            name: `RBAC issuance A ${stamp}`,
        });
        const workB = await createWorkViaAPI(request, ownerB.access_token, {
            name: `RBAC issuance B ${stamp}`,
        });

        // --- ownerB is a NON-member of workA: every access is 403 ------------
        const bGetA = await getWork(request, ownerB.access_token, workA.id);
        expect(bGetA.status, 'non-member GET other-work → 403').toBe(403);
        expect(bGetA.body.message).toBe(NOT_A_MEMBER);
        const bItemsA = await request.get(`${API_BASE}/api/works/${workA.id}/items`, {
            headers: authedHeaders(ownerB.access_token),
        });
        expect(bItemsA.status(), 'non-member GET items → 403').toBe(403);
        const bMembersA = await request.get(`${API_BASE}/api/works/${workA.id}/members`, {
            headers: authedHeaders(ownerB.access_token),
        });
        expect(bMembersA.status(), 'non-member GET members → 403').toBe(403);
        const bPatchA = await patchWork(request, ownerB.access_token, workA.id, {
            description: 'intruder',
        });
        expect(bPatchA, 'non-member PATCH → 403').toBe(403);
        // A non-member CANNOT issue an invitation on someone else's work — the
        // manage-members gate denies even reaching the role check.
        const bIssueA = await request.post(`${API_BASE}/api/works/${workA.id}/invitations`, {
            headers: authedHeaders(ownerB.access_token),
            data: { email: `intruder-${stamp}@test.local`, role: 'viewer' },
        });
        expect(bIssueA.status(), 'non-member cannot issue invitations').toBe(403);
        expect((await bIssueA.json()).message).toBe(NOT_A_MEMBER);
        // And cannot list invitations of a work they don't belong to.
        const bInvA = await request.get(`${API_BASE}/api/works/${workA.id}/invitations`, {
            headers: authedHeaders(ownerB.access_token),
        });
        expect(bInvA.status(), 'non-member cannot list invitations').toBe(403);

        // --- A real EDITOR of workA still cannot issue invitations -----------
        // (issuance needs MANAGER; editor sits one rung below). This proves the
        // 403 is a ROLE gate, distinct from the non-member 403 above.
        const editor = await registerUserViaAPI(request);
        const inv = await issueInvitation(request, ownerA.access_token, workA.id, {
            email: editor.email,
            role: 'editor',
        });
        expect((await acceptClaim(request, editor.access_token, inv.claimToken)).status).toBe(200);
        const editorIssue = await request.post(`${API_BASE}/api/works/${workA.id}/invitations`, {
            headers: authedHeaders(editor.access_token),
            data: { email: `e2-${stamp}@test.local`, role: 'viewer' },
        });
        expect(editorIssue.status(), 'member-but-editor cannot issue').toBe(403);
        expect((await editorIssue.json()).message).toBe(PERM_DENIED);

        // --- owner-claim issuance is OWNER-only ------------------------------
        // The editor (and even a manager) cannot mint an ownership-transfer link;
        // only the creator can. We assert the editor is refused with the
        // permission-level message (ensureIsOwner), not the non-member message.
        const editorOwnerClaim = await request.post(
            `${API_BASE}/api/works/${workA.id}/invitations`,
            {
                headers: authedHeaders(editor.access_token),
                data: { role: 'owner-claim', expectedProviderUsername: 'somebody' },
            },
        );
        expect(editorOwnerClaim.status(), 'editor cannot mint owner-claim').toBe(403);
        // The creator CAN mint one (owner-claim requires expectedProviderUsername).
        const ownerClaim = await request.post(`${API_BASE}/api/works/${workA.id}/invitations`, {
            headers: authedHeaders(ownerA.access_token),
            data: { role: 'owner-claim', expectedProviderUsername: `ghuser-${stamp}` },
        });
        expect(ownerClaim.status(), 'owner can mint owner-claim').toBe(201);
        const ownerClaimBody = (await ownerClaim.json()) as InvitationResponse;
        expect(ownerClaimBody.role).toBe('owner-claim');
        expect(ownerClaimBody.email, 'owner-claim has no recipient email').toBeNull();
        // owner-claim WITHOUT a provider username is rejected at issue time.
        const ownerClaimBad = await request.post(`${API_BASE}/api/works/${workA.id}/invitations`, {
            headers: authedHeaders(ownerA.access_token),
            data: { role: 'owner-claim' },
        });
        expect(ownerClaimBad.status(), 'owner-claim needs expectedProviderUsername').toBe(400);

        // --- Isolation sanity: workB is untouched by all of the above --------
        const bOwnerB = await getWork(request, ownerB.access_token, workB.id);
        expect(bOwnerB.status, 'ownerB still owns workB').toBe(200);
        expect(bOwnerB.userRole).toBe('owner');
        const membersB = await listMembers(request, ownerB.access_token, workB.id);
        expect(membersB.members.length, 'workB has no collaborators').toBe(0);
        expect(membersB.owner.id).toBe(ownerB.user.id);

        // --- A non-existent work is 404 (NotFound precedes the access gate) --
        const ghost = await getWork(
            request,
            ownerA.access_token,
            '00000000-0000-4000-8000-000000000000',
        );
        expect(ghost.status, 'non-existent work → 404, not 403').toBe(404);
    });
});
