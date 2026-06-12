import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, createWorkViaAPI } from './helpers/api';
import { createAgentViaAPI, createTaskViaAPI } from './helpers/agents-tasks';

/**
 * SECURITY PIN: misc EW-711 Waves A–F ownership/authz guards not yet e2e-pinned.
 *
 * One file, six small surfaces — each pins a SPECIFIC audit fix:
 *
 *   1. agent-memory owner-stamp + work gates (EW-711 #29, Wave B —
 *      apps/api/src/plugins-capabilities/agent-memory/agent-memory.controller.ts):
 *      every workId-scoped verb runs WorkOwnershipService BEFORE any provider
 *      resolution; the #29 fix additionally upgraded the mutating id-addressed
 *      handlers (closeSession / deleteEntry) from ensureCanView to
 *      ensureCanEdit and made the per-resource ownerUserId stamp check
 *      unconditional. (The stamp-403 itself needs a live agent-memory backend
 *      — none in e2e — so this file pins the e2e-reachable layers: the
 *      work-gate matrix incl. the VIEW-vs-EDIT role split, and the exact
 *      no-provider envelope that proves the gate fired FIRST.)
 *   2. agent export scope-ownership (EW-711 #8 —
 *      packages/agent/src/agents/agent-export.service.ts `exportOne()` resolves
 *      via findByIdAndUser): cross-user export masks as the same 404 a
 *      never-existed id yields; the envelope scopes to the exporting user.
 *   3. screenshot workId authz (EW-711 #30, `ensureCanView` fronting the
 *      /api/screenshot facade): work resolution precedes the provider gate on
 *      ALL THREE ops. (flow-screenshot-capability-contract.spec.ts already pins
 *      cross-user 403 + non-uuid-workId 404; THIS file pins the gaps it left:
 *      the absent-UUID workId → 404 on get-url/capture/check-availability,
 *      the 404-beats-provider-gate ordering, and the anon get-url 401.)
 *   4. subscription free-only self-service (EW-711 #23 —
 *      apps/api/src/subscriptions/subscriptions.controller.ts POST /plan →
 *      SubscriptionService.changePlanSelfService): a PAID planCode is 403
 *      "Paid plans must be activated through billing and cannot be
 *      self-assigned." unless the non-prod-only escape hatch
 *      SUBSCRIPTIONS_ALLOW_SELF_SERVE_PAID=true is set (it IS set in e2e CI
 *      and on the local stack → environment-adaptive branch below; the flag is
 *      hard-ignored under NODE_ENV=production).
 *   5. invitation-revoke dead-check (EW-711 #16, Wave B PR #1233 —
 *      packages/agent/src/services/work-invitation.service.ts `revoke()` had a
 *      DEAD empty actor-check `if` block, i.e. ZERO service-layer authz; the
 *      fix made it a real ensureCanManageMembers gate mirroring the
 *      controller): non-manager members (viewer/editor) get 403, managers
 *      succeed, and an ACCEPTED invitation is no longer revocable (404) with
 *      the membership surviving.
 *   6. agent-task taskId IDOR (EW-711 #19, Wave B PR #1233 — the owner-scoped
 *      task lookup was moved to the TOP, before any run mutation): a foreign
 *      or absent taskId on POST /api/agents/:id/assign-task → 404 AND no
 *      AgentRun row is ever persisted (run total stays 0).
 *
 * NON-DUPLICATION — already pinned elsewhere, deliberately NOT re-pinned here:
 *   - flow-screenshot-capability-contract.spec.ts: screenshot DTO 400 matrix,
 *     cross-user work 403 on all three ops, non-uuid workId 404 on
 *     check-availability, signed-URL building, no-provider gate per se.
 *   - flow-plugin-screenshot.spec.ts: anon 401 on check-availability+capture
 *     (get-url anon was NOT covered — pinned here).
 *   - flow-idor-resource-access.spec.ts: assign-task foreign-vs-absent task
 *     404 FINGERPRINT equality + victim-task-untouched; invitation revoke
 *     cross-PARENT 404 matrix. (This file adds the zero-run-row invariant and
 *     the member-ROLE revoke ladder, which it does not touch.)
 *   - sec-pin-agent-run-scoping.spec.ts: assign-task foreign-AGENT 404,
 *     dispatcher-unbound 500-with-failed-row on a LEGIT assign, runs 404
 *     fingerprints. (Foreign-TASK + no-row is the complement pinned here.)
 *   - agents-advanced.spec.ts: loose cross-user export [403,404] + happy
 *     envelope spot fields. (Exact 404 mask equality + full key set here.)
 *   - flow-invitation-email-roundtrip.spec.ts: OUTSIDER (non-member) revoke
 *     [401,403,404], double-revoke 404, unknown/malformed invitation ids,
 *     revoke-then-accept. (MEMBER-role ladder + accept-then-revoke here.)
 *   - flow-subscription-billing-grace.spec.ts / flow-subscriptions-budgets:
 *     plan walks under the CI escape hatch, planCode DTO 400, anon /plan 401,
 *     cadence tier-gating. (The #23 paid-self-serve COMPLIANCE branch and the
 *     always-allowed FREE direction as a security contract are pinned here.)
 *   - No existing spec touches /api/agent-memory at all.
 *
 * PROBED CONTRACTS (live sqlite stack http://127.0.0.1:3100, probed via
 * node-fetch immediately before writing every assertion below):
 *   agent-memory (fresh users have NO provider enabled — deterministic in CI):
 *     POST /sessions, /search, /context, GET /sessions, POST /sessions/:id/close,
 *     DELETE /entries/:id with a FOREIGN workId → 403
 *       { status:'error', message:'You do not have permission to access this work' }
 *     same verbs with an ABSENT workId → 404
 *       { status:'error', message:"Work with id '<id>' not found" }
 *     VIEWER member: open/search → 400 no-provider (view gate passed), but
 *       close/delete → 403 { status:'error', message:'You do not have the
 *       required permission level for this action' }  (the #29 EDIT upgrade)
 *     EDITOR member: close/delete → 400 no-provider (edit gate passed).
 *     unscoped no-provider envelope: 400 { status:'error', message:'No
 *       agent-memory provider is enabled. Install + enable an agent-memory
 *       plugin (e.g. `@ever-works/agentmemory-plugin`).', operation:'<op>' }
 *     GET /check-availability → 200 { status:'success', available:boolean }.
 *     anon (no bearer) on every route → 401 { message:'Unauthorized' }.
 *     malformed workId → 400 ['workId must be a UUID'] on BOTH the body-DTO
 *       routes (open/search) and the query-DTO routes (close/delete) — the
 *       DTO fires before the work lookup, even for a cross-user caller;
 *       unknown body property → 400 ['property bogusField should not exist'].
 *   agent export:
 *     GET /api/agents/:id/export cross-user AND absent id → 404
 *       { message:'Agent <id> not found.', error:'Not Found', statusCode:404 }
 *       (identical modulo the echoed id); anon → 401. Owner → 200 envelope
 *       with EXACTLY the top-level keys [version, meta, identity, model,
 *       runtime, avatar, files, skillBindings, budget], version===1,
 *       meta.sourceAgentId/sourceUserId echoing agent + exporting user.
 *   assign-task:
 *     POST /api/agents/:id/assign-task foreign taskId → 404
 *       'Task <id> not found.'; absent taskId → 404 same template; afterwards
 *       GET :id/runs → { data:[], meta:{ total:0, limit:25, offset:0 } }.
 *     malformed AND missing taskId → 400 ['taskId must be a UUID']; a
 *       cross-user caller with a malformed taskId gets the SAME 400 (DTO
 *       precedes the agent gate — no agent-existence disclosure), and no run
 *       row is persisted by any rejected variant.
 *   screenshot:
 *     GET /check-availability?workId=<absent-uuid>, POST /get-url and
 *     /capture with workId:<absent-uuid> → ALL 404 { status:'error',
 *       message:"Work with id '<id>' not found" }; the SAME get-url without a
 *     workId → 400 { status:'error', message:'No screenshot provider
 *       configured' } (work gate precedes provider gate); anon get-url → 401.
 *   subscriptions:
 *     GET /api/subscriptions/plan (fresh) → 200 { status:'success',
 *       enabled:true, plan:{ code:'free', name:'Free', allowedCadences:[…] } }.
 *     POST /plan { planCode:'premium' } → 200 plan.code 'premium' on this
 *       stack (escape hatch ON); the strict branch is the probed-in-source
 *       403 'Paid plans must be activated through billing and cannot be
 *       self-assigned.' — the test accepts EXACTLY these two outcomes and
 *       asserts the matching post-state for whichever fired.
 *     POST /plan { planCode:'free' } → 200 plan.code 'free' (always allowed).
 *   invitations:
 *     POST /api/works/:id/invitations { email, role } → 201 flat body with
 *       id + one-time claimUrl (…/claim/<64-hex>); POST /api/claim/accept
 *       { token } → 200 { invitationId, workId, role, transferStatus }.
 *     VIEWER/EDITOR member DELETE /invitations/:id → 403 { status:'error',
 *       message:'You do not have the required permission level for this
 *       action' }; MANAGER member → 200 { status:'success' }.
 *     Owner DELETE of an ACCEPTED invitation id → 404
 *       { message:'invitation_not_found' } and the member row SURVIVES.
 *
 * ISOLATION: every test registers FRESH users (registerUserViaAPI) and unique
 * timestamp-suffixed names/slugs/emails; API-contract assertions only (no UI
 * navigation); anon requests use a fresh playwright.request.newContext() (the
 * default request fixture would inherit the shared storageState cookie).
 */

