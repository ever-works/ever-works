/**
 * Agent Action Approval Queue — the human-in-the-loop gate, DEEP (#1690).
 *
 * The queue is the durable record + decision surface for side-effectful Agent
 * actions (spawn_agent / schedule_task / send_message / budget_override / other).
 * This file drives the whole public REST surface end-to-end against a live stack
 * and pins the contract byte-for-byte:
 *
 *   GET    /api/agent-approvals              list my proposals, default `pending`
 *   GET    /api/agent-approvals/:id          get one
 *   POST   /api/agent-approvals/:id/approve  approve a pending proposal
 *   POST   /api/agent-approvals/:id/reject   reject a pending proposal
 *   POST   /api/agent-approvals/approve-all  bulk-approve (optional `ids` subset)
 *
 * ── Verified live (http://127.0.0.1:3100, sqlite in-memory) before every
 *    assertion below. Probed contract:
 *
 *   • list → { data: [], meta: { total, limit, offset } }; default limit 50,
 *     offset 0; `meta.limit`/`meta.offset` echo the validated query values.
 *   • ?status= is a strict enum (pending|approved|rejected) → any other value
 *     400; ?organizationId= must be a uuid → 400 otherwise; limit ∈ [1,200],
 *     offset ≥ 0, both integers → 400 otherwise. organizationId is a pure WHERE
 *     filter — a valid-but-unknown org id just yields the empty page (no guard).
 *   • get/approve/reject on an unknown-but-valid uuid → 404 (cross-user reads
 *     404 too — existence is never leaked); malformed uuid → 400 via
 *     ParseUUIDPipe ("Validation failed (uuid is expected)").
 *   • approve-all is best-effort: no body / empty ids / unknown ids →
 *     { approved: 0, skipped: 0 } (never 404); 200 ids is the ArrayMaxSize
 *     boundary; a malformed / non-array / >200-element `ids` or an unknown key
 *     → 400.
 *   • the global AuthSessionGuard runs BEFORE the pipes, so an unauthenticated
 *     request with an otherwise-400 shape (malformed uuid / bad body) → 401.
 *   • NB the DTO `@IsUUID` (ids[], organizationId) is STRICTER than the route
 *     `:id` ParseUUIDPipe — the pipe accepts a non-standard variant nibble
 *     (e.g. `1111…`) and 404s, while the DTO rejects it as 400. So route-param
 *     "unknown id" probes use the nil uuid / real v4 ids; the DTO probes use
 *     real v4 ids.
 *
 *   ⚠ CONTRACT NOTE: there is NO public endpoint that *creates* a pending
 *     proposal — `AgentApprovalsService.createProposal` (with risk scoring +
 *     dispatch-guardrail auto-decide) is internal-only and unwired to any
 *     controller in this build ("executing/resuming the approved action is a
 *     follow-up increment"). So a fresh user's queue is always empty and a real
 *     pending→approved/rejected transition is unreachable over HTTP; this suite
 *     asserts the empty-queue shape, the full validation + auth + cross-user
 *     isolation matrix, the bulk-approve semantics, and the route surface (no
 *     create/delete route; configuring guardrails mints nothing) — the entire
 *     observable public surface — deeply and assertively.
 *
 * Isolation discipline: fresh registerUserViaAPI() owners per test. The
 * throttle tracker is per-user (`user:<id>`), so the queue's 30/min approve/
 * reject write limit is never contended across tests. Fully API-orchestrated
 * (safe `flow-` prefix, not matched by the no-auth testIgnore regex).
 */
import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import { createOrganizationViaAPI } from './helpers/organizations';
import { createAgentViaAPI } from './helpers/agents-tasks';

const AQ_BASE = `${API_BASE}/api/agent-approvals`;
const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** A proper random v4 uuid — valid for BOTH the route ParseUUIDPipe and the
 * DTO `@IsUUID`, so bulk-id probes exercise the service (not the validator). */
