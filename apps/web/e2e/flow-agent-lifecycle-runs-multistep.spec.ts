/**
 * Agent full lifecycle — cradle-to-grave, MULTISTEP end-to-end (FU-2 runtime surface).
 *
 * The sibling flow-agent specs each drill ONE facet in isolation
 * (instruction-files-deep = file edges, runs-pagination/runs-history = the run
 * envelope, budget-enforcement = the three budget layers, scoping-matrix =
 * scope cascade). This file instead walks ONE agent through its ENTIRE journey
 * as a single coherent story and pins the pieces those specs leave uncovered —
 * the exact state-machine error strings, the run-now state gate, the export
 * envelope skeleton coupled to a real SOUL.md write, the lifecycle events feed,
 * and the archive-vs-hard-delete distinction — all probed LIVE against the CI
 * driver (http://127.0.0.1:3100, sqlite in-memory, NO LLM key, NO
 * TRIGGER_SECRET_KEY) before a single assertion was written:
 *
 *   • create → status 'draft', slug auto-derived, permissions all-false,
 *     maxSkillContextTokens 4000, idleBehavior 'propose', pauseAfterFailures 3
 *   • state machine (via /pause + /resume, no separate transition route):
 *       draft →pause  400 "Cannot transition Agent from draft to paused."
 *       draft →resume 200 status 'active'
 *       active→pause  200 status 'paused'
 *       paused→resume 200 status 'active'
 *       active→resume 400 (same-state)   paused→pause 400 (same-state)
 *   • run-now is state-gated: draft → 409 (inactive) / 500 (trigger unbound);
 *     active → 500 (TRIGGER_SECRET_KEY unset) — env-adaptive, asserted tolerantly
 *   • SOUL.md GET default { name, body:'', hash:'', storage:'db' }; PUT → { newHash };
 *     GET reflects body + hash===newHash; all 5 canonical files independent;
 *     stale expectedHash → 400 (etag mismatch, NOT 409); missing body → 400;
 *     invalid file name → 400
 *   • assign-task → 500 (trigger unbound) BUT an AgentRun row still persists:
 *     status 'failed', triggerKind 'task', taskId set, errorMessage
 *     'enqueue-failed: …', finishedAt stamped. Two assigns → two failed runs
 *     (no dedup on terminal). Pagination envelope { data, meta{total,limit,offset} }.
 *     getRun detail (/:id/runs/:runId) carries logs[]; cross-agent runId → 404.
 *   • cancel a terminal failed run → 200 { cancelled:false, previousStatus:'failed' }
 *   • budget defaults { currentSpendCents:0, capCents:null, currency:'USD' } over
 *     a rolling-30-day window; a failed (non-spending) run leaves spend at 0
 *   • export envelope v1 { meta, identity, model, runtime, avatar, files,
 *     skillBindings:[], budget:[] } with the written SOUL.md surfaced in files.soulMd
 *   • events feed reflects transitions (agent_paused / agent_resumed)
 *   • archive (DELETE) → 200 { archived:true }, status 'archived', STILL readable;
 *     hard-delete (?hard=true) → 200 { deleted:true }, then getOne → 404
 *   • cross-user isolation: every lifecycle route on another user's agent → 404
 *   • auth 401, malformed uuid 400, unknown uuid 404, create validation 400
 *
 * Fully API-orchestrated; a FRESH registerUserViaAPI() owner per test (never the
 * shared seeded user). The `flow-` prefix runs it in the authed chromium project
 * and keeps it out of the no-auth testIgnore regex.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import { createAgentViaAPI, createTaskViaAPI, listAgentRuns } from './helpers/agents-tasks';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/i;
const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';
const AGENTS = `${API_BASE}/api/agents`;

const AGENT_FILE_NAMES = ['SOUL.md', 'AGENTS.md', 'HEARTBEAT.md', 'TOOLS.md', 'agent.yml'] as const;

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Resume a fresh draft agent into ACTIVE. Returns the parsed AgentDto. */
async function activate(
    request: APIRequestContext,
    token: string,
    agentId: string,
): Promise<Record<string, unknown>> {
    const res = await request.post(`${AGENTS}/${agentId}/resume`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `resume body=${await res.text().catch(() => '')}`).toBe(200);
    const dto = await res.json();
    expect(dto.status).toBe('active');
    return dto;
}