const MEMORY = `${API_BASE}/api/agent-memory`;
const ABSENT_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

const FOREIGN_WORK_403 = 'You do not have permission to access this work';
const PERMISSION_LEVEL_403 = 'You do not have the required permission level for this action';
const NO_MEMORY_PROVIDER_400 =
    'No agent-memory provider is enabled. Install + enable an agent-memory plugin (e.g. `@ever-works/agentmemory-plugin`).';

function uniq(): string {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

interface ErrorEnvelope {
    status?: string;
    message?: string | string[];
    error?: string;
    statusCode?: number;
    operation?: string;
}

async function jsonOf(res: {
    json(): Promise<unknown>;
}): Promise<ErrorEnvelope & Record<string, unknown>> {
    return (await res.json().catch(() => ({}))) as ErrorEnvelope & Record<string, unknown>;
}

/** The six agent-memory verbs that accept a workId scope, as (method, url, body) rows. */
function memoryVerbs(workId?: string): Array<{
    label: string;
    method: 'get' | 'post' | 'delete';
    url: string;
    data?: Record<string, unknown>;
}> {
    const q = workId ? `?workId=${workId}` : '';
    const scoped = workId ? { workId } : {};
    return [
        { label: 'openSession', method: 'post', url: `${MEMORY}/sessions`, data: { ...scoped } },
        {
            label: 'closeSession',
            method: 'post',
            url: `${MEMORY}/sessions/sec-pin-session/close${q}`,
        },
        { label: 'deleteEntry', method: 'delete', url: `${MEMORY}/entries/sec-pin-entry${q}` },
        {
            label: 'searchMemory',
            method: 'post',
            url: `${MEMORY}/search`,
            data: { query: 'sec-pin', ...scoped },
        },
        {
            label: 'buildContext',
            method: 'post',
            url: `${MEMORY}/context`,
            data: { query: 'sec-pin', ...scoped },
        },
        { label: 'listSessions', method: 'get', url: `${MEMORY}/sessions${q}` },
    ];
}

async function fire(
    request: APIRequestContext,
    token: string | null,
    verb: { method: 'get' | 'post' | 'delete'; url: string; data?: Record<string, unknown> },
): Promise<{ status: number; body: ErrorEnvelope & Record<string, unknown> }> {
    const headers = token ? authedHeaders(token) : undefined;
    const res =
        verb.method === 'get'
            ? await request.get(verb.url, { headers })
            : verb.method === 'delete'
              ? await request.delete(verb.url, { headers })
              : await request.post(verb.url, { headers, data: verb.data ?? {} });
    return { status: res.status(), body: await jsonOf(res) };
}

/**
 * Register a fresh user, invite them to the work with the given role, and
 * accept the claim. Returns the member's token and the invitation id.
 */
async function addMember(
    request: APIRequestContext,
    ownerToken: string,
    workId: string,
    role: 'viewer' | 'editor' | 'manager',
): Promise<{ token: string; userId: string; email: string; invitationId: string }> {
    const email = `sec-${role}-${uniq()}@test.local`;
    const member = await registerUserViaAPI(request, { email });
    const inv = await request.post(`${API_BASE}/api/works/${workId}/invitations`, {
        headers: authedHeaders(ownerToken),
        data: { email, role },
    });
    expect(inv.status(), `invite ${role} → 201`).toBe(201);
    const invBody = await jsonOf(inv);
    const token = String(invBody.claimUrl ?? '').split('/claim/')[1];
    expect(token, 'claimUrl carries the one-time token').toBeTruthy();
    const accept = await request.post(`${API_BASE}/api/claim/accept`, {
        headers: authedHeaders(member.access_token),
        data: { token },
    });
    expect(accept.status(), `${role} accepts the invitation`).toBe(200);
    return {
        token: member.access_token,
        userId: member.user.id,
        email,
        invitationId: String(invBody.id),
    };
}

// ─── EW-711 #29 (Wave B): agent-memory work gates + owner-stamp plumbing ────

test.describe('SEC PIN: agent-memory work-scope gates (EW-711 #29, Wave B)', () => {
    test('non-member work scope → 403 on EVERY agent-memory verb, before any provider resolution', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const attacker = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, {
            name: `sec-mem-foreign-${uniq()}`,
        });

        for (const verb of memoryVerbs(work.id)) {
            const { status, body } = await fire(request, attacker.access_token, verb);
            // If the provider gate ran first this would be the 400 no-provider
            // envelope — the 403 proves WorkOwnershipService fires FIRST.
            expect(status, `${verb.label}: foreign work scope → 403`).toBe(403);
            expect(body.status, `${verb.label}: error envelope`).toBe('error');
            expect(body.message, `${verb.label}: non-member message`).toBe(FOREIGN_WORK_403);
        }
    });

    test('absent work scope → 404 work-not-found (distinct from the non-member 403)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        for (const verb of memoryVerbs(ABSENT_UUID)) {
            const { status, body } = await fire(request, user.access_token, verb);
            expect(status, `${verb.label}: absent work → 404`).toBe(404);
            expect(body.status, `${verb.label}: error envelope`).toBe('error');
            expect(body.message, `${verb.label}: work-not-found template`).toBe(
                `Work with id '${ABSENT_UUID}' not found`,
            );
        }
    });

    test('role matrix: a VIEWER passes the view gate but is 403-blocked on close/delete; an EDITOR passes the edit gate (#29 upgrade)', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, {
            name: `sec-mem-roles-${uniq()}`,
        });
        const viewer = await addMember(request, owner.access_token, work.id, 'viewer');
        const editor = await addMember(request, owner.access_token, work.id, 'editor');

        // VIEWER + read/open verbs: ensureCanView passes, so the request falls
        // through to the facade and surfaces the deterministic no-provider 400
        // (fresh users have no agent-memory plugin enabled, also true in CI).
        const verbs = memoryVerbs(work.id);
        const open = verbs[0];
        const close = verbs[1];
        const del = verbs[2];
        const search = verbs[3];
        for (const verb of [open, search]) {
            const { status, body } = await fire(request, viewer.token, verb);
            expect(status, `viewer ${verb.label}: view gate passes → provider gate`).toBe(400);
            expect(body.message, `viewer ${verb.label}: no-provider envelope`).toBe(
                NO_MEMORY_PROVIDER_400,
            );
            expect(body.operation, `viewer ${verb.label}: operation echoed`).toBe(verb.label);
        }

        // VIEWER + mutating id-addressed verbs: the #29 fix upgraded these
        // from ensureCanView to ensureCanEdit — a viewer must NOT be able to
        // end sessions or forget records.
        for (const verb of [close, del]) {
            const { status, body } = await fire(request, viewer.token, verb);
            expect(status, `viewer ${verb.label}: edit gate → 403`).toBe(403);
            expect(body.status, `viewer ${verb.label}: error envelope`).toBe('error');
            expect(body.message, `viewer ${verb.label}: permission-level message`).toBe(
                PERMISSION_LEVEL_403,
            );
        }

        // EDITOR: passes ensureCanEdit and reaches the owner-stamp/provider
        // seam (the 400 proves the role gate, not ownership masking, decided).
        for (const verb of [close, del]) {
            const { status, body } = await fire(request, editor.token, verb);
            expect(status, `editor ${verb.label}: edit gate passes → provider gate`).toBe(400);
            expect(body.message, `editor ${verb.label}: no-provider envelope`).toBe(
                NO_MEMORY_PROVIDER_400,
            );
            expect(body.operation, `editor ${verb.label}: operation echoed`).toBe(verb.label);
        }
    });

    test('malformed workId is a DTO 400 before any work lookup — identically for a cross-user caller (no ordering leak)', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const attacker = await registerUserViaAPI(request);
        await createWorkViaAPI(request, owner.access_token, {
            name: `sec-mem-dto-${uniq()}`,
        });

        // The workId is validated by class-validator on BOTH DTO shapes:
        // body (OpenSessionDto/SearchMemoryDto) and query (MemoryScopeQueryDto)
        // — before WorkOwnershipService ever runs.
        const malformed: Array<{
            label: string;
            method: 'post' | 'delete';
            url: string;
            data?: Record<string, unknown>;
        }> = [
            {
                label: 'openSession (body DTO)',
                method: 'post',
                url: `${MEMORY}/sessions`,
                data: { workId: 'not-a-uuid' },
            },
            {
                label: 'searchMemory (body DTO)',
                method: 'post',
                url: `${MEMORY}/search`,
                data: { query: 'x', workId: 'not-a-uuid' },
            },
            {
                label: 'closeSession (query DTO)',
                method: 'post',
                url: `${MEMORY}/sessions/sid/close?workId=not-a-uuid`,
            },
            {
                label: 'deleteEntry (query DTO)',
                method: 'delete',
                url: `${MEMORY}/entries/eid?workId=not-a-uuid`,
            },
        ];
        // Identical 400 for the owner AND a cross-user caller — validation
        // order never leaks whether the (malformed) scope could have matched.
        for (const token of [owner.access_token, attacker.access_token]) {
            for (const verb of malformed) {
                const { status, body } = await fire(request, token, verb);
                expect(status, `${verb.label}: malformed workId → 400`).toBe(400);
                expect(body.message, `${verb.label}: class-validator message`).toContain(
                    'workId must be a UUID',
                );
            }
        }

        // whitelist+forbidNonWhitelisted is active on the body DTOs too.
        const bogus = await request.post(`${MEMORY}/sessions`, {
            headers: authedHeaders(owner.access_token),
            data: { bogusField: 1 },
        });
        expect(bogus.status(), 'unknown property → 400').toBe(400);
        expect((await jsonOf(bogus)).message).toContain('property bogusField should not exist');
    });

    test('unscoped mutations always reach the ownership/provider seam (exact no-provider envelope); anon → 401 everywhere', async ({
        request,
        playwright,
    }) => {
        const user = await registerUserViaAPI(request);

        // The #29 fix made the per-resource stamp check UNCONDITIONAL: an
        // omitted workId no longer skips ownership. With no provider enabled
        // the verification seam itself surfaces as the exact 400 envelope,
        // with the operation name echoed for each handler.
        for (const verb of memoryVerbs(undefined)) {
            const { status, body } = await fire(request, user.access_token, verb);
            expect(status, `${verb.label}: unscoped → no-provider 400`).toBe(400);
            expect(body.status, `${verb.label}: error envelope`).toBe('error');
            expect(body.message, `${verb.label}: exact no-provider message`).toBe(
                NO_MEMORY_PROVIDER_400,
            );
            expect(body.operation, `${verb.label}: operation echoed`).toBe(verb.label);
        }

        // check-availability is a read-only registry probe: success envelope
        // with a boolean (registry contents vary across builds — not pinned).
        const avail = await request.get(`${MEMORY}/check-availability`, {
            headers: authedHeaders(user.access_token),
        });
        expect(avail.status()).toBe(200);
        const availBody = await jsonOf(avail);
        expect(availBody.status).toBe('success');
        expect(typeof availBody.available).toBe('boolean');

        // Anonymous sweep — fresh context (no inherited storageState cookie).
        const anon = await playwright.request.newContext();
        try {
            for (const verb of [
                ...memoryVerbs(undefined),
                {
                    label: 'checkAvailability',
                    method: 'get' as const,
                    url: `${MEMORY}/check-availability`,
                },
            ]) {
                const { status, body } = await fire(anon, null, verb);
                expect(status, `anon ${verb.label} → 401`).toBe(401);
                expect(body.message, `anon ${verb.label}: bare Unauthorized`).toBe('Unauthorized');
            }
        } finally {
            await anon.dispose();
        }
    });
});

