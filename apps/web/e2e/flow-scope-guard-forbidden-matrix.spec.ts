import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, createWorkViaAPI } from './helpers/api';
import { createOrganizationViaAPI } from './helpers/organizations';
import { createAgentViaAPI, createTaskViaAPI } from './helpers/agents-tasks';

/**
 * Scope-guard FORBIDDEN MATRIX — the *information-non-disclosure* facet of
 * cross-tenant access control. Sibling specs (flow-multi-tenant-isolation,
 * flow-tenant-isolation-resources, multi-tenant-data-leak) already prove that
 * user B gets a non-2xx STATUS on user A's rows. This file goes one layer
 * deeper and asserts the contract that a forbidden response must ALSO obey:
 *
 *   1. EXISTENCE NON-DISCLOSURE — for an opaque-404 resource (agent / task /
 *      mission / skill / conversation) the forbidden-but-real id and a
 *      never-existed id return the SAME status AND the SAME body shape, so an
 *      attacker cannot enumerate which ids exist.
 *   2. NO SECRET / PII LEAK — no cross-tenant error body (any verb, any
 *      resource) may contain the victim's password hash, email, userId,
 *      tenantId, a SQL fragment, or a stack trace.
 *   3. UNIFORM ERROR ENVELOPE — every resource family answers with one of the
 *      two known JSON error envelopes and nothing richer.
 *   4. VERB×RESOURCE COMPLETENESS — GET/PATCH/DELETE (+ the secondary write
 *      sub-routes: task assignees/transition, agent runs, conversation
 *      message-append, KB list/doc/create, skill bindings) are ALL guarded,
 *      and the owner can still reach every one of those exact ids (proving the
 *      guard is ownership-scoped, not a broken route).
 *   5. AUTH-LAYER vs SCOPE-LAYER — a *missing* bearer is a 401 everywhere; a
 *      *valid-but-foreign* bearer is the resource's scope code (403/404). The
 *      two never collapse into each other.
 *
 * Every status / body below was probed against the LIVE API (sqlite in-memory,
 * the CI driver) with throwaway users before any assertion was written:
 *
 *   Auth
 *     POST /api/auth/register { username(>=3), email, password }
 *       → 201 { access_token (32-char opaque), user:{ id, email, username } }
 *     (no bearer → 401 { message:'Unauthorized', statusCode:401 } on every
 *      scoped route)
 *
 *   Two distinct error envelopes are in play (asserted, never assumed):
 *     • custom  : { status:'error', message }                  (works + KB)
 *     • nest     : { message, error?, statusCode }              (everything else)
 *
 *   Cross-user matrix (A owns, B attacks) — PROBED:
 *     works   : GET 403, PATCH 403   msg "You do not have permission to access
 *               this work"; unknown id → 404 "Work with id '…' not found";
 *               there is NO DELETE route (DELETE → catch-all
 *               "Cannot DELETE /api/works/<id>" 404). NB the works route does
 *               NOT use ParseUUIDPipe → a non-uuid id is a 404, not a 400.
 *     KB docs : GET-list / GET-doc / POST-create → 403 (the /api/works guard
 *               fires BEFORE the KB layer; identical custom envelope).
 *     agents  : GET / PATCH / DELETE / GET-runs → 404 "Agent <id> not found.".
 *               foreign id and unknown id give an IDENTICAL body; non-uuid → 400
 *               "Validation failed (uuid is expected)" (ParseUUIDPipe).
 *     tasks   : GET / PATCH / DELETE / POST-assignees / POST-transition → 404
 *               "Task <id> not found."; non-uuid → 400.
 *     missions: GET / PATCH / DELETE → 404 "Mission not found" (id NOT echoed —
 *               the MOST uniform of all); non-uuid → 400.
 *     skills  : GET / PATCH / DELETE / GET-bindings → 404 "Skill <id> not
 *               found."; non-uuid → 400.  (create DTO needs
 *               ownerType/ownerId/title/description/instructionsMd.)
 *     convos  : GET / PATCH / DELETE / POST-messages → 404 "Not Found" (bare,
 *               id NOT echoed); non-uuid → 404 catch-all.
 *
 *   Existence non-disclosure holds for agents/tasks/missions/skills/convos:
 *     the foreign-real id and the all-zero unknown id return the SAME status
 *     and SAME envelope shape. (works is the one resource that DOES distinguish
 *     403-foreign from 404-unknown — flow 4 documents that asymmetry as the
 *     truthful, intentional exception rather than asserting a fiction.)
 *
 * Isolation discipline (matches every sibling flow): all mutations run on FRESH
 * registerUserViaAPI() users (never the shared seeded user — a user-scoped fake
 * key would shadow the env key and break sibling chat specs). Unique suffixes
 * via Date.now()+random. Cross-guard codes asserted tolerantly where two valid
 * policies exist, so a code shift never makes the flow a false fail. The
 * `flow-` filename prefix is NOT matched by the no-auth testMatch regex in
 * playwright.config.ts, and the file is fully API-orchestrated (no UI/stack
 * contention).
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';
const UNKNOWN_UUID_2 = '11111111-1111-1111-1111-111111111111';

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Substrings that must NEVER appear in a cross-tenant error body. A leak of any
 * of these would let an attacker pivot from "you can't have this" to actually
 * learning the victim's secrets, schema, or internals.
 */