/**
 * Fire an assign-task at an agent. Trigger.dev is unbound on the CI driver, so
 * the HTTP layer 500s — but a run row is persisted either way. Returns the
 * observed status so callers can assert env-adaptively.
 */
async function assign(
    request: APIRequestContext,
    token: string,
    agentId: string,
    taskId: string,
): Promise<number> {
    const res = await request.post(`${AGENTS}/${agentId}/assign-task`, {
        headers: authedHeaders(token),
        data: { taskId },
    });
    // 202 if Trigger.dev were wired; 500 on the key-less CI default.
    expect([202, 500]).toContain(res.status());
    return res.status();
}

test.describe('Agent lifecycle — the cradle-to-grave journey', () => {
    test('create returns a DRAFT agent with the full default shape', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.post(AGENTS, {
            headers: authedHeaders(user.access_token),
            data: { scope: 'tenant', name: `Journey ${stamp()}` },
        });
        expect(res.status()).toBe(201);
        const agent = await res.json();
        expect(agent.id).toMatch(UUID_RE);
        expect(agent.status).toBe('draft');
        expect(agent.scope).toBe('tenant');
        expect(agent.slug).toMatch(/^journey-/);
        expect(agent.userId).toBe(user.user.id);
        // Runtime defaults pinned from the live probe.
        expect(agent.maxSkillContextTokens).toBe(4000);
        expect(agent.idleBehavior).toBe('propose');
        expect(agent.pauseAfterFailures).toBe(3);
        expect(agent.avatarMode).toBe('initials');
        expect(agent.errorCount).toBe(0);
        expect(agent.guardrails).toBeNull();
        expect(agent.targets).toBeNull();
        // Every permission is off by default (least-privilege posture).
        for (const v of Object.values(agent.permissions as Record<string, boolean>)) {
            expect(v).toBe(false);
        }
    });

    test('full journey: create → soul → activate → assign → runs → export → archive', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const H = authedHeaders(token);

        // 1. Born as a draft.
        const agent = await createAgentViaAPI(request, token, {
            scope: 'tenant',
            name: `Cradle ${stamp()}`,
        });
        expect(agent.status).toBe('draft');

        // 2. Give it a soul (instruction file) while still a draft.
        const soul = '# Soul\nBe relentlessly helpful.';
        const put = await request.put(`${AGENTS}/${agent.id}/files/SOUL.md`, {
            headers: H,
            data: { body: soul },
        });
        expect(put.status()).toBe(200);
        expect((await put.json()).newHash).toMatch(SHA256_RE);

        // 3. Activate (draft → active).
        await activate(request, token, agent.id);

        // 4. Assign a task — enqueue 500s (no Trigger.dev) but a run persists.
        const task = await createTaskViaAPI(request, token, { title: `Cradle work ${stamp()}` });
        await assign(request, token, agent.id, task.id);

        // 5. The run history proves the record survived the enqueue failure.
        const runs = await listAgentRuns(request, token, agent.id);
        expect(runs.length).toBeGreaterThanOrEqual(1);
        const run = runs.find((r) => r.taskId === task.id);
        expect(run, 'a run row for the assigned task must exist').toBeTruthy();
        expect(run!.triggerKind).toBe('task');

        // 6. Export carries the identity + the soul we wrote.
        const exp = await request.get(`${AGENTS}/${agent.id}/export`, { headers: H });
        expect(exp.status()).toBe(200);
        const env = await exp.json();
        expect(env.version).toBe(1);
        expect(env.meta.sourceAgentId).toBe(agent.id);
        expect(env.files.soulMd).toBe(soul);

        // 7. Archive — soft-delete, still readable, status flips to 'archived'.
        const del = await request.delete(`${AGENTS}/${agent.id}`, { headers: H });
        expect(del.status()).toBe(200);
        expect((await del.json()).archived).toBe(true);
        const after = await request.get(`${AGENTS}/${agent.id}`, { headers: H });
        expect(after.status()).toBe(200);
        expect((await after.json()).status).toBe('archived');
    });
});

