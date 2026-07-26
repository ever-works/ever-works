/**
 * Agent heartbeat cadence + dispatch lifecycle — the SCHEDULING half of the
 * Agents runtime, probed end-to-end against the live CI driver
 * (http://127.0.0.1:3100, sqlite in-memory, NO LLM key, NO TRIGGER_SECRET_KEY).
 *
 * An Agent (apps/api/src/agents/*, packages/agent/src/agents/*) carries a
 * heartbeat schedule: a `heartbeatCadence` (a 5-field cron expression OR the
 * literal 'manual' / null), an `idleBehavior` (propose | noop | observe), a
 * `pauseAfterFailures` threshold, and the derived scheduler state
 * (`nextHeartbeatAt`, `lastRunAt`, `lastRunStatus`, `errorCount`). The sibling
 * `flow-agent-lifecycle-runs-multistep.spec.ts` walks the draft⇄active⇄paused
 * state machine, the run-now status-gate, task-run persistence, events, and
 * archive/delete. This file deliberately covers the pieces THAT one leaves
 * untouched — the cron→`nextHeartbeatAt` computation, the cadence-update
 * reschedule rules, the create/update validation of the three heartbeat knobs,
 * and the run-now DISPATCH RECORD (a `manual` AgentRun row + the lastRun* /
 * errorCount side-effects) — so the two specs interlock without overlap.
 *
 * Every assertion below was pinned from a LIVE curl walk before it was written:
 *
 *   • create defaults: heartbeatCadence null, idleBehavior 'propose',
 *     pauseAfterFailures 3, nextHeartbeatAt / lastRunAt / lastRunStatus null,
 *     errorCount 0, status 'draft'
 *   • create with a cron cadence persists it verbatim but leaves
 *     nextHeartbeatAt null WHILE DRAFT (the schedule is only armed on activate)
 *   • invalid cron → 400 'Invalid heartbeatCadence "…". Use "manual", null, or
 *     a supported cron expression.'  (6-field, out-of-range, @macros, ?, L all
 *     rejected — the matcher is a strict 5-field Vixie subset)
 *   • idleBehavior enum violation → 400 'idleBehavior must be one of the
 *     following values: propose, noop, observe'
 *   • pauseAfterFailures bounds [1,20] → 400 'must not be less than 1' /
 *     'must not be greater than 20'
 *   • resume (draft→active) with a cron arms nextHeartbeatAt at the NEXT cron
 *     slot (respecting the cadence, not "now"): '0 9 * * *' → next 09:00 UTC,
 *     a 5-minute step cron arms at the next 5-minute boundary; a manual/null
 *     agent stays null
 *   • PATCH heartbeatCadence while ACTIVE reschedules nextHeartbeatAt; PATCH to
 *     'manual' clears it to null; PATCH while DRAFT persists the cadence but
 *     leaves nextHeartbeatAt null
 *   • pause preserves nextHeartbeatAt (the schedule is not thrown away); a
 *     resume recomputes it fresh
 *   • run-now on an ACTIVE manual agent → 500 (TRIGGER_SECRET_KEY unset) BUT a
 *     `manual` AgentRun row still persists: status 'failed', startedAt null,
 *     finishedAt stamped, errorMessage 'dispatch-failed: …', taskId null. The
 *     agent stays ACTIVE, lastRunAt is stamped, lastRunStatus 'dispatch-failed',
 *     and errorCount stays 0 — a DISPATCH failure is NOT an execution failure,
 *     so it never advances the pauseAfterFailures counter (auto-pause into ERROR
 *     is worker-driven and unreachable without Trigger.dev — asserted truthfully)
 *   • run-now is state-gated: draft / paused → 409 'Agent is not in an ACTIVE
 *     state — pause / resume it first.'
 *   • cross-user run-now / runs on another user's agent → 404 (no existence leak)
 *
 * Fully API-orchestrated; a FRESH registerUserViaAPI() owner per test (never the
 * shared seeded user), unique name suffixes throughout. The `flow-` prefix runs
 * it in the authed chromium project and keeps it out of the no-auth testIgnore.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AGENTS = `${API_BASE}/api/agents`;
const CADENCE_ERR = /Invalid heartbeatCadence/i;
const INACTIVE_ERR = 'Agent is not in an ACTIVE state — pause / resume it first.';

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Create an agent with an arbitrary body; expect 201 and return the AgentDto. */
async function createAgent(
    request: APIRequestContext,
    token: string,
    body: Record<string, unknown>,
): Promise<any> {
    const res = await request.post(AGENTS, {
        headers: authedHeaders(token),
        data: { scope: 'tenant', ...body },
    });
    expect(res.status(), `create body=${await res.text().catch(() => '')}`).toBe(201);
    return res.json();
}

