/**
 * Per-Agent Dispatch Guardrails — the policy PUT surface, DEEP (#1710).
 *
 * Guardrails are the per-Agent policy that decides — BEFORE a proposed
 * side-effectful action ever reaches the human approval queue — whether it
 * queues, auto-approves, or is blocked. This file drives the real management
 * surface against a live stack and pins the true response shapes + status
 * codes byte-for-byte:
 *
 *   • policy lives ONLY on the dedicated `PUT /api/agents/:id/guardrails`
 *     endpoint (PUT semantics — the whole object is replaced; a subsequent
 *     PUT drops any previously-set lists). It is NOT a create/update field:
 *     passing `guardrails` on POST /api/agents or PATCH /api/agents/:id →
 *     400 "property guardrails should not exist" (forbidNonWhitelisted).
 *   • a fresh Agent has `guardrails: null` (queue-everything, the pre-#1710
 *     posture); it round-trips on GET one AND in the list projection.
 *   • shapes observed live: `{ mode }`, `{ mode, autoApproveActionTypes[] }`,
 *     `{ mode, blockedActionTypes[] }`, all three together. Modes come from
 *     AGENT_GUARDRAIL_MODES = ['require_approval','autonomous']; action types
 *     from ['spawn_agent','schedule_task','send_message','budget_override','other'].
 *   • clearing: `{"guardrails":null}` OR an empty `{}` body → guardrails null.
 *   • DTO validation (400, message is a string[]): bad/missing/non-string mode;
 *     unknown action type in either list; a non-array list; an unknown key
 *     inside the object; a non-object (array) guardrails.
 *   • service defense-in-depth (400, message is a single string): the two lists
 *     may not overlap; neither list may contain a duplicate.
 *   • auth 401; cross-user 404 (never a 403 existence-leak); malformed id 400
 *     (ParseUUIDPipe); unknown-but-valid uuid 404.
 *   • approval-queue observability: enforcement is internal to
 *     `AgentApprovalsService.createProposal` — there is NO public route that
 *     mints a proposal (POST /api/agent-approvals → 404), so a fresh owner's
 *     queue is the empty `{ data: [], meta: { total, limit, offset } }`.
 *
 * ── Verified live against http://127.0.0.1:3100 (sqlite in-memory — the CI
 *    driver) before every assertion was written.
 *
 * Isolation discipline: every test builds a FRESH registerUserViaAPI() owner +
 * a fresh Agent. Fully API-orchestrated (safe `flow-` prefix, not matched by
 * the no-auth testIgnore regex), so it never contends on the shared UI auth.
 */
import { test, expect, type APIRequestContext, type APIResponse } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import { createAgentViaAPI } from './helpers/agents-tasks';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function guardrailsUrl(agentId: string): string {
    return `${API_BASE}/api/agents/${agentId}/guardrails`;
}

/** PUT the guardrails policy. `body` is the raw request body (so tests can send
 * `{ guardrails: {...} }`, `{ guardrails: null }`, or an empty `{}`). */
function putGuardrails(
    request: APIRequestContext,
    token: string,
    agentId: string,
    body: unknown,
): Promise<APIResponse> {
    return request.put(guardrailsUrl(agentId), {
        headers: { ...authedHeaders(token), 'content-type': 'application/json' },
        data: body,
    });
}

/** class-validator returns `message` as a string[]; the pure service validator
 * throws a single string. Flatten both to one searchable string. */
function messageText(body: { message?: unknown }): string {
    const m = body.message;
    return Array.isArray(m) ? m.join(' | ') : String(m ?? '');
}

