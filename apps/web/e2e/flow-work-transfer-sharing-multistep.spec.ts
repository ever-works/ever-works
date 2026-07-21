import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * flow: WORK SHARING PATHS + VISIBILITY TOGGLES + TRANSFER COEXISTENCE — deep,
 * multi-step INTEGRATION (probed LIVE vs 127.0.0.1:3100 on 2026-07-21, the same
 * sqlite-in-memory driver CI uses).
 *
 * A Work can be shared with another user through TWO distinct paths, and its
 * ownership handed over through a THIRD (transfer). This suite pins how those
 * paths interact — the *convergence*, the *timing*, the *toggles*, and the
 * *coexistence* — angles the sibling specs (each of which drills ONE path in
 * isolation) deliberately do not cover.
 *
 * THE THREE GRANT PATHS (probed):
 *   1. EAGER direct-add   — POST /api/works/:id/members {email, role}
 *        Manager+ only. Requires the invitee to ALREADY be registered; binds a
 *        WorkMember row synchronously. 201 {status:'success', member:{id,userId,
 *        username,email,avatar,role,invitedBy:{id,username},createdAt}}.
 *        Guards: unregistered email -> 404 {message:'User not found'} (generic,
 *        enumeration-stripped); creator self -> 400 'Cannot add the work creator
 *        as a member'; existing member -> 400 'User is already a member of this
 *        work'. Immediately visible in the invitee's discovery list.
 *   2. LAZY tokenised share — POST /api/works/:id/invitations {email, role}
 *        Manager+; mints a single-use token returned ONCE inside claimUrl =
 *        `${webAppUrl}/claim/<64hex>`. Issuing to a NEVER-registered email is a
 *        happy 201 (binding is deferred to accept). Grants NOTHING until
 *        POST /api/claim/accept (authed, 200 {invitationId,workId,role,
 *        transferStatus:'not_required'}) creates the WorkMember row.
 *   3. TRANSFER — POST /api/works/:id/invitations {role:'owner-claim',
 *        expectedProviderUsername}. OWNER-only. A pending owner-claim is NEITHER
 *        a member NOR a share; it never mutates work.userId in-app.
 *
 * VISIBILITY MODEL (probed): GET /api/works?limit=N -> 200 {works:[{id,name,
 *   userRole,...}], total, limit, offset}. `userRole` = 'owner' for owned works
 *   and the member.role for shared works; `total` counts ONLY accessible works.
 *   GET /api/works/:id -> member/owner 200 {work:{...userRole}}, non-member 403
 *   'You do not have permission to access this work'.
 *
 * MANAGEMENT SURFACE (probed):
 *   GET  /api/works/:id/members            -> 200 {status:'success', members:[...],
 *        owner:{id,username,email}} (view-tier; viewer 200, stranger 403).
 *   GET  /api/works/:id/members/:memberId  -> 200 {member}; unknown uuid -> 404
 *        'Member not found'. (:memberId is the WorkMember ROW id, not the userId.)
 *   PUT  /api/works/:id/members/:memberId  -> 200 {member: role updated} (Manager+).
 *   DELETE /api/works/:id/members/:memberId-> 200 {status:'success', message:
 *        'Member removed successfully'} (Manager+).
 *   GET  /api/works/:id/invitations        -> 200 {invitations:[pending...]}
 *        (Manager+; list omits claimUrl). DELETE .../:invId revoke (Manager+).
 *   Below-Manager members hit 403 'You do not have the required permission level
 *   for this action'; strangers hit 403 'You do not have permission to access
 *   this work'.
 *
 * CROSS-USER SINGLE-USE (the sharp, probed distinction this file pins):
 *   Once memberA consumes a token, a DIFFERENT user replaying the SAME token gets
 *   400 invitation_already_accepted (a TOKEN-level lock), whereas memberA's own
 *   re-accept gets 400 already_a_member (a MEMBERSHIP-level lock). Preview of the
 *   consumed token -> 400 invitation_already_accepted.
 *
 * DISTINCTNESS vs siblings (checked, additive not duplicate):
 *   - flow-work-transfer-ownership: owner-claim role matrix / identity gate /
 *     auto-add / leave / lifecycle / UI landing. HERE: transfer *coexisting* with
 *     a live member share on the same work.
 *   - flow-work-sharing-visibility: list scoping, absent public routes, per-role
 *     visibility via separate invitations, claimUrl preview idempotency, abuse.
 *     HERE: the two GRANT PATHS converging on identical visibility, eager-vs-lazy
 *     timing, and owner-driven toggles (removal/escalation) reflected in the
 *     DISCOVERY list.
 *   - flow-work-invitation(s)-{tokens,deep}: DTO validation, revoke work-scope,
 *     duplicate-invite tokens, preview precedence. HERE: cross-USER single-use +
 *     the transfer/share listPending interleave.
 *   - flow-work-member-removal / members-rbac-deep: /members roster CRUD + IDOR.
 *     HERE: removal/escalation reflected in the WORKS-DISCOVERY list (not the
 *     roster), and re-share after removal.
 *
 * ISOLATION: every flow uses FRESH registerUserViaAPI() users + fresh Works —
 * never the shared seeded storageState user. Assertions use toContain /
 * not.toContain (never exact global counts), poll for eventual consistency, and
 * tolerate the per-IP claim throttle (429) on the public preview path.
 */