test.describe('Agent lifecycle — the state machine', () => {
    test('a draft agent cannot be paused (400 with the exact transition message)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, user.access_token, {
            scope: 'tenant',
            name: `SM ${stamp()}`,
        });
        const res = await request.post(`${AGENTS}/${agent.id}/pause`, {
            headers: authedHeaders(user.access_token),
        });
        expect(res.status()).toBe(400);
        expect((await res.json()).message).toBe('Cannot transition Agent from draft to paused.');
    });

    test('draft → resume → active → pause → paused → resume cycles cleanly', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const H = authedHeaders(token);
        const agent = await createAgentViaAPI(request, token, {
            scope: 'tenant',
            name: `Cycle ${stamp()}`,
        });

        const r1 = await request.post(`${AGENTS}/${agent.id}/resume`, { headers: H });
        expect(r1.status()).toBe(200);
        expect((await r1.json()).status).toBe('active');

        const p1 = await request.post(`${AGENTS}/${agent.id}/pause`, { headers: H });
        expect(p1.status()).toBe(200);
        expect((await p1.json()).status).toBe('paused');

        const r2 = await request.post(`${AGENTS}/${agent.id}/resume`, { headers: H });
        expect(r2.status()).toBe(200);
        expect((await r2.json()).status).toBe('active');
    });

    test('same-state transitions are rejected 400 (active→resume, paused→pause)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const H = authedHeaders(token);
        const agent = await createAgentViaAPI(request, token, {
            scope: 'tenant',
            name: `Same ${stamp()}`,
        });
        await activate(request, token, agent.id);

        // active → resume (already active) → 400
        const rr = await request.post(`${AGENTS}/${agent.id}/resume`, { headers: H });
        expect(rr.status()).toBe(400);
        expect((await rr.json()).message).toBe('Cannot transition Agent from active to active.');

        // move to paused, then paused → pause (already paused) → 400
        expect((await request.post(`${AGENTS}/${agent.id}/pause`, { headers: H })).status()).toBe(
            200,
        );
        const pp = await request.post(`${AGENTS}/${agent.id}/pause`, { headers: H });
        expect(pp.status()).toBe(400);
        expect((await pp.json()).message).toBe('Cannot transition Agent from paused to paused.');
    });

    test('run-now is state-gated: draft is refused; an active agent reaches the (unbound) dispatcher', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const H = authedHeaders(token);
        const agent = await createAgentViaAPI(request, token, {
            scope: 'tenant',
            name: `RunNow ${stamp()}`,
        });

        // Draft is not ACTIVE → the dispatcher skips with 'inactive' (409). If the
        // heartbeat trigger were unbound it would 500 first — tolerate both, but
        // never a 2xx and never a 404.
        const draftRun = await request.post(`${AGENTS}/${agent.id}/run-now`, { headers: H });
        expect([409, 500]).toContain(draftRun.status());

        await activate(request, token, agent.id);
        // Active reaches dispatchOne → 500 on the CI default (TRIGGER_SECRET_KEY
        // unset); 202 only if Trigger.dev were wired.
        const activeRun = await request.post(`${AGENTS}/${agent.id}/run-now`, { headers: H });
        expect([202, 500]).toContain(activeRun.status());
    });
});

