import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * flow-work-members-invitations-validation-matrix.spec.ts
 *
 * An EXHAUSTIVE per-field VALIDATION + AUTHZ matrix across the two sibling
 * membership controllers of a Work:
 *   - api/works/:workId/members       (apps/api/src/works/members.controller.ts
 *                                       + packages/agent/src/services/work-member.service.ts)
 *   - api/works/:workId/invitations   (apps/api/src/works/invitations.controller.ts
 *                                       + work-invitation.service.ts)
 *   - api/claim/accept | /preview     (apps/api/src/onboarding/claim.controller.ts,
 *                                       ClaimAcceptDto)
 *
 * ── NON-DUPLICATION ─────────────────────────────────────────────────────────
 * This is DELIBERATELY additive to the existing member/invitation specs, which
 * already own the happy-path CRUD and the token lifecycle:
 *   - flow-work-members-rbac-deep / flow-work-member-removal / flow-work-
 *     invitation-accept-multistep: PUT/GET-one/DELETE/leave RBAC, escalation
 *     ladders, races, cross-work IDOR, invitedBy attribution, enumeration strip.
 *   - flow-work-invitations-deep: full DTO shape, claimUrl-once, list-omits-token,
 *     duplicate-not-deduped, 8 KiB metadata cap, malformed :invitationId (400),
 *     well-formed-unknown :invitationId (404).
 *   - flow-work-invitation-tokens / invitation-token-single-use / flow-invitation-
 *     email-roundtrip: single-use replay, revoked/expired precedence, baked role,
 *     expiry contract, non-manager-cannot-issue.
 *
 * This file therefore pins only the still-uncovered MATRIX ROWS:
 *   A. POST /members — every InviteMemberDto field's failure mode (role enum incl.
 *      'owner'/case, email type/format, forbidNonWhitelisted, empty body) + the
 *      "creator-as-member" business rejection.
 *   B. POST /members member-TIER authz (a viewer/editor MEMBER — not a stranger —
 *      is 403) + the members controller's NO-ParseUUIDPipe posture (malformed
 *      workId/memberId → 404, NOT 400) and unknown-work-404 vs known-work-403.
 *   C. POST /invitations — every CreateInvitationDto field's boundary (role enum
 *      incl. 'owner'/case, member-role-requires-email vs owner-claim-allows-none,
 *      expiresInDays 1..90 boundaries, expectedProviderUsername 1..128 length,
 *      metadata IsObject type, forbidNonWhitelisted).
 *   D. POST /invitations two-tier authz split (member-role needs MANAGER+,
 *      owner-claim needs OWNER → a manager gets 201 for member-role but 403 for
 *      owner-claim) + list/revoke member-tier authz + the invitations controller's
 *      HAS-ParseUUIDPipe posture (malformed workId → 400) — the exact CONTRAST
 *      with the members controller.
 *   E. POST /api/claim/accept — ClaimAcceptDto MinLength(32) boundary (31 → 400
 *      DTO-reject vs 32-unknown → 404 lookup-miss), auth gate, and the public
 *      /preview vs guarded /accept split; plus one single-use round-trip that pins
 *      the accept RESPONSE DTO shape.
 *
 * ── PROBED CONTRACT (verified live @ 127.0.0.1:3100 sqlite in-memory before any
 *    assertion) ────────────────────────────────────────────────────────────────
 *
 *   POST /api/works/:workId/members  { email, role:'viewer'|'editor'|'manager' }
 *     201 { status:'success', member:{…} }
 *     400 ['Role must be one of: viewer, editor, manager']  (role 'owner'/'creator'/'Viewer'/non-string)
 *     400 ['email must be an email']                        (bad/empty/number/array email)
 *     400 ['property <x> should not exist']                 (forbidNonWhitelisted)
 *     400 { status:'error', message:'Cannot add the work creator as a member' } (own email)
 *     404 { status:'error', message:'User not found' }      (unknown email — enumeration strip)
 *     404  (well-formed-unknown workId — NotFound rewritten to 'User not found')
 *     404  (MALFORMED workId — NO ParseUUIDPipe on this controller)
 *     403  (in-work viewer/editor member OR a real work by a non-member stranger)
 *     401  (no bearer — guard precedes everything, incl. a malformed workId)
 *   GET/PUT/DELETE /members/:memberId with a MALFORMED memberId → 404 (no pipe).
 *
 *   POST /api/works/:workId/invitations  { email?, role, expiresInDays?, metadata?, expectedProviderUsername? }
 *     201  member role (manager/editor/viewer) WITH email; owner-claim WITH username (email optional)
 *     400  role 'owner'/'creator'/'MANAGER'/bogus (IsIn ALL_INVITATION_ROLES, case-sensitive)
 *     400  member-role with no email ('email is required for member-role invitations')
 *     400  owner-claim with no expectedProviderUsername
 *     400  expiresInDays ∈ {0, 91, -3, 1.5, "5"};   201 for {1, 90}
 *     400  expectedProviderUsername '' (MinLength 1) / 129 chars (MaxLength 128);  201 for 1..128
 *     400  metadata non-object (string/array/number — IsObject)
 *     400  forbidNonWhitelisted extra property
 *     400  MALFORMED workId (ParseUUIDPipe) — the CONTRAST with /members' 404
 *     403  member-role by a viewer/editor member; owner-claim by a MANAGER (ensureIsOwner)
 *   GET /invitations (list) / DELETE (revoke): manager+ only → viewer/editor 403.
 *
 *   POST /api/claim/accept  { token }  (AuthSessionGuard)
 *     200 { invitationId, workId, role, transferStatus:'not_required' }  (member-role accept)
 *     400 invitation_already_accepted  (replay)
 *     400  token missing/empty/<32 chars (ClaimAcceptDto MinLength 32)
 *     404  well-formed 32+char but unknown token (invitation_not_found)
 *     401  no bearer
 *   GET /api/claim/preview?token=…  is @Public: unknown → 404, empty → 400.
 *
 * ── ISOLATION ───────────────────────────────────────────────────────────────
 * Every test registers FRESH users (never the shared seeded user) + a FRESH work.
 * Unique suffixes come from a per-test counter folded into the title — no module-
 * scope clock/await, no loadSeededTestUser. Fully API-contract driven (no UI nav,
 * no AI / mail / git-remote dependency — none of these paths is git-gated). List
 * assertions use toContain / not.toContain on row ids, never global counts. The
 * `flow-` filename prefix keeps it out of the no-auth testIgnore set.
 */