function randomUuid(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}

/** class-validator returns `message` as a string[]; NestJS built-ins as a
 * string. Flatten both to one searchable string. */
function messageText(body: { message?: unknown }): string {
    const m = body.message;
    return Array.isArray(m) ? m.join(' | ') : String(m ?? '');
}

test.describe('Agent Approval Queue — the read/list path', () => {
    test('a fresh user has an empty pending queue with the exact { data, meta } shape', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.get(AQ_BASE, { headers: authedHeaders(user.access_token) });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(Array.isArray(body.data)).toBe(true);
        expect(body.data).toEqual([]);
        // Fresh owner — nothing has ever been proposed for them.
        expect(body.meta).toEqual({ total: 0, limit: 50, offset: 0 });
    });

    test('explicit ?status=pending equals the default view; approved + rejected are valid filters too', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const H = authedHeaders(user.access_token);
        for (const status of ['pending', 'approved', 'rejected'] as const) {
            const res = await request.get(`${AQ_BASE}?status=${status}`, { headers: H });
            expect(res.status(), `status=${status}`).toBe(200);
            const body = await res.json();
            expect(body.data).toEqual([]);
            expect(body.meta).toEqual({ total: 0, limit: 50, offset: 0 });
        }
    });

    test('pagination: limit + offset are validated and echoed into meta; the 1 and 200 boundaries are accepted', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const H = authedHeaders(user.access_token);

        const paged = await request.get(`${AQ_BASE}?limit=5&offset=2`, { headers: H });
        expect(paged.status()).toBe(200);
        expect((await paged.json()).meta).toEqual({ total: 0, limit: 5, offset: 2 });

        const min = await request.get(`${AQ_BASE}?limit=1`, { headers: H });
        expect(min.status()).toBe(200);
        expect((await min.json()).meta.limit).toBe(1);

        const max = await request.get(`${AQ_BASE}?limit=200`, { headers: H });
        expect(max.status()).toBe(200);
        expect((await max.json()).meta.limit).toBe(200);
    });

    test('?organizationId= is a pure filter: a valid unknown org id → 200 empty (no ownership guard)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.get(`${AQ_BASE}?organizationId=${UNKNOWN_UUID}`, {
            headers: authedHeaders(user.access_token),
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body.data).toEqual([]);
        expect(body.meta).toEqual({ total: 0, limit: 50, offset: 0 });
    });

    test('filtering by my own real Organization id returns the empty scoped queue', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const org = await createOrganizationViaAPI(request, user.access_token, `AQ Org ${stamp()}`);
        expect(org.id).toMatch(UUID_RE);
        const res = await request.get(`${AQ_BASE}?organizationId=${org.id}`, {
            headers: authedHeaders(user.access_token),
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body.data).toEqual([]);
        expect(body.meta).toEqual({ total: 0, limit: 50, offset: 0 });
    });

    test('two fresh users each see their own independent empty queue (no cross-user leakage)', async ({
        request,
    }) => {
        const alice = await registerUserViaAPI(request);
        const bob = await registerUserViaAPI(request);
        const aRes = await request.get(AQ_BASE, { headers: authedHeaders(alice.access_token) });
        const bRes = await request.get(AQ_BASE, { headers: authedHeaders(bob.access_token) });
        expect(aRes.status()).toBe(200);
        expect(bRes.status()).toBe(200);
        expect((await aRes.json()).data).toEqual([]);
        expect((await bRes.json()).data).toEqual([]);
    });
});