test.describe('Agent lifecycle — SOUL.md + instruction files roundtrip', () => {
    test('SOUL.md is empty-on-create, then a PUT round-trips body + a stable content hash', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const H = authedHeaders(token);
        const agent = await createAgentViaAPI(request, token, {
            scope: 'tenant',
            name: `Soul ${stamp()}`,
        });

        const initial = await request.get(`${AGENTS}/${agent.id}/files/SOUL.md`, { headers: H });
        expect(initial.status()).toBe(200);
        const before = await initial.json();
        expect(before.name).toBe('SOUL.md');
        expect(before.body).toBe('');
        expect(before.hash).toBe('');
        expect(before.storage).toBe('db');

        const body = '# Soul\nMission: ship.';
        const put = await request.put(`${AGENTS}/${agent.id}/files/SOUL.md`, {
            headers: H,
            data: { body },
        });
        expect(put.status()).toBe(200);
        const newHash = (await put.json()).newHash as string;
        expect(newHash).toMatch(SHA256_RE);

        const after = await request.get(`${AGENTS}/${agent.id}/files/SOUL.md`, { headers: H });
        const view = await after.json();
        expect(view.body).toBe(body);
        expect(view.hash).toBe(newHash);
    });

    test('all five canonical files are independently writable', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const H = authedHeaders(token);
        const agent = await createAgentViaAPI(request, token, {
            scope: 'tenant',
            name: `Files ${stamp()}`,
        });

        for (const name of AGENT_FILE_NAMES) {
            const body = `content for ${name} ${stamp()}`;
            const put = await request.put(`${AGENTS}/${agent.id}/files/${name}`, {
                headers: H,
                data: { body },
            });
            expect(put.status(), `PUT ${name}`).toBe(200);
            const read = await request.get(`${AGENTS}/${agent.id}/files/${name}`, { headers: H });
            expect((await read.json()).body).toBe(body);
        }
    });

    test('optimistic concurrency + validation: stale hash 400, missing body 400, bad name 400', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const H = authedHeaders(token);
        const agent = await createAgentViaAPI(request, token, {
            scope: 'tenant',
            name: `Guard ${stamp()}`,
        });
        // Seed a body so a real hash exists.
        await request.put(`${AGENTS}/${agent.id}/files/SOUL.md`, {
            headers: H,
            data: { body: 'v1' },
        });

        // Stale expectedHash → 400 (etag mismatch — NOT 409).
        const stale = await request.put(`${AGENTS}/${agent.id}/files/SOUL.md`, {
            headers: H,
            data: { body: 'v2', expectedHash: 'deadbeefdeadbeef' },
        });
        expect(stale.status()).toBe(400);

        // Missing string body → 400.
        const noBody = await request.put(`${AGENTS}/${agent.id}/files/SOUL.md`, {
            headers: H,
            data: { notBody: 'x' },
        });
        expect(noBody.status()).toBe(400);

        // Unknown file name → 400, and the error lists the allowed set.
        const badName = await request.put(`${AGENTS}/${agent.id}/files/BOGUS.md`, {
            headers: H,
            data: { body: 'x' },
        });
        expect(badName.status()).toBe(400);
        expect(String((await badName.json()).message)).toContain('SOUL.md');
    });
});

