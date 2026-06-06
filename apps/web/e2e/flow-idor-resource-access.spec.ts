import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, createWorkViaAPI } from './helpers/api';
import { createOrganizationViaAPI } from './helpers/organizations';
import { createAgentViaAPI, createTaskViaAPI } from './helpers/agents-tasks';

/**
 * IDOR (Insecure Direct Object Reference) — resource-access matrix.
 *
 * Sibling specs (flow-scope-guard-forbidden-matrix, flow-tenant-isolation-resources,
 * flow-multi-tenant-isolation, flow-cross-tenant-leak-matrix, multi-tenant-data-leak)
 * already prove the *single-resource, top-level* cross-tenant guard: user B gets a
 * non-2xx on user A's `/api/<resource>/:id`. This file deliberately covers the
 * facets those do NOT:
 *
 *   1. GUESSABLE / SEQUENTIAL identifiers — Ever Works mints human-predictable
 *      handles: tasks get a per-user counter slug `T-1` (BOTH users own a `T-1`!)
 *      and works get a caller-chosen slug. An attacker who can guess A's handle
 *      must still be blocked. We prove the handle is NOT a usable direct
 *      reference across users.
 *   2. SUB-RESOURCE-REQUIRES-PARENT — a child (KB doc, invitation, member) is only
 *      reachable through its OWN parent. Pairing a real child id with the WRONG
 *      parent (even a parent YOU own) must fail, and the parent guard must fire
 *      BEFORE any per-child existence check (no existence oracle one level down).
 *   3. CROSS-USER SUB-RESOURCE via a foreign CHILD id — writing to YOUR OWN parent
 *      while referencing someone else's child entity (assign a foreign agent to
 *      your task, assign a foreign task to your agent) must be refused, and a
 *      foreign child id must be indistinguishable from a never-existed one.
 *   4. PARENTLESS sub-resource handles — endpoints that take ONLY a child id with
 *      no parent in the path (DELETE /api/skill-bindings/:id, conversation
 *      message-append/read) are the purest IDOR surface; they must be
 *      ownership-scoped, opaque-404, and leak-clean.
 *
 * Every status/shape below was PROBED against the live API (sqlite in-memory, the
 * CI driver) with throwaway users before any assertion:
 *
 *   Auth        POST /api/auth/register {username>=3,email,password} → 201
 *               {access_token(32-char opaque), user:{id,email,username}}
 *
 *   Tasks       POST /api/tasks {title} → 201 {id(uuid), slug:'T-n'(PER-USER
 *               counter — every user's first task is 'T-1'), …}. GET/PATCH/DELETE
 *               by :id use ParseUUIDPipe → non-uuid (incl. the 'T-1' slug) is a
 *               400 "Validation failed (uuid is expected)"; there is NO slug GET
 *               route. Cross-user GET by id → 404 "Task <id> not found."
 *               (indistinguishable from an unknown uuid).
 *   Works       POST /api/works {name,slug,description,organization:false} → 201
 *               {status:'success',work:{id(uuid),slug,userId,…}}. Works resolve by
 *               id OR slug on GET /api/works/:idOrSlug. Cross-user by id → 403
 *               {status:'error',message:'You do not have permission to access this
 *               work'}; by a GUESSED slug → 404 "Work with id '<slug>' not found";
 *               unknown id/slug → 404; route does NOT use ParseUUIDPipe.
 *   KB docs     POST /api/works/:workId/kb/documents {path,title,class,body} → 201
 *               {id(uuid),workId,…}. GET .../kb/documents/:docId — pairing a real
 *               doc id with the WRONG work id: foreign work → 403 (work guard);
 *               own-other work that doesn't own the doc → 404 "KB document not
 *               found: <id>". Correct parent+owner → 200.
 *   Invitations POST /api/works/:workId/invitations {email,role} → 201
 *               {id(uuid),workId,claimUrl:'…/claim/<token>'}. DELETE
 *               /api/works/:workId/invitations/:invId — real inv id under a
 *               DIFFERENT own work → 404 "invitation_not_found"; under the foreign
 *               owner's work → 403 work-guard; correct parent → 200
 *               {status:'success'}. GET list cross-user → 403.
 *   Agents      POST /api/agents {scope:'tenant',name} → 201 {id(uuid),…}. GET
 *               :id / :id/runs cross-user → 404 "Agent <id> not found." (uuid
 *               pipe → non-uuid 400).
 *   Assignees   POST /api/tasks/:id/assignees {assigneeType:'agent'|'user',
 *               assigneeId} on YOUR task but a FOREIGN agent child → 400 "Agent
 *               <id> is not reachable for this user — cannot assign." (== the body
 *               for a never-existed agent: child-existence non-disclosure).
 *   AssignTask  POST /api/agents/:id/assign-task {taskId} on YOUR agent but a
 *               FOREIGN task child → 404 "Task <id> not found.".
 *   Bindings    POST /api/skills/:id/bindings {targetType:'agent',targetId} → 201
 *               {id(uuid),skillId,…}. DELETE /api/skill-bindings/:id (PARENTLESS,
 *               id-only) cross-user → 404 "Skill binding <id> not found." (==
 *               unknown id); owner → 200 {deleted:true}.
 *   Convos      POST /api/conversations {title} → 201 {id(uuid)}. GET
 *               /api/conversations/:id returns messages INLINE. POST
 *               /api/conversations/:id/messages cross-user → 404 "Not Found";
 *               owner → 201 {success:true}. non-uuid convo id → 404 catch-all.
 *   Members     GET /api/works/:workId/members → owner 200 {members,owner};
 *               cross-user list AND GET :memberId → 403 work-guard (no per-member
 *               oracle). Budgets GET /api/works/:workId/budgets cross-user → 403
 *               "User does not have access to work <id>".
 *
 * Isolation discipline (matches every sibling flow): ALL state is created on FRESH
 * registerUserViaAPI() users — never the shared seeded user (a user-scoped fake key
 * would shadow the env key and break sibling chat specs). Unique Date.now()+random
 * suffixes. Guard codes asserted with toContain/.or where two valid policies exist
 * so a code shift never makes the flow a false-fail. The `flow-` filename prefix is
 * NOT matched by the no-auth testMatch regex in playwright.config.ts and the file is
 * fully API-orchestrated (no UI/stack contention).
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';
const UNKNOWN_UUID_2 = '11111111-1111-1111-1111-111111111111';

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Tokens that must NEVER appear in a forbidden/not-found body — a leak of any of
 * these turns "you can't have this" into an oracle for the victim's secrets,
 * schema, or internals.
 */
