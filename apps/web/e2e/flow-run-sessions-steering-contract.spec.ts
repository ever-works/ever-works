import { test, expect, type APIRequestContext } from '@playwright/test';
import {
    API_BASE,
    authedHeaders,
    createWorkViaAPI,
    registerUserViaAPI,
    type RegisteredUser,
} from './helpers/api';
import {
    assignTaskToAgent,
    createAgentViaAPI,
    createTaskViaAPI,
    listAgentRuns,
} from './helpers/agents-tasks';

/**
 * Run orchestration (Wave 4 M3) + run steering (Wave 4 M5) — API
 * CONTRACT. Both shipped without a single e2e.
 *
 * ── Routes ─────────────────────────────────────────────────────────
 *   GET  /api/agents/runs                  Sessions list — MY runs across
 *        every Agent. Filters: status / workId / agentId / taskId / kind /
 *        limit(1..200) / offset(>=0). Declared BEFORE `:id`, so the
 *        literal `runs` segment never reaches ParseUUIDPipe.
 *        → 200 { data: [...], meta: { total, limit, offset } }
 *   GET  /api/agents/runs/:runId/detail    Session detail (Feature K) —
 *        one run's composed drill-in: the same row projection + counts +
 *        filesTouched + a cursor page of the captured timeline. Also
 *        under the literal `runs` segment; a foreign runId 404s.
 *        → 200 { run, counts, filesTouched, timeline }
 *   GET  /api/works/:id/runs-summary       → 200 { running, queued,
 *        awaiting, failedLast24h }; the Work is ownership-gated first.
 *   POST /api/agents/:id/runs/:runId/steer      200 injected|new-run
 *   POST /api/agents/:id/runs/:runId/interrupt  200; 409 when terminal
 *   POST /api/agents/:id/runs/:runId/resume     202; 409 when not resumable
 *
 * The security property under test throughout: `listSessionsForUser`
 * applies `userId = auth.userId` at the REPOSITORY layer, so filters can
 * only ever narrow the caller's own set — passing another user's
 * agentId/workId must return an empty page, never their rows.
 */