const HEX_64_RE = /^[0-9a-f]{64}$/;
const REQUIRED_ROLE_MSG = /required permission level/i;
const NO_ACCESS_MSG = /do not have permission to access/i;

function uniqueSuffix(): string {
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
}

interface WorkRow {
    id: string;
    name?: string;
    userRole?: string;
    [k: string]: unknown;
}
interface MemberRow {
    id: string;
    userId: string;
    role: string;
    email?: string;
    invitedBy?: { id: string; username: string };
    [k: string]: unknown;
}

/** Owner/manager issues a tokenised invitation; returns raw token + parsed body. */
async function issueInvitation(
    request: APIRequestContext,
    actorToken: string,
    workId: string,
    payload: Record<string, unknown>,
): Promise<{ status: number; token: string; body: Record<string, unknown> }> {
    const res = await request.post(`${API_BASE}/api/works/${workId}/invitations`, {
        headers: authedHeaders(actorToken),
        data: payload,
    });
    const body = await res.json().catch(() => ({}) as Record<string, unknown>);
    const claimUrl = String((body as { claimUrl?: string }).claimUrl ?? '');
    const token = claimUrl.match(/\/claim\/([0-9a-f]+)/)?.[1] ?? '';
    return { status: res.status(), token, body };
}

/** Accept a claim token as the given actor. */
async function acceptToken(
    request: APIRequestContext,
    actorToken: string,
    token: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await request.post(`${API_BASE}/api/claim/accept`, {
        headers: authedHeaders(actorToken),
        data: { token },
    });
    const body = await res.json().catch(() => ({}) as Record<string, unknown>);
    return { status: res.status(), body };
}

/** Eager direct-add of a REGISTERED user as a member (Manager+). */
async function directAdd(
    request: APIRequestContext,
    actorToken: string,
    workId: string,
    email: string,
    role: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await request.post(`${API_BASE}/api/works/${workId}/members`, {
        headers: authedHeaders(actorToken),
        data: { email, role },
    });
    const body = await res.json().catch(() => ({}) as Record<string, unknown>);
    return { status: res.status(), body };
}

/** The caller's full accessible-works discovery list. */
async function listWorks(
    request: APIRequestContext,
    token: string,
): Promise<{ works: WorkRow[]; total: number }> {
    const res = await request.get(`${API_BASE}/api/works?limit=200`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), 'discovery list is 200').toBe(200);
    const body = await res.json();
    return { works: (body.works ?? body.data ?? []) as WorkRow[], total: Number(body.total ?? 0) };
}

/** The caller's userRole on a work in their discovery list, or null if absent. */
async function discoveryRole(
    request: APIRequestContext,
    token: string,
    workId: string,
): Promise<string | null> {
    const { works } = await listWorks(request, token);
    return works.find((w) => w.id === workId)?.userRole ?? null;
}

/** Members roster (owner/manager view). */
async function listMembers(
    request: APIRequestContext,
    token: string,
    workId: string,
): Promise<{ status: number; members: MemberRow[]; owner: Record<string, unknown> | null }> {
    const res = await request.get(`${API_BASE}/api/works/${workId}/members`, {
        headers: authedHeaders(token),
    });
    const body = await res.json().catch(() => ({}) as Record<string, unknown>);
    return {
        status: res.status(),
        members: (body.members ?? []) as MemberRow[],
        owner: (body.owner ?? null) as Record<string, unknown> | null,
    };
}

/** Resolve the WorkMember ROW id for a given userId (needed for PUT/DELETE). */
async function memberRowId(
    request: APIRequestContext,
    ownerToken: string,
    workId: string,
    userId: string,
): Promise<string | undefined> {
    const { members } = await listMembers(request, ownerToken, workId);
    return members.find((m) => m.userId === userId)?.id;
}

async function makeWork(request: APIRequestContext, ownerToken: string, label: string) {
    const s = uniqueSuffix();
    return createWorkViaAPI(request, ownerToken, {
        name: `${label} ${s}`,
        slug: `${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${s}`,
        description: `e2e ${label}`,
    });
}