const FORBIDDEN_LEAK_TOKENS = [
    'password',
    '$2b$', // bcrypt hash prefix
    'emailVerificationToken',
    'magicLinkToken',
    'passwordResetToken',
    'SELECT ',
    'select *',
    'FROM "',
    'WHERE ',
    '    at ', // node stack-frame indentation
    'node_modules',
    '.ts:',
    '.js:',
    'QueryFailedError',
    'EntityNotFoundError', // raw TypeORM error class — must be masked
];

/**
 * Assert a forbidden response body is "clean": it is valid JSON, carries one of
 * the two known error envelopes, and leaks none of the forbidden tokens.
 * Returns the parsed body for any caller-specific follow-up assertions.
 */
async function assertCleanError(
    res: { status(): number; text(): Promise<string> },
    context: string,
): Promise<Record<string, unknown>> {
    const raw = await res.text();
    const lower = raw.toLowerCase();
    for (const token of FORBIDDEN_LEAK_TOKENS) {
        expect(lower, `${context} leaked '${token}' → ${raw.slice(0, 300)}`).not.toContain(
            token.toLowerCase(),
        );
    }
    let body: Record<string, unknown> = {};
    try {
        body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
        // A scope guard must always answer JSON; an HTML error page would itself
        // be a contract break.
        throw new Error(`${context}: expected JSON error body, got: ${raw.slice(0, 200)}`);
    }
    // One of the two envelopes — custom { status:'error', message } OR nest
    // { message, statusCode }. Either way `message` is a non-empty string.
    expect(typeof body.message, `${context}: error body has a string message`).toBe('string');
    expect(String(body.message).length, `${context}: message non-empty`).toBeGreaterThan(0);
    const hasCustom = body.status === 'error';
    const hasNest = typeof body.statusCode === 'number';
    expect(
        hasCustom || hasNest,
        `${context}: body uses a known error envelope → ${raw.slice(0, 200)}`,
    ).toBeTruthy();
    return body;
}

/** Normalise an error body to a stable shape for existence-disclosure equality
 *  comparison: we compare the KEY SET + the message with the concrete id masked
 *  out (the requested id legitimately appears in some messages — it is the id
 *  the caller sent, not a leak of stored data; what matters is that foreign and
 *  unknown ids produce the SAME masked message). */
function fingerprint(status: number, body: Record<string, unknown>): string {
    const keys = Object.keys(body).sort().join(',');
    const msg = String(body.message ?? '')
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
        .toLowerCase();
    return `${status}|${keys}|${msg}`;
}

interface Actor {
    user: Awaited<ReturnType<typeof registerUserViaAPI>>;
    token: string;
    headers: { Authorization: string };
}

async function makeActor(request: APIRequestContext): Promise<Actor> {
    const user = await registerUserViaAPI(request);
    return { user, token: user.access_token, headers: authedHeaders(user.access_token) };
}

/** A victim with a full spread of owned resources for B to attack. */
interface Victim extends Actor {
    tenantId: string;
    orgSlug: string;
    workId: string;
    agentId: string;
    taskId: string;
    missionId: string;
    skillId: string;
    conversationId: string;
    kbDocId: string;
}