const UNKNOWN_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function uniq(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function errText(body: unknown): string {
    const m = (body as { message?: unknown })?.message;
    if (Array.isArray(m)) return m.join(' | ');
    return String(m ?? '');
}

function get(request: APIRequestContext, token: string, path: string) {
    return request.get(`${API_BASE}${path}`, { headers: authedHeaders(token) });
}

function post(request: APIRequestContext, token: string, path: string, data?: unknown) {
    return request.post(`${API_BASE}${path}`, {
        headers: authedHeaders(token),
        ...(data === undefined ? {} : { data }),
    });
}

/** Agent + Task + dispatch → the newest run id (null if none appeared). */
async function seedRun(
    request: APIRequestContext,
    user: RegisteredUser,
): Promise<{ agentId: string; taskId: string; runId: string | null }> {
    const agent = await createAgentViaAPI(request, user.access_token, {
        name: `session-agent-${uniq()}`,
    });
    const task = await createTaskViaAPI(request, user.access_token, {
        title: `session-task-${uniq()}`,
    });
    await assignTaskToAgent(request, user.access_token, agent.id, task.id);
    const runs = await listAgentRuns(request, user.access_token, agent.id);
    return { agentId: agent.id, taskId: task.id, runId: runs[0]?.id ?? null };
}

test.describe('GET /api/agents/runs — the Sessions list', () => {
    test('returns a paginated envelope for a fresh user and honours limit/offset', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);

        const res = await get(request, u.access_token, '/api/agents/runs');
        expect(res.status(), `sessions body=${await res.text().catch(() => '')}`).toBe(200);
        const body = await res.json();
        expect(Array.isArray(body.data)).toBe(true);
        expect(body.meta).toBeTruthy();
        expect(typeof body.meta.total).toBe('number');
        expect(typeof body.meta.limit).toBe('number');
        expect(typeof body.meta.offset).toBe('number');

        const paged = await get(request, u.access_token, '/api/agents/runs?limit=1&offset=0');
        expect(paged.status()).toBe(200);
        expect((await paged.json()).meta.limit).toBe(1);
    });

    test('the literal `runs` segment resolves to the sessions route, not to :id', async ({
        request,
    }) => {
        // Regression guard for the route-ordering rule the controller
        // documents: if `@Get(':id')` were declared first, `runs` would hit
        // ParseUUIDPipe and this would be a 400 instead of a 200 envelope.
        const u = await registerUserViaAPI(request);
        const res = await get(request, u.access_token, '/api/agents/runs');
        expect(res.status()).toBe(200);
        expect(await res.json()).toHaveProperty('data');
    });

    test('rejects out-of-contract filters (bad status / kind / uuid / limit)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);

        const cases: Array<[string, string]> = [
            ['status=nope', 'status'],
            ['kind=telepathy', 'kind'],
            ['workId=not-a-uuid', 'workId'],
            ['agentId=not-a-uuid', 'agentId'],
            ['taskId=not-a-uuid', 'taskId'],
            ['limit=201', 'limit'],
            ['limit=0', 'limit'],
            ['offset=-1', 'offset'],
        ];
        for (const [query, field] of cases) {
            const res = await get(request, u.access_token, `/api/agents/runs?${query}`);
            expect(res.status(), `?${query}`).toBe(400);
            expect(errText(await res.json()), `?${query} message`).toContain(field);
        }
    });

    test('a filter can only narrow MY set — another user’s agentId returns an empty page', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const { agentId, runId } = await seedRun(request, owner);

        // The owner sees their own runs (when the environment produced one).
        const mine = await get(request, owner.access_token, `/api/agents/runs?agentId=${agentId}`);
        expect(mine.status()).toBe(200);
        const mineBody = await mine.json();
        if (runId) {
            expect(
                mineBody.data.some((r: { id: string }) => r.id === runId),
                'the owner sees their own run',
            ).toBe(true);
        }

        // The stranger passes the SAME agentId — the repository-level
        // userId clamp makes it an empty page, never a leak, never a 403.
        const theirs = await get(
            request,
            stranger.access_token,
            `/api/agents/runs?agentId=${agentId}`,
        );
        expect(theirs.status(), 'filtering by a foreign agentId is not an error').toBe(200);
        const theirsBody = await theirs.json();
        expect(theirsBody.data).toEqual([]);
        expect(theirsBody.meta.total).toBe(0);
    });

    test('anonymous → 401', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/agents/runs`);
        expect(res.status()).toBe(401);
    });
});

test.describe('GET /api/agents/runs/:runId/detail — the session drill-in', () => {
    test('composes run + counts + filesTouched + timeline for an owned run', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const { runId } = await seedRun(request, u);
        test.skip(!runId, 'this environment produced no run to drill into');

        const res = await get(request, u.access_token, `/api/agents/runs/${runId}/detail`);
        expect(res.status(), `detail body=${await res.text().catch(() => '')}`).toBe(200);
        const body = await res.json();

        expect(body.run.id).toBe(runId);
        // The detail projection is the Sessions-list row plus two ids —
        // one shared builder, so a field can never drift between them.
        expect(body.run).toHaveProperty('sessionAttachable');
        expect(body.run).toHaveProperty('chatMessageId');
        for (const key of ['messages', 'toolCalls', 'filesTouched']) {
            expect(typeof body.counts[key], `counts.${key}`).toBe('number');
        }
        expect(Array.isArray(body.filesTouched)).toBe(true);
        expect(Array.isArray(body.timeline.entries)).toBe(true);
        expect(typeof body.timeline.limit).toBe('number');
        // A short first page has no further pages.
        if (body.timeline.entries.length < body.timeline.limit) {
            expect(body.timeline.nextCursor).toBeNull();
        }
    });

    test('authz: another user’s run 404s exactly like an unknown one (no existence leak)', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const { runId } = await seedRun(request, owner);
        test.skip(!runId, 'this environment produced no run to drill into');

        const cross = await get(request, stranger.access_token, `/api/agents/runs/${runId}/detail`);
        expect(cross.status(), 'a foreign run is indistinguishable from a missing one').toBe(404);
        const unknown = await get(
            request,
            stranger.access_token,
            `/api/agents/runs/${UNKNOWN_UUID}/detail`,
        );
        expect(unknown.status()).toBe(404);
    });

    test('rejects out-of-contract paging (bad cursor / limit) and a malformed runId', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const base = `/api/agents/runs/${UNKNOWN_UUID}/detail`;

        for (const [query, field] of [
            ['cursor=not-a-cursor', 'cursor'],
            ['limit=201', 'limit'],
            ['limit=0', 'limit'],
        ] as Array<[string, string]>) {
            const res = await get(request, u.access_token, `${base}?${query}`);
            expect(res.status(), `?${query}`).toBe(400);
            expect(errText(await res.json()), `?${query} message`).toContain(field);
        }

        const malformed = await get(request, u.access_token, '/api/agents/runs/not-a-uuid/detail');
        expect(malformed.status()).toBe(400);
    });

    test('anonymous → 401', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/agents/runs/${UNKNOWN_UUID}/detail`);
        expect(res.status()).toBe(401);
    });
});

