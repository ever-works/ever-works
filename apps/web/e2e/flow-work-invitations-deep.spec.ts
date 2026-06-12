import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * flow: WORK invitations — long-tail DEEP coverage (REAL integration).
 *
 * Surface (source-verified 2026-06-11 against the live API + source):
 *   apps/api/src/works/invitations.controller.ts        (issue / list / revoke)
 *   apps/api/src/works/dto/create-invitation.dto.ts     (CreateInvitationDto + DTO)
 *   Controller mounts @Controller('api/works/:workId/invitations') under
 *   AuthSessionGuard. :workId AND :invitationId are ParseUUIDPipe.
 *
 * PROBED CONTRACTS (curl against 127.0.0.1:3100, this session):
 *   POST   /api/works/:workId/invitations  -> 201 InvitationResponseDto
 *       body {id, workId, role, email|null, status:'pending', tokenExpiresAt,
 *             createdAt, invitedById, metadata|null, claimUrl}. claimUrl =
 *             `${webAppUrl}/claim/${token}` returned ONCE; list reads omit it.
 *       VALIDATION (all 400, never 500):
 *         - email not an email           -> 400
 *         - role not in {manager,editor,viewer,owner-claim} -> 400 with message
 *           "role must be one of the following values: manager, editor, viewer, owner-claim"
 *         - empty body / missing role    -> 400
 *         - expiresInDays non-int string -> 400
 *         - metadata serialising > 8 KiB -> 400 (MetadataByteCapConstraint)
 *       small metadata is echoed verbatim in the response DTO.
 *   GET    /api/works/:workId/invitations -> 200 {status:'success', invitations:[]}
 *       PENDING-only, SCOPED to the work (another work's invites never appear).
 *   DELETE /api/works/:workId/invitations/:invitationId -> 200 {status:'success'}
 *       404 'invitation_not_found' when the id is not a PENDING invite OF THIS
 *       work (the controller scopes via listPending(workId)). Bad uuid -> 400.
 *   AUTH: no bearer -> 401 on every verb.
 *
 * SHARP, source-confirmed CONTRACT this file PINS (the long-tail gap):
 *   - DUPLICATE invites are NOT de-duped: POSTing the SAME {email, role} twice
 *     mints TWO distinct PENDING invitations (distinct ids + distinct tokens),
 *     both listed. There is no "already invited" guard. (Probed: second POST -> 201.)
 *   - REVOKE IS WORK-SCOPED: a valid invitation id revoked via the WRONG work id
 *     -> 404 invitation_not_found (cannot cross-revoke another work's invite).
 *
 * EXISTING COVERAGE I DELIBERATELY DO NOT DUPLICATE:
 *   - flow-invitation-email-roundtrip.spec.ts: mail round-trip, revoke+reissue
 *     token rotation, revoke-then-accept (403), expiry WINDOW + clamp 400s,
 *     authz boundaries (outsider issue/revoke/list), malformed-uuid 400 /
 *     unknown-uuid 404, member-role-needs-email, owner-claim-needs-username,
 *     anon /claim deeplink.
 *   - flow-work-invitation-tokens.spec.ts: token replay precedence, accept=200,
 *     preview fidelity, baked-role across roles, identity-mismatch 403.
 *   - invitation-token-single-use.spec.ts / member-invitation-happy-path.spec.ts:
 *     token-single-use + the linear invite->accept->role-change->remove path.
 *   - multi-user-invitation.spec.ts: owner-list-then-finds-email, stranger
 *     isolation on POST + GET.
 * This file adds the UNCOVERED CRUD/contract long-tail: DUPLICATE non-de-dup,
 * WORK-SCOPED revoke (cross-work 404), cross-work LIST isolation, the full
 * VALIDATION matrix (email/role-message/empty/expiresInDays-type/metadata-cap),
 * the create-vs-list DTO shape delta (claimUrl + token only at create), role
 * fidelity across manager/editor/viewer, no-bearer 401 across all three verbs,
 * and revoke-is-idempotent-then-404.
 *
 * GOTCHAS honored:
 *   - All mutations on FRESH registerUserViaAPI() users + a fresh work; unique
 *     suffixes from a per-test counter (NOT a module-scope clock). assert
 *     toContain over arrays, never exact counts.
 *   - WORK WRITES are git-gated, but INVITATION rows are NOT (no git needed to
 *     issue/list/revoke) — these mutations succeed against sqlite-in-memory CI.
 *   - role enum is {manager,editor,viewer,owner-claim} — there is NO 'member'/
 *     'owner'/'admin' role on this DTO.
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
    claimUrl?: string;
    metadata?: Record<string, unknown> | null;
}

interface InvitationListBody {
    status: string;
    invitations: InvitationResponse[];
}

let SEQ = 0;
function uniq(tag: string): string {
    SEQ += 1;
    return `${tag}-${SEQ}-${Math.random().toString(36).slice(2, 7)}`;
}

function uniqEmail(tag: string): string {
    return `e2e-inv-deep-${uniq(tag)}@test.local`;
}

async function issue(
    request: APIRequestContext,
    token: string,
    workId: string,
    data: Record<string, unknown>,
): Promise<{ status: number; body: InvitationResponse }> {
    const res = await request.post(`${API_BASE}/api/works/${workId}/invitations`, {
        headers: authedHeaders(token),
        data,
    });
    const body = (await res.json().catch(() => ({}))) as InvitationResponse;
    return { status: res.status(), body };
}

async function list(
    request: APIRequestContext,
    token: string,
    workId: string,
): Promise<{ status: number; body: InvitationListBody }> {
    const res = await request.get(`${API_BASE}/api/works/${workId}/invitations`, {
        headers: authedHeaders(token),
    });
    const body = (await res
        .json()
        .catch(() => ({ status: 'error', invitations: [] }))) as InvitationListBody;
    return { status: res.status(), body };
}

function claimToken(body: InvitationResponse): string | null {
    const m = (body.claimUrl ?? '').match(/\/claim\/([^/?#]+)/);
    return m?.[1] ?? null;
}

async function freshOwnerWork(request: APIRequestContext, tag: string) {
    const owner = await registerUserViaAPI(request);
    const slug = uniq(tag);
    const work = await createWorkViaAPI(request, owner.access_token, {
        name: `inv-deep-${slug}`,
        slug: `inv-deep-${slug}`,
    });
    return { owner, work };
}

test.describe('flow: work invitations — long-tail deep', () => {
    test('create returns the full InvitationResponseDto shape with claimUrl + raw token', async ({
        request,
    }) => {
        const { owner, work } = await freshOwnerWork(request, 'shape');
        const email = uniqEmail('shape');

        const { status, body } = await issue(request, owner.access_token, work.id, {
            email,
            role: 'editor',
        });
        expect(status, JSON.stringify(body)).toBe(201);

        // Required DTO fields.
        expect(typeof body.id).toBe('string');
        expect(body.id.length).toBeGreaterThan(0);
        expect(body.workId).toBe(work.id);
        expect(body.role).toBe('editor');
        expect(body.email).toBe(email);
        expect(body.status.toLowerCase()).toBe('pending');
        expect(body.invitedById).toBe(owner.user.id);
        expect(Number.isNaN(Date.parse(body.tokenExpiresAt))).toBe(false);
        expect(Number.isNaN(Date.parse(body.createdAt))).toBe(false);
        // metadata defaults to null when not supplied.
        expect(body.metadata ?? null).toBeNull();

        // claimUrl carries a raw token (randomBytes(32).hex = 64 chars) ONCE.
        const tok = claimToken(body);
        expect(tok, 'claimUrl must embed the raw token at creation').toBeTruthy();
        expect(tok!.length).toBeGreaterThanOrEqual(48);
        expect(body.claimUrl).toContain('/claim/');
    });

    test('list returns {status:success, invitations[]} and OMITS claimUrl / raw token', async ({
        request,
    }) => {
        const { owner, work } = await freshOwnerWork(request, 'list-shape');
        const created = await issue(request, owner.access_token, work.id, {
            email: uniqEmail('list-shape'),
            role: 'manager',
        });
        expect(created.status).toBe(201);
        const tok = claimToken(created.body);
        expect(tok).toBeTruthy();

        const { status, body } = await list(request, owner.access_token, work.id);
        expect(status).toBe(200);
        expect(body.status).toBe('success');
        expect(Array.isArray(body.invitations)).toBe(true);

        const listed = body.invitations.find((i) => i.id === created.body.id);
        expect(listed, 'issued invite should be listed as pending').toBeTruthy();
        expect(listed!.status.toLowerCase()).toBe('pending');
        // The listing must NOT re-expose the claim URL / raw token.
        expect(listed!.claimUrl ?? '', 'list must not include claimUrl').toBe('');
        const serialized = JSON.stringify(body);
        expect(serialized.includes(tok!), 'list response must not leak the raw token').toBe(false);
    });

    test('DUPLICATE {email, role} is NOT de-duped — a second POST mints a distinct pending invite', async ({
        request,
    }) => {
        const { owner, work } = await freshOwnerWork(request, 'dup');
        const email = uniqEmail('dup');

        const first = await issue(request, owner.access_token, work.id, { email, role: 'manager' });
        expect(first.status).toBe(201);

        // Same email + same role again -> still 201 (no "already invited" guard).
        const second = await issue(request, owner.access_token, work.id, {
            email,
            role: 'manager',
        });
        expect(second.status, 'duplicate invite is allowed (no de-dup)').toBe(201);

        // Two distinct invitation rows + two distinct tokens.
        expect(second.body.id).not.toBe(first.body.id);
        expect(claimToken(second.body)).not.toBe(claimToken(first.body));

        // BOTH appear as pending in the listing for that same email.
        const { body } = await list(request, owner.access_token, work.id);
        const sameEmail = body.invitations.filter((i) => i.email === email);
        const ids = sameEmail.map((i) => i.id);
        expect(ids).toContain(first.body.id);
        expect(ids).toContain(second.body.id);
        expect(sameEmail.length).toBeGreaterThanOrEqual(2);
    });

    test('role fidelity: manager/editor/viewer are each baked verbatim into the created + listed invite', async ({
        request,
    }) => {
        const { owner, work } = await freshOwnerWork(request, 'roles');
        const roles = ['manager', 'editor', 'viewer'] as const;
        const created: Record<string, string> = {};

        for (const role of roles) {
            const res = await issue(request, owner.access_token, work.id, {
                email: uniqEmail(`role-${role}`),
                role,
            });
            expect(res.status, `${role} should create`).toBe(201);
            expect(res.body.role).toBe(role);
            created[role] = res.body.id;
        }

        const { body } = await list(request, owner.access_token, work.id);
        const byId = new Map(body.invitations.map((i) => [i.id, i.role]));
        for (const role of roles) {
            expect(byId.get(created[role]), `${role} role should persist in listing`).toBe(role);
        }
    });

    test('small metadata is echoed back verbatim; metadata serialising over 8 KiB is rejected (400)', async ({
        request,
    }) => {
        const { owner, work } = await freshOwnerWork(request, 'meta');

        const small = await issue(request, owner.access_token, work.id, {
            email: uniqEmail('meta-ok'),
            role: 'editor',
            metadata: { note: 'hello', n: 7 },
        });
        expect(small.status).toBe(201);
        expect(small.body.metadata).toEqual({ note: 'hello', n: 7 });

        // > 8 KiB serialised metadata -> MetadataByteCapConstraint -> 400 (not 500).
        const oversized = await request.post(`${API_BASE}/api/works/${work.id}/invitations`, {
            headers: authedHeaders(owner.access_token),
            data: {
                email: uniqEmail('meta-big'),
                role: 'editor',
                metadata: { blob: 'x'.repeat(9000) },
            },
        });
        expect(oversized.status()).toBe(400);
    });

    test('validation matrix: bad email, invalid role (exact message), empty body, non-int expiresInDays all 400', async ({
        request,
    }) => {
        const { owner, work } = await freshOwnerWork(request, 'validate');
        const base = `${API_BASE}/api/works/${work.id}/invitations`;
        const h = authedHeaders(owner.access_token);

        const badEmail = await request.post(base, {
            headers: h,
            data: { email: 'not-an-email', role: 'editor' },
        });
        expect(badEmail.status(), 'malformed email -> 400').toBe(400);

        const badRole = await request.post(base, {
            headers: h,
            data: { email: uniqEmail('badrole'), role: 'superadmin' },
        });
        expect(badRole.status()).toBe(400);
        // Exact enum message from the IsIn(ALL_INVITATION_ROLES) validator.
        expect((await badRole.text()).toLowerCase()).toContain(
            'role must be one of the following values: manager, editor, viewer, owner-claim',
        );

        const emptyBody = await request.post(base, { headers: h, data: {} });
        expect(emptyBody.status(), 'empty body (missing role) -> 400').toBe(400);

        const badExpiry = await request.post(base, {
            headers: h,
            data: { email: uniqEmail('badexp'), role: 'editor', expiresInDays: 'abc' },
        });
        expect(badExpiry.status(), 'non-int expiresInDays -> 400').toBe(400);
    });

    test('LIST is work-scoped: invites issued on work A never appear when listing work B', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const slugA = uniq('iso-a');
        const slugB = uniq('iso-b');
        const workA = await createWorkViaAPI(request, owner.access_token, {
            name: `inv-deep-${slugA}`,
            slug: `inv-deep-${slugA}`,
        });
        const workB = await createWorkViaAPI(request, owner.access_token, {
            name: `inv-deep-${slugB}`,
            slug: `inv-deep-${slugB}`,
        });

        const inA = await issue(request, owner.access_token, workA.id, {
            email: uniqEmail('iso'),
            role: 'editor',
        });
        expect(inA.status).toBe(201);

        // Work A lists it; work B does not.
        const listA = await list(request, owner.access_token, workA.id);
        expect(listA.body.invitations.map((i) => i.id)).toContain(inA.body.id);

        const listB = await list(request, owner.access_token, workB.id);
        expect(listB.status).toBe(200);
        expect(listB.body.invitations.map((i) => i.id)).not.toContain(inA.body.id);
    });

    test('REVOKE is work-scoped: a valid invite revoked via the WRONG work id -> 404 invitation_not_found', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const slugA = uniq('revscope-a');
        const slugB = uniq('revscope-b');
        const workA = await createWorkViaAPI(request, owner.access_token, {
            name: `inv-deep-${slugA}`,
            slug: `inv-deep-${slugA}`,
        });
        const workB = await createWorkViaAPI(request, owner.access_token, {
            name: `inv-deep-${slugB}`,
            slug: `inv-deep-${slugB}`,
        });

        const inA = await issue(request, owner.access_token, workA.id, {
            email: uniqEmail('revscope'),
            role: 'editor',
        });
        expect(inA.status).toBe(201);

        // Revoke A's invite through B's path -> not pending in B -> 404 not_found.
        const wrong = await request.delete(
            `${API_BASE}/api/works/${workB.id}/invitations/${inA.body.id}`,
            {
                headers: authedHeaders(owner.access_token),
            },
        );
        expect(wrong.status()).toBe(404);
        expect((await wrong.text()).toLowerCase()).toContain('not_found');

        // The invite is still pending on its OWN work (cross-revoke had no effect).
        const stillA = await list(request, owner.access_token, workA.id);
        expect(stillA.body.invitations.map((i) => i.id)).toContain(inA.body.id);

        // Revoking via the CORRECT work succeeds and drops it from pending.
        const right = await request.delete(
            `${API_BASE}/api/works/${workA.id}/invitations/${inA.body.id}`,
            {
                headers: authedHeaders(owner.access_token),
            },
        );
        expect(right.status(), await right.text()).toBe(200);
        expect((await right.json()).status).toBe('success');

        const afterA = await list(request, owner.access_token, workA.id);
        expect(afterA.body.invitations.map((i) => i.id)).not.toContain(inA.body.id);
    });

    test('revoke is single-shot: re-revoking the same (now non-pending) invite -> 404 not_found', async ({
        request,
    }) => {
        const { owner, work } = await freshOwnerWork(request, 'rerevoke');
        const inv = await issue(request, owner.access_token, work.id, {
            email: uniqEmail('rerevoke'),
            role: 'viewer',
        });
        expect(inv.status).toBe(201);

        const first = await request.delete(
            `${API_BASE}/api/works/${work.id}/invitations/${inv.body.id}`,
            {
                headers: authedHeaders(owner.access_token),
            },
        );
        expect(first.status()).toBe(200);

        const second = await request.delete(
            `${API_BASE}/api/works/${work.id}/invitations/${inv.body.id}`,
            {
                headers: authedHeaders(owner.access_token),
            },
        );
        expect(second.status(), 'second revoke of a no-longer-pending invite -> 404').toBe(404);
        expect((await second.text()).toLowerCase()).toContain('not_found');
    });

    test('malformed :invitationId -> 400 (ParseUUIDPipe); well-formed-unknown -> 404 not_found', async ({
        request,
    }) => {
        const { owner, work } = await freshOwnerWork(request, 'badid');

        const badUuid = await request.delete(
            `${API_BASE}/api/works/${work.id}/invitations/not-a-uuid`,
            {
                headers: authedHeaders(owner.access_token),
            },
        );
        expect(badUuid.status(), 'non-uuid invitationId -> 400').toBe(400);

        const unknown = '00000000-0000-4000-8000-000000000000';
        const unknownRes = await request.delete(
            `${API_BASE}/api/works/${work.id}/invitations/${unknown}`,
            {
                headers: authedHeaders(owner.access_token),
            },
        );
        expect(unknownRes.status(), 'well-formed unknown invitationId -> 404').toBe(404);
        expect((await unknownRes.text()).toLowerCase()).toContain('not_found');
    });

    test('no bearer token -> 401 on create, list, and revoke', async ({ request }) => {
        const { owner, work } = await freshOwnerWork(request, 'noauth');
        // Issue one (authed) so revoke has a real target id.
        const inv = await issue(request, owner.access_token, work.id, {
            email: uniqEmail('noauth'),
            role: 'editor',
        });
        expect(inv.status).toBe(201);

        const anonCreate = await request.post(`${API_BASE}/api/works/${work.id}/invitations`, {
            data: { email: uniqEmail('anon'), role: 'editor' },
        });
        expect(anonCreate.status(), 'anon create -> 401').toBe(401);

        const anonList = await request.get(`${API_BASE}/api/works/${work.id}/invitations`);
        expect(anonList.status(), 'anon list -> 401').toBe(401);

        const anonRevoke = await request.delete(
            `${API_BASE}/api/works/${work.id}/invitations/${inv.body.id}`,
        );
        expect(anonRevoke.status(), 'anon revoke -> 401').toBe(401);
    });

    test('bad :workId uuid -> 400 (ParseUUIDPipe) on create + list before any work lookup', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);

        const create = await request.post(`${API_BASE}/api/works/not-a-uuid/invitations`, {
            headers: authedHeaders(owner.access_token),
            data: { email: uniqEmail('badwork'), role: 'editor' },
        });
        expect(create.status(), 'non-uuid workId on create -> 400').toBe(400);

        const listRes = await request.get(`${API_BASE}/api/works/not-a-uuid/invitations`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(listRes.status(), 'non-uuid workId on list -> 400').toBe(400);
    });
});