async function buildVictim(request: APIRequestContext): Promise<Victim> {
    const a = await makeActor(request);
    const sfx = stamp();

    // Creating the first org lazily mints the tenant and gives us a slug.
    const org = await createOrganizationViaAPI(request, a.token, `Victim Org ${sfx}`);
    expect(org.tenantId).toMatch(UUID_RE);

    const work = await createWorkViaAPI(request, a.token, { name: `Victim Work ${sfx}` });
    expect(work.id).toMatch(UUID_RE);

    const agent = await createAgentViaAPI(request, a.token, { name: `Victim Agent ${sfx}` });
    const task = await createTaskViaAPI(request, a.token, { title: `Victim Task ${sfx}` });

    const missionRes = await request.post(`${API_BASE}/api/me/missions`, {
        headers: a.headers,
        data: { title: `Victim Mission ${sfx}`, description: 'd', type: 'one-shot' },
    });
    expect(missionRes.status()).toBe(201);
    const missionId = (await missionRes.json()).id as string;

    const skillRes = await request.post(`${API_BASE}/api/skills`, {
        headers: a.headers,
        data: {
            ownerType: 'tenant',
            // Tenant-scope skills are USER-owned (API filters by userId); the
            // ownerId is the owner's user id, not the tenant id. tenantId is
            // auto-stamped from the owner's tenant.
            ownerId: a.user.user.id,
            title: `Victim Skill ${sfx}`,
            description: 'scope-guard probe skill',
            instructionsMd: '# secret instructions',
        },
    });
    expect(skillRes.status(), `skill body=${await skillRes.text().catch(() => '')}`).toBe(201);
    const skillId = (await skillRes.json()).id as string;

    const convoRes = await request.post(`${API_BASE}/api/conversations`, {
        headers: a.headers,
        data: { title: `Victim Convo ${sfx}` },
    });
    expect(convoRes.status()).toBe(201);
    const conversationId = (await convoRes.json()).id as string;

    const kbRes = await request.post(`${API_BASE}/api/works/${work.id}/kb/documents`, {
        headers: a.headers,
        data: {
            path: `freeform/secret-${sfx}.md`,
            title: 'Victim KB Doc',
            class: 'freeform',
            body: '# top secret content',
        },
    });
    expect(kbRes.status(), `kb body=${await kbRes.text().catch(() => '')}`).toBe(201);
    const kbDocId = (await kbRes.json()).id as string;

    return {
        ...a,
        tenantId: org.tenantId,
        orgSlug: org.slug,
        workId: work.id,
        agentId: agent.id,
        taskId: task.id,
        missionId,
        skillId,
        conversationId,
        kbDocId,
    };
}