/** GET one agent (the read the detail dashboard server-renders from). */
async function getAgent(request: APIRequestContext, token: string, id: string): Promise<any> {
    const res = await request.get(`${AGENTS}/${id}`, { headers: authedHeaders(token) });
    expect(res.status()).toBe(200);
    return res.json();
}

/** PATCH one agent; return { status, body }. */
async function patchAgent(
    request: APIRequestContext,
    token: string,
    id: string,
    patch: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
    const res = await request.patch(`${AGENTS}/${id}`, {
        headers: authedHeaders(token),
        data: patch,
    });
    return { status: res.status(), body: await res.json().catch(() => ({})) };
}

/** Resume a draft/paused agent into ACTIVE; expect 200 + status 'active'. */
async function activate(request: APIRequestContext, token: string, id: string): Promise<any> {
    const res = await request.post(`${AGENTS}/${id}/resume`, { headers: authedHeaders(token) });
    expect(res.status(), `resume body=${await res.text().catch(() => '')}`).toBe(200);
    const dto = await res.json();
    expect(dto.status).toBe('active');
    return dto;
}

/** Fire run-now; Trigger.dev is unbound on CI so it 500s (or 202 if wired). */
async function runNow(
    request: APIRequestContext,
    token: string,
    id: string,
): Promise<{ status: number; body: any }> {
    const res = await request.post(`${AGENTS}/${id}/run-now`, { headers: authedHeaders(token) });
    return { status: res.status(), body: await res.json().catch(() => ({})) };
}

async function listRuns(request: APIRequestContext, token: string, id: string): Promise<any[]> {
    const res = await request.get(`${AGENTS}/${id}/runs`, { headers: authedHeaders(token) });
    expect(res.status()).toBe(200);
    return (await res.json()).data ?? [];
}