test.describe('Agent lifecycle — assign-task run persistence + run history', () => {
    test('assign-task persists a FAILED run even though the enqueue 500s', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const agent = await createAgentViaAPI(request, token, {
            scope: 'tenant',
            name: `Assign ${stamp()}`,
        });
        const task = await createTaskViaAPI(request, token, { title: `Assign work ${stamp()}` });

        const status = await assign(request, token, agent.id, task.id);
        const runs = await listAgentRuns(request, token, agent.id);
        const run = runs.find((r) => r.taskId === task.id);
        expect(run, 'the run row must persist regardless of enqueue outcome').toBeTruthy();
        expect(run!.id).toMatch(UUID_RE);
        expect(run!.triggerKind).toBe('task');
        if (status === 500) {
            // Trigger.dev unbound → the queued row is marked failed with a diagnostic.
            expect(run!.status).toBe('failed');
            expect(String(run!.errorMessage)).toContain('enqueue-failed');
        } else {
            expect(['queued', 'running', 'succeeded', 'failed']).toContain(run!.status);
        }
    });

    test('two assigns of the same task spawn two distinct runs (no dedup once terminal)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const agent = await createAgentViaAPI(request, token, {
            scope: 'tenant',
            name: `Dedup ${stamp()}`,
        });
        const task = await createTaskViaAPI(request, token, { title: `Dedup work ${stamp()}` });

        await assign(request, token, agent.id, task.id);
        await assign(request, token, agent.id, task.id);
        const runs = await listAgentRuns(request, token, agent.id);
        // Both prior runs went terminal (failed), so the second assign could not
        // reuse an in-flight row → two rows for this (task, agent) pair.
        expect(runs.filter((r) => r.taskId === task.id).length).toBeGreaterThanOrEqual(2);
    });

    test('runs pagination envelope: limit/offset echoed, total counts all rows', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const H = authedHeaders(token);
        const agent = await createAgentViaAPI(request, token, {
            scope: 'tenant',
            name: `Page ${stamp()}`,
        });
        const task = await createTaskViaAPI(request, token, { title: `Page work ${stamp()}` });
        await assign(request, token, agent.id, task.id);
        await assign(request, token, agent.id, task.id);

        const page = await request.get(`${AGENTS}/${agent.id}/runs?limit=1&offset=0`, {
            headers: H,
        });
        expect(page.status()).toBe(200);
        const body = await page.json();
        expect(Array.isArray(body.data)).toBe(true);
        expect(body.data.length).toBeLessThanOrEqual(1);
        expect(body.meta.limit).toBe(1);
        expect(body.meta.offset).toBe(0);
        expect(body.meta.total).toBeGreaterThanOrEqual(2);
    });

    test('run detail (/:id/runs/:runId) carries a logs[]; a foreign runId → 404', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const H = authedHeaders(token);
        const a = await createAgentViaAPI(request, token, {
            scope: 'tenant',
            name: `DetailA ${stamp()}`,
        });
        const b = await createAgentViaAPI(request, token, {
            scope: 'tenant',
            name: `DetailB ${stamp()}`,
        });
        const task = await createTaskViaAPI(request, token, { title: `Detail work ${stamp()}` });
        await assign(request, token, a.id, task.id);

        const runs = await listAgentRuns(request, token, a.id);
        const runId = runs[0].id;

        const detail = await request.get(`${AGENTS}/${a.id}/runs/${runId}`, { headers: H });
        expect(detail.status()).toBe(200);
        const d = await detail.json();
        expect(d.id).toBe(runId);
        expect(d.triggerKind).toBe('task');
        expect(Array.isArray(d.logs)).toBe(true);
        // Extended detail-only fields are present (may be null).
        expect(d).toHaveProperty('chatMessageId');
        expect(d).toHaveProperty('memorySessionId');

        // A's runId requested under B (same user, different agent) → 404.
        const crossAgent = await request.get(`${AGENTS}/${b.id}/runs/${runId}`, { headers: H });
        expect(crossAgent.status()).toBe(404);
    });

    test('cancel on a terminal failed run is a no-op; assign errors 404 / 400', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const H = authedHeaders(token);
        const agent = await createAgentViaAPI(request, token, {
            scope: 'tenant',
            name: `Cancel ${stamp()}`,
        });
        const task = await createTaskViaAPI(request, token, { title: `Cancel work ${stamp()}` });
        const status = await assign(request, token, agent.id, task.id);
        const runs = await listAgentRuns(request, token, agent.id);
        const runId = runs[0].id;

        const cancel = await request.post(`${AGENTS}/${agent.id}/runs/${runId}/cancel`, {
            headers: H,
        });
        expect(cancel.status()).toBe(200);
        const c = await cancel.json();
        if (status === 500) {
            // Already failed (terminal) → nothing to cancel.
            expect(c.cancelled).toBe(false);
            expect(c.previousStatus).toBe('failed');
        }

        // assign-task to an unknown task → 404; missing taskId → 400.
        const unknownTask = await request.post(`${AGENTS}/${agent.id}/assign-task`, {
            headers: H,
            data: { taskId: UNKNOWN_UUID },
        });
        expect(unknownTask.status()).toBe(404);
        const missing = await request.post(`${AGENTS}/${agent.id}/assign-task`, {
            headers: H,
            data: {},
        });
        expect(missing.status()).toBe(400);
    });
});