test.describe('Agent Approval Queue — list validation (400)', () => {
    test('an unknown ?status= value → 400 (strict enum)', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.get(`${AQ_BASE}?status=bogus`, {
            headers: authedHeaders(user.access_token),
        });
        expect(res.status()).toBe(400);
        const body = await res.json();
        expect(body.statusCode).toBe(400);
        expect(messageText(body)).toContain('status must be one of the following values');
    });

    test('limit out of range / non-integer → 400 (min 1, max 200, integer)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const H = authedHeaders(user.access_token);

        const low = await request.get(`${AQ_BASE}?limit=0`, { headers: H });
        expect(low.status()).toBe(400);
        expect(messageText(await low.json())).toContain('limit must not be less than 1');

        const high = await request.get(`${AQ_BASE}?limit=201`, { headers: H });
        expect(high.status()).toBe(400);
        expect(messageText(await high.json())).toContain('limit must not be greater than 200');

        const notInt = await request.get(`${AQ_BASE}?limit=abc`, { headers: H });
        expect(notInt.status()).toBe(400);
        expect(messageText(await notInt.json())).toContain('limit must be an integer number');
    });

    test('a negative offset → 400 (min 0)', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.get(`${AQ_BASE}?offset=-1`, {
            headers: authedHeaders(user.access_token),
        });
        expect(res.status()).toBe(400);
        expect(messageText(await res.json())).toContain('offset must not be less than 0');
    });

    test('a non-uuid ?organizationId= → 400 (IsUUID)', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.get(`${AQ_BASE}?organizationId=not-a-uuid`, {
            headers: authedHeaders(user.access_token),
        });
        expect(res.status()).toBe(400);
        expect(messageText(await res.json())).toContain('organizationId must be a UUID');
    });
});

test.describe('Agent Approval Queue — get one', () => {
    test('an unknown-but-valid uuid → 404 with the not-found shape', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.get(`${AQ_BASE}/${UNKNOWN_UUID}`, {
            headers: authedHeaders(user.access_token),
        });
        expect(res.status()).toBe(404);
        const body = await res.json();
        expect(body.statusCode).toBe(404);
        expect(body.message).toContain(UNKNOWN_UUID);
    });

    test('a malformed uuid → 400 via ParseUUIDPipe', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.get(`${AQ_BASE}/not-a-uuid`, {
            headers: authedHeaders(user.access_token),
        });
        expect(res.status()).toBe(400);
        expect(messageText(await res.json())).toContain('Validation failed (uuid is expected)');
    });

    test('cross-user: a second user querying an arbitrary v4 uuid gets 404, never a leak', async ({
        request,
    }) => {
        const intruder = await registerUserViaAPI(request);
        const res = await request.get(`${AQ_BASE}/${randomUuid()}`, {
            headers: authedHeaders(intruder.access_token),
        });
        expect(res.status()).toBe(404);
    });
});

test.describe('Agent Approval Queue — approve / reject a single proposal', () => {
    test('approve on an unknown uuid → 404', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.post(`${AQ_BASE}/${UNKNOWN_UUID}/approve`, {
            headers: authedHeaders(user.access_token),
        });
        expect(res.status()).toBe(404);
        expect(messageText(await res.json())).toContain(UNKNOWN_UUID);
    });

    test('approve on a malformed uuid → 400 (ParseUUIDPipe, before the service ever runs)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.post(`${AQ_BASE}/not-a-uuid/approve`, {
            headers: authedHeaders(user.access_token),
        });
        expect(res.status()).toBe(400);
        expect(messageText(await res.json())).toContain('Validation failed (uuid is expected)');
    });

    test('reject on an unknown uuid → 404', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.post(`${AQ_BASE}/${UNKNOWN_UUID}/reject`, {
            headers: authedHeaders(user.access_token),
        });
        expect(res.status()).toBe(404);
        expect(messageText(await res.json())).toContain(UNKNOWN_UUID);
    });

    test('reject on a malformed uuid → 400', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.post(`${AQ_BASE}/not-a-uuid/reject`, {
            headers: authedHeaders(user.access_token),
        });
        expect(res.status()).toBe(400);
        expect(messageText(await res.json())).toContain('Validation failed (uuid is expected)');
    });

    test("cross-user: rejecting another user's (unknown-to-me) v4 id → 404, no existence leak", async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const intruder = await registerUserViaAPI(request);
        // The owner has no proposals to steal (no create endpoint), so the
        // intruder hitting any valid uuid must get the same 404 an unknown id
        // yields — the contract never distinguishes "not yours" from "gone".
        void owner;
        const res = await request.post(`${AQ_BASE}/${randomUuid()}/reject`, {
            headers: authedHeaders(intruder.access_token),
        });
        expect(res.status()).toBe(404);
    });
});