test.describe('Agent heartbeat — cadence + knobs at creation', () => {
    test('a fresh agent has an unarmed manual schedule (all scheduler fields at defaults)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const agent = await createAgent(request, user.access_token, {
            name: `HB Fresh ${stamp()}`,
        });

        expect(agent.id).toMatch(UUID_RE);
        expect(agent.status).toBe('draft');
        // The heartbeat is "manual by omission": no cadence, so no armed schedule.
        expect(agent.heartbeatCadence).toBeNull();
        expect(agent.idleBehavior).toBe('propose');
        expect(agent.pauseAfterFailures).toBe(3);
        expect(agent.nextHeartbeatAt).toBeNull();
        expect(agent.lastRunAt).toBeNull();
        expect(agent.lastRunStatus).toBeNull();
        expect(agent.errorCount).toBe(0);
    });

    test('a cron cadence + idleBehavior + pauseAfterFailures persist verbatim but stay unarmed while draft', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const agent = await createAgent(request, user.access_token, {
            name: `HB Cfg ${stamp()}`,
            heartbeatCadence: '0 9 * * *',
            idleBehavior: 'observe',
            pauseAfterFailures: 2,
        });

        expect(agent.heartbeatCadence).toBe('0 9 * * *');
        expect(agent.idleBehavior).toBe('observe');
        expect(agent.pauseAfterFailures).toBe(2);
        // Draft ⇒ the scheduler has NOT armed nextHeartbeatAt yet (that happens
        // on activation). A GET confirms the persisted, still-unarmed shape.
        expect(agent.status).toBe('draft');
        expect(agent.nextHeartbeatAt).toBeNull();
        const fresh = await getAgent(request, user.access_token, agent.id);
        expect(fresh.heartbeatCadence).toBe('0 9 * * *');
        expect(fresh.nextHeartbeatAt).toBeNull();
    });

    test("explicit 'manual' cadence round-trips and never arms a schedule", async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const agent = await createAgent(request, user.access_token, {
            name: `HB Manual ${stamp()}`,
            heartbeatCadence: 'manual',
            idleBehavior: 'noop',
        });
        expect(agent.heartbeatCadence).toBe('manual');
        expect(agent.idleBehavior).toBe('noop');
        expect(agent.nextHeartbeatAt).toBeNull();

        // Even after activation a 'manual' agent has no computed next slot.
        const active = await activate(request, user.access_token, agent.id);
        expect(active.heartbeatCadence).toBe('manual');
        expect(active.nextHeartbeatAt).toBeNull();
    });

    test('the cron matcher is a strict 5-field subset: malformed cadences are all rejected 400', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const H = authedHeaders(user.access_token);
        // Every one of these fails the 5-field Vixie-subset parser used by
        // computeNextHeartbeat, so the service refuses the create with 400.
        const invalid = [
            'not a cron', // free text
            '0 0 0 * * *', // 6 fields (seconds not supported)
            '99 99 * * *', // minute/hour out of range
            '@hourly', // macro not supported
            '0 9 ? * MON', // '?' operator not supported
            '0 9 L * *', // 'L' operator not supported
            '* * *', // too few fields
        ];
        for (const cadence of invalid) {
            const res = await request.post(AGENTS, {
                headers: H,
                data: { scope: 'tenant', name: `HB Bad ${stamp()}`, heartbeatCadence: cadence },
            });
            expect(res.status(), `cadence=${JSON.stringify(cadence)}`).toBe(400);
            expect(String((await res.json()).message)).toMatch(CADENCE_ERR);
        }
    });

    test('rich-but-valid cron variants (steps, ranges, aliases) are all accepted 201', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const H = authedHeaders(user.access_token);
        // Operators + aliases the matcher DOES support (steps, ranges,
        // enumerations, month/dow aliases, dom-OR-dow both restricted).
        const valid = [
            '*/5 * * * *',
            '0 */2 * * *',
            '15 9-17 * * 1-5',
            '0 0 1 JAN *',
            '30 8 * * MON,WED,FRI',
            '0 9 1 * MON', // both dom + dow restricted → OR semantics, still valid
        ];
        for (const cadence of valid) {
            const agent = await createAgent(request, user.access_token, {
                name: `HB Ok ${stamp()}`,
                heartbeatCadence: cadence,
            });
            expect(agent.heartbeatCadence, `cadence=${cadence}`).toBe(cadence);
        }
        // Sanity: unauth just to prove the loop's tokens were real (no-op guard).
        expect(H.Authorization).toContain('Bearer ');
    });

    test('a cadence longer than the 64-char column is rejected 400 before the parser runs', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        // 65 chars of digits+spaces — MaxLength(64) on the DTO trips first.
        const tooLong = '1'.repeat(65);
        const res = await request.post(AGENTS, {
            headers: authedHeaders(user.access_token),
            data: { scope: 'tenant', name: `HB Long ${stamp()}`, heartbeatCadence: tooLong },
        });
        expect(res.status()).toBe(400);
    });

    test('idleBehavior only accepts the three canonical modes', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const H = authedHeaders(user.access_token);
        // Each canonical mode is accepted and echoed back.
        for (const mode of ['propose', 'noop', 'observe']) {
            const agent = await createAgent(request, user.access_token, {
                name: `HB Idle ${mode} ${stamp()}`,
                idleBehavior: mode,
            });
            expect(agent.idleBehavior).toBe(mode);
        }
        // An off-enum value is a 400 that names the allowed set.
        const bad = await request.post(AGENTS, {
            headers: H,
            data: { scope: 'tenant', name: `HB Idle bad ${stamp()}`, idleBehavior: 'sleep' },
        });
        expect(bad.status()).toBe(400);
        expect(String((await bad.json()).message)).toMatch(/propose, noop, observe/);
    });

    test('pauseAfterFailures is clamped to [1,20] at the DTO boundary', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const H = authedHeaders(user.access_token);

        const zero = await request.post(AGENTS, {
            headers: H,
            data: { scope: 'tenant', name: `HB PB0 ${stamp()}`, pauseAfterFailures: 0 },
        });
        expect(zero.status()).toBe(400);
        expect(String((await zero.json()).message)).toMatch(/not be less than 1/);

        const over = await request.post(AGENTS, {
            headers: H,
            data: { scope: 'tenant', name: `HB PB21 ${stamp()}`, pauseAfterFailures: 21 },
        });
        expect(over.status()).toBe(400);
        expect(String((await over.json()).message)).toMatch(/not be greater than 20/);

        // Both extremes of the inclusive range are accepted.
        const lo = await createAgent(request, user.access_token, {
            name: `HB PB1 ${stamp()}`,
            pauseAfterFailures: 1,
        });
        expect(lo.pauseAfterFailures).toBe(1);
        const hi = await createAgent(request, user.access_token, {
            name: `HB PB20 ${stamp()}`,
            pauseAfterFailures: 20,
        });
        expect(hi.pauseAfterFailures).toBe(20);
    });
});

