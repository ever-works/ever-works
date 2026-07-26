import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, type RegisteredUser } from './helpers/api';
import {
    assignTaskToAgent,
    createAgentViaAPI,
    createTaskViaAPI,
    listAgentRuns,
} from './helpers/agents-tasks';

/**
 * Streaming terminal (Wave 1 M3/M6) — attach-token, start and status
 * API CONTRACT. Zero e2e existed for ~2,600 lines of tested machinery.
 *
 * ── Routes (apps/api/src/terminal/terminal-attach.controller.ts) ────
 *   POST /api/agents/:id/runs/:runId/terminal/attach-token → 201
 *        { token, wsPath:'/ws/terminal/<runId>', role:'driver', expiresInSec }
 *        503 when neither TERMINAL_ATTACH_SECRET nor BETTER_AUTH_SECRET
 *        is set (fail-closed: an unsecured relay refuses attaches).
 *   POST /api/agents/:id/runs/:runId/terminal/start        → 202
 *        409 session already live / run already finished
 *        503 no background job runtime wired
 *   GET  /api/agents/:id/runs/:runId/terminal              → 200
 *        live relay view merged with the persisted run terminal columns
 *
 * Authorization is identical on all three: agent ownership
 * (`AgentsService.getOne`) + user-scoped run lookup + agentId match, so
 * a cross-user or cross-agent runId 404s with NO existence leak. That
 * closure is the security property this file pins.
 *
 * Environment note: the e2e stack has no Trigger.dev key, so a run
 * created through `assign-task` lands `failed` and `start` legitimately
 * answers 409 (run not live) or 503 (no dispatcher). The spec asserts
 * the SET of legal answers rather than pretending a worker exists —
 * what must never happen is a 2xx "started" for a dead run.
 */

const UNKNOWN_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function uniq(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function terminalBase(agentId: string, runId: string): string {
    return `/api/agents/${agentId}/runs/${runId}/terminal`;
}

/**
 * Create an Agent + Task and dispatch, then return the newest run id.
 * Returns null when no run row materialised — callers skip the
 * run-dependent assertions rather than assert on a fixture that the
 * environment could not produce.
 */
async function seedRun(
    request: APIRequestContext,
    user: RegisteredUser,
): Promise<{ agentId: string; runId: string | null }> {
    const agent = await createAgentViaAPI(request, user.access_token, {
        name: `terminal-agent-${uniq()}`,
    });
    const task = await createTaskViaAPI(request, user.access_token, {
        title: `terminal-task-${uniq()}`,
    });
    // Returns null on the expected enqueue failure — the run row is still
    // persisted, which is what we are after.
    await assignTaskToAgent(request, user.access_token, agent.id, task.id);
    const runs = await listAgentRuns(request, user.access_token, agent.id);
    return { agentId: agent.id, runId: runs[0]?.id ?? null };
}

test.describe('terminal attach-token', () => {
    test('mints a driver token for the run owner (or fails closed with 503 when unconfigured)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const { agentId, runId } = await seedRun(request, user);
        test.skip(!runId, 'no AgentRun row was produced by this environment');

        const res = await request.post(
            `${API_BASE}${terminalBase(agentId, runId as string)}/attach-token`,
            { headers: authedHeaders(user.access_token) },
        );
        expect([201, 503], `attach-token returned ${res.status()}`).toContain(res.status());

        if (res.status() === 503) {
            // Fail-closed arm: no signing secret on this install.
            expect(String((await res.json()).message)).toContain('not configured');
            return;
        }

        const body = await res.json();
        expect(typeof body.token).toBe('string');
        expect(body.token.length).toBeGreaterThan(0);
        // The token is presented in the FIRST WebSocket message, never in
        // the URL — so wsPath must carry the run id and nothing secret.
        expect(body.wsPath).toBe(`/ws/terminal/${runId}`);
        expect(body.wsPath).not.toContain(body.token);
        expect(body.role).toBe('driver');
        expect(typeof body.expiresInSec).toBe('number');
        expect(body.expiresInSec).toBeGreaterThan(0);
        // Short-lived by construction — a leak must have a small blast radius.
        expect(body.expiresInSec).toBeLessThanOrEqual(300);
    });

    test('cross-user and cross-agent run ids 404 with no existence leak; anon is 401', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const { agentId, runId } = await seedRun(request, owner);
        test.skip(!runId, 'no AgentRun row was produced by this environment');

        const path = `${terminalBase(agentId, runId as string)}/attach-token`;

        // Stranger: the AGENT lookup 404s first — same answer either way.
        const cross = await request.post(`${API_BASE}${path}`, {
            headers: authedHeaders(stranger.access_token),
        });
        expect(cross.status(), 'a stranger must never mint a token').toBe(404);

        // Owner, but the run belongs to a DIFFERENT agent of theirs.
        const otherAgent = await createAgentViaAPI(request, owner.access_token, {
            name: `other-agent-${uniq()}`,
        });
        const mismatched = await request.post(
            `${API_BASE}${terminalBase(otherAgent.id, runId as string)}/attach-token`,
            { headers: authedHeaders(owner.access_token) },
        );
        expect(mismatched.status(), 'agentId/runId must match').toBe(404);

        const anon = await request.post(`${API_BASE}${path}`);
        expect(anon.status()).toBe(401);
    });

    test('unknown run uuid → 404, malformed uuid → 400 (ParseUUIDPipe before the handler)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, user.access_token, {
            name: `terminal-agent-${uniq()}`,
        });

        const unknown = await request.post(
            `${API_BASE}${terminalBase(agent.id, UNKNOWN_UUID)}/attach-token`,
            { headers: authedHeaders(user.access_token) },
        );
        expect(unknown.status()).toBe(404);

        const malformed = await request.post(
            `${API_BASE}${terminalBase(agent.id, 'not-a-uuid')}/attach-token`,
            { headers: authedHeaders(user.access_token) },
        );
        expect(malformed.status()).toBe(400);
        expect(String((await malformed.json()).message)).toContain('uuid is expected');
    });
});