test.describe('Agent Dispatch Guardrails — persistence + PUT semantics', () => {
    test('a fresh Agent has guardrails: null (the queue-everything default)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, user.access_token, {
            name: `GR default ${stamp()}`,
        });
        expect(agent.id).toMatch(UUID_RE);
        expect((agent as unknown as { guardrails: unknown }).guardrails).toBeNull();
    });

    test('PUT a bare autonomous policy → 200, persisted verbatim on GET', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, user.access_token, {
            name: `GR autonomous ${stamp()}`,
        });

        const res = await putGuardrails(request, user.access_token, agent.id, {
            guardrails: { mode: 'autonomous' },
        });
        expect(res.status(), `put body=${await res.text().catch(() => '')}`).toBe(200);
        const dto = await res.json();
        expect(dto.id).toBe(agent.id);
        expect(dto.guardrails).toEqual({ mode: 'autonomous' });

        const got = await request.get(`${API_BASE}/api/agents/${agent.id}`, {
            headers: authedHeaders(user.access_token),
        });
        expect(got.status()).toBe(200);
        expect((await got.json()).guardrails).toEqual({ mode: 'autonomous' });
    });

    test('require_approval + blockedActionTypes round-trips exactly', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, user.access_token, {
            name: `GR blocked ${stamp()}`,
        });
        const policy = {
            mode: 'require_approval',
            blockedActionTypes: ['budget_override', 'send_message'],
        };

        const res = await putGuardrails(request, user.access_token, agent.id, {
            guardrails: policy,
        });
        expect(res.status()).toBe(200);
        expect((await res.json()).guardrails).toEqual(policy);
    });

    test('autonomous + autoApprove narrowing + blocked list all persist (key order preserved)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, user.access_token, {
            name: `GR full ${stamp()}`,
        });
        const policy = {
            mode: 'autonomous',
            autoApproveActionTypes: ['schedule_task', 'send_message'],
            blockedActionTypes: ['budget_override'],
        };

        const res = await putGuardrails(request, user.access_token, agent.id, {
            guardrails: policy,
        });
        expect(res.status()).toBe(200);
        const stored = (await res.json()).guardrails;
        expect(stored).toEqual(policy);
        // The narrowing list keeps its order (it's not sorted/deduped on write).
        expect(stored.autoApproveActionTypes).toEqual(['schedule_task', 'send_message']);
    });

    test('an empty autoApproveActionTypes array is valid (autonomous that auto-approves nothing)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, user.access_token, {
            name: `GR empty-allow ${stamp()}`,
        });

        const res = await putGuardrails(request, user.access_token, agent.id, {
            guardrails: { mode: 'autonomous', autoApproveActionTypes: [] },
        });
        expect(res.status()).toBe(200);
        expect((await res.json()).guardrails).toEqual({
            mode: 'autonomous',
            autoApproveActionTypes: [],
        });
    });

    test('require_approval carrying an autoApproveActionTypes list is structurally valid (semantic no-op) and persists', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, user.access_token, {
            name: `GR noop ${stamp()}`,
        });

        const res = await putGuardrails(request, user.access_token, agent.id, {
            guardrails: { mode: 'require_approval', autoApproveActionTypes: ['other'] },
        });
        expect(res.status()).toBe(200);
        expect((await res.json()).guardrails).toEqual({
            mode: 'require_approval',
            autoApproveActionTypes: ['other'],
        });
    });

    test('blocking all five known action types is accepted', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, user.access_token, {
            name: `GR block-all ${stamp()}`,
        });
        const all = ['spawn_agent', 'schedule_task', 'send_message', 'budget_override', 'other'];

        const res = await putGuardrails(request, user.access_token, agent.id, {
            guardrails: { mode: 'require_approval', blockedActionTypes: all },
        });
        expect(res.status()).toBe(200);
        expect((await res.json()).guardrails.blockedActionTypes).toEqual(all);
    });

    test('PUT is a full replace — a subsequent bare PUT drops the previously-set lists', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, user.access_token, {
            name: `GR replace ${stamp()}`,
        });

        const first = await putGuardrails(request, user.access_token, agent.id, {
            guardrails: { mode: 'autonomous', blockedActionTypes: ['spawn_agent'] },
        });
        expect(first.status()).toBe(200);
        expect((await first.json()).guardrails.blockedActionTypes).toEqual(['spawn_agent']);

        const second = await putGuardrails(request, user.access_token, agent.id, {
            guardrails: { mode: 'autonomous' },
        });
        expect(second.status()).toBe(200);
        // No merge — the blocked list is gone.
        expect((await second.json()).guardrails).toEqual({ mode: 'autonomous' });
    });

    test('clearing with an explicit {"guardrails":null} resets to null', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, user.access_token, {
            name: `GR clear-null ${stamp()}`,
        });

        await putGuardrails(request, user.access_token, agent.id, {
            guardrails: { mode: 'autonomous' },
        });
        const res = await putGuardrails(request, user.access_token, agent.id, { guardrails: null });
        expect(res.status()).toBe(200);
        expect((await res.json()).guardrails).toBeNull();
    });

    test('clearing with an empty {} body also resets to null', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, user.access_token, {
            name: `GR clear-empty ${stamp()}`,
        });

        await putGuardrails(request, user.access_token, agent.id, {
            guardrails: { mode: 'autonomous' },
        });
        const res = await putGuardrails(request, user.access_token, agent.id, {});
        expect(res.status()).toBe(200);
        expect((await res.json()).guardrails).toBeNull();
    });

    test('the guardrails policy is surfaced in the GET /api/agents list projection', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, user.access_token, {
            name: `GR list ${stamp()}`,
        });
        const policy = { mode: 'autonomous', autoApproveActionTypes: ['schedule_task'] };
        await putGuardrails(request, user.access_token, agent.id, { guardrails: policy });

        const list = await request.get(`${API_BASE}/api/agents?limit=200`, {
            headers: authedHeaders(user.access_token),
        });
        expect(list.status()).toBe(200);
        const rows = (await list.json()).data as Array<{ id: string; guardrails: unknown }>;
        const mine = rows.find((r) => r.id === agent.id);
        expect(mine, 'own agent should appear in the list').toBeTruthy();
        expect(mine!.guardrails).toEqual(policy);
    });
});