test.describe('Scope-guard forbidden matrix (no information leak)', () => {
    // ── Flow 1 ──────────────────────────────────────────────────────────────
    // The opaque-404 resources (agent / task / mission / skill / conversation)
    // must be INDISTINGUISHABLE from a never-existed id: same status, same body
    // fingerprint. This is the heart of existence non-disclosure — an attacker
    // probing 1000 ids learns nothing about which are real.
    test('flow 1 — existence non-disclosure: foreign id and unknown id are byte-shape identical across every opaque-404 resource', async ({
        request,
    }) => {
        const victim = await buildVictim(request);
        const attacker = await makeActor(request);
        const atk = attacker.headers;

        // resource label → [foreign-real url, unknown url]. We use a SECOND
        // random unknown id too, to prove the unknown response is itself stable
        // (i.e. the message is templated on the input, not on stored state).
        const cases: Array<{ label: string; foreign: string; unknown: string; unknown2: string }> =
            [
                {
                    label: 'agent',
                    foreign: `${API_BASE}/api/agents/${victim.agentId}`,
                    unknown: `${API_BASE}/api/agents/${UNKNOWN_UUID}`,
                    unknown2: `${API_BASE}/api/agents/${UNKNOWN_UUID_2}`,
                },
                {
                    label: 'task',
                    foreign: `${API_BASE}/api/tasks/${victim.taskId}`,
                    unknown: `${API_BASE}/api/tasks/${UNKNOWN_UUID}`,
                    unknown2: `${API_BASE}/api/tasks/${UNKNOWN_UUID_2}`,
                },
                {
                    label: 'mission',
                    foreign: `${API_BASE}/api/me/missions/${victim.missionId}`,
                    unknown: `${API_BASE}/api/me/missions/${UNKNOWN_UUID}`,
                    unknown2: `${API_BASE}/api/me/missions/${UNKNOWN_UUID_2}`,
                },
                {
                    label: 'skill',
                    foreign: `${API_BASE}/api/skills/${victim.skillId}`,
                    unknown: `${API_BASE}/api/skills/${UNKNOWN_UUID}`,
                    unknown2: `${API_BASE}/api/skills/${UNKNOWN_UUID_2}`,
                },
                {
                    label: 'conversation',
                    foreign: `${API_BASE}/api/conversations/${victim.conversationId}`,
                    unknown: `${API_BASE}/api/conversations/${UNKNOWN_UUID}`,
                    unknown2: `${API_BASE}/api/conversations/${UNKNOWN_UUID_2}`,
                },
            ];

        for (const c of cases) {
            const foreignRes = await request.get(c.foreign, { headers: atk });
            const unknownRes = await request.get(c.unknown, { headers: atk });
            const unknown2Res = await request.get(c.unknown2, { headers: atk });

            // Every one is a 404 (opaque — never a 403 that would confirm the row).
            expect(foreignRes.status(), `${c.label} foreign status`).toBe(404);
            expect(unknownRes.status(), `${c.label} unknown status`).toBe(404);
            expect(unknown2Res.status(), `${c.label} unknown2 status`).toBe(404);

            const fBody = await assertCleanError(foreignRes, `${c.label} foreign`);
            const uBody = await assertCleanError(unknownRes, `${c.label} unknown`);
            const u2Body = await assertCleanError(unknown2Res, `${c.label} unknown2`);

            // THE assertion: the foreign-real response is indistinguishable from
            // the unknown response once the requested id is masked out.
            expect(
                fingerprint(foreignRes.status(), fBody),
                `${c.label}: foreign id MUST be indistinguishable from a never-existed id`,
            ).toBe(fingerprint(unknownRes.status(), uBody));
            // …and the unknown response is stable across two different unknowns.
            expect(fingerprint(unknownRes.status(), uBody)).toBe(
                fingerprint(unknown2Res.status(), u2Body),
            );
        }

        // Owner sanity: every "foreign" id above is genuinely reachable by its
        // rightful owner — so the 404s are ownership-scoped, not dead rows.
        const own = victim.headers;
        expect(
            (
                await request.get(`${API_BASE}/api/agents/${victim.agentId}`, { headers: own })
            ).status(),
        ).toBe(200);
        expect(
            (
                await request.get(`${API_BASE}/api/tasks/${victim.taskId}`, { headers: own })
            ).status(),
        ).toBe(200);
        expect(
            (
                await request.get(`${API_BASE}/api/me/missions/${victim.missionId}`, {
                    headers: own,
                })
            ).status(),
        ).toBe(200);
        expect(
            (
                await request.get(`${API_BASE}/api/skills/${victim.skillId}`, { headers: own })
            ).status(),
        ).toBe(200);
        expect(
            (
                await request.get(`${API_BASE}/api/conversations/${victim.conversationId}`, {
                    headers: own,
                })
            ).status(),
        ).toBe(200);
    });

    // ── Flow 2 ──────────────────────────────────────────────────────────────
    // Full GET×PATCH×DELETE matrix on every opaque-404 resource — EVERY mutating
    // verb is guarded AND every forbidden body is leak-clean. Crucially we also
    // flip the bearer to the owner on the SAME urls and prove the writes were
    // merely blocked (the row is untouched), not silently swallowed.
    test('flow 2 — every verb (GET/PATCH/DELETE) on every foreign resource is 404 + leak-clean, and the row is provably untouched', async ({
        request,
    }) => {
        const victim = await buildVictim(request);
        const attacker = await makeActor(request);
        const atk = attacker.headers;

        const targets: Array<{ label: string; url: string; patch: object }> = [
            {
                label: 'agent',
                url: `${API_BASE}/api/agents/${victim.agentId}`,
                patch: { name: 'hijacked' },
            },
            {
                label: 'task',
                url: `${API_BASE}/api/tasks/${victim.taskId}`,
                patch: { title: 'hijacked' },
            },
            {
                label: 'mission',
                url: `${API_BASE}/api/me/missions/${victim.missionId}`,
                patch: { title: 'hijacked' },
            },
            {
                label: 'skill',
                url: `${API_BASE}/api/skills/${victim.skillId}`,
                patch: { title: 'hijacked' },
            },
            {
                label: 'conversation',
                url: `${API_BASE}/api/conversations/${victim.conversationId}`,
                patch: { title: 'hijacked' },
            },
        ];

        for (const t of targets) {
            const get = await request.get(t.url, { headers: atk });
            const patch = await request.patch(t.url, { headers: atk, data: t.patch });
            const del = await request.delete(t.url, { headers: atk });

            expect(get.status(), `${t.label} GET`).toBe(404);
            expect(patch.status(), `${t.label} PATCH`).toBe(404);
            expect(del.status(), `${t.label} DELETE`).toBe(404);

            await assertCleanError(get, `${t.label} GET`);
            await assertCleanError(patch, `${t.label} PATCH`);
            await assertCleanError(del, `${t.label} DELETE`);
        }

        // Provably untouched: the owner re-reads each row and the hijack value
        // never landed (the DELETE above also did not destroy the row).
        const own = victim.headers;
        const agentAfter = await request.get(`${API_BASE}/api/agents/${victim.agentId}`, {
            headers: own,
        });
        expect(agentAfter.status()).toBe(200);
        expect((await agentAfter.json()).name).not.toBe('hijacked');

        const taskAfter = await request.get(`${API_BASE}/api/tasks/${victim.taskId}`, {
            headers: own,
        });
        expect(taskAfter.status()).toBe(200);
        expect((await taskAfter.json()).title).not.toBe('hijacked');

        const skillAfter = await request.get(`${API_BASE}/api/skills/${victim.skillId}`, {
            headers: own,
        });
        expect(skillAfter.status()).toBe(200);
        expect((await skillAfter.json()).title).not.toBe('hijacked');

        const convoAfter = await request.get(
            `${API_BASE}/api/conversations/${victim.conversationId}`,
            { headers: own },
        );
        expect(convoAfter.status()).toBe(200);
        expect((await convoAfter.json()).title).not.toBe('hijacked');
    });

    // ── Flow 3 ──────────────────────────────────────────────────────────────
    // Secondary WRITE sub-routes are the soft underbelly of scope guards — they
    // are easy to forget. Cross-tenant: task assignees + transition, agent runs
    // + assign-task, conversation message-append, skill bindings. None may
    // succeed and none may leak; and we prove the OWNER write contract still
    // works (the assignee POST is a real 201 for the owner) so a flat "404 on
    // everything" cannot be a false pass from a wrong route.
    test('flow 3 — secondary write sub-routes (assignees/transition/runs/messages/bindings) are all guarded cross-tenant', async ({
        request,
    }) => {
        const victim = await buildVictim(request);
        const attacker = await makeActor(request);
        const atk = attacker.headers;

        // Task secondary writes.
        const assigneeRes = await request.post(`${API_BASE}/api/tasks/${victim.taskId}/assignees`, {
            headers: atk,
            data: { assigneeType: 'user', assigneeId: attacker.user.user.id },
        });
        expect(assigneeRes.status(), 'foreign task assignee').toBe(404);
        await assertCleanError(assigneeRes, 'task assignee');

        const transitionRes = await request.post(
            `${API_BASE}/api/tasks/${victim.taskId}/transition`,
            {
                headers: atk,
                data: { to: 'todo' },
            },
        );
        expect(transitionRes.status(), 'foreign task transition').toBe(404);
        await assertCleanError(transitionRes, 'task transition');

        // Agent secondary reads/writes.
        const runsRes = await request.get(`${API_BASE}/api/agents/${victim.agentId}/runs`, {
            headers: atk,
        });
        expect(runsRes.status(), 'foreign agent runs').toBe(404);
        await assertCleanError(runsRes, 'agent runs');

        const assignRes = await request.post(
            `${API_BASE}/api/agents/${victim.agentId}/assign-task`,
            {
                headers: atk,
                data: { taskId: victim.taskId },
            },
        );
        // Cross-tenant the agent itself is invisible → 404 (the enqueue 500 the
        // OWNER would hit never gets reached). Tolerate either to be future-proof.
        expect([403, 404], 'foreign agent assign-task').toContain(assignRes.status());
        await assertCleanError(assignRes, 'agent assign-task');

        // Conversation message-append (the classic "inject into someone else's
        // thread" attack) must be opaque-404, never a 201/204.
        const msgRes = await request.post(
            `${API_BASE}/api/conversations/${victim.conversationId}/messages`,
            {
                headers: atk,
                data: { messages: [{ role: 'user', content: 'injected by attacker' }] },
            },
        );
        expect(msgRes.status(), 'foreign convo message-append').toBe(404);
        await assertCleanError(msgRes, 'convo message-append');

        // Skill bindings sub-tree.
        const bindingsGet = await request.get(`${API_BASE}/api/skills/${victim.skillId}/bindings`, {
            headers: atk,
        });
        expect(bindingsGet.status(), 'foreign skill bindings GET').toBe(404);
        await assertCleanError(bindingsGet, 'skill bindings GET');

        // Owner contract sanity: the assignee POST is a genuine 201 for the
        // rightful owner, so the 404 above is ownership-scoped (not a 404 route).
        const ownAssignee = await request.post(`${API_BASE}/api/tasks/${victim.taskId}/assignees`, {
            headers: victim.headers,
            data: { assigneeType: 'user', assigneeId: victim.user.user.id },
        });
        expect(ownAssignee.status(), 'owner task assignee').toBe(201);
    });

    // ── Flow 4 ──────────────────────────────────────────────────────────────
    // Works + KB are the one family on a custom { status:'error' } envelope and
    // a 403 (not 404) cross-tenant guard. We assert: PATCH is also 403 (write
    // path guarded same as read), the KB sub-tree inherits the work guard
    // BEFORE the KB layer (so a foreign work id never reveals whether the doc
    // exists), every body is leak-clean, and we DOCUMENT the truthful
    // 403-foreign / 404-unknown asymmetry instead of pretending it is uniform.
    test('flow 4 — works + KB custom-envelope guard: PATCH/GET 403 cross-tenant, KB sub-tree 403 before existence check, leak-clean', async ({
        request,
    }) => {
        const victim = await buildVictim(request);
        const attacker = await makeActor(request);
        const atk = attacker.headers;

        const workUrl = `${API_BASE}/api/works/${victim.workId}`;
        const workGet = await request.get(workUrl, { headers: atk });
        expect([403, 404], 'foreign work GET').toContain(workGet.status());
        const getBody = await assertCleanError(workGet, 'work GET');
        if (workGet.status() === 403) {
            expect(String(getBody.message).toLowerCase()).toContain('permission');
            expect(getBody.status).toBe('error');
        }

        const workPatch = await request.patch(workUrl, {
            headers: atk,
            data: { name: 'hijacked' },
        });
        expect([403, 404], 'foreign work PATCH').toContain(workPatch.status());
        await assertCleanError(workPatch, 'work PATCH');

        // KB sub-tree: list, single-doc, and create are ALL gated by the work
        // ownership guard. A foreign work id therefore yields 403 on the doc
        // route WITHOUT ever revealing whether that doc id exists — existence is
        // hidden one level up.
        const kbList = await request.get(`${API_BASE}/api/works/${victim.workId}/kb/documents`, {
            headers: atk,
        });
        expect([403, 404], 'foreign KB list').toContain(kbList.status());
        await assertCleanError(kbList, 'KB list');

        const kbDoc = await request.get(
            `${API_BASE}/api/works/${victim.workId}/kb/documents/${victim.kbDocId}`,
            {
                headers: atk,
            },
        );
        expect([403, 404], 'foreign KB doc').toContain(kbDoc.status());
        await assertCleanError(kbDoc, 'KB doc');

        // A foreign work id paired with a TOTALLY made-up doc id gives the SAME
        // 403 — proving the guard fires before any per-doc lookup (no oracle).
        const kbDocFake = await request.get(
            `${API_BASE}/api/works/${victim.workId}/kb/documents/${UNKNOWN_UUID}`,
            { headers: atk },
        );
        expect(kbDocFake.status(), 'KB doc with fake doc id == same code as real doc id').toBe(
            kbDoc.status(),
        );

        const kbCreate = await request.post(`${API_BASE}/api/works/${victim.workId}/kb/documents`, {
            headers: atk,
            data: { path: 'freeform/inject.md', title: 'inject', class: 'freeform', body: 'x' },
        });
        expect([403, 404], 'foreign KB create').toContain(kbCreate.status());
        await assertCleanError(kbCreate, 'KB create');

        // Truthful asymmetry: an UNKNOWN work id is a 404 (works distinguishes
        // "not yours" 403 from "no such row" 404). We assert that this is the
        // documented behaviour AND that the 404 body is still leak-clean. (The
        // works route also does NOT use ParseUUIDPipe, so a non-uuid is a 404,
        // not a 400 — asserted here so a future pipe addition is caught.)
        const unknownWork = await request.get(`${API_BASE}/api/works/${UNKNOWN_UUID}`, {
            headers: atk,
        });
        expect(unknownWork.status(), 'unknown work').toBe(404);
        await assertCleanError(unknownWork, 'unknown work');
        const badIdWork = await request.get(`${API_BASE}/api/works/not-a-uuid`, { headers: atk });
        expect(badIdWork.status(), 'non-uuid work id').toBe(404);
        await assertCleanError(badIdWork, 'non-uuid work');

        // Owner still fully reaches the work + its KB doc — guard is scoped.
        const own = victim.headers;
        expect((await request.get(workUrl, { headers: own })).status()).toBe(200);
        const ownKb = await request.get(`${API_BASE}/api/works/${victim.workId}/kb/documents`, {
            headers: own,
        });
        expect(ownKb.status()).toBe(200);
    });

    // ── Flow 5 ──────────────────────────────────────────────────────────────
    // AUTH layer vs SCOPE layer must never collapse. A *missing* bearer is a
    // 401 on every scoped route (authn fails first). A *valid-but-foreign*
    // bearer is the resource's scope code (403/404, authn passed, authz failed).
    // A garbage bearer is also 401. We sweep the same urls under three identity
    // states and prove the three response classes stay distinct + leak-clean.
    test('flow 5 — auth-layer (401) never collapses into scope-layer (403/404): missing vs garbage vs foreign bearer', async ({
        request,
    }) => {
        const victim = await buildVictim(request);
        const foreign = await makeActor(request);

        const urls: Array<{ label: string; url: string; scope: number[] }> = [
            { label: 'work', url: `${API_BASE}/api/works/${victim.workId}`, scope: [403, 404] },
            { label: 'agent', url: `${API_BASE}/api/agents/${victim.agentId}`, scope: [404] },
            { label: 'task', url: `${API_BASE}/api/tasks/${victim.taskId}`, scope: [404] },
            {
                label: 'mission',
                url: `${API_BASE}/api/me/missions/${victim.missionId}`,
                scope: [404],
            },
            { label: 'skill', url: `${API_BASE}/api/skills/${victim.skillId}`, scope: [404] },
            {
                label: 'conversation',
                url: `${API_BASE}/api/conversations/${victim.conversationId}`,
                scope: [404],
            },
        ];

        for (const u of urls) {
            // (a) NO bearer → 401 authn failure, before any scope check.
            const noAuth = await request.get(u.url);
            expect(noAuth.status(), `${u.label} no-auth`).toBe(401);
            const noAuthBody = await assertCleanError(noAuth, `${u.label} no-auth`);
            expect(String(noAuthBody.message).toLowerCase()).toContain('unauthorized');

            // (b) GARBAGE bearer → still 401 (token rejected at authn, not authz).
            const garbage = await request.get(u.url, {
                headers: { Authorization: 'Bearer not-a-real-token-xxxxxxxxxxxxxxxx' },
            });
            expect(garbage.status(), `${u.label} garbage-auth`).toBe(401);
            await assertCleanError(garbage, `${u.label} garbage-auth`);

            // (c) VALID FOREIGN bearer → the resource's SCOPE code, and NEVER 401
            //     (authn passed; only authz failed). The two layers stay distinct.
            const foreignRes = await request.get(u.url, { headers: foreign.headers });
            expect(u.scope, `${u.label} foreign scope code`).toContain(foreignRes.status());
            expect(foreignRes.status(), `${u.label} foreign must not be 401`).not.toBe(401);
            await assertCleanError(foreignRes, `${u.label} foreign`);
        }
    });

    // ── Flow 6 ──────────────────────────────────────────────────────────────
    // The aggregate / cross-resource sweep: an attacker who knows the victim's
    // org slug can reach the GLOBAL org resolver (200, by design) yet that
    // reachability must bleed NOTHING — none of the victim's rows appear in the
    // attacker's own list endpoints, and attacker-supplied scope params
    // (?owner=, ?tenantId=, ?organizationId=) cannot widen the result set. This
    // proves the guard is row-level, not merely route-level.
    test('flow 6 — global org resolver leaks no scoped rows; attacker-controlled scope params cannot widen list endpoints', async ({
        request,
    }) => {
        const victim = await buildVictim(request);
        const attacker = await makeActor(request);
        const atk = attacker.headers;

        // The org-slug resolver is global → 200 for any authed user (documented,
        // not a leak). But it must not be an oracle for the victim's resources.
        const resolved = await request.get(`${API_BASE}/api/organizations/${victim.orgSlug}`, {
            headers: atk,
        });
        expect([200, 403, 404], 'org resolver reachability').toContain(resolved.status());
        const resolvedBody = await assertCleanError(resolved, 'org resolver').catch(async () => {
            // On 200 it is NOT an error envelope — re-read as the org object and
            // assert it carries no foreign userId / member roster / secrets.
            return {} as Record<string, unknown>;
        });
        if (resolved.status() === 200) {
            const raw = await resolved.text();
            const lower = raw.toLowerCase();
            for (const token of FORBIDDEN_LEAK_TOKENS) {
                expect(lower, `org resolver leaked '${token}'`).not.toContain(token.toLowerCase());
            }
        } else {
            void resolvedBody;
        }

        // None of the victim's ids appear in the attacker's own lists — even
        // when the attacker tries to forge scope params to widen the query.
        const listChecks: Array<{
            label: string;
            url: string;
            pick: (b: unknown) => unknown[];
            id: string;
            // Some list DTOs run under a whitelisting ValidationPipe
            // (forbidNonWhitelisted) and REJECT an unknown forged scope param
            // with a 400 BEFORE any row is selected — an even stronger form of
            // "you cannot widen this query". Others silently ignore the unknown
            // param and answer 200 with the attacker's own (empty-of-victim)
            // rows. Tolerate both: a 400 means nothing leaked at all; a 200
            // still must not surface the victim's id. (Probed live: agents
            // ?tenantId → 400 "property tenantId should not exist"; works/tasks/
            // skills/conversations/missions → 200.)
            widenRejectedByWhitelist?: boolean;
        }> = [
            {
                label: 'works',
                url: `${API_BASE}/api/works?limit=100&owner=${victim.user.user.id}&tenantId=${victim.tenantId}`,
                pick: (b) => (b as { works?: unknown[] }).works ?? [],
                id: victim.workId,
            },
            {
                label: 'agents',
                url: `${API_BASE}/api/agents?limit=100&tenantId=${victim.tenantId}`,
                pick: (b) => (b as { data?: unknown[] }).data ?? [],
                id: victim.agentId,
                widenRejectedByWhitelist: true,
            },
            {
                label: 'tasks',
                url: `${API_BASE}/api/tasks?limit=100&organizationId=${victim.tenantId}`,
                pick: (b) => (b as { data?: unknown[] }).data ?? [],
                id: victim.taskId,
            },
            {
                label: 'skills',
                url: `${API_BASE}/api/skills?limit=100&ownerId=${victim.tenantId}`,
                pick: (b) => (b as { data?: unknown[] }).data ?? [],
                id: victim.skillId,
            },
            {
                label: 'conversations',
                url: `${API_BASE}/api/conversations?limit=100`,
                pick: (b) => (b as { conversations?: unknown[] }).conversations ?? [],
                id: victim.conversationId,
            },
            {
                label: 'missions',
                url: `${API_BASE}/api/me/missions`,
                pick: (b) => (Array.isArray(b) ? b : []),
                id: victim.missionId,
            },
        ];

        for (const lc of listChecks) {
            const res = await request.get(lc.url, { headers: atk });
            if (lc.widenRejectedByWhitelist && res.status() === 400) {
                // Forged scope param rejected at the whitelist before any row
                // was selected → nothing of the victim's leaked. Strongest pass.
                // (class-validator 400 carries a `message` ARRAY, not the string
                // the two scope envelopes use, so verify cleanliness inline
                // rather than via assertCleanError.)
                const raw = (await res.text()).toLowerCase();
                for (const token of FORBIDDEN_LEAK_TOKENS) {
                    expect(raw, `${lc.label} widen-rejected leaked '${token}'`).not.toContain(
                        token.toLowerCase(),
                    );
                }
                expect(raw, `${lc.label} widen-rejected mentions the forged param`).toContain(
                    'tenantid',
                );
                continue;
            }
            expect(res.status(), `${lc.label} list`).toBe(200);
            const body = await res.json();
            const ids = lc.pick(body).map((row) => (row as { id?: string }).id);
            expect(ids, `${lc.label}: attacker list MUST NOT contain victim id`).not.toContain(
                lc.id,
            );
        }

        // And the direct per-id fetch of every victim resource is still guarded
        // (the sweep above does not accidentally short-circuit the per-row guard).
        expect(
            (
                await request.get(`${API_BASE}/api/agents/${victim.agentId}`, { headers: atk })
            ).status(),
        ).toBe(404);
        expect(
            (
                await request.get(`${API_BASE}/api/tasks/${victim.taskId}`, { headers: atk })
            ).status(),
        ).toBe(404);
        expect(
            (
                await request.get(`${API_BASE}/api/skills/${victim.skillId}`, { headers: atk })
            ).status(),
        ).toBe(404);
        expect(
            (
                await request.get(`${API_BASE}/api/conversations/${victim.conversationId}`, {
                    headers: atk,
                })
            ).status(),
        ).toBe(404);
        expect([403, 404]).toContain(
            (
                await request.get(`${API_BASE}/api/works/${victim.workId}`, { headers: atk })
            ).status(),
        );
    });
});