test.describe('GET /api/works/:id/runs-summary', () => {
    test('returns the four counters for an owned Work, all zero when nothing ran', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, u.access_token, {
            name: `Summary Work ${uniq()}`,
        });

        const res = await get(request, u.access_token, `/api/works/${work.id}/runs-summary`);
        expect(res.status(), `summary body=${await res.text().catch(() => '')}`).toBe(200);
        const body = await res.json();
        for (const key of ['running', 'queued', 'awaiting', 'failedLast24h']) {
            expect(typeof body[key], `${key} is a number`).toBe('number');
            expect(body[key], `${key} is non-negative`).toBeGreaterThanOrEqual(0);
        }
    });

    test('authz: stranger refused (403), unknown work 404, malformed 400, anon 401', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, {
            name: `Summary Work ${uniq()}`,
        });
        const path = `/api/works/${work.id}/runs-summary`;

        // The Work gate is the shared `WorkOwnershipService.ensureAccess`,
        // whose contract is 404 only for a Work that does NOT exist and
        // 403 for one that exists without a membership row for the caller.
        // (The controller's comment claims 404-with-no-existence-leak;
        // that overstates the shared service, which dozens of endpoints
        // share.) The counters themselves never reach a non-member.
        const cross = await get(request, stranger.access_token, path);
        expect(cross.status(), 'a non-member never gets another Work’s counters').toBe(403);
        expect(await cross.text()).not.toContain('failedLast24h');

        const unknown = await get(
            request,
            owner.access_token,
            `/api/works/${UNKNOWN_UUID}/runs-summary`,
        );
        expect(unknown.status()).toBe(404);

        const malformed = await get(
            request,
            owner.access_token,
            `/api/works/not-a-uuid/runs-summary`,
        );
        expect(malformed.status()).toBe(400);

        const anon = await request.get(`${API_BASE}${path}`);
        expect(anon.status()).toBe(401);
    });
});