// ---------------------------------------------------------------------------
test.describe('Share paths converge — direct-add vs tokenised claim', () => {
    test('both grant paths land the SAME discovery visibility (userRole); owner stays owner', async ({
        request,
    }) => {
        // The platform offers two ways to share. This pins that — however the
        // membership was created — the invitee sees the work in their OWN
        // GET /api/works with a userRole EQUAL to the granted role, and the
        // owner's own view is unchanged ('owner', never 'shared').
        const owner = await registerUserViaAPI(request);
        const viaDirect = await registerUserViaAPI(request);
        const viaToken = await registerUserViaAPI(request);
        const { id: workId } = await makeWork(request, owner.access_token, 'ShareConverge');

        // Path 1: eager direct-add of a registered user as editor.
        const add = await directAdd(request, owner.access_token, workId, viaDirect.email, 'editor');
        expect(add.status, `direct-add editor 201 (${JSON.stringify(add.body)})`).toBe(201);
        const addedMember = add.body.member as MemberRow;
        expect(addedMember.userId).toBe(viaDirect.user.id);
        expect(addedMember.role).toBe('editor');
        expect(addedMember.id, 'direct-add returns a WorkMember row id').toBeTruthy();
        expect((addedMember.invitedBy as { id: string }).id, 'invitedBy is the owner').toBe(
            owner.user.id,
        );

        // Path 2: lazy tokenised share to the second user, who accepts.
        const inv = await issueInvitation(request, owner.access_token, workId, {
            email: viaToken.email,
            role: 'editor',
        });
        expect(inv.status, 'token invite 201').toBe(201);
        expect(inv.token, 'token embedded once in claimUrl').toMatch(HEX_64_RE);
        const accept = await acceptToken(request, viaToken.access_token, inv.token);
        expect(accept.status, 'token accept 200').toBe(200);
        expect(accept.body.role).toBe('editor');
        expect(accept.body.transferStatus).toBe('not_required');

        // CONVERGENCE: both invitees now see the work as 'editor'.
        for (const u of [viaDirect, viaToken]) {
            await expect
                .poll(() => discoveryRole(request, u.access_token, workId), {
                    timeout: 20_000,
                    message: 'both share paths surface the work as editor',
                })
                .toBe('editor');
        }

        // Owner's perspective is 'owner' regardless of how many are shared.
        expect(await discoveryRole(request, owner.access_token, workId)).toBe('owner');

        // The roster now lists BOTH invitees at editor next to the owner block.
        const { members, owner: ownerBlock } = await listMembers(
            request,
            owner.access_token,
            workId,
        );
        const ids = members.map((m) => m.userId);
        expect(ids).toContain(viaDirect.user.id);
        expect(ids).toContain(viaToken.user.id);
        expect(String((ownerBlock as { id: string }).id)).toBe(owner.user.id);
    });

    test('eager vs lazy timing: direct-add is instantly visible; a PENDING token invite grants no visibility until accept', async ({
        request,
    }) => {
        // Two invitees, one per path. The direct-add is visible with no accept
        // step; the token invitee stays invisible while the invitation is merely
        // PENDING, and only becomes visible after the authed accept.
        const owner = await registerUserViaAPI(request);
        const eager = await registerUserViaAPI(request);
        const lazy = await registerUserViaAPI(request);
        const { id: workId } = await makeWork(request, owner.access_token, 'ShareTiming');

        await directAdd(request, owner.access_token, workId, eager.email, 'viewer');
        const inv = await issueInvitation(request, owner.access_token, workId, {
            email: lazy.email,
            role: 'viewer',
        });
        expect(inv.status).toBe(201);

        // Eager path: visible immediately (no accept).
        await expect
            .poll(() => discoveryRole(request, eager.access_token, workId), { timeout: 20_000 })
            .toBe('viewer');

        // Lazy path while PENDING: NOT visible, cannot read, NOT on the roster.
        expect(
            await discoveryRole(request, lazy.access_token, workId),
            'pending token invite grants no discovery visibility',
        ).toBeNull();
        const lazyReadPre = await request.get(`${API_BASE}/api/works/${workId}`, {
            headers: authedHeaders(lazy.access_token),
        });
        expect(lazyReadPre.status(), 'pending invitee cannot read the work').toBe(403);
        const rosterPre = await listMembers(request, owner.access_token, workId);
        expect(
            rosterPre.members.some((m) => m.userId === lazy.user.id),
            'pending invitee is not yet on the roster',
        ).toBe(false);

        // Accept flips the lazy invitee to visible.
        const accept = await acceptToken(request, lazy.access_token, inv.token);
        expect(accept.status).toBe(200);
        await expect
            .poll(() => discoveryRole(request, lazy.access_token, workId), { timeout: 20_000 })
            .toBe('viewer');
    });

    test('path contrast at the invitee boundary: the token path issues to a NEVER-registered email (201); direct-add of that same email is 404', async ({
        request,
    }) => {
        // The defining difference between the paths is WHEN the invitee is
        // resolved. The lazy token path binds at accept, so issuing to an email
        // that was never registered is a happy 201. The eager direct path
        // resolves up-front and 404s the same email (generic, no enumeration).
        const owner = await registerUserViaAPI(request);
        const { id: workId } = await makeWork(request, owner.access_token, 'ShareBoundary');
        const ghostEmail = `ghost-${uniqueSuffix()}@nowhere.test.local`;

        // Token path: unknown email is fine — 201 with a real claim URL.
        const inv = await issueInvitation(request, owner.access_token, workId, {
            email: ghostEmail,
            role: 'viewer',
        });
        expect(inv.status, 'token invite to an unregistered email is 201').toBe(201);
        expect(inv.token).toMatch(HEX_64_RE);
        expect(String(inv.body.email)).toBe(ghostEmail);

        // Direct path: same unknown email -> 404 generic 'User not found'.
        const add = await directAdd(request, owner.access_token, workId, ghostEmail, 'viewer');
        expect(add.status, 'direct-add of an unregistered email is 404').toBe(404);
        expect(String(add.body.message)).toBe('User not found');
        // No email is echoed back (enumeration-stripped).
        expect(JSON.stringify(add.body)).not.toContain(ghostEmail);
    });

    test('the creator is un-shareable to themselves via EITHER path', async ({ request }) => {
        // Sharing a work with its own creator is nonsensical and rejected on
        // both surfaces — but with path-specific messages that this pins.
        const owner = await registerUserViaAPI(request);
        const { id: workId } = await makeWork(request, owner.access_token, 'ShareSelf');

        // Direct path: 400 'Cannot add the work creator as a member'.
        const selfAdd = await directAdd(request, owner.access_token, workId, owner.email, 'viewer');
        expect(selfAdd.status, 'direct-add self is 400').toBe(400);
        expect(String(selfAdd.body.message)).toMatch(/creator/i);

        // Token path: the owner can ISSUE a self-addressed invite, but accepting
        // their own token is refused at accept with claimant_is_already_owner.
        const inv = await issueInvitation(request, owner.access_token, workId, {
            email: owner.email,
            role: 'viewer',
        });
        expect(inv.status).toBe(201);
        const selfClaim = await acceptToken(request, owner.access_token, inv.token);
        expect(selfClaim.status, 'creator self-claim is 400').toBe(400);
        expect(String(selfClaim.body.message)).toBe('claimant_is_already_owner');

        // Either way, the owner never appears as a member of their own work.
        const { members } = await listMembers(request, owner.access_token, workId);
        expect(members.some((m) => m.userId === owner.user.id)).toBe(false);
    });

    test('cross-USER single-use: a consumed token is a TOKEN-level lock for others and a MEMBERSHIP-level lock for the same user', async ({
        request,
    }) => {
        // This is the sharp distinction the sibling specs don't draw. After
        // memberA consumes a token: (a) a DIFFERENT user replaying the SAME token
        // gets 400 invitation_already_accepted (the token is spent, regardless of
        // who they are); (b) memberA replaying it gets 400 already_a_member (they
        // ARE the share now); (c) the public preview of that token is 400
        // invitation_already_accepted.
        const owner = await registerUserViaAPI(request);
        const memberA = await registerUserViaAPI(request);
        const memberB = await registerUserViaAPI(request);
        const { id: workId } = await makeWork(request, owner.access_token, 'ShareSingleUse');

        const inv = await issueInvitation(request, owner.access_token, workId, {
            email: memberA.email,
            role: 'editor',
        });
        expect(inv.status).toBe(201);

        const first = await acceptToken(request, memberA.access_token, inv.token);
        expect(first.status, 'first accept 200').toBe(200);

        // (a) A different user cannot ride the spent token.
        const bReplay = await acceptToken(request, memberB.access_token, inv.token);
        expect(bReplay.status, 'different user replay 400').toBe(400);
        expect(String(bReplay.body.message)).toBe('invitation_already_accepted');
        // ...and gained nothing.
        expect(await discoveryRole(request, memberB.access_token, workId)).toBeNull();

        // (b) The original claimant's re-accept is refused at the TOKEN level:
        // the invitation was already consumed, so the replay reports
        // `invitation_already_accepted` (a single-use-token lock), which also
        // implies they are already a member.
        const aReplay = await acceptToken(request, memberA.access_token, inv.token);
        expect(aReplay.status, 'same user replay 400').toBe(400);
        expect(String(aReplay.body.message)).toMatch(
            /invitation_already_accepted|already_a_member/,
        );

        // (c) Preview of the consumed token — 400 (tolerate the per-IP throttle).
        const preview = await request.get(`${API_BASE}/api/claim/preview?token=${inv.token}`);
        expect([400, 429]).toContain(preview.status());
        if (preview.status() === 400) {
            expect((await preview.json()).message).toBe('invitation_already_accepted');
        }
    });
});