// ─── EW-711 #8: per-Agent export scope-ownership ────────────────────────────

test.describe('SEC PIN: agent export scope-ownership (EW-711 #8)', () => {
    test('cross-user export masks as the SAME 404 a never-existed agent yields; anon → 401', async ({
        request,
        playwright,
    }) => {
        const owner = await registerUserViaAPI(request);
        const attacker = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, owner.access_token, {
            name: `sec-exp-${uniq()}`,
        });

        const foreign = await request.get(`${API_BASE}/api/agents/${agent.id}/export`, {
            headers: authedHeaders(attacker.access_token),
        });
        const absent = await request.get(`${API_BASE}/api/agents/${ABSENT_UUID}/export`, {
            headers: authedHeaders(attacker.access_token),
        });
        expect(foreign.status(), 'foreign export → 404 (never 403)').toBe(404);
        expect(absent.status(), 'absent export → 404').toBe(404);

        const fBody = await jsonOf(foreign);
        const aBody = await jsonOf(absent);
        expect(fBody.message).toBe(`Agent ${agent.id} not found.`);
        // Identical refusals modulo the echoed id — an attacker probing ids
        // cannot distinguish "exists but not mine" from "does not exist".
        const normalize = (b: ErrorEnvelope, id: string): string =>
            JSON.stringify(b).split(id).join('<ID>');
        expect(normalize(fBody, agent.id)).toBe(normalize(aBody, ABSENT_UUID));

        const anon = await playwright.request.newContext();
        try {
            const res = await anon.get(`${API_BASE}/api/agents/${agent.id}/export`);
            expect(res.status(), 'anon export → 401').toBe(401);
        } finally {
            await anon.dispose();
        }
    });

    test('owner export → 200 envelope with exactly the documented top-level shape, scoped to the exporting user', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, owner.access_token, {
            name: `sec-exp-own-${uniq()}`,
        });

        const res = await request.get(`${API_BASE}/api/agents/${agent.id}/export`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(res.status(), 'owner export → 200').toBe(200);
        const env = (await res.json()) as {
            version: number;
            meta: { exportedAt: string; sourceAgentId: string; sourceUserId: string };
            identity: Record<string, unknown>;
            runtime: Record<string, unknown>;
            skillBindings: unknown[];
            budget: unknown[];
        };

        expect(Object.keys(env).sort()).toEqual(
            [
                'version',
                'meta',
                'identity',
                'model',
                'runtime',
                'avatar',
                'files',
                'skillBindings',
                'budget',
            ].sort(),
        );
        expect(env.version).toBe(1);
        // The envelope binds itself to its source agent AND the exporting
        // user — combined with the 404 mask above, sourceUserId can only ever
        // be the caller's own id (never another account's).
        expect(env.meta.sourceAgentId).toBe(agent.id);
        expect(env.meta.sourceUserId).toBe(owner.user.id);
        expect(Object.keys(env.identity).sort()).toEqual(
            ['name', 'slug', 'title', 'capabilities', 'scope'].sort(),
        );
        expect(env.identity.name).toBe(agent.name);
        expect(Object.keys(env.runtime)).toContain('permissions');
        expect(Array.isArray(env.skillBindings)).toBe(true);
        expect(Array.isArray(env.budget)).toBe(true);
    });
});