test.describe('Agent Approval Queue — bulk approve-all', () => {
    test('an empty body, an absent body, and ids:[] all no-op to { approved: 0, skipped: 0 } (200)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const H = { ...authedHeaders(user.access_token), 'content-type': 'application/json' };

        const emptyObj = await request.post(`${AQ_BASE}/approve-all`, { headers: H, data: {} });
        expect(emptyObj.status()).toBe(200);
        expect(await emptyObj.json()).toEqual({ approved: 0, skipped: 0 });

        const noBody = await request.post(`${AQ_BASE}/approve-all`, { headers: H });
        expect(noBody.status()).toBe(200);
        expect(await noBody.json()).toEqual({ approved: 0, skipped: 0 });

        const emptyIds = await request.post(`${AQ_BASE}/approve-all`, {
            headers: H,
            data: { ids: [] },
        });
        expect(emptyIds.status()).toBe(200);
        expect(await emptyIds.json()).toEqual({ approved: 0, skipped: 0 });
    });

    test('an unknown-id subset is silently ignored (never 404) → { approved: 0, skipped: 0 }', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.post(`${AQ_BASE}/approve-all`, {
            headers: { ...authedHeaders(user.access_token), 'content-type': 'application/json' },
            data: { ids: [UNKNOWN_UUID, randomUuid(), randomUuid()] },
        });
        expect(res.status()).toBe(200);
        // Cross-user / unknown ids don't match the owner-scoped query, so they
        // are neither approved nor counted as skipped — both counters stay 0.
        expect(await res.json()).toEqual({ approved: 0, skipped: 0 });
    });

    test('a 200-id subset is accepted (the ArrayMaxSize boundary) and no-ops when none are owned', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const ids = Array.from({ length: 200 }, () => randomUuid());
        const res = await request.post(`${AQ_BASE}/approve-all`, {
            headers: { ...authedHeaders(user.access_token), 'content-type': 'application/json' },
            data: { ids },
        });
        expect(res.status(), `approve-all 200 ids body=${await res.text().catch(() => '')}`).toBe(
            200,
        );
        expect(await res.json()).toEqual({ approved: 0, skipped: 0 });
    });

    test('body validation: 201 ids, a non-uuid id, a non-array ids, and an unknown key are all rejected (400)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const H = { ...authedHeaders(user.access_token), 'content-type': 'application/json' };

        const tooMany = await request.post(`${AQ_BASE}/approve-all`, {
            headers: H,
            data: { ids: Array.from({ length: 201 }, () => randomUuid()) },
        });
        expect(tooMany.status()).toBe(400);
        expect(messageText(await tooMany.json())).toContain(
            'ids must contain no more than 200 elements',
        );

        const badId = await request.post(`${AQ_BASE}/approve-all`, {
            headers: H,
            data: { ids: ['not-a-uuid'] },
        });
        expect(badId.status()).toBe(400);
        expect(messageText(await badId.json())).toContain('each value in ids must be a UUID');

        const notArray = await request.post(`${AQ_BASE}/approve-all`, {
            headers: H,
            data: { ids: 'x' },
        });
        expect(notArray.status()).toBe(400);
        expect(messageText(await notArray.json())).toContain('ids must be an array');

        const extraKey = await request.post(`${AQ_BASE}/approve-all`, {
            headers: H,
            data: { foo: 1 },
        });
        expect(extraKey.status()).toBe(400);
        expect(messageText(await extraKey.json())).toContain('property foo should not exist');
    });
});