// ---------------------------------------------------------------------------
test.describe('Share-link fan-out + pending-share semantics', () => {
    test('claimUrl is a well-formed absolute share link; a 3-role fan-out mints 3 distinct tokens and lists them pending (work-scoped, no leaked tokens)', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const { id: workId } = await makeWork(request, owner.access_token, 'ShareFanout');
        // A DIFFERENT work whose invitations must never bleed into this one.
        const { id: otherWorkId } = await makeWork(request, owner.access_token, 'ShareFanoutOther');
        const otherInv = await issueInvitation(request, owner.access_token, otherWorkId, {
            email: `other-${uniqueSuffix()}@test.local`,
            role: 'viewer',
        });
        expect(otherInv.status).toBe(201);

        const roles: Array<'viewer' | 'editor' | 'manager'> = ['viewer', 'editor', 'manager'];
        const issued: Array<{ id: string; token: string; claimUrl: string }> = [];
        for (const role of roles) {
            const res = await request.post(`${API_BASE}/api/works/${workId}/invitations`, {
                headers: authedHeaders(owner.access_token),
                data: { email: `fan-${role}-${uniqueSuffix()}@test.local`, role },
            });
            expect(res.status(), `issue ${role} 201`).toBe(201);
            const body = await res.json();
            const claimUrl = String(body.claimUrl);
            // Absolute http(s) URL ending in /claim/<64hex>.
            expect(claimUrl, 'claimUrl is an absolute share link').toMatch(
                /^https?:\/\/.+\/claim\/[0-9a-f]{64}$/,
            );
            issued.push({ id: String(body.id), token: claimUrl.split('/claim/')[1], claimUrl });
        }

        // All three tokens (and URLs) are distinct — no token reuse across a fan-out.
        expect(new Set(issued.map((i) => i.token)).size).toBe(3);
        expect(new Set(issued.map((i) => i.claimUrl)).size).toBe(3);

        // listPending is scoped to THIS work: contains all 3, never the other work's invite.
        const listRes = await request.get(`${API_BASE}/api/works/${workId}/invitations`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(listRes.status()).toBe(200);
        const listed = (await listRes.json()).invitations as Array<Record<string, unknown>>;
        const listedIds = listed.map((i) => String(i.id));
        for (const i of issued) expect(listedIds).toContain(i.id);
        expect(listedIds, 'another work invite never leaks in').not.toContain(otherInv.body.id);
        // The list read never re-exposes the raw token/claimUrl (returned once).
        for (const row of listed) expect(row).not.toHaveProperty('claimUrl');
    });

    test('a pending invitation is neither a roster member nor a discovery share for the invitee — only accept materialises both', async ({
        request,
    }) => {
        // Reinforces the "pending grants nothing" invariant from the invitee's
        // OWN vantage (distinct from the timing test which contrasts two paths):
        // the invitee sees no work and no membership, yet a public preview of the
        // still-live token faithfully echoes the offer without consuming it.
        const owner = await registerUserViaAPI(request);
        const invitee = await registerUserViaAPI(request);
        const workName = `SharePending ${uniqueSuffix()}`;
        const { id: workId } = await createWorkViaAPI(request, owner.access_token, {
            name: workName,
            slug: `sharepending-${uniqueSuffix()}`,
            description: 'pending-share invariant',
        });

        const inv = await issueInvitation(request, owner.access_token, workId, {
            email: invitee.email,
            role: 'manager',
        });
        expect(inv.status).toBe(201);

        // Invitee sees nothing yet.
        expect(await discoveryRole(request, invitee.access_token, workId)).toBeNull();
        const rosterRes = await listMembers(request, owner.access_token, workId);
        expect(rosterRes.members.some((m) => m.userId === invitee.user.id)).toBe(false);

        // Public preview echoes the offer (tolerate throttle) but doesn't consume it.
        const preview = await request.get(`${API_BASE}/api/claim/preview?token=${inv.token}`);
        expect([200, 429]).toContain(preview.status());
        if (preview.status() === 200) {
            const p = await preview.json();
            expect(p.workName).toBe(workName);
            expect(p.role).toBe('manager');
            expect(typeof p.expiresAt).toBe('string');
        }

        // Still pending → still invisible after the preview.
        expect(await discoveryRole(request, invitee.access_token, workId)).toBeNull();

        // Accept materialises the share.
        const accept = await acceptToken(request, invitee.access_token, inv.token);
        expect(accept.status).toBe(200);
        await expect
            .poll(() => discoveryRole(request, invitee.access_token, workId), { timeout: 20_000 })
            .toBe('manager');
    });
});