const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';
const MALFORMED_ID = 'not-a-uuid';

/** Per-test unique suffix source (no module-scope clock). */
let seq = 0;
function uniq(tag: string): string {
    seq += 1;
    return `${tag}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Invite (= synchronously add) an already-registered user; asserts + returns the row id. */
async function addMember(
    request: APIRequestContext,
    callerToken: string,
    workId: string,
    email: string,
    role: 'viewer' | 'editor' | 'manager',
): Promise<string> {
    const res = await request.post(`${API_BASE}/api/works/${workId}/members`, {
        headers: authedHeaders(callerToken),
        data: { email, role },
    });
    expect(res.status(), `add ${email} as ${role}`).toBe(201);
    const id = (await res.json())?.member?.id;
    expect(id, 'member row id present').toBeTruthy();
    return id as string;
}

/** POST an invitation; returns { status, body }. */
async function issue(
    request: APIRequestContext,
    token: string,
    workId: string,
    data: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
    const res = await request.post(`${API_BASE}/api/works/${workId}/invitations`, {
        headers: authedHeaders(token),
        data,
    });
    const body = await res.json().catch(() => ({}));
    return { status: res.status(), body };
}

/** Stringify a class-validator message (string | string[]) for regex matching. */
function msg(body: any): string {
    return JSON.stringify(body?.message ?? body ?? '');
}

// ════════════════════════════════════════════════════════════════════════════
// A. MEMBERS — POST invite: per-field validation matrix
// ════════════════════════════════════════════════════════════════════════════
test.describe('Work members — invite (POST) field validation matrix', () => {
    test('role field: owner/creator/case-variant/non-string all 400 with the assignable-enum message', async ({
        request,
    }) => {
        const tag = uniq('m-role');
        const owner = await registerUserViaAPI(request);
        const invitee = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, { name: tag });

        // 'owner' is a REAL WorkMemberRole but is excluded from ASSIGNABLE_MEMBER_ROLES.
        for (const role of ['owner', 'creator', 'Viewer', 'ADMIN', 'superuser'] as const) {
            const res = await request.post(`${API_BASE}/api/works/${work.id}/members`, {
                headers: authedHeaders(owner.access_token),
                data: { email: invitee.email, role },
            });
            expect(res.status(), `role '${role}' → 400`).toBe(400);
            expect(msg(await res.json()), `enum message for '${role}'`).toMatch(
                /viewer, editor, manager/i,
            );
        }

        // role as a non-string container is also rejected by IsIn.
        for (const role of [['viewer'], 123, true, null] as const) {
            const res = await request.post(`${API_BASE}/api/works/${work.id}/members`, {
                headers: authedHeaders(owner.access_token),
                data: { email: invitee.email, role },
            });
            expect(res.status(), `role ${JSON.stringify(role)} → 400`).toBe(400);
        }

        // None of the rejected calls minted a row.
        const roster = await request.get(`${API_BASE}/api/works/${work.id}/members`, {
            headers: authedHeaders(owner.access_token),
        });
        expect((await roster.json()).members.map((m: any) => m.userId)).not.toContain(
            invitee.user.id,
        );
    });

    test('email field: missing/empty/malformed/number/array all 400 before any user lookup', async ({
        request,
    }) => {
        const tag = uniq('m-email');
        const owner = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, { name: tag });

        const bad: Array<Record<string, unknown>> = [
            { role: 'viewer' }, // missing email
            { email: '', role: 'viewer' }, // empty
            { email: 'not-an-email', role: 'viewer' }, // malformed
            { email: 'missing-at-sign.example.com', role: 'viewer' }, // no @
            { email: 123, role: 'viewer' }, // number
            { email: ['a@b.co'], role: 'viewer' }, // array
        ];
        for (const data of bad) {
            const res = await request.post(`${API_BASE}/api/works/${work.id}/members`, {
                headers: authedHeaders(owner.access_token),
                data,
            });
            expect(res.status(), `email payload ${JSON.stringify(data)} → 400`).toBe(400);
        }
    });

    test('forbidNonWhitelisted: an unknown extra property is rejected 400 "should not exist"', async ({
        request,
    }) => {
        const tag = uniq('m-whitelist');
        const owner = await registerUserViaAPI(request);
        const invitee = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, { name: tag });

        const res = await request.post(`${API_BASE}/api/works/${work.id}/members`, {
            headers: authedHeaders(owner.access_token),
            data: { email: invitee.email, role: 'viewer', isAdmin: true, userId: invitee.user.id },
        });
        expect(res.status(), 'extra fields rejected').toBe(400);
        expect(msg(await res.json())).toMatch(/should not exist/i);

        // The whitelisted-clean version still works, proving only the extras were the problem.
        await addMember(request, owner.access_token, work.id, invitee.email, 'viewer');
    });

    test('empty body → 400 (both email and role are required)', async ({ request }) => {
        const tag = uniq('m-empty');
        const owner = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, { name: tag });

        const res = await request.post(`${API_BASE}/api/works/${work.id}/members`, {
            headers: authedHeaders(owner.access_token),
            data: {},
        });
        expect(res.status(), 'empty body → 400').toBe(400);
    });

    test('business rule: the work CREATOR cannot be added as a member (400), even by themselves', async ({
        request,
    }) => {
        const tag = uniq('m-creator');
        const owner = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, { name: tag });

        const res = await request.post(`${API_BASE}/api/works/${work.id}/members`, {
            headers: authedHeaders(owner.access_token),
            data: { email: owner.email, role: 'manager' },
        });
        expect(res.status(), 'creator-as-member → 400').toBe(400);
        expect(msg(await res.json())).toMatch(/creator/i);

        // The creator remains the sibling `owner`, never a members[] row.
        const roster = await request.get(`${API_BASE}/api/works/${work.id}/members`, {
            headers: authedHeaders(owner.access_token),
        });
        const body = await roster.json();
        expect(body.owner?.id).toBe(owner.user.id);
        expect(body.members.map((m: any) => m.userId)).not.toContain(owner.user.id);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// B. MEMBERS — authz tiers + the NO-ParseUUIDPipe posture
// ════════════════════════════════════════════════════════════════════════════
test.describe('Work members — POST authz tiers + uuid posture', () => {
    test('invite is manager+: a viewer member 403, an editor member 403, a manager member 201', async ({
        request,
    }) => {
        const tag = uniq('m-tier');
        const owner = await registerUserViaAPI(request);
        const viewer = await registerUserViaAPI(request);
        const editor = await registerUserViaAPI(request);
        const manager = await registerUserViaAPI(request);
        const target = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, { name: tag });

        await addMember(request, owner.access_token, work.id, viewer.email, 'viewer');
        await addMember(request, owner.access_token, work.id, editor.email, 'editor');
        await addMember(request, owner.access_token, work.id, manager.email, 'manager');

        // A viewer MEMBER lacks manage-members rights → 403 (the in-work tier denial,
        // distinct from the stranger denial below).
        const viewerRes = await request.post(`${API_BASE}/api/works/${work.id}/members`, {
            headers: authedHeaders(viewer.access_token),
            data: { email: target.email, role: 'viewer' },
        });
        expect(viewerRes.status(), 'viewer cannot invite').toBe(403);
        expect(msg(await viewerRes.json())).toMatch(/required permission level/i);

        // An editor MEMBER likewise cannot invite.
        const editorRes = await request.post(`${API_BASE}/api/works/${work.id}/members`, {
            headers: authedHeaders(editor.access_token),
            data: { email: target.email, role: 'viewer' },
        });
        expect(editorRes.status(), 'editor cannot invite').toBe(403);

        // A manager MEMBER CAN invite → 201.
        await addMember(request, manager.access_token, work.id, target.email, 'viewer');
    });

    test('POST posture: unknown-but-valid workId → 404; a real work by a non-member stranger → 403', async ({
        request,
    }) => {
        const tag = uniq('m-posture');
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const invitee = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, { name: tag });

        // Well-formed but non-existent work → 404 (the missing-work NotFound is caught
        // and rewritten to the generic 'User not found' by the enumeration-strip catch).
        const unknownWork = await request.post(`${API_BASE}/api/works/${UNKNOWN_UUID}/members`, {
            headers: authedHeaders(owner.access_token),
            data: { email: invitee.email, role: 'viewer' },
        });
        expect(unknownWork.status(), 'unknown work → 404').toBe(404);

        // A real work the caller is NOT a member of → 403 (work exists, access denied).
        const strangerRes = await request.post(`${API_BASE}/api/works/${work.id}/members`, {
            headers: authedHeaders(stranger.access_token),
            data: { email: invitee.email, role: 'viewer' },
        });
        expect(strangerRes.status(), 'stranger on real work → 403').toBe(403);
    });

    test('members controller has NO ParseUUIDPipe: malformed workId/memberId → 404 (not 400); no-auth still 401', async ({
        request,
    }) => {
        const tag = uniq('m-nopipe');
        const owner = await registerUserViaAPI(request);
        const invitee = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, { name: tag });
        await addMember(request, owner.access_token, work.id, invitee.email, 'viewer');

        // Malformed workId on POST + GET-list → 404 (routed through the service, which
        // returns not-found; there is no ParseUUIDPipe to short-circuit with a 400).
        const postMalformed = await request.post(`${API_BASE}/api/works/${MALFORMED_ID}/members`, {
            headers: authedHeaders(owner.access_token),
            data: { email: invitee.email, role: 'viewer' },
        });
        expect(postMalformed.status(), 'malformed workId POST → 404').toBe(404);

        const listMalformed = await request.get(`${API_BASE}/api/works/${MALFORMED_ID}/members`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(listMalformed.status(), 'malformed workId list → 404').toBe(404);

        // Malformed memberId on GET/PUT/DELETE (real work, owner authorized) → 404 'Member not found'.
        const getMember = await request.get(
            `${API_BASE}/api/works/${work.id}/members/${MALFORMED_ID}`,
            { headers: authedHeaders(owner.access_token) },
        );
        expect(getMember.status(), 'malformed memberId GET → 404').toBe(404);
        expect(msg(await getMember.json())).toMatch(/member not found/i);

        const putMember = await request.put(
            `${API_BASE}/api/works/${work.id}/members/${MALFORMED_ID}`,
            { headers: authedHeaders(owner.access_token), data: { role: 'viewer' } },
        );
        expect(putMember.status(), 'malformed memberId PUT → 404').toBe(404);

        const delMember = await request.delete(
            `${API_BASE}/api/works/${work.id}/members/${MALFORMED_ID}`,
            { headers: authedHeaders(owner.access_token) },
        );
        expect(delMember.status(), 'malformed memberId DELETE → 404').toBe(404);

        // No auth beats the malformed-uuid path entirely (guard runs first) → 401.
        const noAuth = await request.get(`${API_BASE}/api/works/${MALFORMED_ID}/members`);
        expect(noAuth.status(), 'no-auth (even malformed) → 401').toBe(401);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// C. INVITATIONS — POST create: per-field validation matrix
// ════════════════════════════════════════════════════════════════════════════
test.describe('Work invitations — create (POST) field validation matrix', () => {
    test('role enum: owner/creator/case-variant/bogus 400; the 3 member roles + owner-claim accepted', async ({
        request,
    }) => {
        const tag = uniq('i-role');
        const owner = await registerUserViaAPI(request);
        const invitee = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, { name: tag });

        // 'owner' is NOT in ALL_INVITATION_ROLES; IsIn is case-sensitive.
        for (const role of ['owner', 'creator', 'MANAGER', 'Owner-Claim', 'admin'] as const) {
            const { status } = await issue(request, owner.access_token, work.id, {
                email: invitee.email,
                role,
            });
            expect(status, `invitation role '${role}' → 400`).toBe(400);
        }

        // The three assignable member roles all mint a pending invite.
        for (const role of ['manager', 'editor', 'viewer'] as const) {
            const { status, body } = await issue(request, owner.access_token, work.id, {
                email: invitee.email,
                role,
            });
            expect(status, `invitation role '${role}' → 201`).toBe(201);
            expect(body.role, 'role baked verbatim').toBe(role);
        }

        // owner-claim (with the required username) also mints.
        const oc = await issue(request, owner.access_token, work.id, {
            role: 'owner-claim',
            expectedProviderUsername: 'avelino',
        });
        expect(oc.status, 'owner-claim → 201').toBe(201);
        expect(oc.body.role).toBe('owner-claim');
    });

    test('email requirement diverges by role: member-role NEEDS email (400), owner-claim allows none (201)', async ({
        request,
    }) => {
        const tag = uniq('i-emailreq');
        const owner = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, { name: tag });

        // Member-role with no email → 400 (controller-level, after the ownership gate).
        const noEmail = await issue(request, owner.access_token, work.id, { role: 'editor' });
        expect(noEmail.status, 'member-role no email → 400').toBe(400);
        expect(msg(noEmail.body)).toMatch(/email is required/i);

        // owner-claim with no email but a username → 201 (email is optional here).
        const ownerClaim = await issue(request, owner.access_token, work.id, {
            role: 'owner-claim',
            expectedProviderUsername: 'octocat',
        });
        expect(ownerClaim.status, 'owner-claim without email → 201').toBe(201);
        expect(ownerClaim.body.email, 'owner-claim persists null email').toBeNull();

        // A malformed email (when provided) is still IsEmail-rejected.
        const badEmail = await issue(request, owner.access_token, work.id, {
            role: 'viewer',
            email: 'nope',
        });
        expect(badEmail.status, 'member-role bad email → 400').toBe(400);
    });

    test('expiresInDays boundary matrix: 1 and 90 accepted; 0, 91, -3, 1.5, "5" rejected 400', async ({
        request,
    }) => {
        const tag = uniq('i-expiry');
        const owner = await registerUserViaAPI(request);
        const invitee = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, { name: tag });

        for (const days of [1, 90]) {
            const { status, body } = await issue(request, owner.access_token, work.id, {
                email: invitee.email,
                role: 'viewer',
                expiresInDays: days,
            });
            expect(status, `expiresInDays ${days} → 201`).toBe(201);
            // The window is genuinely in the future (default/clamped correctly).
            expect(new Date(body.tokenExpiresAt).getTime()).toBeGreaterThan(Date.now());
        }

        for (const days of [0, 91, -3, 1.5]) {
            const { status } = await issue(request, owner.access_token, work.id, {
                email: invitee.email,
                role: 'viewer',
                expiresInDays: days,
            });
            expect(status, `expiresInDays ${days} → 400`).toBe(400);
        }

        // A string is rejected by @IsInt (transform does not coerce here).
        const asString = await issue(request, owner.access_token, work.id, {
            email: invitee.email,
            role: 'viewer',
            expiresInDays: '5',
        });
        expect(asString.status, 'expiresInDays "5" → 400').toBe(400);
    });

    test('expectedProviderUsername length matrix (owner-claim): empty & 129 chars 400; 1 & 128 chars 201', async ({
        request,
    }) => {
        const tag = uniq('i-username');
        const owner = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, { name: tag });

        // Empty string fails @MinLength(1); 129 chars fails @MaxLength(128).
        const empty = await issue(request, owner.access_token, work.id, {
            role: 'owner-claim',
            expectedProviderUsername: '',
        });
        expect(empty.status, "username '' → 400").toBe(400);

        const tooLong = await issue(request, owner.access_token, work.id, {
            role: 'owner-claim',
            expectedProviderUsername: 'a'.repeat(129),
        });
        expect(tooLong.status, 'username 129 chars → 400').toBe(400);

        // Boundary-valid lengths mint.
        const one = await issue(request, owner.access_token, work.id, {
            role: 'owner-claim',
            expectedProviderUsername: 'a',
        });
        expect(one.status, 'username 1 char → 201').toBe(201);

        const max = await issue(request, owner.access_token, work.id, {
            role: 'owner-claim',
            expectedProviderUsername: 'a'.repeat(128),
        });
        expect(max.status, 'username 128 chars → 201').toBe(201);
    });

    test('owner-claim requires expectedProviderUsername: absent 400; supplied top-level OR via metadata 201', async ({
        request,
    }) => {
        const tag = uniq('i-ocreq');
        const owner = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, { name: tag });

        // Absent entirely → 400.
        const absent = await issue(request, owner.access_token, work.id, { role: 'owner-claim' });
        expect(absent.status, 'owner-claim no username → 400').toBe(400);

        // Supplied at the top level → 201.
        const topLevel = await issue(request, owner.access_token, work.id, {
            role: 'owner-claim',
            expectedProviderUsername: 'avelino',
        });
        expect(topLevel.status, 'top-level username → 201').toBe(201);

        // Supplied via metadata.expectedProviderUsername (the dual-source resolution) → 201.
        const viaMeta = await issue(request, owner.access_token, work.id, {
            role: 'owner-claim',
            metadata: { expectedProviderUsername: 'octocat' },
        });
        expect(viaMeta.status, 'metadata-sourced username → 201').toBe(201);
        expect(viaMeta.body.metadata?.expectedProviderUsername).toBe('octocat');
    });

    test('metadata must be an object: string/array/number 400; a small object is echoed back verbatim', async ({
        request,
    }) => {
        const tag = uniq('i-meta');
        const owner = await registerUserViaAPI(request);
        const invitee = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, { name: tag });

        for (const metadata of ['notobject', [1, 2, 3], 42] as const) {
            const { status } = await issue(request, owner.access_token, work.id, {
                email: invitee.email,
                role: 'viewer',
                metadata,
            });
            expect(status, `metadata ${JSON.stringify(metadata)} → 400 (IsObject)`).toBe(400);
        }

        // A small well-formed object round-trips.
        const ok = await issue(request, owner.access_token, work.id, {
            email: invitee.email,
            role: 'viewer',
            metadata: { note: 'welcome', ref: tag },
        });
        expect(ok.status, 'object metadata → 201').toBe(201);
        expect(ok.body.metadata?.note).toBe('welcome');
        expect(ok.body.metadata?.ref).toBe(tag);
    });

    test('forbidNonWhitelisted: an unknown extra property on the invitation body → 400', async ({
        request,
    }) => {
        const tag = uniq('i-whitelist');
        const owner = await registerUserViaAPI(request);
        const invitee = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, { name: tag });

        const { status, body } = await issue(request, owner.access_token, work.id, {
            email: invitee.email,
            role: 'viewer',
            grantAdmin: true,
            workId: work.id,
        });
        expect(status, 'extra invitation fields → 400').toBe(400);
        expect(msg(body)).toMatch(/should not exist/i);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// D. INVITATIONS — two-tier authz + the HAS-ParseUUIDPipe posture (contrast)
// ════════════════════════════════════════════════════════════════════════════
test.describe('Work invitations — RBAC tiers + uuid posture', () => {
    test('two-tier authz: a MANAGER may issue member-role (201) but NOT owner-claim (403); the OWNER may issue both', async ({
        request,
    }) => {
        const tag = uniq('i-tier');
        const owner = await registerUserViaAPI(request);
        const manager = await registerUserViaAPI(request);
        const invitee = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, { name: tag });
        await addMember(request, owner.access_token, work.id, manager.email, 'manager');

        // Manager can issue a member-role invitation (ensureCanManageMembers passes).
        const mgrMember = await issue(request, manager.access_token, work.id, {
            email: invitee.email,
            role: 'editor',
        });
        expect(mgrMember.status, 'manager issues member-role → 201').toBe(201);

        // But owner-claim demands OWNER (ensureIsOwner) → a manager is forbidden.
        const mgrOwnerClaim = await issue(request, manager.access_token, work.id, {
            role: 'owner-claim',
            expectedProviderUsername: 'avelino',
        });
        expect(mgrOwnerClaim.status, 'manager issues owner-claim → 403').toBe(403);

        // The owner may issue BOTH kinds.
        const ownerMember = await issue(request, owner.access_token, work.id, {
            email: invitee.email,
            role: 'viewer',
        });
        expect(ownerMember.status, 'owner issues member-role → 201').toBe(201);
        const ownerClaim = await issue(request, owner.access_token, work.id, {
            role: 'owner-claim',
            expectedProviderUsername: 'avelino',
        });
        expect(ownerClaim.status, 'owner issues owner-claim → 201').toBe(201);
    });

    test('list + revoke are manager+: a viewer 403, an editor 403; a manager may list', async ({
        request,
    }) => {
        const tag = uniq('i-listtier');
        const owner = await registerUserViaAPI(request);
        const viewer = await registerUserViaAPI(request);
        const editor = await registerUserViaAPI(request);
        const manager = await registerUserViaAPI(request);
        const invitee = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, { name: tag });
        await addMember(request, owner.access_token, work.id, viewer.email, 'viewer');
        await addMember(request, owner.access_token, work.id, editor.email, 'editor');
        await addMember(request, owner.access_token, work.id, manager.email, 'manager');

        const created = await issue(request, owner.access_token, work.id, {
            email: invitee.email,
            role: 'viewer',
        });
        expect(created.status).toBe(201);
        const invitationId = created.body.id as string;

        // Viewer + editor cannot list the pending invitations.
        for (const u of [viewer, editor]) {
            const res = await request.get(`${API_BASE}/api/works/${work.id}/invitations`, {
                headers: authedHeaders(u.access_token),
            });
            expect(res.status(), 'non-manager list → 403').toBe(403);
        }

        // A viewer also cannot revoke.
        const viewerRevoke = await request.delete(
            `${API_BASE}/api/works/${work.id}/invitations/${invitationId}`,
            { headers: authedHeaders(viewer.access_token) },
        );
        expect(viewerRevoke.status(), 'viewer revoke → 403').toBe(403);

        // A manager CAN list, and the pending invite is present (no claimUrl leaked in list).
        const mgrList = await request.get(`${API_BASE}/api/works/${work.id}/invitations`, {
            headers: authedHeaders(manager.access_token),
        });
        expect(mgrList.status(), 'manager list → 200').toBe(200);
        const listBody = await mgrList.json();
        const ids = listBody.invitations.map((i: any) => i.id);
        expect(ids, 'pending invite visible to a manager').toContain(invitationId);
        expect(listBody.invitations.every((i: any) => i.claimUrl === undefined)).toBe(true);
    });

    test('invitations controller HAS ParseUUIDPipe: malformed workId → 400 on create + list (contrast with members 404)', async ({
        request,
    }) => {
        const tag = uniq('i-pipe');
        const owner = await registerUserViaAPI(request);
        const invitee = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, { name: tag });

        // Malformed workId is short-circuited by ParseUUIDPipe → 400 (NOT the 404 the
        // pipe-less members controller returns for the same malformed value).
        const createMalformed = await request.post(
            `${API_BASE}/api/works/${MALFORMED_ID}/invitations`,
            {
                headers: authedHeaders(owner.access_token),
                data: { email: invitee.email, role: 'viewer' },
            },
        );
        expect(createMalformed.status(), 'malformed workId create → 400').toBe(400);

        const listMalformed = await request.get(
            `${API_BASE}/api/works/${MALFORMED_ID}/invitations`,
            { headers: authedHeaders(owner.access_token) },
        );
        expect(listMalformed.status(), 'malformed workId list → 400').toBe(400);

        // Direct proof of divergence: the SAME malformed workId on /members is 404.
        const membersMalformed = await request.get(
            `${API_BASE}/api/works/${MALFORMED_ID}/members`,
            {
                headers: authedHeaders(owner.access_token),
            },
        );
        expect(membersMalformed.status(), 'members side of the same malformed workId → 404').toBe(
            404,
        );

        // No auth still beats the pipe (guard first) → 401 even with a malformed workId.
        const noAuth = await request.post(`${API_BASE}/api/works/${MALFORMED_ID}/invitations`, {
            data: { email: invitee.email, role: 'viewer' },
        });
        expect(noAuth.status(), 'no-auth invitation create → 401').toBe(401);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// E. CLAIM accept — DTO boundary + public/guarded split + single-use round-trip
// ════════════════════════════════════════════════════════════════════════════
test.describe('Claim accept — token DTO validation + single-use', () => {
    test('ClaimAcceptDto MinLength(32) boundary: missing/empty/31-char 400; 32-char-unknown 404; no-auth 401', async ({
        request,
    }) => {
        const claimant = await registerUserViaAPI(request);
        const h = authedHeaders(claimant.access_token);

        // Missing / empty / below the 32-char floor are DTO-rejected (400) before any lookup.
        for (const data of [{}, { token: '' }, { token: 'a'.repeat(31) }, { token: 42 }]) {
            const res = await request.post(`${API_BASE}/api/claim/accept`, { headers: h, data });
            expect(res.status(), `accept ${JSON.stringify(data)} → 400`).toBe(400);
        }

        // A 32-char (DTO-valid) but unknown token passes validation and misses the lookup → 404.
        const unknown = await request.post(`${API_BASE}/api/claim/accept`, {
            headers: h,
            data: { token: '0'.repeat(32) },
        });
        expect(unknown.status(), '32-char unknown token → 404').toBe(404);
        expect(msg(await unknown.json())).toMatch(/not_found|not found/i);

        // The accept surface is guarded — no bearer → 401.
        const noAuth = await request.post(`${API_BASE}/api/claim/accept`, {
            data: { token: '0'.repeat(64) },
        });
        expect(noAuth.status(), 'accept no-auth → 401').toBe(401);
    });

    test('/preview is public but /accept is guarded: preview unknown 404 / empty 400 without auth', async ({
        request,
    }) => {
        // Preview needs no bearer (it is @Public); an unknown 32-char token → 404.
        const previewUnknown = await request.get(
            `${API_BASE}/api/claim/preview?token=${'0'.repeat(32)}`,
        );
        expect(previewUnknown.status(), 'public preview unknown → 404').toBe(404);

        // An empty token still validates at the service layer → 400 invalid_token.
        const previewEmpty = await request.get(`${API_BASE}/api/claim/preview?token=`);
        expect(previewEmpty.status(), 'public preview empty → 400').toBe(400);

        // The very same anonymous request against /accept is 401 (guarded), proving the split.
        const acceptAnon = await request.post(`${API_BASE}/api/claim/accept`, {
            data: { token: '0'.repeat(64) },
        });
        expect(acceptAnon.status(), 'accept anon → 401').toBe(401);
    });

    test('single-use round-trip: a real token accepts once (200 shape) then replays as 400, minting exactly one member', async ({
        request,
    }) => {
        const tag = uniq('accept-roundtrip');
        const owner = await registerUserViaAPI(request);
        const claimant = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, { name: tag });

        const created = await issue(request, owner.access_token, work.id, {
            email: claimant.email,
            role: 'editor',
        });
        expect(created.status, 'invite issued').toBe(201);
        const token = String(created.body.claimUrl).split('/claim/')[1];
        expect(token, 'raw token present in claimUrl').toBeTruthy();
        expect(token.length, 'token is 64 hex chars (32 bytes)').toBe(64);

        // First accept → 200 with the exact ClaimAcceptResponseDto shape.
        const first = await request.post(`${API_BASE}/api/claim/accept`, {
            headers: authedHeaders(claimant.access_token),
            data: { token },
        });
        expect(first.status(), 'first accept → 200').toBe(200);
        const firstBody = await first.json();
        expect(firstBody.invitationId).toBe(created.body.id);
        expect(firstBody.workId).toBe(work.id);
        expect(firstBody.role, 'baked role honored on accept').toBe('editor');
        expect(firstBody.transferStatus, 'member-role accept is not a transfer').toBe(
            'not_required',
        );

        // Replay of the now-consumed token → 400 invitation_already_accepted.
        const replay = await request.post(`${API_BASE}/api/claim/accept`, {
            headers: authedHeaders(claimant.access_token),
            data: { token },
        });
        expect(replay.status(), 'replay → 400').toBe(400);
        expect(msg(await replay.json())).toMatch(/already_accepted|already accepted/i);

        // Exactly one editor membership resulted for the claimant.
        const roster = await request.get(`${API_BASE}/api/works/${work.id}/members`, {
            headers: authedHeaders(owner.access_token),
        });
        const rows = (await roster.json()).members.filter(
            (m: any) => m.userId === claimant.user.id,
        );
        expect(rows.length, 'exactly one membership minted').toBe(1);
        expect(rows[0].role).toBe('editor');
    });
});