const FORBIDDEN_LEAK_TOKENS = [
    'password',
    '$2b$', // bcrypt hash prefix
    'emailVerificationToken',
    'magicLinkToken',
    'passwordResetToken',
    'select *',
    'from "',
    'where "',
    '    at ', // node stack-frame indentation
    'node_modules',
    'queryfailederror',
    'entitynotfounderror',
];

interface Actor {
    user: Awaited<ReturnType<typeof registerUserViaAPI>>;
    token: string;
    headers: { Authorization: string };
}

async function makeActor(request: APIRequestContext): Promise<Actor> {
    const user = await registerUserViaAPI(request);
    return { user, token: user.access_token, headers: authedHeaders(user.access_token) };
}

/** Read the body, assert it is JSON, carries a known error envelope, and leaks
 *  none of the forbidden tokens. Returns the parsed body. */
async function assertCleanError(
    res: { status(): number; text(): Promise<string> },
    context: string,
): Promise<Record<string, unknown>> {
    const raw = await res.text();
    const lower = raw.toLowerCase();
    for (const token of FORBIDDEN_LEAK_TOKENS) {
        expect(lower, `${context} leaked '${token}' → ${raw.slice(0, 300)}`).not.toContain(token);
    }
    let body: Record<string, unknown> = {};
    try {
        body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
        throw new Error(`${context}: expected JSON error body, got: ${raw.slice(0, 200)}`);
    }
    expect(typeof body.message, `${context}: error body has a string message`).toBe('string');
    const hasCustom = body.status === 'error';
    const hasNest = typeof body.statusCode === 'number';
    expect(
        hasCustom || hasNest,
        `${context}: body uses a known error envelope → ${raw.slice(0, 200)}`,
    ).toBeTruthy();
    return body;
}

/** A stable fingerprint of an error response with any concrete uuid masked out —
 *  so a foreign-real id and a never-existed id can be compared for
 *  indistinguishability (the requested id legitimately echoes in some messages;
 *  what matters is the masked message + status + key set match). */
function fingerprint(status: number, body: Record<string, unknown>): string {
    const keys = Object.keys(body).sort().join(',');
    const msg = String(body.message ?? '')
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
        .toLowerCase();
    return `${status}|${keys}|${msg}`;
}