test.describe('Agent heartbeat — activation arms nextHeartbeatAt from the cadence', () => {
    test("a daily '0 9 * * *' agent arms at the next 09:00 UTC slot, in the future", async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const agent = await createAgent(request, user.access_token, {
            name: `HB Daily ${stamp()}`,
            heartbeatCadence: '0 9 * * *',
        });
        expect(agent.nextHeartbeatAt).toBeNull(); // still draft

        const before = Date.now();
        const active = await activate(request, user.access_token, agent.id);
        expect(active.nextHeartbeatAt).not.toBeNull();

        const next = new Date(active.nextHeartbeatAt);
        // The armed slot MUST satisfy the cron: minute 0, hour 9 (UTC).
        expect(next.getUTCMinutes()).toBe(0);
        expect(next.getUTCHours()).toBe(9);
        // …and it is a genuine future fire within the next day (not "now").
        expect(next.getTime()).toBeGreaterThan(before - 2 * 60_000);
        expect(next.getTime()).toBeLessThan(before + 25 * 60 * 60 * 1000);
    });

    test("a '*/5 * * * *' agent arms at the next 5-minute boundary", async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const agent = await createAgent(request, user.access_token, {
            name: `HB Fast ${stamp()}`,
            heartbeatCadence: '*/5 * * * *',
        });
        const before = Date.now();
        const active = await activate(request, user.access_token, agent.id);
        expect(active.nextHeartbeatAt).not.toBeNull();

        const next = new Date(active.nextHeartbeatAt);
        // Minute divisible by 5, zero seconds, and within the next 6 minutes.
        expect(next.getUTCMinutes() % 5).toBe(0);
        expect(next.getUTCSeconds()).toBe(0);
        expect(next.getTime()).toBeGreaterThan(before - 2 * 60_000);
        expect(next.getTime()).toBeLessThan(before + 6 * 60_000);
    });

    test('a cadence set while DRAFT is armed only when the agent is later activated', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        // Born manual; a PATCH gives it a cron WHILE STILL DRAFT.
        const agent = await createAgent(request, user.access_token, { name: `HB Late ${stamp()}` });
        const patched = await patchAgent(request, user.access_token, agent.id, {
            heartbeatCadence: '0 0 * * *',
        });
        expect(patched.status).toBe(200);
        expect(patched.body.heartbeatCadence).toBe('0 0 * * *');
        // Draft ⇒ the PATCH persisted the cadence but did NOT arm nextHeartbeatAt.
        expect(patched.body.status).toBe('draft');
        expect(patched.body.nextHeartbeatAt).toBeNull();

        // Activation is what finally arms it — at the next midnight UTC.
        const active = await activate(request, user.access_token, agent.id);
        expect(active.nextHeartbeatAt).not.toBeNull();
        const next = new Date(active.nextHeartbeatAt);
        expect(next.getUTCHours()).toBe(0);
        expect(next.getUTCMinutes()).toBe(0);
    });

    test('activating a manual agent leaves nextHeartbeatAt null (nothing to schedule)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const agent = await createAgent(request, user.access_token, {
            name: `HB NoSched ${stamp()}`,
        });
        const active = await activate(request, user.access_token, agent.id);
        expect(active.status).toBe('active');
        expect(active.heartbeatCadence).toBeNull();
        expect(active.nextHeartbeatAt).toBeNull();
    });
});

