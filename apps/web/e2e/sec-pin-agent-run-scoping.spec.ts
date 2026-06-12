import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import { createAgentViaAPI, createTaskViaAPI } from './helpers/agents-tasks';

/**
 * sec-pin: Agent run scoping (EW-710 Wave M #133) + Agent attachment
 * uploadId validation (Wave M #118).
 *
 * Wave M #133 made GET /api/agents/:id/runs defense-in-depth: besides the
 * service.getOne() ownership gate, the controller now queries the
 * USER-SCOPED repository variants (findByAgentAndUser / countByAgentAndUser),
 * so run rows and run COUNTS can never leak across users even if the front
 * gate were refactored away. Wave M #118 replaced the raw inline body type
 * of POST /api/agents/:id/attachments with a class-validator DTO
 * (AddAgentAttachmentDto { @IsUUID() uploadId }) enforced by the global
 * ValidationPipe.
 *
 * NON-DUPLICATION — already pinned elsewhere, NOT re-pinned here:
 *   - flow-agent-runs-pagination.spec.ts: cross-user GET :id/runs → bare 404;
 *     anon GET :id/runs → 401; non-UUID agent id → 400; unknown agent → 404;
 *     runs pagination envelope/ordering; cancel idempotency + unknown runId
 *     404 under the OWNER's agent.
 *   - flow-agent-runs-history.spec.ts: multi-run ordering, budget, meta math.
 *   - flow-idor-resource-access.spec.ts: GET :id and :id/runs cross-user 404
 *     status matrix; foreign-task-to-own-agent assign → 404 Task not found.
 *   - agents-advanced.spec.ts: GET :id/attachments starts as [].
 *   This file pins the COMPLEMENTARY surface: 404-body fingerprint equality
 *   (foreign vs never-existed) for the runs/attachments routes, cross-user
 *   run CANCEL and cross-user assign-task (foreign AGENT direction), per-user
 *   run-count disjointness, and the whole Wave M #118 attachment-validation
 *   contract, none of which any existing spec asserts.
 *
 * PROBED CONTRACTS (live sqlite stack, 2026-06-11 — every assertion below
 * was observed via curl before being written):
 *   - POST /api/agents/:id/assign-task with no Trigger.dev binding → 500
 *     "enqueue-failed…", BUT a failed AgentRun row IS persisted (assert run
 *     records, never completions).
 *   - GET /api/agents/:id/runs (owner) → 200 { data:[{ id, status,
 *     triggerKind:'task', taskId, … }], meta:{ total, limit:25, offset:0 } };
 *     totals are per-owner and run-id sets of two users are disjoint.
 *   - GET /api/agents/:id/runs (other user) → 404
 *     { message:"Agent <id> not found.", error:"Not Found", statusCode:404 }
 *     — byte-identical in shape to a never-existed agent id (non-disclosure).
 *   - POST /api/agents/:id/runs/:runId/cancel (other user, REAL ids) → the
 *     same agent-gate 404; the victim's run row stays status:'failed' and
 *     meta.total is unchanged.
 *   - POST /api/agents/:id/assign-task (other user's agent, own task) → the
 *     same agent-gate 404; no run row is created anywhere; the task is
 *     untouched.
 *   - POST /api/agents/:id/attachments {uploadId:'not-a-uuid'} → 400
 *     { message:["uploadId must be a UUID"], error:"Bad Request" } — and the
 *     SAME field 400 for a missing uploadId, a numeric uploadId, and a
 *     UUID-SHAPED string with an invalid RFC-4122 variant nibble
 *     ('44444444-4444-4444-4444-444444444444' fails: class-validator IsUUID
 *     checks variant bits, unlike lookalike formats ParseUUIDPipe accepts).
 *   - POST attachments with a WELL-FORMED v4 UUID (owner) → 400
 *     { message:"Invalid uploadId" } (STRING message, service layer): the
 *     deeper agents.service guard requires a 64-hex sha-256 id (PR #1044),
 *     so the DTO (@IsUUID) and the service (SHA256_RE) currently disagree —
 *     we pin only the reachable rejection statuses/messages, not a success.
 *     Nothing persists: GET attachments stays [].
 *   - DTO validation runs BEFORE the ownership gate: a cross-user POST with
 *     a malformed uploadId 400s (no agent-existence disclosure); with a
 *     well-formed uploadId it 404s at the agent gate exactly like a
 *     never-existed agent.
 *   - GET /api/agents/:id/attachments cross-user → agent-gate 404 with the
 *     same fingerprint as an unknown agent.
 *   - DELETE /api/agents/:id/attachments/:attachmentId — malformed
 *     attachmentId → 400 "Validation failed (uuid is expected)"
 *     (ParseUUIDPipe); unknown well-formed id (owner) → 404
 *     "Attachment not found"; cross-user with real agent id → agent-gate 404.
 *   - Anonymous GET/POST/DELETE on the attachment surface → 401
 *     { message:"Unauthorized", statusCode:401 }.
 *
 * Isolation: every test registers FRESH users via registerUserViaAPI and
 * uses unique timestamp-suffixed names; nothing touches the seeded
 * storageState user. API-contract assertions only (no UI navigation).
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Well-formed RFC-4122 v4 UUIDs that exist nowhere in the DB. */
const UNKNOWN_UPLOAD_UUID = 'a6c1f0e2-3b4d-4e5f-8a9b-0c1d2e3f4a5b';
/** A well-formed sha256 (64-hex) that no real upload owns — passes the DTO,
 *  fails the upload-ownership gate. */