// ─── EW-711 #19 (Wave B, PR #1233): assign-task foreign-taskId IDOR ─────────

test.describe('SEC PIN: assign-task taskId gate (EW-711 #19, Wave B PR #1233)', () => {
    test('foreign/absent taskId → 404 BEFORE any AgentRun row is created (run total stays 0)', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const victim = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, owner.access_token, {
            name: `sec-assign-${uniq()}`,
        });
        const foreignTask = await createTaskViaAPI(request, victim.access_token, {
            title: `sec-task-${uniq()}`,
        });

        // PR #1233 moved the owner-scoped task lookup to the TOP of the
        // handler/task — ahead of agentRuns.createQueued AND ahead of the
        // dispatcher-unbound 500 the e2e stack would otherwise hit (see
        // sec-pin-agent-run-scoping.spec.ts: a LEGIT assign 500s at enqueue
        // but persists a failed run row). A 404 with zero rows proves the
        // gate fires before any run mutation.
        const foreign = await request.post(`${API_BASE}/api/agents/${agent.id}/assign-task`, {
            headers: authedHeaders(owner.access_token),
            data: { taskId: foreignTask.id },
        });
        expect(foreign.status(), 'foreign taskId → 404, not 500').toBe(404);
        expect((await jsonOf(foreign)).message).toBe(`Task ${foreignTask.id} not found.`);

        const absent = await request.post(`${API_BASE}/api/agents/${agent.id}/assign-task`, {
            headers: authedHeaders(owner.access_token),
            data: { taskId: ABSENT_UUID },
        });
        expect(absent.status(), 'absent taskId → 404').toBe(404);
        expect((await jsonOf(absent)).message).toBe(`Task ${ABSENT_UUID} not found.`);

        // The critical #19 regression-proof: NO queued/failed AgentRun row
        // was persisted for either rejected assign.
        const runs = await request.get(`${API_BASE}/api/agents/${agent.id}/runs`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(runs.status()).toBe(200);
        const page = (await runs.json()) as { data: unknown[]; meta: { total: number } };
        expect(page.meta.total, 'no run row persisted by rejected assigns').toBe(0);
        expect(page.data).toEqual([]);
    });

    test('taskId DTO validation precedes the agent gate — a cross-user caller with a malformed taskId learns nothing', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const attacker = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, owner.access_token, {
            name: `sec-assign-dto-${uniq()}`,
        });

        // Owner: malformed and MISSING taskId are the same class-validator 400.
        for (const data of [{ taskId: 'not-a-uuid' }, {}]) {
            const res = await request.post(`${API_BASE}/api/agents/${agent.id}/assign-task`, {
                headers: authedHeaders(owner.access_token),
                data,
            });
            expect(res.status(), `assign ${JSON.stringify(data)} → 400`).toBe(400);
            expect((await jsonOf(res)).message).toContain('taskId must be a UUID');
        }

        // Cross-user + malformed taskId: the DTO 400 fires BEFORE the agent
        // ownership gate, so the attacker cannot use validation behaviour to
        // probe whether the agent id exists (compare: with a WELL-FORMED
        // taskId the same caller hits the agent-gate 404 — pinned by
        // sec-pin-agent-run-scoping.spec.ts, not re-asserted here).
        const probe = await request.post(`${API_BASE}/api/agents/${agent.id}/assign-task`, {
            headers: authedHeaders(attacker.access_token),
            data: { taskId: 'not-a-uuid' },
        });
        expect(probe.status(), 'cross-user malformed taskId → DTO 400, no disclosure').toBe(400);
        expect((await jsonOf(probe)).message).toContain('taskId must be a UUID');

        // None of the rejected variants persisted a run row.
        const runs = await request.get(`${API_BASE}/api/agents/${agent.id}/runs`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(runs.status()).toBe(200);
        expect(((await runs.json()) as { meta: { total: number } }).meta.total).toBe(0);
    });
});