test.describe('Agent heartbeat — cadence updates reschedule the armed slot', () => {
    test('PATCHing the cadence on an ACTIVE agent recomputes nextHeartbeatAt to the new cron', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const agent = await createAgent(request, user.access_token, {
            name: `HB Resched ${stamp()}`,
            heartbeatCadence: '0 9 * * *',
        });
        const active = await activate(request, user.access_token, agent.id);
        expect(new Date(active.nextHeartbeatAt).getUTCHours()).toBe(9);

        // Repoint to midnight — the armed slot follows the new cadence.
        const patched = await patchAgent(request, user.access_token, agent.id, {
            heartbeatCadence: '0 0 * * *',
        });
        expect(patched.status).toBe(200);
        expect(patched.body.heartbeatCadence).toBe('0 0 * * *');
        expect(patched.body.nextHeartbeatAt).not.toBeNull();
        const next = new Date(patched.body.nextHeartbeatAt);
        expect(next.getUTCHours()).toBe(0);
        expect(next.getUTCMinutes()).toBe(0);
    });

    test("PATCHing an ACTIVE agent's cadence to 'manual' disarms the schedule (null)", async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const agent = await createAgent(request, user.access_token, {
            name: `HB Disarm ${stamp()}`,
            heartbeatCadence: '*/10 * * * *',
        });
        const active = await activate(request, user.access_token, agent.id);
        expect(active.nextHeartbeatAt).not.toBeNull();

        const patched = await patchAgent(request, user.access_token, agent.id, {
            heartbeatCadence: 'manual',
        });
        expect(patched.status).toBe(200);
        expect(patched.body.heartbeatCadence).toBe('manual');
        expect(patched.body.nextHeartbeatAt).toBeNull();
        // Confirm the disarm persisted.
        const fresh = await getAgent(request, user.access_token, agent.id);
        expect(fresh.nextHeartbeatAt).toBeNull();
    });

    test('an invalid cadence PATCH is refused 400 and leaves the armed slot untouched', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const agent = await createAgent(request, user.access_token, {
            name: `HB BadPatch ${stamp()}`,
            heartbeatCadence: '0 9 * * *',
        });
        const active = await activate(request, user.access_token, agent.id);
        const armed = active.nextHeartbeatAt;
        expect(armed).not.toBeNull();

        const bad = await patchAgent(request, user.access_token, agent.id, {
            heartbeatCadence: '99 99 * * *',
        });
        expect(bad.status).toBe(400);
        expect(String(bad.body.message)).toMatch(CADENCE_ERR);

        // The rejected PATCH is atomic: cadence + armed slot are unchanged.
        const fresh = await getAgent(request, user.access_token, agent.id);
        expect(fresh.heartbeatCadence).toBe('0 9 * * *');
        expect(fresh.nextHeartbeatAt).toBe(armed);
    });

    test('idleBehavior and pauseAfterFailures are independently editable post-create', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const agent = await createAgent(request, user.access_token, {
            name: `HB Knobs ${stamp()}`,
        });
        expect(agent.idleBehavior).toBe('propose');
        expect(agent.pauseAfterFailures).toBe(3);

        const ok = await patchAgent(request, user.access_token, agent.id, {
            idleBehavior: 'observe',
            pauseAfterFailures: 5,
        });
        expect(ok.status).toBe(200);
        expect(ok.body.idleBehavior).toBe('observe');
        expect(ok.body.pauseAfterFailures).toBe(5);

        // Off-enum idleBehavior + out-of-range threshold are both 400.
        const badIdle = await patchAgent(request, user.access_token, agent.id, {
            idleBehavior: 'hibernate',
        });
        expect(badIdle.status).toBe(400);
        const badThreshold = await patchAgent(request, user.access_token, agent.id, {
            pauseAfterFailures: 0,
        });
        expect(badThreshold.status).toBe(400);

        // Neither rejected PATCH mutated the last good state.
        const fresh = await getAgent(request, user.access_token, agent.id);
        expect(fresh.idleBehavior).toBe('observe');
        expect(fresh.pauseAfterFailures).toBe(5);
    });

    test('pause preserves the armed slot; a following resume recomputes it fresh', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const H = authedHeaders(user.access_token);
        const agent = await createAgent(request, user.access_token, {
            name: `HB Keep ${stamp()}`,
            heartbeatCadence: '0 9 * * *',
        });
        const active = await activate(request, user.access_token, agent.id);
        const armed = active.nextHeartbeatAt;
        expect(armed).not.toBeNull();

        // Pausing does NOT throw the schedule away (the operator can resume it).
        const pause = await request.post(`${AGENTS}/${agent.id}/pause`, { headers: H });
        expect(pause.status()).toBe(200);
        const paused = await pause.json();
        expect(paused.status).toBe('paused');
        expect(paused.nextHeartbeatAt).toBe(armed);

        // Resuming recomputes a fresh (still 09:00 UTC) slot from the cadence.
        const resumed = await activate(request, user.access_token, agent.id);
        expect(resumed.nextHeartbeatAt).not.toBeNull();
        expect(new Date(resumed.nextHeartbeatAt).getUTCHours()).toBe(9);
        expect(new Date(resumed.nextHeartbeatAt).getUTCMinutes()).toBe(0);
    });
});