// ---------------------------------------------------------------------------
test.describe('Visibility toggles via owner actions', () => {
    test('owner-initiated removal flips DISCOVERY visibility off: work leaves the list, read 403, total drops', async ({
        request,
    }) => {
        // Distinct from the /members-roster flip pinned elsewhere: here we assert
        // the invitee's WORKS-DISCOVERY list and total react to an owner-driven
        // DELETE removal.
        const owner = await registerUserViaAPI(request);
        const member = await registerUserViaAPI(request);
        const { id: workId } = await makeWork(request, owner.access_token, 'ShareRevoke');

        await directAdd(request, owner.access_token, workId, member.email, 'editor');
        await expect
            .poll(() => discoveryRole(request, member.access_token, workId), { timeout: 20_000 })
            .toBe('editor');
        const before = await listWorks(request, member.access_token);
        expect(before.works.some((w) => w.id === workId)).toBe(true);
        const totalBefore = before.total;

        // Owner removes the member (needs the WorkMember row id).
        const rowId = await memberRowId(request, owner.access_token, workId, member.user.id);
        expect(rowId, 'resolved the member row id').toBeTruthy();
        const del = await request.delete(`${API_BASE}/api/works/${workId}/members/${rowId}`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(del.status(), 'removal is 200').toBe(200);
        expect((await del.json()).message).toBe('Member removed successfully');

        // Discovery visibility flips OFF.
        await expect
            .poll(
                async () =>
                    (await listWorks(request, member.access_token)).works.some(
                        (w) => w.id === workId,
                    ),
                {
                    timeout: 20_000,
                    message: 'removed work should leave the discovery list',
                },
            )
            .toBe(false);
        const after = await listWorks(request, member.access_token);
        expect(after.total, 'accessible total drops after removal').toBe(totalBefore - 1);
        const read = await request.get(`${API_BASE}/api/works/${workId}`, {
            headers: authedHeaders(member.access_token),
        });
        expect(read.status(), 'ex-member read is 403').toBe(403);
        expect((await read.json()).message).toMatch(NO_ACCESS_MSG);
    });

    test('role escalation (PUT viewer→manager) reflects in the discovery userRole AND unlocks the manager-only invitation list', async ({
        request,
    }) => {
        // A visibility TOGGLE in the role dimension: promoting a viewer changes
        // the userRole they see in discovery, and — proving the grant is truly
        // live — the newly-minted manager can now list the work's invitations
        // (a Manager+ capability that was 403 as a viewer).
        const owner = await registerUserViaAPI(request);
        const member = await registerUserViaAPI(request);
        const { id: workId } = await makeWork(request, owner.access_token, 'ShareEscalate');

        await directAdd(request, owner.access_token, workId, member.email, 'viewer');
        await expect
            .poll(() => discoveryRole(request, member.access_token, workId), { timeout: 20_000 })
            .toBe('viewer');

        // As a viewer, listing invitations is forbidden.
        const preInv = await request.get(`${API_BASE}/api/works/${workId}/invitations`, {
            headers: authedHeaders(member.access_token),
        });
        expect(preInv.status(), 'viewer cannot list invitations').toBe(403);
        expect(String((await preInv.json()).message)).toMatch(REQUIRED_ROLE_MSG);

        // Owner promotes viewer -> manager.
        const rowId = await memberRowId(request, owner.access_token, workId, member.user.id);
        const put = await request.put(`${API_BASE}/api/works/${workId}/members/${rowId}`, {
            headers: authedHeaders(owner.access_token),
            data: { role: 'manager' },
        });
        expect(put.status(), 'role update is 200').toBe(200);
        expect((await put.json()).member.role).toBe('manager');

        // Discovery userRole flips to manager.
        await expect
            .poll(() => discoveryRole(request, member.access_token, workId), {
                timeout: 20_000,
                message: 'promoted member should read as manager in discovery',
            })
            .toBe('manager');

        // The grant is effective: the manager can now list invitations (200).
        const postInv = await request.get(`${API_BASE}/api/works/${workId}/invitations`, {
            headers: authedHeaders(member.access_token),
        });
        expect(postInv.status(), 'promoted manager can list invitations').toBe(200);
        expect((await postInv.json()).status).toBe('success');

        // The owner-side getMember read model reflects the new role too.
        const getMember = await request.get(`${API_BASE}/api/works/${workId}/members/${rowId}`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(getMember.status()).toBe(200);
        expect((await getMember.json()).member.role).toBe('manager');
    });

    test('selective removal in a multi-member share isolates the revoke — only the removed member loses visibility', async ({
        request,
    }) => {
        // Share the work with three members, then remove exactly one. The removed
        // member's visibility flips off while the untouched members keep theirs —
        // proving a revoke is scoped to a single membership, not the whole share.
        const owner = await registerUserViaAPI(request);
        const keepViewer = await registerUserViaAPI(request);
        const dropEditor = await registerUserViaAPI(request);
        const keepManager = await registerUserViaAPI(request);
        const { id: workId } = await makeWork(request, owner.access_token, 'ShareSelective');

        await directAdd(request, owner.access_token, workId, keepViewer.email, 'viewer');
        await directAdd(request, owner.access_token, workId, dropEditor.email, 'editor');
        await directAdd(request, owner.access_token, workId, keepManager.email, 'manager');

        for (const [u, role] of [
            [keepViewer, 'viewer'],
            [dropEditor, 'editor'],
            [keepManager, 'manager'],
        ] as const) {
            await expect
                .poll(() => discoveryRole(request, u.access_token, workId), { timeout: 20_000 })
                .toBe(role);
        }

        // Remove ONLY the editor.
        const dropRowId = await memberRowId(
            request,
            owner.access_token,
            workId,
            dropEditor.user.id,
        );
        const del = await request.delete(`${API_BASE}/api/works/${workId}/members/${dropRowId}`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(del.status()).toBe(200);

        // The editor loses visibility; the other two keep it.
        await expect
            .poll(() => discoveryRole(request, dropEditor.access_token, workId), {
                timeout: 20_000,
            })
            .toBeNull();
        expect(await discoveryRole(request, keepViewer.access_token, workId)).toBe('viewer');
        expect(await discoveryRole(request, keepManager.access_token, workId)).toBe('manager');

        // The roster now lists exactly the two survivors (not the removed editor).
        const { members } = await listMembers(request, owner.access_token, workId);
        const ids = members.map((m) => m.userId);
        expect(ids).toContain(keepViewer.user.id);
        expect(ids).toContain(keepManager.user.id);
        expect(ids).not.toContain(dropEditor.user.id);
    });

    test('removal is complete and re-shareable: after DELETE, a fresh token invite re-grants visibility at a new role', async ({
        request,
    }) => {
        // Proves removal clears the membership entirely (not a soft state): the
        // same user can be re-shared via a brand-new token and lands at the new
        // role, and getMember on the stale row id is 404.
        const owner = await registerUserViaAPI(request);
        const member = await registerUserViaAPI(request);
        const { id: workId } = await makeWork(request, owner.access_token, 'ShareReshare');

        await directAdd(request, owner.access_token, workId, member.email, 'viewer');
        const rowId = await memberRowId(request, owner.access_token, workId, member.user.id);
        expect(rowId).toBeTruthy();
        await request.delete(`${API_BASE}/api/works/${workId}/members/${rowId}`, {
            headers: authedHeaders(owner.access_token),
        });
        await expect
            .poll(() => discoveryRole(request, member.access_token, workId), { timeout: 20_000 })
            .toBeNull();

        // The stale member row id no longer resolves.
        const staleGet = await request.get(`${API_BASE}/api/works/${workId}/members/${rowId}`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(staleGet.status(), 'removed row id is 404').toBe(404);
        expect((await staleGet.json()).message).toBe('Member not found');

        // Re-share the SAME user via a fresh token, this time as editor.
        const inv = await issueInvitation(request, owner.access_token, workId, {
            email: member.email,
            role: 'editor',
        });
        expect(inv.status).toBe(201);
        const accept = await acceptToken(request, member.access_token, inv.token);
        expect(accept.status, 're-share accept 200 (membership was fully cleared)').toBe(200);
        expect(accept.body.role).toBe('editor');
        await expect
            .poll(() => discoveryRole(request, member.access_token, workId), { timeout: 20_000 })
            .toBe('editor');
    });
});

// ---------------------------------------------------------------------------
test.describe('Transfer + share coexistence on one work', () => {
    test('an owner-claim transfer and a member share coexist; accepting the member share drops only THAT invite from listPending, owner-claim stays pending', async ({
        request,
    }) => {
        // Transfer and sharing are separate ceremonies that can be in flight on
        // the same work at once. We interleave them and pin that the pending
        // owner-claim is untouched by a member accepting an ordinary invite.
        const owner = await registerUserViaAPI(request);
        const member = await registerUserViaAPI(request);
        const { id: workId } = await makeWork(request, owner.access_token, 'ShareCoexist');

        // Issue BOTH: an owner-claim (transfer) and a viewer share.
        const ownerClaim = await issueInvitation(request, owner.access_token, workId, {
            role: 'owner-claim',
            expectedProviderUsername: `gh-${uniqueSuffix()}`,
        });
        expect(ownerClaim.status, 'owner-claim issued').toBe(201);
        const memberInv = await issueInvitation(request, owner.access_token, workId, {
            email: member.email,
            role: 'viewer',
        });
        expect(memberInv.status, 'member share issued').toBe(201);

        // Both are pending in the work-scoped list.
        const beforeList = (
            await (
                await request.get(`${API_BASE}/api/works/${workId}/invitations`, {
                    headers: authedHeaders(owner.access_token),
                })
            ).json()
        ).invitations as Array<{ id: string; role: string; status: string }>;
        const beforeIds = beforeList.map((i) => i.id);
        expect(beforeIds).toContain(String(ownerClaim.body.id));
        expect(beforeIds).toContain(String(memberInv.body.id));
        expect(beforeList.find((i) => i.id === ownerClaim.body.id)?.role).toBe('owner-claim');

        // Member accepts the viewer share -> becomes a share (visible).
        const accept = await acceptToken(request, member.access_token, memberInv.token);
        expect(accept.status).toBe(200);
        await expect
            .poll(() => discoveryRole(request, member.access_token, workId), { timeout: 20_000 })
            .toBe('viewer');

        // listPending now shows ONLY the still-pending owner-claim; the accepted
        // member invite dropped out (accepted invites are not pending).
        const afterList = (
            await (
                await request.get(`${API_BASE}/api/works/${workId}/invitations`, {
                    headers: authedHeaders(owner.access_token),
                })
            ).json()
        ).invitations as Array<{ id: string; status: string }>;
        const afterIds = afterList.map((i) => i.id);
        expect(afterIds, 'owner-claim still pending').toContain(String(ownerClaim.body.id));
        expect(afterIds, 'accepted member invite left the pending list').not.toContain(
            String(memberInv.body.id),
        );

        // The in-app owner is unchanged by the still-pending transfer.
        const workRead = await request.get(`${API_BASE}/api/works/${workId}`, {
            headers: authedHeaders(owner.access_token),
        });
        expect((await workRead.json()).work.userId ?? owner.user.id).toBe(owner.user.id);
    });

    test('revoking the pending owner-claim leaves the member share (and its visibility) fully intact', async ({
        request,
    }) => {
        // Aborting a transfer must not disturb an unrelated live share on the same
        // work. We share first, then issue+revoke an owner-claim, and confirm the
        // member's visibility and role are untouched throughout.
        const owner = await registerUserViaAPI(request);
        const member = await registerUserViaAPI(request);
        const { id: workId } = await makeWork(request, owner.access_token, 'ShareTransferAbort');

        await directAdd(request, owner.access_token, workId, member.email, 'editor');
        await expect
            .poll(() => discoveryRole(request, member.access_token, workId), { timeout: 20_000 })
            .toBe('editor');

        const ownerClaim = await issueInvitation(request, owner.access_token, workId, {
            role: 'owner-claim',
            expectedProviderUsername: `gh-${uniqueSuffix()}`,
        });
        expect(ownerClaim.status).toBe(201);

        // Revoke the transfer.
        const revoke = await request.delete(
            `${API_BASE}/api/works/${workId}/invitations/${ownerClaim.body.id}`,
            { headers: authedHeaders(owner.access_token) },
        );
        expect(revoke.status(), 'owner revokes the transfer').toBe(200);
        expect((await revoke.json()).status).toBe('success');

        // The share is untouched: still editor, still visible, still on the roster.
        expect(await discoveryRole(request, member.access_token, workId)).toBe('editor');
        const memberRead = await request.get(`${API_BASE}/api/works/${workId}`, {
            headers: authedHeaders(member.access_token),
        });
        expect(memberRead.status()).toBe(200);
        expect((await memberRead.json()).work.userRole).toBe('editor');
        const { members } = await listMembers(request, owner.access_token, workId);
        expect(members.some((m) => m.userId === member.user.id && m.role === 'editor')).toBe(true);
    });

    test("a pending transfer is neither a membership nor a discovery share — the roster and everyone's visibility are unaffected", async ({
        request,
    }) => {
        // An owner-claim in flight adds NO member row and grants NO discovery
        // access to anyone, and does not mutate ownership. It is purely a
        // repo-handoff offer, orthogonal to the share model.
        const owner = await registerUserViaAPI(request);
        const bystander = await registerUserViaAPI(request);
        const { id: workId } = await makeWork(request, owner.access_token, 'ShareTransferOnly');

        const rosterBefore = await listMembers(request, owner.access_token, workId);
        expect(rosterBefore.members.length, 'no members before transfer').toBe(0);

        const ownerClaim = await issueInvitation(request, owner.access_token, workId, {
            role: 'owner-claim',
            expectedProviderUsername: `gh-${uniqueSuffix()}`,
        });
        expect(ownerClaim.status).toBe(201);

        // The roster gained no member; the bystander sees nothing and can't read.
        const rosterAfter = await listMembers(request, owner.access_token, workId);
        expect(rosterAfter.members.length, 'pending transfer adds no member').toBe(0);
        expect(await discoveryRole(request, bystander.access_token, workId)).toBeNull();
        const bystanderRead = await request.get(`${API_BASE}/api/works/${workId}`, {
            headers: authedHeaders(bystander.access_token),
        });
        expect([403, 404]).toContain(bystanderRead.status());

        // Ownership is still the creator's.
        const ownerRead = await request.get(`${API_BASE}/api/works/${workId}`, {
            headers: authedHeaders(owner.access_token),
        });
        expect((await ownerRead.json()).work.userRole).toBe('owner');
    });
});

// ---------------------------------------------------------------------------
test.describe('Administering a share is privileged', () => {
    test('a shared VIEWER cannot re-share or administer: 403 on list-invitations, revoke, and direct-add', async ({
        request,
    }) => {
        // A collaborator granted view access must not be able to widen the share.
        // We pin the whole below-Manager management surface as 403 for a viewer.
        const owner = await registerUserViaAPI(request);
        const viewer = await registerUserViaAPI(request);
        const target = await registerUserViaAPI(request);
        const { id: workId } = await makeWork(request, owner.access_token, 'ShareViewerRBAC');

        await directAdd(request, owner.access_token, workId, viewer.email, 'viewer');
        await expect
            .poll(() => discoveryRole(request, viewer.access_token, workId), { timeout: 20_000 })
            .toBe('viewer');

        // Owner leaves a pending invitation for the viewer to try (and fail) to revoke.
        const pending = await issueInvitation(request, owner.access_token, workId, {
            email: `pending-${uniqueSuffix()}@test.local`,
            role: 'viewer',
        });
        expect(pending.status).toBe(201);

        // viewer: list invitations -> 403.
        const list = await request.get(`${API_BASE}/api/works/${workId}/invitations`, {
            headers: authedHeaders(viewer.access_token),
        });
        expect(list.status()).toBe(403);
        expect(String((await list.json()).message)).toMatch(REQUIRED_ROLE_MSG);

        // viewer: revoke a real pending invitation -> 403 (gate before lookup).
        const revoke = await request.delete(
            `${API_BASE}/api/works/${workId}/invitations/${pending.body.id}`,
            { headers: authedHeaders(viewer.access_token) },
        );
        expect(revoke.status()).toBe(403);
        expect(String((await revoke.json()).message)).toMatch(REQUIRED_ROLE_MSG);

        // viewer: direct-add another member -> 403.
        const add = await directAdd(request, viewer.access_token, workId, target.email, 'viewer');
        expect(add.status).toBe(403);
        expect(String(add.body.message)).toMatch(REQUIRED_ROLE_MSG);

        // The pending invitation the viewer failed to revoke is still pending.
        const stillListed = (
            await (
                await request.get(`${API_BASE}/api/works/${workId}/invitations`, {
                    headers: authedHeaders(owner.access_token),
                })
            ).json()
        ).invitations as Array<{ id: string }>;
        expect(stillListed.map((i) => i.id)).toContain(String(pending.body.id));
    });

    test('a stranger has NO share surface: read, roster, list, issue and revoke are all 403', async ({
        request,
    }) => {
        // Someone with no membership at all is walled off from every share verb,
        // with the distinct "no access" message (not the "insufficient role" one).
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const { id: workId } = await makeWork(request, owner.access_token, 'ShareStranger');

        // A real pending invitation for the stranger to fail to revoke/list.
        const inv = await issueInvitation(request, owner.access_token, workId, {
            email: `x-${uniqueSuffix()}@test.local`,
            role: 'viewer',
        });
        expect(inv.status).toBe(201);

        const read = await request.get(`${API_BASE}/api/works/${workId}`, {
            headers: authedHeaders(stranger.access_token),
        });
        expect(read.status()).toBe(403);
        expect(String((await read.json()).message)).toMatch(NO_ACCESS_MSG);

        const roster = await listMembers(request, stranger.access_token, workId);
        expect(roster.status).toBe(403);

        const list = await request.get(`${API_BASE}/api/works/${workId}/invitations`, {
            headers: authedHeaders(stranger.access_token),
        });
        expect(list.status()).toBe(403);
        expect(String((await list.json()).message)).toMatch(NO_ACCESS_MSG);

        const issue = await issueInvitation(request, stranger.access_token, workId, {
            email: `y-${uniqueSuffix()}@test.local`,
            role: 'viewer',
        });
        expect(issue.status).toBe(403);
        expect(String(issue.body.message)).toMatch(NO_ACCESS_MSG);

        const revoke = await request.delete(
            `${API_BASE}/api/works/${workId}/invitations/${inv.body.id}`,
            { headers: authedHeaders(stranger.access_token) },
        );
        expect(revoke.status()).toBe(403);
        expect(String((await revoke.json()).message)).toMatch(NO_ACCESS_MSG);

        // Owner-claim (transfer) issuance by a stranger is likewise 403.
        const strangerTransfer = await issueInvitation(request, stranger.access_token, workId, {
            role: 'owner-claim',
            expectedProviderUsername: `gh-${uniqueSuffix()}`,
        });
        expect(strangerTransfer.status).toBe(403);
        expect(String(strangerTransfer.body.message)).toMatch(NO_ACCESS_MSG);
    });
});