// ─── EW-711 #30: screenshot workId resolution precedes the provider gate ────

test.describe('SEC PIN: screenshot workId authz gaps (EW-711 #30)', () => {
    test('absent-UUID workId → 404 on all three ops; the same call un-scoped is the provider-gate 400; anon get-url → 401', async ({
        request,
        playwright,
    }) => {
        const user = await registerUserViaAPI(request);
        const headers = authedHeaders(user.access_token);
        const workNotFound = `Work with id '${ABSENT_UUID}' not found`;

        // check-availability: the sibling spec pinned the non-uuid 404 and the
        // cross-user 403 — the absent-but-well-formed UUID was the gap.
        const avail = await request.get(
            `${API_BASE}/api/screenshot/check-availability?workId=${ABSENT_UUID}`,
            { headers },
        );
        expect(avail.status(), 'check-availability absent work → 404').toBe(404);
        expect((await jsonOf(avail)).message).toBe(workNotFound);

        // get-url and capture resolve the work BEFORE the provider gate: this
        // fresh user has no provider, so a provider-first ordering would have
        // produced the 400 'No screenshot provider configured' instead.
        for (const op of ['get-url', 'capture'] as const) {
            const res = await request.post(`${API_BASE}/api/screenshot/${op}`, {
                headers,
                data: { url: 'https://example.com', workId: ABSENT_UUID },
            });
            expect(res.status(), `${op} absent work → 404 (work gate first)`).toBe(404);
            const body = await jsonOf(res);
            expect(body.status, `${op}: error envelope`).toBe('error');
            expect(body.message, `${op}: work-not-found template`).toBe(workNotFound);
        }

        // Ordering contrast: the byte-identical request WITHOUT the workId
        // falls through to the provider gate.
        const unscoped = await request.post(`${API_BASE}/api/screenshot/get-url`, {
            headers,
            data: { url: 'https://example.com' },
        });
        expect(unscoped.status(), 'un-scoped get-url → provider gate 400').toBe(400);
        expect((await jsonOf(unscoped)).message).toBe('No screenshot provider configured');

        // Anon get-url (check-availability + capture 401s are pinned by
        // flow-plugin-screenshot.spec.ts — get-url was the gap).
        const anon = await playwright.request.newContext();
        try {
            const res = await anon.post(`${API_BASE}/api/screenshot/get-url`, {
                data: { url: 'https://example.com' },
            });
            expect(res.status(), 'anon get-url → 401').toBe(401);
        } finally {
            await anon.dispose();
        }
    });
});