test.describe('Agent lifecycle — budget, export envelope + events feed', () => {
    test('budget defaults to a zero-spend USD rolling-30-day window after a failed run', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const H = authedHeaders(token);
        const agent = await createAgentViaAPI(request, token, {
            scope: 'tenant',
            name: `Budget ${stamp()}`,
        });
        const task = await createTaskViaAPI(request, token, { title: `Budget work ${stamp()}` });
        // A failed (non-billed) run must NOT move the spend needle.
        await assign(request, token, agent.id, task.id);

        const res = await request.get(`${AGENTS}/${agent.id}/budget`, { headers: H });
        expect(res.status()).toBe(200);
        const budget = await res.json();
        expect(budget.currentSpendCents).toBe(0);
        expect(budget.capCents).toBeNull();
        expect(budget.currency).toBe('USD');
        const spanMs =
            new Date(budget.periodEnd).getTime() - new Date(budget.periodStart).getTime();
        const days = spanMs / (24 * 60 * 60 * 1000);
        expect(days).toBeGreaterThan(29);
        expect(days).toBeLessThan(31);
    });

    test('export envelope v1 has the full section skeleton with defaults', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const H = authedHeaders(token);
        const agent = await createAgentViaAPI(request, token, {
            scope: 'tenant',
            name: `Envelope ${stamp()}`,
        });

        const res = await request.get(`${AGENTS}/${agent.id}/export`, { headers: H });
        expect(res.status()).toBe(200);
        const env = await res.json();
        expect(env.version).toBe(1);
        expect(env.meta.sourceAgentId).toBe(agent.id);
        expect(env.meta.sourceUserId).toBe(user.user.id);
        expect(typeof env.meta.exportedAt).toBe('string');
        expect(env.identity.name).toBe(agent.name);
        expect(env.identity.scope).toBe('tenant');
        expect(env.model.maxSkillContextTokens).toBe(4000);
        expect(env.runtime.idleBehavior).toBe('propose');
        expect(env.runtime.pauseAfterFailures).toBe(3);
        expect(env.avatar.mode).toBe('initials');
        // Empty files + no bindings + no budget on a fresh agent.
        expect(env.files.soulMd).toBeNull();
        expect(Array.isArray(env.skillBindings)).toBe(true);
        expect(env.skillBindings.length).toBe(0);
        expect(Array.isArray(env.budget)).toBe(true);
    });

    test('a written SOUL.md surfaces in the export envelope files.soulMd', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const H = authedHeaders(token);
        const agent = await createAgentViaAPI(request, token, {
            scope: 'tenant',
            name: `ExportSoul ${stamp()}`,
        });
        const soul = `# Exported soul ${stamp()}`;
        await request.put(`${AGENTS}/${agent.id}/files/SOUL.md`, {
            headers: H,
            data: { body: soul },
        });
        await request.put(`${AGENTS}/${agent.id}/files/TOOLS.md`, {
            headers: H,
            data: { body: '- ripgrep' },
        });

        const env = await (
            await request.get(`${AGENTS}/${agent.id}/export`, { headers: H })
        ).json();
        expect(env.files.soulMd).toBe(soul);
        expect(env.files.toolsMd).toBe('- ripgrep');
        expect(env.files.agentsMd).toBeNull();
    });

    test('the events feed records lifecycle transitions (paused / resumed)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const H = authedHeaders(token);
        const agent = await createAgentViaAPI(request, token, {
            scope: 'tenant',
            name: `Events ${stamp()}`,
        });
        await activate(request, token, agent.id); // logs agent_resumed
        expect((await request.post(`${AGENTS}/${agent.id}/pause`, { headers: H })).status()).toBe(
            200,
        ); // logs agent_paused

        const res = await request.get(`${AGENTS}/${agent.id}/events`, { headers: H });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(Array.isArray(body.data)).toBe(true);
        const types = body.data.map((e: { actionType: string }) => e.actionType);
        expect(types).toContain('agent_paused');
        expect(types).toContain('agent_resumed');
        expect(body.meta.total).toBeGreaterThanOrEqual(2);
        // Event rows carry a stable shape.
        for (const e of body.data) {
            expect(e.id).toMatch(UUID_RE);
            expect(typeof e.createdAt).toBe('string');
        }
    });
});