const UNKNOWN_UPLOAD_SHA = 'a'.repeat(64);
const UNKNOWN_AGENT_UUID = '9e8d7c6b-5a4f-4321-9876-fedcba987654';
const UNKNOWN_ATTACHMENT_UUID = 'b7d2e1f3-4c5a-4b6d-9e8f-1a2b3c4d5e6f';
/** UUID-shaped but RFC-invalid (variant nibble '4' — must be 8/9/a/b). */
const BAD_VARIANT_UUID = '44444444-4444-4444-4444-444444444444';

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

interface RunRow {
    id: string;
    status: string;
    triggerKind: string;
    taskId: string | null;
}

interface RunsPage {
    data: RunRow[];
    meta: { total: number; limit: number; offset: number };
}

interface ErrorBody {
    message: string | string[];
    error?: string;
    statusCode: number;
}

async function getRunsPage(
    request: APIRequestContext,
    token: string,
    agentId: string,
): Promise<RunsPage> {
    const res = await request.get(`${API_BASE}/api/agents/${agentId}/runs`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `runs body=${await res.text().catch(() => '')}`).toBe(200);
    return res.json();
}

/**
 * Dispatch a task onto an agent. Without a Trigger.dev binding (the e2e
 * default) the HTTP call 500s at enqueue but a failed run row IS persisted —
 * tolerate [202, 500] and let callers assert via the run record.
 */
async function dispatch(
    request: APIRequestContext,
    token: string,
    agentId: string,
    taskId: string,
): Promise<void> {
    const res = await request.post(`${API_BASE}/api/agents/${agentId}/assign-task`, {
        headers: authedHeaders(token),
        data: { taskId },
    });
    expect([202, 500]).toContain(res.status());
}

/** Wait until the agent's run total reaches `n` (rows persist async-ish). */
async function waitForRunTotal(
    request: APIRequestContext,
    token: string,
    agentId: string,
    n: number,
): Promise<void> {
    await expect
        .poll(async () => (await getRunsPage(request, token, agentId)).meta.total, {
            timeout: 20_000,
            message: `expected ${n} run row(s) for agent ${agentId}`,
        })
        .toBeGreaterThanOrEqual(n);
}