test.describe('Agent Dispatch Guardrails — validation (400)', () => {
    test('an invalid, missing, or non-string mode is rejected (DTO IsIn)', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, user.access_token, {
            name: `GR badmode ${stamp()}`,
        });

        for (const bad of [
            { mode: 'yolo' },
            { autoApproveActionTypes: ['other'] }, // mode omitted
            { mode: 5 },
        ]) {
            const res = await putGuardrails(request, user.access_token, agent.id, {
                guardrails: bad,
            });
            expect(res.status(), `payload=${JSON.stringify(bad)}`).toBe(400);
            expect(messageText(await res.json())).toContain(
                'mode must be one of the following values',
            );
        }
    });

    test('an unknown action type in either list is rejected (DTO IsIn each)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, user.access_token, {
            name: `GR badtype ${stamp()}`,
        });

        const inAllow = await putGuardrails(request, user.access_token, agent.id, {
            guardrails: { mode: 'autonomous', autoApproveActionTypes: ['nuke_everything'] },
        });
        expect(inAllow.status()).toBe(400);
        expect(messageText(await inAllow.json())).toContain('autoApproveActionTypes');

        const inBlocked = await putGuardrails(request, user.access_token, agent.id, {
            guardrails: { mode: 'require_approval', blockedActionTypes: ['nuke_everything'] },
        });
        expect(inBlocked.status()).toBe(400);
        expect(messageText(await inBlocked.json())).toContain('blockedActionTypes');
    });

    test('a list that is not an array is rejected (DTO IsArray)', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, user.access_token, {
            name: `GR notarray ${stamp()}`,
        });

        const res = await putGuardrails(request, user.access_token, agent.id, {
            guardrails: { mode: 'autonomous', autoApproveActionTypes: 'other' },
        });
        expect(res.status()).toBe(400);
        expect(messageText(await res.json())).toContain('autoApproveActionTypes must be an array');
    });

    test('overlapping auto-approve + blocked types are rejected by the service validator (single-string message)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, user.access_token, {
            name: `GR overlap ${stamp()}`,
        });

        const res = await putGuardrails(request, user.access_token, agent.id, {
            guardrails: {
                mode: 'autonomous',
                autoApproveActionTypes: ['other'],
                blockedActionTypes: ['other'],
            },
        });
        expect(res.status()).toBe(400);
        const body = await res.json();
        // Not a class-validator array — the pure validateGuardrails() message.
        expect(typeof body.message).toBe('string');
        expect(body.message).toContain('cannot be both auto-approved and blocked');
    });

    test('a duplicate action type within a list is rejected by the service validator (single-string message)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, user.access_token, {
            name: `GR dupe ${stamp()}`,
        });

        const res = await putGuardrails(request, user.access_token, agent.id, {
            guardrails: { mode: 'require_approval', blockedActionTypes: ['other', 'other'] },
        });
        expect(res.status()).toBe(400);
        const body = await res.json();
        expect(typeof body.message).toBe('string');
        expect(body.message).toContain('duplicate action type');
    });

    test('an unknown key inside the guardrails object is rejected (forbidNonWhitelisted, nested)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, user.access_token, {
            name: `GR extrakey ${stamp()}`,
        });

        const res = await putGuardrails(request, user.access_token, agent.id, {
            guardrails: { mode: 'autonomous', bogusField: true },
        });
        expect(res.status()).toBe(400);
        expect(messageText(await res.json())).toContain('bogusField should not exist');
    });

    test('a non-object (array) guardrails value is rejected (DTO ValidateNested)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, user.access_token, {
            name: `GR arr ${stamp()}`,
        });

        const res = await putGuardrails(request, user.access_token, agent.id, {
            guardrails: ['mode'],
        });
        expect(res.status()).toBe(400);
    });

    test('guardrails is NOT a create/update field — it is rejected on POST create and PATCH update', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);

        // POST /api/agents with a guardrails field → 400 (property should not exist).
        const create = await request.post(`${API_BASE}/api/agents`, {
            headers: { ...authedHeaders(user.access_token), 'content-type': 'application/json' },
            data: {
                scope: 'tenant',
                name: `GR create ${stamp()}`,
                guardrails: { mode: 'autonomous' },
            },
        });
        expect(create.status()).toBe(400);
        expect(messageText(await create.json())).toContain('guardrails should not exist');

        // PATCH /api/agents/:id likewise refuses the field.
        const agent = await createAgentViaAPI(request, user.access_token, {
            name: `GR patch ${stamp()}`,
        });
        const patch = await request.patch(`${API_BASE}/api/agents/${agent.id}`, {
            headers: { ...authedHeaders(user.access_token), 'content-type': 'application/json' },
            data: { guardrails: { mode: 'autonomous' } },
        });
        expect(patch.status()).toBe(400);
        expect(messageText(await patch.json())).toContain('guardrails should not exist');
    });
});