test.describe('Agent lifecycle — archive/delete, isolation + validation', () => {
    test('archive is a reversible soft-delete; hard-delete is permanent', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const H = authedHeaders(token);

        // Soft archive: agent survives, flips to 'archived'.
        const soft = await createAgentViaAPI(request, token, {
            scope: 'tenant',
            name: `Soft ${stamp()}`,
        });
        const arch = await request.delete(`${AGENTS}/${soft.id}`, { headers: H });
        expect(arch.status()).toBe(200);
        expect((await arch.json()).archived).toBe(true);
        expect(
            (await (await request.get(`${AGENTS}/${soft.id}`, { headers: H })).json()).status,
        ).toBe('archived');

        // Hard delete: gone for good → 404.
        const hard = await createAgentViaAPI(request, token, {
            scope: 'tenant',
            name: `Hard ${stamp()}`,
        });
        const del = await request.delete(`${AGENTS}/${hard.id}?hard=true`, { headers: H });
        expect(del.status()).toBe(200);
        expect((await del.json()).deleted).toBe(true);
        expect((await request.get(`${AGENTS}/${hard.id}`, { headers: H })).status()).toBe(404);
    });

    test('list filters by status: an active agent shows under active, not under paused', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const H = authedHeaders(token);
        const agent = await createAgentViaAPI(request, token, {
            scope: 'tenant',
            name: `Filter ${stamp()}`,
        });
        await activate(request, token, agent.id);

        const active = await request.get(`${AGENTS}?status=active`, { headers: H });
        expect(active.status()).toBe(200);
        expect((await active.json()).data.map((a: { id: string }) => a.id)).toContain(agent.id);

        const paused = await request.get(`${AGENTS}?status=paused`, { headers: H });
        expect((await paused.json()).data.map((a: { id: string }) => a.id)).not.toContain(agent.id);
    });

    test("cross-user isolation: every lifecycle route on another user's agent → 404", async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const intruder = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, owner.access_token, {
            scope: 'tenant',
            name: `Private ${stamp()}`,
        });
        const iH = authedHeaders(intruder.access_token);

        expect((await request.get(`${AGENTS}/${agent.id}`, { headers: iH })).status()).toBe(404);
        expect((await request.get(`${AGENTS}/${agent.id}/runs`, { headers: iH })).status()).toBe(
            404,
        );
        expect((await request.get(`${AGENTS}/${agent.id}/export`, { headers: iH })).status()).toBe(
            404,
        );
        expect((await request.get(`${AGENTS}/${agent.id}/budget`, { headers: iH })).status()).toBe(
            404,
        );
        expect(
            (await request.get(`${AGENTS}/${agent.id}/files/SOUL.md`, { headers: iH })).status(),
        ).toBe(404);
        expect((await request.get(`${AGENTS}/${agent.id}/events`, { headers: iH })).status()).toBe(
            404,
        );
        expect((await request.post(`${AGENTS}/${agent.id}/pause`, { headers: iH })).status()).toBe(
            404,
        );
        expect((await request.post(`${AGENTS}/${agent.id}/resume`, { headers: iH })).status()).toBe(
            404,
        );
        expect(
            (
                await request.put(`${AGENTS}/${agent.id}/files/SOUL.md`, {
                    headers: iH,
                    data: { body: 'x' },
                })
            ).status(),
        ).toBe(404);
        expect(
            (
                await request.patch(`${AGENTS}/${agent.id}`, {
                    headers: iH,
                    data: { name: 'hijack' },
                })
            ).status(),
        ).toBe(404);
        expect((await request.delete(`${AGENTS}/${agent.id}`, { headers: iH })).status()).toBe(404);

        // The owner's agent is untouched.
        expect(
            (
                await request.get(`${AGENTS}/${agent.id}`, {
                    headers: authedHeaders(owner.access_token),
                })
            ).status(),
        ).toBe(200);
    });

    test('auth + id shape: unauth 401, malformed uuid 400, unknown uuid 404', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const H = authedHeaders(user.access_token);
        // No token at all.
        expect((await request.get(AGENTS)).status()).toBe(401);
        expect((await request.get(`${AGENTS}/${UNKNOWN_UUID}`)).status()).toBe(401);
        // Authed but malformed id → ParseUUIDPipe 400.
        expect((await request.get(`${AGENTS}/not-a-uuid`, { headers: H })).status()).toBe(400);
        expect((await request.get(`${AGENTS}/not-a-uuid/runs`, { headers: H })).status()).toBe(400);
        // Well-formed but unknown id → 404.
        expect((await request.get(`${AGENTS}/${UNKNOWN_UUID}`, { headers: H })).status()).toBe(404);
    });

    test('create validation: missing name 400, invalid scope 400, scope=work without workId 400', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const H = authedHeaders(user.access_token);
        expect(
            (await request.post(AGENTS, { headers: H, data: { scope: 'tenant' } })).status(),
        ).toBe(400);

        const badScope = await request.post(AGENTS, {
            headers: H,
            data: { scope: 'galaxy', name: `X ${stamp()}` },
        });
        expect(badScope.status()).toBe(400);
        expect(String((await badScope.json()).message)).toContain('scope');

        expect(
            (
                await request.post(AGENTS, {
                    headers: H,
                    data: { scope: 'work', name: `X ${stamp()}` },
                })
            ).status(),
        ).toBe(400);
    });
});