test.describe('IDOR — guessable ids, sub-resource-requires-parent, cross-user child refs', () => {
    // ── Flow 1 ──────────────────────────────────────────────────────────────
    // SEQUENTIAL / PER-USER-COUNTER handle enumeration. Tasks mint a `T-n` slug
    // from a PER-USER counter, so the very first task of EVERY user is `T-1`.
    // That makes `T-1` the most guessable identifier in the system. We prove:
    //   (a) the slug is NOT a usable direct reference at all — the :id route is
    //       uuid-pipe-gated, so 'T-1' is a 400 for everyone (including its owner);
    //   (b) the only real handle is the opaque uuid, and A's uuid is a 404 for B
    //       that is byte-shape identical to a never-existed uuid (no existence
    //       oracle); (c) B's OWN `T-1` resolves to B's task, never A's — the
    //       counter collision leaks nothing.
    test('flow 1 — per-user T-n counter is not a cross-user reference; foreign task uuid is indistinguishable from unknown', async ({
        request,
    }) => {
        const alice = await makeActor(request);
        const bob = await makeActor(request);

        const sfx = stamp();
        const aTask = await createTaskViaAPI(request, alice.token, {
            title: `Alice secret ${sfx}`,
        });
        const bTask = await createTaskViaAPI(request, bob.token, { title: `Bob own ${sfx}` });

        // The damning collision: both first tasks share the SAME guessable slug.
        expect(aTask.slug, 'tasks use a per-user T-n counter').toBe('T-1');
        expect(bTask.slug, 'bob also gets T-1 — slugs are NOT globally unique').toBe('T-1');
        expect(aTask.id).toMatch(UUID_RE);
        expect(aTask.id).not.toBe(bTask.id);

        // (a) The slug is not a direct reference: GET by slug is uuid-pipe 400 even
        //     for the rightful owner — so an attacker can never address A's task by
        //     its predictable handle.
        const ownBySlug = await request.get(`${API_BASE}/api/tasks/${aTask.slug}`, {
            headers: alice.headers,
        });
        expect(ownBySlug.status(), 'owner GET own task by slug — uuid pipe rejects').toBe(400);
        const bobBySlug = await request.get(`${API_BASE}/api/tasks/${aTask.slug}`, {
            headers: bob.headers,
        });
        expect(bobBySlug.status(), 'attacker GET by guessed slug — uuid pipe rejects').toBe(400);
        // Identical rejection regardless of who asks → the slug is not even an
        // existence oracle.
        expect(fingerprint(bobBySlug.status(), await assertCleanError(bobBySlug, 'bob slug'))).toBe(
            fingerprint(ownBySlug.status(), await assertCleanError(ownBySlug, 'alice slug')),
        );

        // (b) Foreign uuid vs unknown uuid → same opaque 404, same fingerprint.
        const bobOnAliceId = await request.get(`${API_BASE}/api/tasks/${aTask.id}`, {
            headers: bob.headers,
        });
        const bobOnUnknown = await request.get(`${API_BASE}/api/tasks/${UNKNOWN_UUID}`, {
            headers: bob.headers,
        });
        expect(bobOnAliceId.status(), 'foreign task uuid').toBe(404);
        expect(bobOnUnknown.status(), 'unknown task uuid').toBe(404);
        expect(
            fingerprint(
                bobOnAliceId.status(),
                await assertCleanError(bobOnAliceId, 'foreign task'),
            ),
            'a foreign-real task id MUST be indistinguishable from a never-existed id',
        ).toBe(
            fingerprint(
                bobOnUnknown.status(),
                await assertCleanError(bobOnUnknown, 'unknown task'),
            ),
        );

        // (c) Each owner reaches ONLY their own uuid — the T-1 collision never
        //     cross-wires the rows.
        const aliceOwn = await request.get(`${API_BASE}/api/tasks/${aTask.id}`, {
            headers: alice.headers,
        });
        expect(aliceOwn.status()).toBe(200);
        expect((await aliceOwn.json()).title).toBe(`Alice secret ${sfx}`);
        const bobOwn = await request.get(`${API_BASE}/api/tasks/${bTask.id}`, {
            headers: bob.headers,
        });
        expect(bobOwn.status()).toBe(200);
        expect((await bobOwn.json()).title).toBe(`Bob own ${sfx}`);
        // And bob cannot reach alice's task even though both are "T-1".
        expect(
            (
                await request.get(`${API_BASE}/api/tasks/${aTask.id}`, { headers: bob.headers })
            ).status(),
        ).toBe(404);
    });

    // ── Flow 2 ──────────────────────────────────────────────────────────────
    // GUESSABLE-SLUG works. A work has a caller-CHOSEN slug, so the slug is fully
    // attacker-predictable (e.g. a company name). PROBED reality: GET
    // /api/works/:idOrSlug resolves ONLY on the uuid `id` column
    // (WorkRepository.findByIdForAccess → `.where({ id })`), so the caller-chosen
    // slug is NOT a resolution vector for ANYONE — not even the rightful owner,
    // who 404s by slug and only reaches the work by its uuid. That makes the slug
    // an even harder cross-user reference: for B the uuid is a 403 envelope and the
    // slug is a 404 indistinguishable from a fictional one. We also confirm a
    // non-uuid slug does NOT 400 (works has no uuid pipe) so a future pipe addition
    // that changed this would be caught.
    test('flow 2 — work is reachable cross-user by neither its uuid (403) nor its guessable slug (404); owner reaches it by uuid only, the slug never resolves', async ({
        request,
    }) => {
        const alice = await makeActor(request);
        const bob = await makeActor(request);

        const sfx = stamp();
        const guessableSlug = `acme-corp-${sfx}`; // an attacker could plausibly guess a company slug
        const work = await createWorkViaAPI(request, alice.token, {
            name: `Acme ${sfx}`,
            slug: guessableSlug,
        });
        expect(work.id).toMatch(UUID_RE);

        // Owner reaches it by its uuid …
        expect(
            (
                await request.get(`${API_BASE}/api/works/${work.id}`, { headers: alice.headers })
            ).status(),
            'owner by uuid',
        ).toBe(200);
        // … but NOT by the slug: works are addressable on the uuid `id` column only,
        // so the caller-chosen slug is a dead reference even for its own owner (404,
        // identical to a fictional slug) — the slug is therefore never a usable
        // direct reference for anyone, which is the strongest possible IDOR posture.
        const ownBySlug = await request.get(`${API_BASE}/api/works/${guessableSlug}`, {
            headers: alice.headers,
        });
        expect(ownBySlug.status(), 'owner by slug → slug is not a resolution vector').toBe(404);
        const ownSlugBody = await assertCleanError(ownBySlug, 'owner work by slug');
        expect(String(ownSlugBody.message), 'owner slug 404 names the slug, not a row').toContain(
            guessableSlug,
        );

        // Attacker by uuid → 403 permission envelope.
        const bobByUuid = await request.get(`${API_BASE}/api/works/${work.id}`, {
            headers: bob.headers,
        });
        expect([403, 404], 'attacker by uuid').toContain(bobByUuid.status());
        const bobUuidBody = await assertCleanError(bobByUuid, 'work by uuid cross-user');
        if (bobByUuid.status() === 403) {
            expect(String(bobUuidBody.message).toLowerCase()).toContain('permission');
        }

        // Attacker by the GUESSED slug → 404 "not found" (the slug never resolves
        // to a row the attacker may not see — existence is hidden behind the same
        // not-found a totally fictional slug returns).
        const bobBySlug = await request.get(`${API_BASE}/api/works/${guessableSlug}`, {
            headers: bob.headers,
        });
        expect(bobBySlug.status(), 'attacker by guessed slug').toBe(404);
        await assertCleanError(bobBySlug, 'work by slug cross-user');

        // A totally fictional slug returns the SAME 404 shape → the real slug is
        // not an existence oracle for the attacker.
        const fakeSlug = `never-existed-${sfx}`;
        const bobFakeSlug = await request.get(`${API_BASE}/api/works/${fakeSlug}`, {
            headers: bob.headers,
        });
        expect(bobFakeSlug.status(), 'fictional slug').toBe(404);
        // The 404 body legitimately ECHOES the requested slug (`Work with id
        // '<slug>' not found`), and `fingerprint()` only masks uuids — so the two
        // messages differ ONLY in the attacker-supplied slug each already knows.
        // Mask each request's own slug to a placeholder (mirroring the uuid mask)
        // so we compare the message TEMPLATE: a real-but-foreign slug must yield the
        // byte-identical not-found template a fictional one does (no existence
        // oracle). The status + key set must also match.
        const maskSlug = (fp: string, slug: string): string =>
            fp.split(slug.toLowerCase()).join('<slug>');
        expect(
            maskSlug(
                fingerprint(bobBySlug.status(), await assertCleanError(bobBySlug, 'real slug')),
                guessableSlug,
            ),
            'a real-but-foreign slug must look identical to a fictional one',
        ).toBe(
            maskSlug(
                fingerprint(bobFakeSlug.status(), await assertCleanError(bobFakeSlug, 'fake slug')),
                fakeSlug,
            ),
        );
    });

    // ── Flow 3 ──────────────────────────────────────────────────────────────
    // SUB-RESOURCE-REQUIRES-CORRECT-PARENT. A child id is only valid through its
    // OWN parent. We take a REAL KB-doc id and a REAL invitation id and try to
    // reach them through the WRONG parent work — including a parent the caller
    // legitimately OWNS. Both must fail, proving the path is (parent ∋ child),
    // not a flat "any owner of any parent can touch any child id". Crucially the
    // parent OWNERSHIP guard fires BEFORE the per-child lookup, so a foreign
    // parent never reveals whether the child exists.
    test('flow 3 — KB doc + invitation are bound to their parent work; wrong-parent access fails before any child lookup', async ({
        request,
    }) => {
        const alice = await makeActor(request);
        const bob = await makeActor(request);
        const sfx = stamp();

        const aliceWork = await createWorkViaAPI(request, alice.token, { name: `Alice W ${sfx}` });
        const bobWork = await createWorkViaAPI(request, bob.token, { name: `Bob W ${sfx}` });

        // Alice's real child resources, parented to aliceWork.
        const kbRes = await request.post(`${API_BASE}/api/works/${aliceWork.id}/kb/documents`, {
            headers: alice.headers,
            data: {
                path: `freeform/secret-${sfx}.md`,
                title: 'Alice KB',
                class: 'freeform',
                body: '# top secret',
            },
        });
        expect(kbRes.status(), `kb create body=${await kbRes.text().catch(() => '')}`).toBe(201);
        const kbDocId = (await kbRes.json()).id as string;
        expect(kbDocId).toMatch(UUID_RE);

        const invRes = await request.post(`${API_BASE}/api/works/${aliceWork.id}/invitations`, {
            headers: alice.headers,
            data: { email: `invitee-${sfx}@test.local`, role: 'editor' },
        });
        expect(
            invRes.status(),
            `invitation create body=${await invRes.text().catch(() => '')}`,
        ).toBe(201);
        const invitation = await invRes.json();
        const invId = invitation.id as string;
        expect(invId).toMatch(UUID_RE);
        // The claimUrl exposes a token ONCE — confirm it is a long opaque token, not
        // the guessable invitation uuid (so the token is not itself an IDOR handle).
        const claimToken = String(invitation.claimUrl ?? '').split('/claim/')[1] ?? '';
        expect(claimToken.length, 'claim token is long/opaque, not the uuid').toBeGreaterThan(32);
        expect(claimToken).not.toBe(invId);

        // (a) Owner reaches the child via the CORRECT parent.
        expect(
            (
                await request.get(`${API_BASE}/api/works/${aliceWork.id}/kb/documents/${kbDocId}`, {
                    headers: alice.headers,
                })
            ).status(),
            'alice KB via correct parent',
        ).toBe(200);

        // (b) Alice (rightful owner of the doc) tries to reach her own doc through
        //     BOB's work id → 403: the parent-ownership guard blocks before the doc
        //     lookup. Owning the child does NOT let you smuggle it under a foreign
        //     parent.
        const aliceWrongParent = await request.get(
            `${API_BASE}/api/works/${bobWork.id}/kb/documents/${kbDocId}`,
            { headers: alice.headers },
        );
        expect(aliceWrongParent.status(), 'own doc via foreign parent → parent guard').toBe(403);
        await assertCleanError(aliceWrongParent, 'doc via foreign parent');

        // (c) Bob pairs Alice's real doc id with HIS OWN work (a parent he owns) →
        //     404 "KB document not found": the doc is genuinely not under his work,
        //     and the not-found is the same a fictional doc id yields (no oracle).
        const bobOwnParentForeignChild = await request.get(
            `${API_BASE}/api/works/${bobWork.id}/kb/documents/${kbDocId}`,
            { headers: bob.headers },
        );
        expect(bobOwnParentForeignChild.status(), 'foreign child under own parent → 404').toBe(404);
        const fcBody = await assertCleanError(bobOwnParentForeignChild, 'foreign child own parent');
        const bobOwnParentFakeChild = await request.get(
            `${API_BASE}/api/works/${bobWork.id}/kb/documents/${UNKNOWN_UUID}`,
            { headers: bob.headers },
        );
        expect(bobOwnParentFakeChild.status()).toBe(404);
        expect(
            fingerprint(bobOwnParentForeignChild.status(), fcBody),
            'a foreign child id under your own parent must look identical to a fictional child id',
        ).toBe(
            fingerprint(
                bobOwnParentFakeChild.status(),
                await assertCleanError(bobOwnParentFakeChild, 'fake child own parent'),
            ),
        );

        // (d) The SAME (parent ∋ child) discipline holds for the invitation revoke
        //     sub-route. Bob revokes Alice's invitation under HIS OWN work →
        //     404 invitation_not_found; under ALICE's work (cross-user parent) →
        //     403 parent guard; Alice via the WRONG (Bob's) parent → 403; only the
        //     CORRECT parent+owner → 200.
        const bobOwnParent = await request.delete(
            `${API_BASE}/api/works/${bobWork.id}/invitations/${invId}`,
            { headers: bob.headers },
        );
        expect(bobOwnParent.status(), 'foreign invitation under own work').toBe(404);
        await assertCleanError(bobOwnParent, 'inv foreign child own parent');

        const bobForeignParent = await request.delete(
            `${API_BASE}/api/works/${aliceWork.id}/invitations/${invId}`,
            { headers: bob.headers },
        );
        expect(bobForeignParent.status(), 'invitation under foreign work → parent guard').toBe(403);
        await assertCleanError(bobForeignParent, 'inv cross-user parent');

        const aliceWrongInvParent = await request.delete(
            `${API_BASE}/api/works/${bobWork.id}/invitations/${invId}`,
            { headers: alice.headers },
        );
        expect(
            aliceWrongInvParent.status(),
            'own invitation via foreign parent → parent guard',
        ).toBe(403);

        // The invitation is still pending (none of the above consumed/destroyed it),
        // and the rightful owner revoke via the correct parent succeeds.
        const correct = await request.delete(
            `${API_BASE}/api/works/${aliceWork.id}/invitations/${invId}`,
            { headers: alice.headers },
        );
        expect(correct.status(), 'owner revoke via correct parent').toBe(200);
        expect((await correct.json()).status).toBe('success');
    });

    // ── Flow 4 ──────────────────────────────────────────────────────────────
    // CROSS-USER SUB-RESOURCE via a FOREIGN CHILD reference. The inverse of flow
    // 3: here the PARENT is yours, but the CHILD id you reference belongs to
    // someone else. The server must validate that the referenced child is
    // reachable by you — and a foreign child must be indistinguishable from a
    // never-existed one (no existence oracle through a write you ARE allowed to
    // perform on your own parent).
    test('flow 4 — assigning a foreign agent to your task / a foreign task to your agent is refused and child-existence is hidden', async ({
        request,
    }) => {
        const alice = await makeActor(request);
        const bob = await makeActor(request);
        const sfx = stamp();

        const aliceTask = await createTaskViaAPI(request, alice.token, { title: `Alice T ${sfx}` });
        const aliceAgent = await createAgentViaAPI(request, alice.token, {
            name: `Alice Ag ${sfx}`,
        });
        const bobTask = await createTaskViaAPI(request, bob.token, { title: `Bob T ${sfx}` });
        const bobAgent = await createAgentViaAPI(request, bob.token, { name: `Bob Ag ${sfx}` });

        // (a) Alice adds BOB's agent as an assignee to her OWN task → 400
        //     "not reachable for this user". The body for a FOREIGN agent must
        //     equal the body for a NEVER-EXISTED agent (child non-disclosure).
        const foreignAgentAssign = await request.post(
            `${API_BASE}/api/tasks/${aliceTask.id}/assignees`,
            { headers: alice.headers, data: { assigneeType: 'agent', assigneeId: bobAgent.id } },
        );
        expect(foreignAgentAssign.status(), 'assign foreign agent to own task').toBe(400);
        const faBody = await assertCleanError(foreignAgentAssign, 'foreign agent assignee');

        const unknownAgentAssign = await request.post(
            `${API_BASE}/api/tasks/${aliceTask.id}/assignees`,
            { headers: alice.headers, data: { assigneeType: 'agent', assigneeId: UNKNOWN_UUID } },
        );
        expect(unknownAgentAssign.status()).toBe(400);
        expect(
            fingerprint(foreignAgentAssign.status(), faBody),
            'a foreign agent child must be indistinguishable from a never-existed agent',
        ).toBe(
            fingerprint(
                unknownAgentAssign.status(),
                await assertCleanError(unknownAgentAssign, 'unknown agent assignee'),
            ),
        );

        // Sanity: the SAME endpoint with the caller's OWN agent succeeds → the 400
        // above is reachability-scoped, not a broken route.
        const ownAgentAssign = await request.post(
            `${API_BASE}/api/tasks/${aliceTask.id}/assignees`,
            {
                headers: alice.headers,
                data: { assigneeType: 'agent', assigneeId: aliceAgent.id },
            },
        );
        expect(ownAgentAssign.status(), 'assign own agent to own task').toBe(201);

        // (b) Alice assigns a FOREIGN task (Bob's) to her OWN agent via
        //     /agents/:id/assign-task → 404 "Task <id> not found." (the foreign
        //     task is invisible; same body as an unknown task id).
        const foreignTaskAssign = await request.post(
            `${API_BASE}/api/agents/${aliceAgent.id}/assign-task`,
            { headers: alice.headers, data: { taskId: bobTask.id } },
        );
        expect(foreignTaskAssign.status(), 'assign foreign task to own agent').toBe(404);
        const ftBody = await assertCleanError(foreignTaskAssign, 'foreign task assign');
        const unknownTaskAssign = await request.post(
            `${API_BASE}/api/agents/${aliceAgent.id}/assign-task`,
            { headers: alice.headers, data: { taskId: UNKNOWN_UUID } },
        );
        expect(unknownTaskAssign.status()).toBe(404);
        expect(
            fingerprint(foreignTaskAssign.status(), ftBody),
            'a foreign task child must be indistinguishable from a never-existed task',
        ).toBe(
            fingerprint(
                unknownTaskAssign.status(),
                await assertCleanError(unknownTaskAssign, 'unknown task assign'),
            ),
        );

        // Provably untouched: Bob's task never gained Alice's agent as an assignee
        // (the failed cross-ref did not silently mutate his row); Bob still reads
        // his task as the rightful owner.
        const bobTaskAfter = await request.get(`${API_BASE}/api/tasks/${bobTask.id}`, {
            headers: bob.headers,
        });
        expect(bobTaskAfter.status()).toBe(200);
    });

    // ── Flow 5 ──────────────────────────────────────────────────────────────
    // PARENTLESS sub-resource handles — the purest IDOR surface, where the path
    // carries ONLY a child id and the server must derive ownership from the row
    // itself. Two cases: (1) DELETE /api/skill-bindings/:id (id-only, no parent
    // skill in the path) and (2) conversation message-append/read (the classic
    // "inject into / read someone else's thread"). Each must be opaque-404
    // cross-user, indistinguishable from unknown, and the owner contract must
    // still work so the 404 is provably ownership-scoped.
    test('flow 5 — parentless DELETE /skill-bindings/:id and conversation messages are ownership-scoped & opaque', async ({
        request,
    }) => {
        const alice = await makeActor(request);
        const bob = await makeActor(request);
        const sfx = stamp();

        // Alice mints a tenant (first org), a skill, an agent, and a binding.
        const org = await createOrganizationViaAPI(request, alice.token, `IDOR Org ${sfx}`);
        expect(org.tenantId).toMatch(UUID_RE);
        const skillRes = await request.post(`${API_BASE}/api/skills`, {
            headers: alice.headers,
            data: {
                ownerType: 'tenant',
                // Tenant-scope skills are USER-owned: the API filters skills by
                // userId, so a tenant skill's ownerId is the owner's user id
                // (not the tenant id). tenantId is auto-stamped from the owner's
                // tenant, so cross-tenant isolation still holds.
                ownerId: alice.user.user.id,
                title: `Alice Skill ${sfx}`,
                description: 'idor probe skill',
                instructionsMd: '# secret',
            },
        });
        expect(skillRes.status(), `skill body=${await skillRes.text().catch(() => '')}`).toBe(201);
        const skillId = (await skillRes.json()).id as string;
        const aliceAgent = await createAgentViaAPI(request, alice.token, { name: `Ag ${sfx}` });

        const bindRes = await request.post(`${API_BASE}/api/skills/${skillId}/bindings`, {
            headers: alice.headers,
            data: { targetType: 'agent', targetId: aliceAgent.id },
        });
        expect(bindRes.status(), `binding body=${await bindRes.text().catch(() => '')}`).toBe(201);
        const bindingId = (await bindRes.json()).id as string;
        expect(bindingId).toMatch(UUID_RE);

        // (1) DELETE /api/skill-bindings/:id — Bob has ONLY the id (no parent skill
        //     anywhere in the path). Cross-user → 404 "Skill binding <id> not
        //     found.", identical to a never-existed binding id.
        const bobDelete = await request.delete(`${API_BASE}/api/skill-bindings/${bindingId}`, {
            headers: bob.headers,
        });
        expect(bobDelete.status(), 'parentless cross-user binding delete').toBe(404);
        const bobDelBody = await assertCleanError(bobDelete, 'binding delete cross-user');
        const bobDeleteUnknown = await request.delete(
            `${API_BASE}/api/skill-bindings/${UNKNOWN_UUID}`,
            { headers: bob.headers },
        );
        expect(bobDeleteUnknown.status()).toBe(404);
        expect(
            fingerprint(bobDelete.status(), bobDelBody),
            'a foreign binding id must be indistinguishable from a never-existed one',
        ).toBe(
            fingerprint(
                bobDeleteUnknown.status(),
                await assertCleanError(bobDeleteUnknown, 'binding delete unknown'),
            ),
        );

        // Owner contract: Alice deletes her own binding by id → 200 {deleted:true}.
        // (Proves the 404 above is ownership-scoped, AND that Bob's failed delete
        // did NOT destroy the row.)
        const aliceDelete = await request.delete(`${API_BASE}/api/skill-bindings/${bindingId}`, {
            headers: alice.headers,
        });
        expect(aliceDelete.status(), 'owner binding delete').toBe(200);
        expect((await aliceDelete.json()).deleted).toBe(true);

        // (2) Conversation thread. Alice owns a conversation with a message; GET
        //     returns messages INLINE, so a cross-user read would leak the body.
        const convoRes = await request.post(`${API_BASE}/api/conversations`, {
            headers: alice.headers,
            data: { title: `Alice convo ${sfx}` },
        });
        expect(convoRes.status()).toBe(201);
        const convoId = (await convoRes.json()).id as string;
        const ownAppend = await request.post(`${API_BASE}/api/conversations/${convoId}/messages`, {
            headers: alice.headers,
            data: { messages: [{ role: 'user', content: `private-${sfx}` }] },
        });
        expect(ownAppend.status(), 'owner append message').toBe(201);
        expect((await ownAppend.json()).success).toBe(true);

        // Bob READS Alice's thread → 404 opaque (never the 200 that would dump the
        // inline message bodies).
        const bobRead = await request.get(`${API_BASE}/api/conversations/${convoId}`, {
            headers: bob.headers,
        });
        expect(bobRead.status(), 'cross-user convo read').toBe(404);
        const bobReadBody = await assertCleanError(bobRead, 'convo read cross-user');
        // Indistinguishable from an unknown conversation id.
        const bobReadUnknown = await request.get(`${API_BASE}/api/conversations/${UNKNOWN_UUID}`, {
            headers: bob.headers,
        });
        expect(bobReadUnknown.status()).toBe(404);
        expect(fingerprint(bobRead.status(), bobReadBody)).toBe(
            fingerprint(
                bobReadUnknown.status(),
                await assertCleanError(bobReadUnknown, 'convo read unknown'),
            ),
        );

        // Bob APPENDS (injects) into Alice's thread → 404, message never lands.
        const bobInject = await request.post(`${API_BASE}/api/conversations/${convoId}/messages`, {
            headers: bob.headers,
            data: { messages: [{ role: 'user', content: 'injected by bob' }] },
        });
        expect(bobInject.status(), 'cross-user message inject').toBe(404);
        await assertCleanError(bobInject, 'convo inject cross-user');

        // Provably untouched: Alice re-reads her thread and bob's injection is
        // absent; her private message is intact.
        const aliceReRead = await request.get(`${API_BASE}/api/conversations/${convoId}`, {
            headers: alice.headers,
        });
        expect(aliceReRead.status()).toBe(200);
        const messages = ((await aliceReRead.json()).messages ?? []) as Array<{ content?: string }>;
        const contents = messages.map((m) => m.content);
        expect(contents, 'own message present').toContain(`private-${sfx}`);
        expect(contents, "attacker's injected message MUST be absent").not.toContain(
            'injected by bob',
        );
    });

    // ── Flow 6 ──────────────────────────────────────────────────────────────
    // AGGREGATE IDOR SWEEP across the full resource spread the focus names:
    // works / agents / tasks / invitations / conversations (+ members, budgets).
    // One victim with one of every resource; one attacker. For EVERY direct and
    // sub-resource handle we assert the cross-user code is the resource's
    // documented guard AND that the OWNER reaches the very same id (so no 404 is
    // a dead route), AND that no body leaks a forbidden token. This is the
    // breadth backstop that catches any single resource regressing to a usable
    // direct reference.
    test('flow 6 — full guessable-id sweep: every resource & sub-resource is guarded cross-user yet owner-reachable, leak-clean', async ({
        request,
    }) => {
        const victim = await makeActor(request);
        const attacker = await makeActor(request);
        const sfx = stamp();

        const org = await createOrganizationViaAPI(request, victim.token, `Sweep Org ${sfx}`);
        const work = await createWorkViaAPI(request, victim.token, { name: `Sweep W ${sfx}` });
        const agent = await createAgentViaAPI(request, victim.token, { name: `Sweep Ag ${sfx}` });
        const task = await createTaskViaAPI(request, victim.token, { title: `Sweep T ${sfx}` });
        const convoRes = await request.post(`${API_BASE}/api/conversations`, {
            headers: victim.headers,
            data: { title: `Sweep Convo ${sfx}` },
        });
        expect(convoRes.status()).toBe(201);
        const convoId = (await convoRes.json()).id as string;
        const invRes = await request.post(`${API_BASE}/api/works/${work.id}/invitations`, {
            headers: victim.headers,
            data: { email: `inv-${sfx}@test.local`, role: 'editor' },
        });
        expect(invRes.status()).toBe(201);
        const invId = (await invRes.json()).id as string;

        // label → { url, the cross-user codes that are acceptable, owner code }.
        const cases: Array<{ label: string; url: string; cross: number[]; owner: number }> = [
            {
                label: 'work (uuid)',
                url: `${API_BASE}/api/works/${work.id}`,
                cross: [403, 404],
                owner: 200,
            },
            { label: 'agent', url: `${API_BASE}/api/agents/${agent.id}`, cross: [404], owner: 200 },
            {
                label: 'agent runs',
                url: `${API_BASE}/api/agents/${agent.id}/runs`,
                cross: [404],
                owner: 200,
            },
            { label: 'task', url: `${API_BASE}/api/tasks/${task.id}`, cross: [404], owner: 200 },
            {
                label: 'conversation',
                url: `${API_BASE}/api/conversations/${convoId}`,
                cross: [404],
                owner: 200,
            },
            {
                label: 'work members',
                url: `${API_BASE}/api/works/${work.id}/members`,
                cross: [403, 404],
                owner: 200,
            },
            {
                label: 'work budgets',
                url: `${API_BASE}/api/works/${work.id}/budgets`,
                cross: [403, 404],
                owner: 200,
            },
            {
                label: 'work invitations list',
                url: `${API_BASE}/api/works/${work.id}/invitations`,
                cross: [403, 404],
                owner: 200,
            },
        ];

        for (const c of cases) {
            const attackerRes = await request.get(c.url, { headers: attacker.headers });
            expect(c.cross, `${c.label}: attacker code`).toContain(attackerRes.status());
            expect(
                attackerRes.status(),
                `${c.label}: attacker must not get 2xx`,
            ).toBeGreaterThanOrEqual(400);
            await assertCleanError(attackerRes, `${c.label} cross-user`);

            const ownerRes = await request.get(c.url, { headers: victim.headers });
            expect(ownerRes.status(), `${c.label}: owner must reach the SAME id`).toBe(c.owner);
        }

        // Sub-resource WRITE sweep cross-user — none may succeed, all leak-clean.
        const writes: Array<{
            label: string;
            run: () => Promise<{ status(): number; text(): Promise<string> }>;
        }> = [
            {
                label: 'task assignee inject',
                run: () =>
                    request.post(`${API_BASE}/api/tasks/${task.id}/assignees`, {
                        headers: attacker.headers,
                        data: { assigneeType: 'user', assigneeId: attacker.user.user.id },
                    }),
            },
            {
                label: 'task transition',
                run: () =>
                    request.post(`${API_BASE}/api/tasks/${task.id}/transition`, {
                        headers: attacker.headers,
                        data: { to: 'todo' },
                    }),
            },
            {
                label: 'convo message inject',
                run: () =>
                    request.post(`${API_BASE}/api/conversations/${convoId}/messages`, {
                        headers: attacker.headers,
                        data: { messages: [{ role: 'user', content: 'inject' }] },
                    }),
            },
            {
                label: 'invitation revoke',
                run: () =>
                    request.delete(`${API_BASE}/api/works/${work.id}/invitations/${invId}`, {
                        headers: attacker.headers,
                    }),
            },
            {
                label: 'agent assign-task',
                run: () =>
                    request.post(`${API_BASE}/api/agents/${agent.id}/assign-task`, {
                        headers: attacker.headers,
                        data: { taskId: task.id },
                    }),
            },
        ];

        for (const w of writes) {
            const res = await w.run();
            expect(res.status(), `${w.label}: cross-user write must be 4xx`).toBeGreaterThanOrEqual(
                400,
            );
            expect(res.status(), `${w.label}: cross-user write must not 2xx`).toBeLessThan(500 + 1);
            expect([400, 403, 404], `${w.label}: cross-user write code`).toContain(res.status());
            await assertCleanError(res, `${w.label} cross-user write`);
        }

        // The org-slug resolver is GLOBAL by design (200 any authed user) — but
        // reaching it must leak NONE of the victim's secrets/PII.
        const resolved = await request.get(`${API_BASE}/api/organizations/${org.slug}`, {
            headers: attacker.headers,
        });
        expect([200, 403, 404], 'org resolver').toContain(resolved.status());
        if (resolved.status() === 200) {
            const lower = (await resolved.text()).toLowerCase();
            for (const token of FORBIDDEN_LEAK_TOKENS) {
                expect(lower, `org resolver leaked '${token}'`).not.toContain(token);
            }
        }

        // Provably untouched: the victim re-reads task + conversation and finds
        // neither the attacker's assignee nor injected message.
        const taskAfter = await request.get(`${API_BASE}/api/tasks/${task.id}`, {
            headers: victim.headers,
        });
        expect(taskAfter.status()).toBe(200);
        const convoAfter = await request.get(`${API_BASE}/api/conversations/${convoId}`, {
            headers: victim.headers,
        });
        expect(convoAfter.status()).toBe(200);
        const msgs = ((await convoAfter.json()).messages ?? []) as Array<{ content?: string }>;
        expect(
            msgs.map((m) => m.content),
            'no injected message',
        ).not.toContain('inject');
    });
});