test.describe('Agent Dispatch Guardrails — auth, isolation, id handling', () => {
    test('unauthenticated PUT → 401', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, user.access_token, {
            name: `GR unauth ${stamp()}`,
        });

        const res = await request.put(guardrailsUrl(agent.id), {
            headers: { 'content-type': 'application/json' },
            data: { guardrails: { mode: 'autonomous' } },
        });
        expect(res.status()).toBe(401);
    });

    test("another user's Agent is walled off with 404 (never a 403 existence-leak)", async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const intruder = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, owner.access_token, {
            name: `GR private ${stamp()}`,
        });

        const res = await putGuardrails(request, intruder.access_token, agent.id, {
            guardrails: { mode: 'autonomous' },
        });
        expect(res.status()).toBe(404);

        // And the owner's policy is untouched by the failed cross-user write.
        const got = await request.get(`${API_BASE}/api/agents/${agent.id}`, {
            headers: authedHeaders(owner.access_token),
        });
        expect((await got.json()).guardrails).toBeNull();
    });

    test('a malformed id → 400 (ParseUUIDPipe); an unknown-but-valid uuid → 404', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);

        const malformed = await putGuardrails(request, user.access_token, 'not-a-uuid', {
            guardrails: { mode: 'autonomous' },
        });
        expect(malformed.status()).toBe(400);

        const unknown = await putGuardrails(request, user.access_token, UNKNOWN_UUID, {
            guardrails: { mode: 'autonomous' },
        });
        expect(unknown.status()).toBe(404);
    });

    test('DTO body validation is owner-agnostic — a bad body on a foreign agent 400s (pipe) before the service ownership 404', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const intruder = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, owner.access_token, {
            name: `GR order ${stamp()}`,
        });

        // Body ValidationPipe runs before the handler (and thus before the
        // service's requireOwned check), so an intruder sending an INVALID body
        // to the owner's agent gets the 400, not the ownership 404.
        const badBody = await putGuardrails(request, intruder.access_token, agent.id, {
            guardrails: { mode: 'yolo' },
        });
        expect(badBody.status()).toBe(400);
        expect(messageText(await badBody.json())).toContain(
            'mode must be one of the following values',
        );

        // With a VALID body, ownership wins → 404 (never a 403 existence-leak).
        const validBody = await putGuardrails(request, intruder.access_token, agent.id, {
            guardrails: { mode: 'require_approval' },
        });
        expect([403, 404]).toContain(validBody.status());
        expect(validBody.status()).toBe(404);
    });
});

test.describe('Agent Dispatch Guardrails — approval-queue observability', () => {
    test("a fresh owner's approval queue is the empty { data: [], meta } shape; unauth list → 401", async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        await createAgentViaAPI(request, user.access_token, { name: `GR queue ${stamp()}` });

        const list = await request.get(`${API_BASE}/api/agent-approvals`, {
            headers: authedHeaders(user.access_token),
        });
        expect(list.status()).toBe(200);
        const body = await list.json();
        expect(Array.isArray(body.data)).toBe(true);
        expect(body.data).toEqual([]);
        expect(body.meta).toMatchObject({ total: 0, limit: 50, offset: 0 });

        expect((await request.get(`${API_BASE}/api/agent-approvals`)).status()).toBe(401);
    });

    test('guardrail enforcement is internal — there is no public route to mint a proposal, and an unknown proposal id → 404', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);

        // No POST /api/agent-approvals exists — proposals are created by
        // AgentApprovalsService.createProposal at dispatch time, where the pure
        // evaluateGuardrails() decides queue / auto_approve / block.
        const post = await request.post(`${API_BASE}/api/agent-approvals`, {
            headers: { ...authedHeaders(user.access_token), 'content-type': 'application/json' },
            data: { actionType: 'other', title: 'x', payload: {} },
        });
        expect(post.status()).toBe(404);

        // A get on a non-existent proposal id → 404 (no existence-leak).
        const get = await request.get(`${API_BASE}/api/agent-approvals/${UNKNOWN_UUID}`, {
            headers: authedHeaders(user.access_token),
        });
        expect(get.status()).toBe(404);
    });
});