// ─── EW-711 #23: subscription self-service is free-only (escape hatch aside) ─

test.describe('SEC PIN: subscription free-only self-service (EW-711 #23)', () => {
    test('paid self-serve obeys SUBSCRIPTIONS_ALLOW_SELF_SERVE_PAID; free direction is always allowed', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const headers = authedHeaders(user.access_token);
        const PLAN = `${API_BASE}/api/subscriptions/plan`;

        const readPlanCode = async (): Promise<string> => {
            const res = await request.get(PLAN, { headers });
            expect(res.status()).toBe(200);
            const body = (await res.json()) as { status: string; plan: { code: string } };
            expect(body.status).toBe('success');
            return body.plan.code;
        };

        // Fresh accounts start on the free tier.
        expect(await readPlanCode(), 'fresh account starts free').toBe('free');

        // The #23 contract has EXACTLY two legal outcomes for a paid
        // self-assign, keyed off the non-prod-only escape hatch (which IS
        // wired 'true' in e2e CI and on the local stack; production
        // hard-ignores it):
        const paid = await request.post(PLAN, { headers, data: { planCode: 'premium' } });
        expect(
            [200, 403],
            `paid self-serve is either hatch-allowed or billing-403 (got ${paid.status()})`,
        ).toContain(paid.status());

        if (paid.status() === 403) {
            // STRICT branch: the exact EW-711 #23 refusal, and NO partial
            // mutation — the account still reads free.
            const body = await jsonOf(paid);
            expect(body.message).toBe(
                'Paid plans must be activated through billing and cannot be self-assigned.',
            );
            expect(await readPlanCode(), 'refused upgrade must not persist').toBe('free');
            test.info().annotations.push({
                type: 'note',
                description:
                    'SUBSCRIPTIONS_ALLOW_SELF_SERVE_PAID is OFF on this stack — exercised the strict 403 branch.',
            });
        } else {
            // ESCAPE-HATCH branch (e2e default): the change is real and
            // observable on the read side.
            const body = (await paid.json()) as { status: string; plan: { code: string } };
            expect(body.status).toBe('success');
            expect(body.plan.code).toBe('premium');
            expect(await readPlanCode(), 'hatch-allowed upgrade persists').toBe('premium');
            test.info().annotations.push({
                type: 'note',
                description:
                    'SUBSCRIPTIONS_ALLOW_SELF_SERVE_PAID is ON (non-prod) — exercised the escape-hatch 200 branch.',
            });
        }

        // The FREE direction (sign-up default / downgrade / cancel) is the
        // self-service that must ALWAYS work — in BOTH branches.
        const down = await request.post(PLAN, { headers, data: { planCode: 'free' } });
        expect(down.status(), 'free self-serve always allowed').toBe(200);
        const downBody = (await down.json()) as { plan: { code: string } };
        expect(downBody.plan.code).toBe('free');
        expect(await readPlanCode(), 'free downgrade persists').toBe('free');
    });
});

