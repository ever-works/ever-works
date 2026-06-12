import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * flow-work-members-rbac-deep.spec.ts
 *
 * WORK-LEVEL member RBAC, long-tail deep coverage for the
 * api/works/:workId/members controller (apps/api/src/works/members.controller.ts
 * + packages/agent/src/services/work-member.service.ts). This is DISTINCT from
 * the ORG-member surface: flow-org-members-rbac.spec.ts and
 * flow-org-member-roles-matrix.spec.ts both deal with the Organizations API
 * (which has NO /:id/members at all — the member/role matrix in this product
 * lives on WORKS). This file pins the WORK controller.
 *
 * ── NON-DUPLICATION ─────────────────────────────────────────────────────────
 * The sibling flow-work-member-removal.spec.ts already exhaustively covers the
 * DELETE + leave half of this controller (remove revokes access, double-remove
 * 404, creator un-removable / cannot-leave, viewer/editor-can't-evict vs
 * manager-can, wrong-work 404, no-auth 401, anon UI gate). flow-org-members-
 * rbac.spec.ts covers the invitation-TOKEN flow + the work-RESOURCE gate
 * (GET /api/works/:id). This spec therefore pins ONLY the still-uncovered GAPS:
 *
 *   1. PUT /members/:memberId  (updateMemberRole) — NOT touched by any sibling:
 *        role mutation round-trips into list + GET, role-enum validation,
 *        unknown-member 404, and the MANAGER+/creator authz gate (viewer &
 *        editor → 403; manager → 200).
 *   2. GET /members/:memberId  (getMember) — exact DTO shape, view-tier read
 *        (a low-trust VIEWER can read any row), unknown-id 404, non-member 403,
 *        no-auth 401.
 *   3. POST /members error contract — the user-ENUMERATION strip (controller
 *        rewrites the service's "User with email 'X' not found" into a generic
 *        "User not found"), duplicate-add 400, role-enum 400, email-format 400,
 *        missing-role 400; plus invitedBy ATTRIBUTION (a manager-issued invite
 *        records the manager, not the creator).
 *   4. Cross-work member-id IDOR: a VALID member row from work A, addressed
 *        under work B's URL, is 404 "Member not found" on GET/PUT/DELETE
 *        (member.workId !== workId guard) — the owner of BOTH works still can't
 *        cross the boundary by id.
 *   5. Roster shape: the creator is a SIBLING `owner` object (with email), never
 *        an entry inside `members[]`.
 *
 * ── PROBED CONTRACTS (verified live @ 127.0.0.1:3100, sqlite in-memory CI
 *    driver, REQUIRE_EMAIL_VERIFICATION=false, before any assertion) ──────────
 *
 *   POST   /api/works/:id/members  { email, role:'viewer'|'editor'|'manager' }
 *     201 { status:'success', member:{ id, userId, username, email, avatar,
 *           role, invitedBy:{ id, username }, createdAt } }
 *           — member.id is the ROW id (the :memberId for GET/PUT/DELETE), NOT userId.
 *           — invitedBy reflects the CALLER who issued the invite (owner OR manager).
 *     404 { status:'error', message:'User not found' }   (email not registered;
 *           controller STRIPS the email out of the service's enumerating message)
 *     400 'User is already a member of this work'                (duplicate)
 *     400 ['Role must be one of: viewer, editor, manager']       (role 'creator'/bogus)
 *     400 ['email must be an email']                             (bad email)
 *     400 ['role should not be empty', 'Role must be one of: …'] (missing role)
 *
 *   GET    /api/works/:id/members  (ensureCanView → viewer+ OR creator)
 *     200 { status:'success', members:[…], owner:{ id, username, email, avatar } }
 *           — owner is a sibling field; owner.id is NEVER a members[].userId.
 *
 *   GET    /api/works/:id/members/:memberId  (ensureCanView)
 *     200 { status:'success', member:{ …full DTO… } }   (even a VIEWER may read)
 *     404 { status:'error', message:'Member not found' } (unknown id / wrong work)
 *     403 'You do not have permission to access this work' (non-member)
 *     401 (no auth)
 *
 *   PUT    /api/works/:id/members/:memberId  { role }  (ensureCanManageMembers → manager+ OR creator)
 *     200 { status:'success', member:{ …, role:<new> } }     (owner & manager)
 *     400 ['Role must be one of: viewer, editor, manager']   (role 'creator'/bogus)
 *     404 { status:'error', message:'Member not found' }     (unknown id / wrong work)
 *     403 'You do not have the required permission level for this action' (viewer/editor member)
 *
 *   DELETE /api/works/:id/members/:memberId  → 404 'Member not found' for a
 *           cross-work row id (same guard as GET/PUT) — asserted here only for
 *           the IDOR boundary; full DELETE RBAC lives in the removal spec.
 *
 * ── ISOLATION (matches sibling specs) ───────────────────────────────────────
 * Every test runs on FRESH registerUserViaAPI() users + a FRESH work per
 * mutation (never the shared seeded user). Unique suffixes come from a per-test
 * counter folded into the test title — NOT a module-scope clock. No module-scope
 * await / loadSeededTestUser. Fully API-contract driven (no UI nav, no AI / mail
 * / git-remote dependency — none of these reads/writes is git-gated). List
 * assertions use toContain / not.toContain on row ids, never global counts.
 * Filename uses the safe `flow-` prefix (not matched by the no-auth testIgnore).
 */

const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';

type AssignableRole = 'viewer' | 'editor' | 'manager';

interface MemberRow {
    id: string;
    userId: string;
    username: string;
    email: string;
    role: string;
    invitedBy?: { id: string; username: string };
    createdAt: string;
}

/** Per-test unique suffix source (no module-scope clock). */
let seq = 0;
function uniq(tag: string): string {
    seq += 1;
    return `${tag}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Invite (= synchronously add) an already-registered user; returns the member row. */
async function addMember(
    request: APIRequestContext,
    callerToken: string,
    workId: string,
    email: string,
    role: AssignableRole,
): Promise<MemberRow> {
    const res = await request.post(`${API_BASE}/api/works/${workId}/members`, {
        headers: authedHeaders(callerToken),
        data: { email, role },
    });
    expect(res.status(), `invite ${email} as ${role}`).toBe(201);
    const body = await res.json();
    const member = body?.member ?? body;
    expect(member?.id, 'member row id present').toBeTruthy();
    return member as MemberRow;
}

/** List member rows + owner for a work (caller must have view rights). */
async function listMembers(
    request: APIRequestContext,
    token: string,
    workId: string,
): Promise<{ status: number; members: MemberRow[]; owner?: { id: string; email?: string } }> {
    const res = await request.get(`${API_BASE}/api/works/${workId}/members`, {
        headers: authedHeaders(token),
    });
    let members: MemberRow[] = [];
    let owner: { id: string; email?: string } | undefined;
    if (res.ok()) {
        const body = await res.json();
        members = Array.isArray(body) ? body : (body?.members ?? body?.data ?? []);
        owner = body?.owner;
    }
    return { status: res.status(), members, owner };
}

test.describe('Work members — RBAC deep (PUT / GET-one / invite-errors / IDOR)', () => {
    // ── 1. POST invite: shape + role assignment ──────────────────────────────
    test('invite synchronously adds a registered user with the requested role and a row id', async ({
        request,
    }) => {
        const tag = uniq('invite-shape');
        const owner = await registerUserViaAPI(request);
        const invitee = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, { name: tag });

        const row = await addMember(request, owner.access_token, work.id, invitee.email, 'editor');

        // Row id is the MEMBER-ROW id, distinct from the user's id.
        expect(row.id).not.toBe(invitee.user.id);
        expect(row.userId, 'row maps to the invitee user').toBe(invitee.user.id);
        expect(row.email).toBe(invitee.email);
        expect(row.role).toBe('editor');
        expect(row.createdAt, 'row carries a created timestamp').toBeTruthy();

        // The row is discoverable in the roster under its row id.
        const roster = await listMembers(request, owner.access_token, work.id);
        expect(roster.status).toBe(200);
        expect(roster.members.map((m) => m.id)).toContain(row.id);
    });

    // ── 2. POST invite: invitedBy attribution (manager, not creator) ──────────
    test('invitedBy records the actual inviter — a manager-issued invite is attributed to the manager', async ({
        request,
    }) => {
        const tag = uniq('invitedby');
        const owner = await registerUserViaAPI(request);
        const manager = await registerUserViaAPI(request);
        const invitee = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, { name: tag });

        // Owner promotes a manager; manager's invitedBy is the owner.
        const mgrRow = await addMember(
            request,
            owner.access_token,
            work.id,
            manager.email,
            'manager',
        );
        expect(mgrRow.invitedBy?.id, 'manager was invited by the owner').toBe(owner.user.id);

        // Manager (manager+ can manage members) invites the third user → invitedBy = manager.
        const inviteeRow = await addMember(
            request,
            manager.access_token,
            work.id,
            invitee.email,
            'viewer',
        );
        expect(inviteeRow.invitedBy?.id, 'invitee attributed to the manager, not the creator').toBe(
            manager.user.id,
        );
        expect(inviteeRow.invitedBy?.id).not.toBe(owner.user.id);
    });

    // ── 3. POST invite: user-enumeration strip ────────────────────────────────
    test('inviting an unregistered email returns a GENERIC "User not found" (email stripped, no enumeration)', async ({
        request,
    }) => {
        const tag = uniq('enum-strip');
        const owner = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, { name: tag });

        const ghostEmail = `ghost-${tag}@nowhere.invalid`;
        const res = await request.post(`${API_BASE}/api/works/${work.id}/members`, {
            headers: authedHeaders(owner.access_token),
            data: { email: ghostEmail, role: 'viewer' },
        });
        expect(res.status(), 'unknown invitee → 404').toBe(404);
        const body = await res.json();
        const message = String(body?.message ?? '');
        // The controller rewrites the service's enumerating "User with email 'X'
        // not found" into a generic message — the probed email must NOT leak back.
        expect(message).toMatch(/user not found/i);
        expect(message, 'probed email must not be echoed').not.toContain(ghostEmail);
    });

    // ── 4. POST invite: duplicate + role/email/missing validation ─────────────
    test('invite validation: duplicate 400, role-enum 400, bad-email 400, missing-role 400', async ({
        request,
    }) => {
        const tag = uniq('invite-validation');
        const owner = await registerUserViaAPI(request);
        const invitee = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, { name: tag });

        await addMember(request, owner.access_token, work.id, invitee.email, 'viewer');

        // Duplicate add of the same user → 400 "already a member".
        const dup = await request.post(`${API_BASE}/api/works/${work.id}/members`, {
            headers: authedHeaders(owner.access_token),
            data: { email: invitee.email, role: 'editor' },
        });
        expect(dup.status(), 'duplicate member → 400').toBe(400);
        const dupBody = await dup.json().catch(() => ({}));
        if (dupBody?.message) {
            expect(JSON.stringify(dupBody.message)).toMatch(/already a member/i);
        }

        // 'creator' is excluded from ASSIGNABLE_MEMBER_ROLES → role-enum 400.
        const badRole = await request.post(`${API_BASE}/api/works/${work.id}/members`, {
            headers: authedHeaders(owner.access_token),
            data: { email: invitee.email, role: 'creator' },
        });
        expect(badRole.status(), "role 'creator' rejected by the assignable enum").toBe(400);
        expect(JSON.stringify((await badRole.json()).message)).toMatch(/viewer, editor, manager/i);

        // Malformed email → class-validator 400 before any lookup.
        const badEmail = await request.post(`${API_BASE}/api/works/${work.id}/members`, {
            headers: authedHeaders(owner.access_token),
            data: { email: 'not-an-email', role: 'viewer' },
        });
        expect(badEmail.status(), 'bad email → 400').toBe(400);

        // Missing role → 400 (both "should not be empty" and the enum message).
        const noRole = await request.post(`${API_BASE}/api/works/${work.id}/members`, {
            headers: authedHeaders(owner.access_token),
            data: { email: invitee.email },
        });
        expect(noRole.status(), 'missing role → 400').toBe(400);
    });

    // ── 5. GET :memberId — exact DTO shape, owner read ────────────────────────
    test('GET :memberId returns the full member DTO for the owner', async ({ request }) => {
        const tag = uniq('get-one-shape');
        const owner = await registerUserViaAPI(request);
        const invitee = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, { name: tag });
        const row = await addMember(request, owner.access_token, work.id, invitee.email, 'manager');

        const res = await request.get(`${API_BASE}/api/works/${work.id}/members/${row.id}`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(res.status(), 'owner reads a single member').toBe(200);
        const body = await res.json();
        expect(body?.status).toBe('success');
        const member = body.member;
        expect(member.id).toBe(row.id);
        expect(member.userId).toBe(invitee.user.id);
        expect(member.email).toBe(invitee.email);
        expect(member.role).toBe('manager');
        expect(member.invitedBy?.id, 'invitedBy populated').toBe(owner.user.id);
        expect(typeof member.createdAt).toBe('string');
    });

    // ── 6. GET :memberId — a VIEWER (lowest tier) can still read a row ─────────
    test('GET :memberId is view-tier: a VIEWER member can read another member row', async ({
        request,
    }) => {
        const tag = uniq('get-one-viewer');
        const owner = await registerUserViaAPI(request);
        const viewer = await registerUserViaAPI(request);
        const target = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, { name: tag });

        await addMember(request, owner.access_token, work.id, viewer.email, 'viewer');
        const targetRow = await addMember(
            request,
            owner.access_token,
            work.id,
            target.email,
            'editor',
        );

        // A viewer has ensureCanView rights → may read the target member row (200).
        const res = await request.get(`${API_BASE}/api/works/${work.id}/members/${targetRow.id}`, {
            headers: authedHeaders(viewer.access_token),
        });
        expect(res.status(), 'viewer reads a peer member row').toBe(200);
        const member = (await res.json()).member;
        expect(member.id).toBe(targetRow.id);
        // The full email column is exposed to view-tier (a documented behaviour).
        expect(member.email).toBe(target.email);
    });

    // ── 7. GET :memberId — unknown id, non-member, no-auth ────────────────────
    test('GET :memberId denials: unknown-id 404, non-member 403, no-auth 401', async ({
        request,
    }) => {
        const tag = uniq('get-one-deny');
        const owner = await registerUserViaAPI(request);
        const invitee = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, { name: tag });
        const row = await addMember(request, owner.access_token, work.id, invitee.email, 'viewer');

        // Unknown (valid-UUID) member id, owner authorized → 404 "Member not found".
        const unknown = await request.get(
            `${API_BASE}/api/works/${work.id}/members/${UNKNOWN_UUID}`,
            { headers: authedHeaders(owner.access_token) },
        );
        expect(unknown.status(), 'unknown member id → 404').toBe(404);
        const unknownBody = await unknown.json().catch(() => ({}));
        if (unknownBody?.message) {
            expect(String(unknownBody.message)).toMatch(/member not found/i);
        }

        // A non-member fails the view gate FIRST → 403 (not 404): the work exists,
        // they just lack access; the member-existence branch is unreachable.
        const nonMember = await request.get(`${API_BASE}/api/works/${work.id}/members/${row.id}`, {
            headers: authedHeaders(stranger.access_token),
        });
        expect(nonMember.status(), 'non-member single-read → 403').toBe(403);

        // No auth → 401, before any ownership logic.
        const noAuth = await request.get(`${API_BASE}/api/works/${work.id}/members/${row.id}`);
        expect(noAuth.status(), 'unauthenticated single-read → 401').toBe(401);
    });

    // ── 8. PUT :memberId — owner mutates role, round-trips into list + GET ─────
    test('PUT :memberId updates the role and the change round-trips into list and GET', async ({
        request,
    }) => {
        const tag = uniq('put-roundtrip');
        const owner = await registerUserViaAPI(request);
        const invitee = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, { name: tag });
        const row = await addMember(request, owner.access_token, work.id, invitee.email, 'viewer');

        // Promote viewer → manager.
        const put = await request.put(`${API_BASE}/api/works/${work.id}/members/${row.id}`, {
            headers: authedHeaders(owner.access_token),
            data: { role: 'manager' },
        });
        expect(put.status(), 'owner promotes member').toBe(200);
        const putBody = await put.json();
        expect(putBody?.status).toBe('success');
        expect(putBody.member.role, 'PUT echoes the new role').toBe('manager');
        expect(putBody.member.id, 'same row id preserved across role change').toBe(row.id);

        // GET the single member → new role.
        const get = await request.get(`${API_BASE}/api/works/${work.id}/members/${row.id}`, {
            headers: authedHeaders(owner.access_token),
        });
        expect((await get.json()).member.role, 'GET reflects the new role').toBe('manager');

        // Roster reflects the new role for that row.
        const roster = await listMembers(request, owner.access_token, work.id);
        const seen = roster.members.find((m) => m.id === row.id);
        expect(seen?.role, 'roster reflects the promotion').toBe('manager');

        // Demote back down → still 200, role tracks.
        const demote = await request.put(`${API_BASE}/api/works/${work.id}/members/${row.id}`, {
            headers: authedHeaders(owner.access_token),
            data: { role: 'editor' },
        });
        expect(demote.status()).toBe(200);
        expect((await demote.json()).member.role).toBe('editor');
    });

    // ── 9. PUT :memberId — role-enum + unknown-id validation ──────────────────
    test('PUT :memberId validation: role-enum 400 (creator/bogus), unknown-id 404', async ({
        request,
    }) => {
        const tag = uniq('put-validation');
        const owner = await registerUserViaAPI(request);
        const invitee = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, { name: tag });
        const row = await addMember(request, owner.access_token, work.id, invitee.email, 'editor');

        // 'creator' is not assignable → 400 (DTO IsIn before service runs).
        const creatorRole = await request.put(
            `${API_BASE}/api/works/${work.id}/members/${row.id}`,
            { headers: authedHeaders(owner.access_token), data: { role: 'creator' } },
        );
        expect(creatorRole.status(), "PUT role 'creator' rejected").toBe(400);
        expect(JSON.stringify((await creatorRole.json()).message)).toMatch(
            /viewer, editor, manager/i,
        );

        // A bogus role string → 400.
        const bogus = await request.put(`${API_BASE}/api/works/${work.id}/members/${row.id}`, {
            headers: authedHeaders(owner.access_token),
            data: { role: 'superuser' },
        });
        expect(bogus.status(), 'PUT bogus role rejected').toBe(400);

        // Unknown member id (valid role, owner authorized) → 404 "Member not found".
        const unknown = await request.put(
            `${API_BASE}/api/works/${work.id}/members/${UNKNOWN_UUID}`,
            { headers: authedHeaders(owner.access_token), data: { role: 'viewer' } },
        );
        expect(unknown.status(), 'PUT unknown member id → 404').toBe(404);
        const unknownBody = await unknown.json().catch(() => ({}));
        if (unknownBody?.message) {
            expect(String(unknownBody.message)).toMatch(/member not found/i);
        }

        // The original row is untouched by all the rejected mutations.
        const after = await listMembers(request, owner.access_token, work.id);
        expect(after.members.find((m) => m.id === row.id)?.role).toBe('editor');
    });

    // ── 10. PUT :memberId — authz gate: viewer & editor 403, manager 200 ──────
    test('PUT :memberId is manager+: viewer 403, editor 403, manager may change a peer role', async ({
        request,
    }) => {
        const tag = uniq('put-authz');
        const owner = await registerUserViaAPI(request);
        const viewer = await registerUserViaAPI(request);
        const editor = await registerUserViaAPI(request);
        const manager = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, { name: tag });

        const viewerRow = await addMember(
            request,
            owner.access_token,
            work.id,
            viewer.email,
            'viewer',
        );
        const editorRow = await addMember(
            request,
            owner.access_token,
            work.id,
            editor.email,
            'editor',
        );
        await addMember(request, owner.access_token, work.id, manager.email, 'manager');

        // A VIEWER cannot manage members → 403 "required permission level".
        const viewerPut = await request.put(
            `${API_BASE}/api/works/${work.id}/members/${editorRow.id}`,
            { headers: authedHeaders(viewer.access_token), data: { role: 'viewer' } },
        );
        expect(viewerPut.status(), 'viewer cannot change roles').toBe(403);
        const viewerBody = await viewerPut.json().catch(() => ({}));
        if (viewerBody?.message) {
            expect(String(viewerBody.message)).toMatch(/required permission level/i);
        }

        // An EDITOR likewise lacks manage-members rights → 403 (even on itself).
        const editorPut = await request.put(
            `${API_BASE}/api/works/${work.id}/members/${editorRow.id}`,
            { headers: authedHeaders(editor.access_token), data: { role: 'manager' } },
        );
        expect(editorPut.status(), 'editor cannot change roles').toBe(403);

        // A MANAGER CAN change a peer's role → 200.
        const managerPut = await request.put(
            `${API_BASE}/api/works/${work.id}/members/${viewerRow.id}`,
            { headers: authedHeaders(manager.access_token), data: { role: 'editor' } },
        );
        expect(managerPut.status(), 'manager may change a peer role').toBe(200);
        expect((await managerPut.json()).member.role).toBe('editor');

        // Denied attempts changed nothing: the editor row is still an editor.
        const after = await listMembers(request, owner.access_token, work.id);
        expect(after.members.find((m) => m.id === editorRow.id)?.role).toBe('editor');
    });

    // ── 11. PUT :memberId — non-member stranger is 403 (cannot reach graph) ───
    test('PUT :memberId by a non-member stranger → 403 (no access to the work at all)', async ({
        request,
    }) => {
        const tag = uniq('put-stranger');
        const owner = await registerUserViaAPI(request);
        const invitee = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, { name: tag });
        const row = await addMember(request, owner.access_token, work.id, invitee.email, 'viewer');

        const res = await request.put(`${API_BASE}/api/works/${work.id}/members/${row.id}`, {
            headers: authedHeaders(stranger.access_token),
            data: { role: 'manager' },
        });
        // Non-member trips the access gate (different message than the in-work tier denial).
        expect(res.status(), 'stranger PUT → 403').toBe(403);
        const body = await res.json().catch(() => ({}));
        if (body?.message) {
            expect(String(body.message)).toMatch(/do not have permission to access this work/i);
        }

        // No mutation occurred.
        const after = await listMembers(request, owner.access_token, work.id);
        expect(after.members.find((m) => m.id === row.id)?.role).toBe('viewer');
    });

    // ── 12. Cross-work member-id IDOR boundary ────────────────────────────────
    test('cross-work IDOR: a member row from work A is 404 under work B on GET/PUT/DELETE', async ({
        request,
    }) => {
        const tag = uniq('cross-work');
        const owner = await registerUserViaAPI(request);
        const invitee = await registerUserViaAPI(request);
        // SAME owner for both works, so the only barrier is the workId/member scope.
        const workA = await createWorkViaAPI(request, owner.access_token, { name: `${tag}-a` });
        const workB = await createWorkViaAPI(request, owner.access_token, { name: `${tag}-b` });

        const rowA = await addMember(
            request,
            owner.access_token,
            workA.id,
            invitee.email,
            'editor',
        );

        // Sanity: the row resolves under its OWN work.
        const ownWork = await request.get(`${API_BASE}/api/works/${workA.id}/members/${rowA.id}`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(ownWork.status(), 'row resolves under its own work').toBe(200);

        // GET the SAME valid row id under work B's URL → 404 (member.workId !== workId).
        const crossGet = await request.get(`${API_BASE}/api/works/${workB.id}/members/${rowA.id}`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(crossGet.status(), 'cross-work GET → 404').toBe(404);
        expect(String((await crossGet.json()).message)).toMatch(/member not found/i);

        // PUT the cross-work row id → 404 (cannot promote across the boundary).
        const crossPut = await request.put(`${API_BASE}/api/works/${workB.id}/members/${rowA.id}`, {
            headers: authedHeaders(owner.access_token),
            data: { role: 'manager' },
        });
        expect(crossPut.status(), 'cross-work PUT → 404').toBe(404);

        // DELETE the cross-work row id → 404 (cannot evict across the boundary).
        const crossDel = await request.delete(
            `${API_BASE}/api/works/${workB.id}/members/${rowA.id}`,
            { headers: authedHeaders(owner.access_token) },
        );
        expect(crossDel.status(), 'cross-work DELETE → 404').toBe(404);

        // The row is still intact under work A (none of the cross attempts touched it).
        const stillThere = await listMembers(request, owner.access_token, workA.id);
        expect(stillThere.members.map((m) => m.id)).toContain(rowA.id);
        expect(stillThere.members.find((m) => m.id === rowA.id)?.role).toBe('editor');
    });

    // ── 13. Roster shape: owner is a sibling field, never inside members[] ────
    test('roster exposes the creator as a sibling owner object (with email), not a members[] row', async ({
        request,
    }) => {
        const tag = uniq('owner-sibling');
        const owner = await registerUserViaAPI(request);
        const m1 = await registerUserViaAPI(request);
        const m2 = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, { name: tag });

        await addMember(request, owner.access_token, work.id, m1.email, 'viewer');
        await addMember(request, owner.access_token, work.id, m2.email, 'manager');

        const roster = await listMembers(request, owner.access_token, work.id);
        expect(roster.status).toBe(200);
        expect(roster.owner?.id, 'owner present as sibling field').toBe(owner.user.id);
        expect(roster.owner?.email, 'owner sibling carries email').toBe(owner.email);

        // The owner's user id is NEVER an entry inside members[] — DELETE/PUT can't
        // name them by row id, so the creator is structurally unmanageable here.
        expect(
            roster.members.map((m) => m.userId),
            'owner is not a removable/role-mutable member row',
        ).not.toContain(owner.user.id);
        // Only the two invited collaborators appear, with their assigned roles.
        const byUser = new Map(roster.members.map((m) => [m.userId, m.role]));
        expect(byUser.get(m1.user.id)).toBe('viewer');
        expect(byUser.get(m2.user.id)).toBe('manager');
    });

    // ── 14. List/GET on a non-existent work → 404, no-auth list → 401 ─────────
    test('unknown work and no-auth: list on missing work → 404, list with no auth → 401', async ({
        request,
    }) => {
        const tag = uniq('work-gate');
        const owner = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, { name: tag });

        // A valid-UUID work that does not exist → 404 (route exists, work doesn't).
        const missing = await request.get(`${API_BASE}/api/works/${UNKNOWN_UUID}/members`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(missing.status(), 'list on non-existent work → 404').toBe(404);

        // PUT against a missing work likewise 404s before any member logic.
        const missingPut = await request.put(
            `${API_BASE}/api/works/${UNKNOWN_UUID}/members/${UNKNOWN_UUID}`,
            { headers: authedHeaders(owner.access_token), data: { role: 'viewer' } },
        );
        expect(missingPut.status(), 'PUT on non-existent work → 404').toBe(404);

        // No-auth list of a REAL work → 401 (the guard runs before ownership).
        const noAuth = await request.get(`${API_BASE}/api/works/${work.id}/members`);
        expect(noAuth.status(), 'unauthenticated list → 401').toBe(401);
    });
});