test.describe('terminal start', () => {
    test('never reports "started" for a run that is not live — 409 or 503, never 2xx', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const { agentId, runId } = await seedRun(request, user);
        test.skip(!runId, 'no AgentRun row was produced by this environment');

        const res = await request.post(
            `${API_BASE}${terminalBase(agentId, runId as string)}/start`,
            { headers: authedHeaders(user.access_token) },
        );
        // 409 = run finished / session already live. 503 = no job runtime
        // wired on this install. Both are correct refusals; a 202 here
        // would mean the launcher dispatched a shell onto a dead run.
        expect([409, 503], `start returned ${res.status()}`).toContain(res.status());
        expect(res.status(), 'a dead run must never report "started"').not.toBe(202);
    });

    test('start authz: stranger 404, unknown run 404, malformed 400, anon 401', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, owner.access_token, {
            name: `terminal-agent-${uniq()}`,
        });

        const unknown = await request.post(
            `${API_BASE}${terminalBase(agent.id, UNKNOWN_UUID)}/start`,
            { headers: authedHeaders(owner.access_token) },
        );
        expect(unknown.status()).toBe(404);

        const cross = await request.post(
            `${API_BASE}${terminalBase(agent.id, UNKNOWN_UUID)}/start`,
            {
                headers: authedHeaders(stranger.access_token),
            },
        );
        expect(cross.status()).toBe(404);

        const malformed = await request.post(
            `${API_BASE}${terminalBase(agent.id, 'not-a-uuid')}/start`,
            { headers: authedHeaders(owner.access_token) },
        );
        expect(malformed.status()).toBe(400);

        const anon = await request.post(`${API_BASE}${terminalBase(agent.id, UNKNOWN_UUID)}/start`);
        expect(anon.status()).toBe(401);
    });
});

test.describe('terminal status', () => {
    test('returns the merged relay + persisted view, and never leaks the resume id', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const { agentId, runId } = await seedRun(request, user);
        test.skip(!runId, 'no AgentRun row was produced by this environment');

        const res = await request.get(`${API_BASE}${terminalBase(agentId, runId as string)}`, {
            headers: authedHeaders(user.access_token),
        });
        expect(res.status(), `status body=${await res.text().catch(() => '')}`).toBe(200);
        const body = await res.json();

        // Persisted half is always present (it survives replica restarts).
        expect(body.run).toBeTruthy();
        expect(typeof body.run.persistent).toBe('boolean');
        expect(body.run).toHaveProperty('terminalState');
        expect(body.run).toHaveProperty('terminalEndedReason');
        expect(body.run).toHaveProperty('lastFrameSeq');
        // PRESENCE only — the pipeline resume id must stay server-side.
        expect(typeof body.run.hasCliSession).toBe('boolean');
        expect(body.run).not.toHaveProperty('cliSessionId');
        expect(JSON.stringify(body)).not.toContain('cliSessionId');
    });

    test('status authz: stranger 404, malformed run uuid 400, anon 401', async ({ request }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, owner.access_token, {
            name: `terminal-agent-${uniq()}`,
        });

        const cross = await request.get(`${API_BASE}${terminalBase(agent.id, UNKNOWN_UUID)}`, {
            headers: authedHeaders(stranger.access_token),
        });
        expect(cross.status()).toBe(404);

        const malformed = await request.get(`${API_BASE}${terminalBase(agent.id, 'not-a-uuid')}`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(malformed.status()).toBe(400);

        const anon = await request.get(`${API_BASE}${terminalBase(agent.id, UNKNOWN_UUID)}`);
        expect(anon.status()).toBe(401);
    });
});