// ─── EW-711 #16 (Wave B, PR #1233): invitation revoke authorization ─────────

test.describe('SEC PIN: invitation-revoke manager gate (EW-711 #16, Wave B PR #1233)', () => {
    test('member-role ladder: viewer and editor get 403 on revoke; a manager succeeds', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, {
            name: `sec-inv-ladder-${uniq()}`,
        });
        const viewer = await addMember(request, owner.access_token, work.id, 'viewer');
        const editor = await addMember(request, owner.access_token, work.id, 'editor');
        const manager = await addMember(request, owner.access_token, work.id, 'manager');

        // A pending invitation to revoke (never accepted).
        const pending = await request.post(`${API_BASE}/api/works/${work.id}/invitations`, {
            headers: authedHeaders(owner.access_token),
            data: { email: `sec-pending-${uniq()}@test.local`, role: 'viewer' },
        });
        expect(pending.status()).toBe(201);
        const pendingId = String((await jsonOf(pending)).id);

        // PR #1233 replaced the DEAD empty actor-check in
        // work-invitation.service.revoke() with a real
        // ensureCanManageMembers gate (mirroring the controller). Members
        // below manager can VIEW (even edit) the work but must not manage
        // invitations — exact 403, not a masked 404 (they can see the work).
        for (const [label, token] of [
            ['viewer', viewer.token],
            ['editor', editor.token],
        ] as const) {
            const res = await request.delete(
                `${API_BASE}/api/works/${work.id}/invitations/${pendingId}`,
                { headers: authedHeaders(token) },
            );
            expect(res.status(), `${label} member revoke → 403`).toBe(403);
            const body = await jsonOf(res);
            expect(body.status, `${label}: error envelope`).toBe('error');
            expect(body.message, `${label}: permission-level message`).toBe(PERMISSION_LEVEL_403);
        }

        // The gate must not break the legit flow: a MANAGER member revokes.
        const ok = await request.delete(
            `${API_BASE}/api/works/${work.id}/invitations/${pendingId}`,
            { headers: authedHeaders(manager.token) },
        );
        expect(ok.status(), 'manager member revoke → 200').toBe(200);
        expect(((await ok.json()) as { status: string }).status).toBe('success');

        // And the revocation is real: the owner's pending list no longer
        // carries the invitation.
        const list = await request.get(`${API_BASE}/api/works/${work.id}/invitations`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(list.status()).toBe(200);
        const invitations = ((await list.json()) as { invitations: Array<{ id: string }> })
            .invitations;
        expect(invitations.map((i) => i.id)).not.toContain(pendingId);
    });

    test('an ACCEPTED invitation is dead for revoke (404 invitation_not_found) and the membership survives', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, {
            name: `sec-inv-accepted-${uniq()}`,
        });
        const member = await addMember(request, owner.access_token, work.id, 'editor');

        // The controller resolves revoke targets ONLY among the work's
        // PENDING invitations, so an accepted invitation id is
        // indistinguishable from a never-existed one — and revoking it can
        // never claw back the granted membership.
        const res = await request.delete(
            `${API_BASE}/api/works/${work.id}/invitations/${member.invitationId}`,
            { headers: authedHeaders(owner.access_token) },
        );
        expect(res.status(), 'accepted invitation revoke → 404').toBe(404);
        expect((await jsonOf(res)).message).toBe('invitation_not_found');

        // The member row is untouched.
        const members = await request.get(`${API_BASE}/api/works/${work.id}/members`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(members.status()).toBe(200);
        const body = (await members.json()) as {
            members: Array<{ email: string; role: string }>;
        };
        const row = body.members.find((m) => m.email === member.email);
        expect(row, 'membership survives the failed revoke').toBeTruthy();
        expect(row!.role).toBe('editor');
    });
});