test.describe('Agent heartbeat — run-now dispatch record + side-effects', () => {
    test('run-now on an ACTIVE manual agent persists a failed MANUAL run and stamps lastRun*', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const agent = await createAgent(request, token, { name: `HB RunNow ${stamp()}` });
        await activate(request, token, agent.id);

        // Trigger.dev unbound on CI ⇒ the dispatch enqueue 500s (202 only if wired).
        const res = await runNow(request, token, agent.id);
        expect([202, 500]).toContain(res.status);

        // A run row is recorded regardless of the enqueue outcome.
        const runs = await listRuns(request, token, agent.id);
        expect(runs.length).toBeGreaterThanOrEqual(1);
        const run = runs[0];
        expect(run.id).toMatch(UUID_RE);
        expect(run.triggerKind).toBe('manual'); // NOT a task/chat run
        expect(run.taskId).toBeNull();

        const agentAfter = await getAgent(request, token, agent.id);
        // A dispatch failure leaves the agent ACTIVE (it never entered RUNNING).
        expect(agentAfter.status).toBe('active');
        // lastRunAt is stamped whichever way the dispatch went.
        expect(agentAfter.lastRunAt).not.toBeNull();

        if (res.status === 500) {
            // Keyless CI: the queued row is marked failed with the diagnostic,
            // the agent's lastRunStatus reflects the dispatch failure, and the
            // failure carries a finishedAt but never a startedAt.
            expect(run.status).toBe('failed');
            expect(String(run.errorMessage)).toContain('dispatch-failed');
            expect(run.startedAt).toBeNull();
            expect(run.finishedAt).not.toBeNull();
            expect(agentAfter.lastRunStatus).toBe('dispatch-failed');
        }
    });

    test('a dispatch failure does NOT advance the pauseAfterFailures counter (no false auto-pause)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        // A low threshold would auto-pause into ERROR after 2 EXECUTION failures —
        // but dispatch failures are a different class and must not count.
        const agent = await createAgent(request, token, {
            name: `HB NoCount ${stamp()}`,
            pauseAfterFailures: 2,
        });
        await activate(request, token, agent.id);

        // Two run-now attempts, each a dispatch failure on keyless CI.
        const first = await runNow(request, token, agent.id);
        const second = await runNow(request, token, agent.id);
        expect([202, 500]).toContain(first.status);
        expect([202, 500]).toContain(second.status);

        const runs = await listRuns(request, token, agent.id);
        // Both attempts recorded distinct manual rows (no dedup once terminal).
        expect(runs.filter((r) => r.triggerKind === 'manual').length).toBeGreaterThanOrEqual(2);

        const agentAfter = await getAgent(request, token, agent.id);
        // errorCount is the EXECUTION-failure tally (advanced by the worker), so
        // it stays 0 here — and the agent is therefore still ACTIVE, NOT paused
        // to ERROR, even though two dispatches failed and threshold is 2.
        expect(agentAfter.errorCount).toBe(0);
        expect(agentAfter.status).toBe('active');
        expect(agentAfter.pauseAfterFailures).toBe(2);
    });

    test('run-now is state-gated: draft and paused agents are refused 409', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const H = authedHeaders(token);
        const agent = await createAgent(request, token, { name: `HB Gate ${stamp()}` });

        // Draft is not ACTIVE → 409 inactive with the exact message.
        const draftRun = await runNow(request, token, agent.id);
        expect(draftRun.status).toBe(409);
        expect(draftRun.body.message).toBe(INACTIVE_ERR);

        // Activate, then pause; a paused agent is refused the same way.
        await activate(request, token, agent.id);
        expect((await request.post(`${AGENTS}/${agent.id}/pause`, { headers: H })).status()).toBe(
            200,
        );
        const pausedRun = await runNow(request, token, agent.id);
        expect(pausedRun.status).toBe(409);
        expect(pausedRun.body.message).toBe(INACTIVE_ERR);

        // A refused run-now created NO run row.
        expect((await listRuns(request, token, agent.id)).length).toBe(0);
    });

    test('the persisted manual run is fully readable via the run-detail endpoint', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const H = authedHeaders(token);
        const agent = await createAgent(request, token, { name: `HB Detail ${stamp()}` });
        await activate(request, token, agent.id);
        await runNow(request, token, agent.id);

        const runs = await listRuns(request, token, agent.id);
        expect(runs.length).toBeGreaterThanOrEqual(1);
        const runId = runs[0].id;

        const detail = await request.get(`${AGENTS}/${agent.id}/runs/${runId}`, { headers: H });
        expect(detail.status()).toBe(200);
        const d = await detail.json();
        expect(d.id).toBe(runId);
        expect(d.triggerKind).toBe('manual');
        expect(Array.isArray(d.logs)).toBe(true);
        // Detail-only fields are present on the envelope (may be null on CI).
        expect(d).toHaveProperty('chatMessageId');
        expect(d).toHaveProperty('memorySessionId');
        expect(d.taskId).toBeNull();
    });

    test("cross-user run-now / runs on another owner's agent are 404 (no existence leak)", async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const intruder = await registerUserViaAPI(request);
        const agent = await createAgent(request, owner.access_token, {
            name: `HB Private ${stamp()}`,
            heartbeatCadence: '0 9 * * *',
        });
        await activate(request, owner.access_token, agent.id);
        const iH = authedHeaders(intruder.access_token);

        // The intruder cannot dispatch, list runs, or even see the agent — all 404.
        expect(
            (await request.post(`${AGENTS}/${agent.id}/run-now`, { headers: iH })).status(),
        ).toBe(404);
        expect((await request.get(`${AGENTS}/${agent.id}/runs`, { headers: iH })).status()).toBe(
            404,
        );
        expect((await request.get(`${AGENTS}/${agent.id}`, { headers: iH })).status()).toBe(404);
        expect(
            (
                await request.patch(`${AGENTS}/${agent.id}`, {
                    headers: iH,
                    data: { heartbeatCadence: '*/1 * * * *' },
                })
            ).status(),
        ).toBe(404);

        // The owner's schedule is untouched by the intruder's probes.
        const stillOwned = await getAgent(request, owner.access_token, agent.id);
        expect(stillOwned.heartbeatCadence).toBe('0 9 * * *');
        expect(stillOwned.nextHeartbeatAt).not.toBeNull();
    });
});