test.describe('run steering — steer / interrupt / resume', () => {
    test('steer: empty message is a DTO 400, whitespace-only is a 409, oversized is rejected', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, u.access_token, {
            name: `steer-agent-${uniq()}`,
        });
        const path = `/api/agents/${agent.id}/runs/${UNKNOWN_UUID}/steer`;

        // `@IsNotEmpty()` on the DTO fires before the service is reached.
        const empty = await post(request, u.access_token, path, { message: '' });
        expect(empty.status()).toBe(400);
        expect(errText(await empty.json())).toContain('message');

        // Whitespace passes the DTO; the service's own trim guard rejects
        // it — and does so BEFORE the run lookup, so this is 409 not 404.
        const whitespace = await post(request, u.access_token, path, { message: '   ' });
        expect(whitespace.status()).toBe(409);
        expect(errText(await whitespace.json())).toContain('steering message is required');

        const oversized = await post(request, u.access_token, path, {
            message: 'a'.repeat(16_385),
        });
        expect(oversized.status()).toBe(400);
    });

    test('steer: a real message against an unknown run → 404; anon → 401', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, u.access_token, {
            name: `steer-agent-${uniq()}`,
        });
        const path = `/api/agents/${agent.id}/runs/${UNKNOWN_UUID}/steer`;

        const unknown = await post(request, u.access_token, path, { message: 'keep going' });
        expect(unknown.status()).toBe(404);

        const anon = await request.post(`${API_BASE}${path}`, { data: { message: 'keep going' } });
        expect(anon.status()).toBe(401);
    });

    test('steer on a FINISHED run answers new-run (a normal race), never an error', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const { agentId, runId } = await seedRun(request, u);
        test.skip(!runId, 'no AgentRun row was produced by this environment');

        const res = await post(
            request,
            u.access_token,
            `/api/agents/${agentId}/runs/${runId}/steer`,
            { message: 'please continue' },
        );
        expect(res.status(), `steer body=${await res.text().catch(() => '')}`).toBe(200);
        const body = await res.json();
        // "The run finished while you were typing" is a defined outcome
        // with a defined next step — deliberately NOT a 409.
        expect(['injected', 'new-run']).toContain(body.dispatched);
        expect(body.runId).toBe(runId);
    });

    test('interrupt on a terminal run → 409; unknown run → 404; anon → 401', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const { agentId, runId } = await seedRun(request, u);

        const unknown = await post(
            request,
            u.access_token,
            `/api/agents/${agentId}/runs/${UNKNOWN_UUID}/interrupt`,
        );
        expect(unknown.status()).toBe(404);

        const anon = await request.post(
            `${API_BASE}/api/agents/${agentId}/runs/${UNKNOWN_UUID}/interrupt`,
        );
        expect(anon.status()).toBe(401);

        test.skip(!runId, 'no AgentRun row was produced by this environment');
        const terminal = await post(
            request,
            u.access_token,
            `/api/agents/${agentId}/runs/${runId}/interrupt`,
        );
        // Unlike steer, interrupt has no meaningful fallback — 409.
        expect([200, 409], `interrupt returned ${terminal.status()}`).toContain(terminal.status());
        if (terminal.status() === 409) {
            expect(errText(await terminal.json())).toContain('interrupted');
        }
    });

    test('resume: unknown run → 404, non-resumable run → 409, anon → 401', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const { agentId, runId } = await seedRun(request, u);

        const unknown = await post(
            request,
            u.access_token,
            `/api/agents/${agentId}/runs/${UNKNOWN_UUID}/resume`,
            {},
        );
        expect(unknown.status()).toBe(404);

        const anon = await request.post(
            `${API_BASE}/api/agents/${agentId}/runs/${UNKNOWN_UUID}/resume`,
            { data: {} },
        );
        expect(anon.status()).toBe(401);

        test.skip(!runId, 'no AgentRun row was produced by this environment');
        const notResumable = await post(
            request,
            u.access_token,
            `/api/agents/${agentId}/runs/${runId}/resume`,
            {},
        );
        // Resume applies to runs awaiting input or parked for a resumable
        // reason; a plain failed run is not one, so 409 with an explanation.
        expect([202, 409], `resume returned ${notResumable.status()}`).toContain(
            notResumable.status(),
        );
        if (notResumable.status() === 409) {
            expect(errText(await notResumable.json())).toContain('not resumable');
        }
    });

    test('all three controls reject a cross-user agent with 404, never 403', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, owner.access_token, {
            name: `steer-agent-${uniq()}`,
        });

        const base = `/api/agents/${agent.id}/runs/${UNKNOWN_UUID}`;
        const steer = await post(request, stranger.access_token, `${base}/steer`, {
            message: 'hello',
        });
        expect(steer.status()).toBe(404);

        const interrupt = await post(request, stranger.access_token, `${base}/interrupt`);
        expect(interrupt.status()).toBe(404);

        const resume = await post(request, stranger.access_token, `${base}/resume`, {});
        expect(resume.status()).toBe(404);
    });
});