test.describe('Agent Approval Queue — auth gating (401)', () => {
    test('every route requires authentication', async ({ request }) => {
        expect((await request.get(AQ_BASE)).status()).toBe(401);
        expect((await request.get(`${AQ_BASE}?status=approved`)).status()).toBe(401);
        expect((await request.get(`${AQ_BASE}/${UNKNOWN_UUID}`)).status()).toBe(401);
        expect((await request.post(`${AQ_BASE}/${UNKNOWN_UUID}/approve`)).status()).toBe(401);
        expect((await request.post(`${AQ_BASE}/${UNKNOWN_UUID}/reject`)).status()).toBe(401);
        const bulk = await request.post(`${AQ_BASE}/approve-all`, {
            headers: { 'content-type': 'application/json' },
            data: {},
        });
        expect(bulk.status()).toBe(401);
    });

    test('the auth guard runs BEFORE the pipes — an unauthenticated malformed request → 401, not the 400 the pipe would give', async ({
        request,
    }) => {
        // Malformed route uuid, unauthenticated → 401 (guard wins over ParseUUIDPipe).
        expect((await request.get(`${AQ_BASE}/not-a-uuid`)).status()).toBe(401);
        // Malformed body, unauthenticated → 401 (guard wins over the DTO ValidationPipe).
        const badBody = await request.post(`${AQ_BASE}/approve-all`, {
            headers: { 'content-type': 'application/json' },
            data: { ids: 'x' },
        });
        expect(badBody.status()).toBe(401);
    });
});

test.describe('Agent Approval Queue — route surface + guardrail wiring', () => {
    test('there is NO public create or delete route — proposals are minted only internally', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const H = { ...authedHeaders(user.access_token), 'content-type': 'application/json' };

        // POST /api/agent-approvals is not a route (creation is internal to
        // AgentApprovalsService.createProposal at dispatch time).
        const create = await request.post(AQ_BASE, {
            headers: H,
            data: { actionType: 'other', title: 'x', payload: {} },
        });
        expect(create.status()).toBe(404);
        expect(messageText(await create.json())).toContain('Cannot POST');

        // DELETE /:id is likewise not modelled.
        const del = await request.delete(`${AQ_BASE}/${UNKNOWN_UUID}`, {
            headers: authedHeaders(user.access_token),
        });
        expect(del.status()).toBe(404);
        expect(messageText(await del.json())).toContain('Cannot DELETE');
    });

    test('`approve-all` has no GET route, so GET /approve-all falls through to GET /:id and the pipe rejects the literal → 400', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.get(`${AQ_BASE}/approve-all`, {
            headers: authedHeaders(user.access_token),
        });
        expect(res.status()).toBe(400);
        expect(messageText(await res.json())).toContain('Validation failed (uuid is expected)');
    });

    test('configuring an Agent guardrails policy does NOT populate the queue over HTTP', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, user.access_token, {
            name: `AQ guardrails ${stamp()}`,
        });
        expect(agent.id).toMatch(UUID_RE);

        // Even a require_approval policy (the "queue everything" mode) mints
        // nothing here: enforcement runs at internal dispatch, which has no HTTP
        // entrypoint in this stack.
        const put = await request.put(`${API_BASE}/api/agents/${agent.id}/guardrails`, {
            headers: { ...authedHeaders(user.access_token), 'content-type': 'application/json' },
            data: {
                guardrails: { mode: 'require_approval', blockedActionTypes: ['budget_override'] },
            },
        });
        expect(put.status(), `put guardrails body=${await put.text().catch(() => '')}`).toBe(200);

        const queue = await request.get(AQ_BASE, { headers: authedHeaders(user.access_token) });
        expect(queue.status()).toBe(200);
        const body = await queue.json();
        expect(body.data).toEqual([]);
        expect(body.meta).toEqual({ total: 0, limit: 50, offset: 0 });
    });
});