/** Register a user, mint an agent + task, and record one failed run. */
async function seedOwnerWithRun(request: APIRequestContext, label: string) {
    const user = await registerUserViaAPI(request);
    const agent = await createAgentViaAPI(request, user.access_token, {
        name: `${label} Agent ${stamp()}`,
    });
    const task = await createTaskViaAPI(request, user.access_token, {
        title: `${label} Task ${stamp()}`,
    });
    await dispatch(request, user.access_token, agent.id, task.id);
    await waitForRunTotal(request, user.access_token, agent.id, 1);
    return { user, agent, task };
}

/** Redact the embedded UUID so two error bodies can be fingerprint-compared. */
function fingerprint(body: ErrorBody): string {
    return JSON.stringify(body).replace(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
        '<uuid>',
    );
}

test.describe('sec-pin: agent run scoping (Wave M #133) + attachment uploadId validation (#118)', () => {
    test('run history and run COUNTS are per-owner: two users see fully disjoint run sets', async ({
        request,
    }) => {
        // Two independent owners, each with exactly one task-triggered run.
        const a = await seedOwnerWithRun(request, 'ScopeA');
        const b = await seedOwnerWithRun(request, 'ScopeB');

        const pageA = await getRunsPage(request, a.user.access_token, a.agent.id);
        const pageB = await getRunsPage(request, b.user.access_token, b.agent.id);

        // Owner-side contract: the envelope defaults and the recorded row.
        expect(pageA.meta).toEqual({ total: 1, limit: 25, offset: 0 });
        expect(pageB.meta).toEqual({ total: 1, limit: 25, offset: 0 });
        expect(pageA.data).toHaveLength(1);
        expect(pageA.data[0].id).toMatch(UUID_RE);
        expect(pageA.data[0].triggerKind).toBe('task');
        expect(pageA.data[0].taskId).toBe(a.task.id);
        expect(pageB.data[0].taskId).toBe(b.task.id);

        // Wave M #133 (findByAgentAndUser / countByAgentAndUser): the two
        // owners' run-id sets are DISJOINT — neither count nor rows include
        // the other user's run, even though both live in the same table.
        const idsA = new Set(pageA.data.map((r) => r.id));
        const idsB = new Set(pageB.data.map((r) => r.id));
        for (const id of idsA) expect(idsB.has(id), `run ${id} must not leak to B`).toBe(false);
        // And B's taskId never appears in A's page (no foreign rows at all).
        expect(pageA.data.some((r) => r.taskId === b.task.id)).toBe(false);
        expect(pageB.data.some((r) => r.taskId === a.task.id)).toBe(false);
    });

    test("user B listing user A's runs gets a 404 body INDISTINGUISHABLE from a never-existed agent", async ({
        request,
    }) => {
        // (The bare cross-user 404 status is pinned in
        // flow-agent-runs-pagination.spec.ts — the NEW pin here is the exact
        // body shape and its fingerprint-equality with the unknown-agent 404,
        // i.e. agent-existence non-disclosure on the runs route.)
        const a = await seedOwnerWithRun(request, 'Fp');
        const b = await registerUserViaAPI(request);

        const crossRes = await request.get(`${API_BASE}/api/agents/${a.agent.id}/runs`, {
            headers: authedHeaders(b.access_token),
        });
        expect(crossRes.status()).toBe(404);
        const crossBody = (await crossRes.json()) as ErrorBody;
        expect(crossBody).toEqual({
            message: `Agent ${a.agent.id} not found.`,
            error: 'Not Found',
            statusCode: 404,
        });

        const unknownRes = await request.get(`${API_BASE}/api/agents/${UNKNOWN_AGENT_UUID}/runs`, {
            headers: authedHeaders(b.access_token),
        });
        expect(unknownRes.status()).toBe(404);
        const unknownBody = (await unknownRes.json()) as ErrorBody;

        // Id-redacted bodies are byte-identical: a foreign agent and a
        // never-existed agent are indistinguishable to the prober.
        expect(fingerprint(crossBody)).toBe(fingerprint(unknownBody));
    });

    test("user B cannot cancel user A's run — agent-gate 404 with real ids, run row untouched", async ({
        request,
    }) => {
        const a = await seedOwnerWithRun(request, 'Cxl');
        const b = await registerUserViaAPI(request);
        const before = await getRunsPage(request, a.user.access_token, a.agent.id);
        const run = before.data[0];
        expect(run.status).toBe('failed'); // enqueue-failed at dispatch (no Trigger binding)

        // B holds BOTH real ids (agent + run) — the cancel still 404s at the
        // agent ownership gate, identical to the runs-list gate.
        const res = await request.post(
            `${API_BASE}/api/agents/${a.agent.id}/runs/${run.id}/cancel`,
            { headers: authedHeaders(b.access_token) },
        );
        expect(res.status()).toBe(404);
        const body = (await res.json()) as ErrorBody;
        expect(body.message).toBe(`Agent ${a.agent.id} not found.`);

        // The victim's history is provably untouched: same total, same row,
        // same terminal status (a cancel would have flipped/echoed state).
        const after = await getRunsPage(request, a.user.access_token, a.agent.id);
        expect(after.meta.total).toBe(before.meta.total);
        const sameRun = after.data.find((r) => r.id === run.id);
        expect(sameRun).toBeTruthy();
        expect(sameRun!.status).toBe('failed');
    });

    test("user B cannot dispatch onto user A's agent — cross-user assign-task 404s and records NO run", async ({
        request,
    }) => {
        // (flow-idor pins the OTHER direction: own agent + foreign task →
        // 404 Task not found. This pins the foreign-AGENT direction.)
        const a = await seedOwnerWithRun(request, 'Disp');
        const b = await registerUserViaAPI(request);
        const bTask = await createTaskViaAPI(request, b.access_token, {
            title: `Disp B Task ${stamp()}`,
        });

        const res = await request.post(`${API_BASE}/api/agents/${a.agent.id}/assign-task`, {
            headers: authedHeaders(b.access_token),
            data: { taskId: bTask.id },
        });
        expect(res.status()).toBe(404);
        const body = (await res.json()) as ErrorBody;
        expect(body.message).toBe(`Agent ${a.agent.id} not found.`);

        // No run row was minted anywhere: A's total is still exactly 1 and
        // no row references B's task.
        const after = await getRunsPage(request, a.user.access_token, a.agent.id);
        expect(after.meta.total).toBe(1);
        expect(after.data.some((r) => r.taskId === bTask.id)).toBe(false);

        // B's task is intact and still in its initial backlog state.
        const taskRes = await request.get(`${API_BASE}/api/tasks/${bTask.id}`, {
            headers: authedHeaders(b.access_token),
        });
        expect(taskRes.status()).toBe(200);
        expect(((await taskRes.json()) as { status: string }).status).toBe('backlog');
    });

    test('Wave M #118 — malformed/missing/numeric uploadId all hit the same field-scoped class-validator 400', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, u.access_token, {
            name: `Att Dto ${stamp()}`,
        });

        // Three distinct invalid shapes, ONE canonical DTO rejection: the
        // global ValidationPipe surfaces class-validator's array message.
        const payloads: Array<Record<string, unknown>> = [
            { uploadId: 'not-a-uuid' },
            {}, // missing entirely
            { uploadId: 12345 }, // type confusion
        ];
        for (const data of payloads) {
            const res = await request.post(`${API_BASE}/api/agents/${agent.id}/attachments`, {
                headers: authedHeaders(u.access_token),
                data,
            });
            expect(res.status(), `payload=${JSON.stringify(data)}`).toBe(400);
            const body = (await res.json()) as ErrorBody;
            expect(body.error).toBe('Bad Request');
            expect(Array.isArray(body.message), 'class-validator message array').toBe(true);
            // `uploadId` is the sha256 content hash (NOT a UUID) — aligned with the
            // Mission/Idea attachment DTOs and the service's own SHA256 guard, so a
            // malformed/missing/typed-wrong value is a field-scoped sha256 rejection.
            expect(String(body.message)).toContain('uploadId');
        }
    });

    test('a UUID-shaped uploadId is rejected by the DTO — uploadId is a sha256 hash, not a UUID', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, u.access_token, {
            name: `Att Variant ${stamp()}`,
        });

        // The agent-attachment DTO now `@Matches(/^[0-9a-f]{64}$/i)` (aligned with
        // Mission/Idea + the service guard, fixing the prior `@IsUUID` that rejected
        // every real upload id). A UUID-shaped value is therefore a clean field 400.
        const res = await request.post(`${API_BASE}/api/agents/${agent.id}/attachments`, {
            headers: authedHeaders(u.access_token),
            data: { uploadId: BAD_VARIANT_UUID },
        });
        expect(res.status()).toBe(400);
        const body = (await res.json()) as ErrorBody;
        expect(Array.isArray(body.message)).toBe(true);
        expect(String(body.message)).toContain('uploadId must match');
    });

    test('a well-formed sha256 uploadId that the caller does NOT own is rejected by the ownership gate (404) — nothing persists', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, u.access_token, {
            name: `Att Service ${stamp()}`,
        });

        // A well-formed sha256 clears the DTO and reaches the service, whose
        // ownership gate (user_uploads lookup) 404s it because no upload with that
        // hash is owned by the caller — closing the dangling-attachment edge.
        const res = await request.post(`${API_BASE}/api/agents/${agent.id}/attachments`, {
            headers: authedHeaders(u.access_token),
            data: { uploadId: UNKNOWN_UPLOAD_SHA },
        });
        expect(res.status()).toBe(404);
        const body = (await res.json()) as ErrorBody;
        expect(String(body.message)).toContain('Upload');
        expect(body.error).toBe('Not Found');

        // Every rejected write above left zero attachment rows behind.
        const list = await request.get(`${API_BASE}/api/agents/${agent.id}/attachments`, {
            headers: authedHeaders(u.access_token),
        });
        expect(list.status()).toBe(200);
        expect(await list.json()).toEqual([]);
    });

    test('DTO validation precedes the ownership gate; cross-user attach/list probes are non-disclosing', async ({
        request,
    }) => {
        const a = await registerUserViaAPI(request);
        const b = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, a.access_token, {
            name: `Att Cross ${stamp()}`,
        });

        // (a) Malformed uploadId from B on A's agent → the SAME field 400 the
        // owner would get: the ValidationPipe fires before requireOwned, so
        // the response discloses nothing about the agent's existence.
        const malformed = await request.post(`${API_BASE}/api/agents/${agent.id}/attachments`, {
            headers: authedHeaders(b.access_token),
            data: { uploadId: 'nope' },
        });
        expect(malformed.status()).toBe(400);
        expect(String(((await malformed.json()) as ErrorBody).message)).toContain(
            'uploadId must match',
        );

        // (b) Well-formed (sha256) uploadId from B → the AGENT-ownership gate
        // (requireOwned) answers first: 404 "Agent <id> not found.", the same as a
        // never-existed agent (it precedes the upload-ownership lookup).
        const wellFormed = await request.post(`${API_BASE}/api/agents/${agent.id}/attachments`, {
            headers: authedHeaders(b.access_token),
            data: { uploadId: UNKNOWN_UPLOAD_SHA },
        });
        expect(wellFormed.status()).toBe(404);
        const wfBody = (await wellFormed.json()) as ErrorBody;
        expect(wfBody.message).toBe(`Agent ${agent.id} not found.`);

        // (c) Cross-user LIST → the same agent-gate 404, fingerprint-equal
        // to listing attachments of an unknown agent.
        const crossList = await request.get(`${API_BASE}/api/agents/${agent.id}/attachments`, {
            headers: authedHeaders(b.access_token),
        });
        expect(crossList.status()).toBe(404);
        const unknownList = await request.get(
            `${API_BASE}/api/agents/${UNKNOWN_AGENT_UUID}/attachments`,
            { headers: authedHeaders(b.access_token) },
        );
        expect(unknownList.status()).toBe(404);
        expect(fingerprint((await crossList.json()) as ErrorBody)).toBe(
            fingerprint((await unknownList.json()) as ErrorBody),
        );

        // (d) The owner still sees a clean empty list — B's probes wrote nothing.
        const ownerList = await request.get(`${API_BASE}/api/agents/${agent.id}/attachments`, {
            headers: authedHeaders(a.access_token),
        });
        expect(ownerList.status()).toBe(200);
        expect(await ownerList.json()).toEqual([]);
    });

    test('detach guards: ParseUUIDPipe 400, unknown attachment 404, cross-user delete hits the agent gate', async ({
        request,
    }) => {
        const a = await registerUserViaAPI(request);
        const b = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, a.access_token, {
            name: `Att Detach ${stamp()}`,
        });

        // (a) Malformed attachmentId → ParseUUIDPipe's canonical message
        // (a STRING — the pipe, not class-validator's array).
        const malformed = await request.delete(
            `${API_BASE}/api/agents/${agent.id}/attachments/not-a-uuid`,
            { headers: authedHeaders(a.access_token) },
        );
        expect(malformed.status()).toBe(400);
        const mBody = (await malformed.json()) as ErrorBody;
        expect(mBody.message).toBe('Validation failed (uuid is expected)');

        // (b) Owner + well-formed but unknown attachment id → a scoped 404
        // that names the ATTACHMENT (the agent gate passed).
        const unknown = await request.delete(
            `${API_BASE}/api/agents/${agent.id}/attachments/${UNKNOWN_ATTACHMENT_UUID}`,
            { headers: authedHeaders(a.access_token) },
        );
        expect(unknown.status()).toBe(404);
        expect(((await unknown.json()) as ErrorBody).message).toBe('Attachment not found');

        // (c) Cross-user delete with the REAL agent id → the agent gate fires
        // first: "Agent <id> not found." — B never learns whether the
        // attachment id exists.
        const cross = await request.delete(
            `${API_BASE}/api/agents/${agent.id}/attachments/${UNKNOWN_ATTACHMENT_UUID}`,
            { headers: authedHeaders(b.access_token) },
        );
        expect(cross.status()).toBe(404);
        expect(((await cross.json()) as ErrorBody).message).toBe(`Agent ${agent.id} not found.`);
    });

    test('the attachment surface demands a bearer: anonymous GET/POST/DELETE are uniform 401s', async ({
        request,
    }) => {
        // (Anon GET :id/runs → 401 is already pinned in
        // flow-agent-runs-pagination.spec.ts; the attachment routes are not.)
        // The API authenticates by Authorization header only, so requests
        // without a bearer are anonymous even under the storageState project.
        const a = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, a.access_token, {
            name: `Att Anon ${stamp()}`,
        });

        const anonGet = await request.get(`${API_BASE}/api/agents/${agent.id}/attachments`);
        expect(anonGet.status()).toBe(401);
        expect((await anonGet.json()) as ErrorBody).toEqual({
            message: 'Unauthorized',
            statusCode: 401,
        });

        const anonPost = await request.post(`${API_BASE}/api/agents/${agent.id}/attachments`, {
            data: { uploadId: UNKNOWN_UPLOAD_UUID },
        });
        expect(anonPost.status(), 'anonymous attach is 401 (before any validation)').toBe(401);

        const anonDelete = await request.delete(
            `${API_BASE}/api/agents/${agent.id}/attachments/${UNKNOWN_ATTACHMENT_UUID}`,
        );
        expect(anonDelete.status()).toBe(401);
    });
});
