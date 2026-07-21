/**
 * Schedules ("Cadence") view — GET /api/schedules, DEEP end-to-end (#1671).
 *
 * The Schedules feature is a READ-ONLY aggregation endpoint that unifies the
 * seven heterogeneous scheduled sources in the platform into one `ScheduleView`
 * read-model, scoped to the caller (userId + active Organization; personal
 * scope filters `organizationId IS NULL`). It shipped with no dedicated e2e
 * coverage. This file drives every source into existence against a live stack
 * and pins the true projection shape + status codes byte-for-byte:
 *
 *   • empty state → a bare `[]`; unauth → 401 (JWT guard, no per-resource route)
 *   • the SEVEN source projections, each with the exact synthetic id
 *     `${sourceType}:${ownerId}`, cadenceRaw/cadenceHuman, next-run, status pill
 *     and enabled flag:
 *       - mission_tick     (scheduled Mission; cron → computed nextRunAt)
 *       - recurring_task   (Task made recurring; RRULE → human cadence)
 *       - agent_heartbeat  (Agent heartbeatCadence; draft = disabled)
 *       - data_sync        (every Work; 5-minute default, due now)
 *       - source_validation(Work source-validation enabled; cadence enum)
 *       - work_schedule    (Work scheduled-update; paused row still shows)
 *       - inbound_trigger  (event-driven; ownerType 'trigger', 'On event', no next-run)
 *   • negative projections: one-shot Missions, non-recurring Tasks, and
 *     manual/no-cadence Agents produce NO row
 *   • query filters — sourceType / entityKind / enabledOnly — each narrows the
 *     read-model; entityKind=work buckets work_schedule + source_validation +
 *     data_sync; enabledOnly drops disabled/paused rows
 *   • validation — a typo'd sourceType/entityKind, a non-boolean enabledOnly,
 *     and any unknown query param all 400 (whitelist + forbidNonWhitelisted)
 *   • structural cross-user isolation — a user's list contains ONLY their own
 *     rows, never another user's (404-never — there is no cross-user path)
 *   • ordering — nextRunAt ascending, nulls last
 *   • lifecycle — pausing/resuming a Mission toggles its row's status/enabled/nextRunAt
 *   • the synthetic-id contract — `${sourceType}:${ownerId}`, unique per row
 *
 * ── Verified live against http://127.0.0.1:3100 (sqlite in-memory — the CI
 *    driver, all feature flags ON) before assertions were written. Probed the
 *    real projected shapes of all seven sources + the filter/validation matrix.
 *    Backed by apps/api/src/schedules/schedules.controller.ts +
 *    apps/api/src/schedules/dto/schedules-query.dto.ts +
 *    packages/agent/src/schedules/schedules.service.ts (+ cadence.ts).
 *
 * Isolation discipline: every test builds FRESH registerUserViaAPI() owners, so
 * each caller's schedule read-model is exactly the rows that test created.
 * Fully API-orchestrated (safe `flow-` prefix, not matched by the no-auth
 * testIgnore regex), so it never contends on the UI.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, createWorkViaAPI } from './helpers/api';
import { createAgentViaAPI, createTaskViaAPI } from './helpers/agents-tasks';
import { createTriggerViaAPI } from './helpers/triggers';

const SCHEDULES_BASE = `${API_BASE}/api/schedules`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCE_TYPES = [
    'recurring_task',
    'agent_heartbeat',
    'work_schedule',
    'mission_tick',
    'source_validation',
    'data_sync',
    'inbound_trigger',
];

interface ScheduleView {
    id: string;
    sourceType: string;
    ownerType: string;
    ownerId: string;
    ownerName: string;
    ownerLink: string;
    cadenceRaw: string | null;
    cadenceHuman: string;
    nextRunAt: string | null;
    lastRunAt: string | null;
    lastRunStatus: string | null;
    status: string;
    enabled: boolean;
}

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** GET /api/schedules (optionally with a `?...` query) as the given user. */
async function getSchedules(
    request: APIRequestContext,
    token: string,
    query = '',
): Promise<ScheduleView[]> {
    const res = await request.get(`${SCHEDULES_BASE}${query}`, { headers: authedHeaders(token) });
    expect(res.status(), `schedules body=${await res.text().catch(() => '')}`).toBe(200);
    return res.json();
}

function findRow(list: ScheduleView[], id: string): ScheduleView | undefined {
    return list.find((r) => r.id === id);
}

/** Create a SCHEDULED Mission (cron cadence) → returns its id. */
async function createScheduledMission(
    request: APIRequestContext,
    token: string,
    title: string,
    schedule = '0 9 * * *',
): Promise<string> {
    const res = await request.post(`${API_BASE}/api/me/missions`, {
        headers: authedHeaders(token),
        data: { title, description: 'schedules e2e mission', type: 'scheduled', schedule },
    });
    expect(res.status(), `createScheduledMission body=${await res.text().catch(() => '')}`).toBe(
        201,
    );
    return (await res.json()).id as string;
}

/** Make an existing Task recurring (RRULE) → 200. */
async function makeTaskRecurring(
    request: APIRequestContext,
    token: string,
    taskId: string,
    recurrenceRule = 'FREQ=DAILY;INTERVAL=1',
): Promise<void> {
    const res = await request.post(`${API_BASE}/api/tasks/${taskId}/recurring`, {
        headers: authedHeaders(token),
        data: { recurrenceRule },
    });
    expect(res.status(), `makeTaskRecurring body=${await res.text().catch(() => '')}`).toBe(200);
}

/** Draft Agent → resume (draft/paused/errored → ACTIVE) → 200. */
async function resumeAgent(
    request: APIRequestContext,
    token: string,
    agentId: string,
): Promise<void> {
    const res = await request.post(`${API_BASE}/api/agents/${agentId}/resume`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `resumeAgent body=${await res.text().catch(() => '')}`).toBe(200);
}

/**
 * Create a tenant Agent carrying a `heartbeatCadence` (posted directly since
 * the shared createAgentViaAPI helper's typed body omits the field). A cron
 * cadence → a real heartbeat schedule; `'manual'`/omitted → no heartbeat row.
 */
async function createAgentWithHeartbeat(
    request: APIRequestContext,
    token: string,
    name: string,
    heartbeatCadence: string,
): Promise<{ id: string; name: string; status: string }> {
    const res = await request.post(`${API_BASE}/api/agents`, {
        headers: authedHeaders(token),
        data: { scope: 'tenant', name, heartbeatCadence },
    });
    expect(res.status(), `createAgentWithHeartbeat body=${await res.text().catch(() => '')}`).toBe(
        201,
    );
    return res.json();
}

/** Upsert a Work scheduled-update config (PUT /works/:id/schedule) → 200. */
async function setWorkSchedule(
    request: APIRequestContext,
    token: string,
    workId: string,
    data: Record<string, unknown>,
): Promise<void> {
    const res = await request.put(`${API_BASE}/api/works/${workId}/schedule`, {
        headers: authedHeaders(token),
        data,
    });
    expect(res.status(), `setWorkSchedule body=${await res.text().catch(() => '')}`).toBe(200);
}

/** Enable/disable a Work's source-validation (PUT /works/:id/source-validation) → 200. */
async function setSourceValidation(
    request: APIRequestContext,
    token: string,
    workId: string,
    data: { enabled: boolean; cadence?: string },
): Promise<void> {
    const res = await request.put(`${API_BASE}/api/works/${workId}/source-validation`, {
        headers: authedHeaders(token),
        data,
    });
    expect(res.status(), `setSourceValidation body=${await res.text().catch(() => '')}`).toBe(200);
}

test.describe('Schedules — source projections', () => {
    test('a fresh user gets a bare [] read-model; the unauth request → 401', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const list = await getSchedules(request, user.access_token);
        expect(Array.isArray(list)).toBe(true);
        expect(list).toEqual([]);

        expect((await request.get(SCHEDULES_BASE)).status()).toBe(401);
    });

    test('a scheduled Mission projects a mission_tick row with a computed nextRunAt + human cadence', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const missionId = await createScheduledMission(
            request,
            user.access_token,
            `Nightly ${stamp()}`,
            '0 9 * * *',
        );

        const row = findRow(
            await getSchedules(request, user.access_token),
            `mission_tick:${missionId}`,
        );
        expect(row, 'mission_tick row should exist').toBeTruthy();
        expect(row!.sourceType).toBe('mission_tick');
        expect(row!.ownerType).toBe('mission');
        expect(row!.ownerId).toBe(missionId);
        expect(row!.ownerId).toMatch(UUID_RE);
        expect(row!.ownerLink).toBe(`/missions/${missionId}`);
        expect(row!.cadenceRaw).toBe('0 9 * * *');
        expect(row!.cadenceHuman).toBe('Every day at 09:00');
        // Missions persist no next-fire; it's computed from the cron at query time.
        expect(row!.nextRunAt).toMatch(/T09:00:00\.000Z$/);
        expect(row!.lastRunAt).toBeNull();
        expect(row!.lastRunStatus).toBeNull();
        expect(row!.status).toBe('active');
        expect(row!.enabled).toBe(true);
    });

    test('a recurring Task projects a recurring_task row; the RRULE renders as human cadence', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const task = await createTaskViaAPI(request, user.access_token, {
            title: `Recur ${stamp()}`,
        });
        await makeTaskRecurring(request, user.access_token, task.id, 'FREQ=DAILY;INTERVAL=1');

        const row = findRow(
            await getSchedules(request, user.access_token),
            `recurring_task:${task.id}`,
        );
        expect(row, 'recurring_task row should exist').toBeTruthy();
        expect(row!.sourceType).toBe('recurring_task');
        expect(row!.ownerType).toBe('task');
        expect(row!.ownerId).toBe(task.id);
        expect(row!.ownerName).toBe(task.title);
        expect(row!.ownerLink).toBe(`/tasks/${task.id}`);
        expect(row!.cadenceRaw).toBe('FREQ=DAILY;INTERVAL=1');
        expect(row!.cadenceHuman).toBe('Every day');
        expect(row!.nextRunAt).not.toBeNull();
        expect(row!.status).toBe('active');
        expect(row!.enabled).toBe(true);
    });

    test('a draft Agent with a heartbeatCadence projects a DISABLED agent_heartbeat row', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const agent = await createAgentWithHeartbeat(
            request,
            user.access_token,
            `HB ${stamp()}`,
            '0 * * * *',
        );

        const row = findRow(
            await getSchedules(request, user.access_token),
            `agent_heartbeat:${agent.id}`,
        );
        expect(row, 'agent_heartbeat row should exist').toBeTruthy();
        expect(row!.sourceType).toBe('agent_heartbeat');
        expect(row!.ownerType).toBe('agent');
        expect(row!.ownerId).toBe(agent.id);
        expect(row!.ownerLink).toBe(`/agents/${agent.id}`);
        expect(row!.cadenceRaw).toBe('0 * * * *');
        expect(row!.cadenceHuman).toBe('Every hour');
        // A brand-new Agent is DRAFT → the heartbeat is present but not yet ticking.
        expect(row!.status).toBe('disabled');
        expect(row!.enabled).toBe(false);
    });

    test('resuming the Agent flips its heartbeat row to active + enabled', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const agent = await createAgentWithHeartbeat(
            request,
            user.access_token,
            `Wake ${stamp()}`,
            '*/15 * * * *',
        );
        const id = `agent_heartbeat:${agent.id}`;

        expect(findRow(await getSchedules(request, user.access_token), id)!.enabled).toBe(false);

        await resumeAgent(request, user.access_token, agent.id);

        const after = findRow(await getSchedules(request, user.access_token), id);
        expect(after!.status).toBe('active');
        expect(after!.enabled).toBe(true);
        expect(after!.cadenceHuman).toBe('Every 15 minutes');
    });

    test('manual-cadence and no-cadence Agents produce NO heartbeat row', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const manual = await createAgentWithHeartbeat(
            request,
            user.access_token,
            `Manual ${stamp()}`,
            'manual',
        );
        const none = await createAgentViaAPI(request, user.access_token, {
            scope: 'tenant',
            name: `NoHB ${stamp()}`,
        });

        const ids = (await getSchedules(request, user.access_token)).map((r) => r.id);
        expect(ids).not.toContain(`agent_heartbeat:${manual.id}`);
        expect(ids).not.toContain(`agent_heartbeat:${none.id}`);
    });

    test('every Work auto-projects a data_sync row (5-minute default), due now', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const { id: workId } = await createWorkViaAPI(request, user.access_token, {
            name: `Sync Work ${stamp()}`,
            slug: `sync-work-${stamp()}`,
        });

        const row = findRow(await getSchedules(request, user.access_token), `data_sync:${workId}`);
        expect(row, 'data_sync row should exist for any Work').toBeTruthy();
        expect(row!.sourceType).toBe('data_sync');
        expect(row!.ownerType).toBe('work');
        expect(row!.ownerId).toBe(workId);
        expect(row!.ownerLink).toBe(`/works/${workId}`);
        expect(row!.cadenceRaw).toBe('5m');
        expect(row!.cadenceHuman).toBe('Every 5 minutes');
        // Never-polled Work is due "now" — nextRunAt is a real timestamp, never null.
        expect(row!.nextRunAt).not.toBeNull();
        expect(row!.status).toBe('active');
        expect(row!.enabled).toBe(true);
    });

    test('enabling source-validation projects a source_validation row carrying the cadence', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const { id: workId } = await createWorkViaAPI(request, user.access_token, {
            name: `SV Work ${stamp()}`,
            slug: `sv-work-${stamp()}`,
        });
        await setSourceValidation(request, user.access_token, workId, {
            enabled: true,
            cadence: 'weekly',
        });

        const row = findRow(
            await getSchedules(request, user.access_token),
            `source_validation:${workId}`,
        );
        expect(row, 'source_validation row should exist').toBeTruthy();
        expect(row!.sourceType).toBe('source_validation');
        expect(row!.ownerType).toBe('work');
        expect(row!.ownerId).toBe(workId);
        expect(row!.ownerLink).toBe(`/works/${workId}`);
        expect(row!.cadenceRaw).toBe('weekly');
        expect(row!.cadenceHuman).toBe('Every week');
        expect(row!.nextRunAt).not.toBeNull();
        // source_validation is always projected as active/enabled while turned on.
        expect(row!.status).toBe('active');
        expect(row!.enabled).toBe(true);
    });

    test('a paused Work scheduled-update projects a paused/disabled work_schedule row', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const { id: workId } = await createWorkViaAPI(request, user.access_token, {
            name: `WS Work ${stamp()}`,
            slug: `ws-work-${stamp()}`,
        });
        // enable:false persists a real PAUSED row (bypasses the readiness gate) that
        // the aggregation still surfaces (it queries ACTIVE + PAUSED schedules).
        await setWorkSchedule(request, user.access_token, workId, {
            enable: false,
            cadence: 'daily',
        });

        const row = findRow(
            await getSchedules(request, user.access_token),
            `work_schedule:${workId}`,
        );
        expect(row, 'work_schedule row should exist').toBeTruthy();
        expect(row!.sourceType).toBe('work_schedule');
        expect(row!.ownerType).toBe('work');
        expect(row!.ownerId).toBe(workId);
        expect(row!.ownerLink).toBe(`/works/${workId}/generator/schedule`);
        expect(row!.cadenceRaw).toBe('daily');
        expect(row!.cadenceHuman).toBe('Every day');
        expect(row!.status).toBe('paused');
        expect(row!.enabled).toBe(false);
        expect(row!.nextRunAt).toBeNull();
    });

    test('an inbound Trigger projects an event-driven inbound_trigger row (ownerType trigger, no cadence/next-run)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const { trigger } = await createTriggerViaAPI(request, user.access_token, {
            name: `Hook ${stamp()}`,
            kind: 'webhook',
        });

        const row = findRow(
            await getSchedules(request, user.access_token),
            `inbound_trigger:${trigger.id}`,
        );
        expect(row, 'inbound_trigger row should exist').toBeTruthy();
        expect(row!.sourceType).toBe('inbound_trigger');
        // No target Agent → it's its own 'trigger' owner and links back to the Schedules view.
        expect(row!.ownerType).toBe('trigger');
        expect(row!.ownerId).toBe(trigger.id);
        expect(row!.ownerName).toBe(trigger.name);
        expect(row!.ownerLink).toBe('/activity?view=schedules');
        // Event-driven: an external system decides when it fires — no timer at all.
        expect(row!.cadenceRaw).toBeNull();
        expect(row!.cadenceHuman).toBe('On event');
        expect(row!.nextRunAt).toBeNull();
        expect(row!.status).toBe('active');
        expect(row!.enabled).toBe(true);
    });

    test('one-shot Missions and non-recurring Tasks never appear in the read-model', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const oneShot = await request.post(`${API_BASE}/api/me/missions`, {
            headers: authedHeaders(user.access_token),
            data: { title: `OneShot ${stamp()}`, description: 'd', type: 'one-shot' },
        });
        expect(oneShot.status()).toBe(201);
        const oneShotId = (await oneShot.json()).id as string;
        const plainTask = await createTaskViaAPI(request, user.access_token, {
            title: `Plain ${stamp()}`,
        });

        const list = await getSchedules(request, user.access_token);
        // A user whose only entities are non-scheduled has an empty read-model.
        expect(list).toEqual([]);
        const ids = list.map((r) => r.id);
        expect(ids).not.toContain(`mission_tick:${oneShotId}`);
        expect(ids).not.toContain(`recurring_task:${plainTask.id}`);
    });
});

test.describe('Schedules — query filters', () => {
    test('sourceType filter narrows the read-model to that source only', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const missionId = await createScheduledMission(request, user.access_token, `FM ${stamp()}`);
        await createWorkViaAPI(request, user.access_token, {
            name: `FW ${stamp()}`,
            slug: `fw-${stamp()}`,
        });

        const list = await getSchedules(request, user.access_token, '?sourceType=mission_tick');
        expect(list.length).toBeGreaterThan(0);
        expect(new Set(list.map((r) => r.sourceType))).toEqual(new Set(['mission_tick']));
        expect(list.map((r) => r.id)).toContain(`mission_tick:${missionId}`);
    });

    test('entityKind=work buckets work_schedule + source_validation + data_sync', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const { id: workId } = await createWorkViaAPI(request, user.access_token, {
            name: `EK Work ${stamp()}`,
            slug: `ek-work-${stamp()}`,
        });
        await setWorkSchedule(request, user.access_token, workId, {
            enable: false,
            cadence: 'daily',
        });
        await setSourceValidation(request, user.access_token, workId, {
            enabled: true,
            cadence: 'weekly',
        });

        const list = await getSchedules(request, user.access_token, '?entityKind=work');
        // Every returned row is owned by a Work.
        expect(new Set(list.map((r) => r.ownerType))).toEqual(new Set(['work']));
        const sources = new Set(list.map((r) => r.sourceType));
        expect(sources).toContain('work_schedule');
        expect(sources).toContain('source_validation');
        expect(sources).toContain('data_sync');
        // No non-work sources leak through the filter.
        expect(sources.has('mission_tick')).toBe(false);
        expect(sources.has('agent_heartbeat')).toBe(false);
    });

    test('entityKind=agent returns only agent_heartbeat rows', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const agent = await createAgentWithHeartbeat(
            request,
            user.access_token,
            `EKA ${stamp()}`,
            '0 * * * *',
        );
        await createScheduledMission(request, user.access_token, `EKAM ${stamp()}`);

        const list = await getSchedules(request, user.access_token, '?entityKind=agent');
        expect(list.length).toBeGreaterThan(0);
        expect(new Set(list.map((r) => r.sourceType))).toEqual(new Set(['agent_heartbeat']));
        expect(list.map((r) => r.id)).toContain(`agent_heartbeat:${agent.id}`);
    });

    test('enabledOnly=true drops disabled rows (draft agent, paused work schedule)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const missionId = await createScheduledMission(request, user.access_token, `EO ${stamp()}`);
        const agent = await createAgentWithHeartbeat(
            request,
            user.access_token,
            `EO Agent ${stamp()}`,
            '0 * * * *',
        );
        const { id: workId } = await createWorkViaAPI(request, user.access_token, {
            name: `EO Work ${stamp()}`,
            slug: `eo-work-${stamp()}`,
        });
        await setWorkSchedule(request, user.access_token, workId, {
            enable: false,
            cadence: 'daily',
        });

        const list = await getSchedules(request, user.access_token, '?enabledOnly=true');
        // Every surviving row is enabled.
        expect(list.every((r) => r.enabled === true)).toBe(true);
        const ids = list.map((r) => r.id);
        // The enabled mission survives; the draft agent + paused work-schedule are dropped.
        expect(ids).toContain(`mission_tick:${missionId}`);
        expect(ids).not.toContain(`agent_heartbeat:${agent.id}`);
        expect(ids).not.toContain(`work_schedule:${workId}`);
    });

    test('enabledOnly=false keeps disabled rows in the read-model', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const agent = await createAgentWithHeartbeat(
            request,
            user.access_token,
            `Keep ${stamp()}`,
            '0 * * * *',
        );

        const list = await getSchedules(request, user.access_token, '?enabledOnly=false');
        // The draft (disabled) agent heartbeat is still present when the flag is false.
        expect(list.map((r) => r.id)).toContain(`agent_heartbeat:${agent.id}`);
        expect(list.some((r) => r.enabled === false)).toBe(true);
    });

    test('sourceType + enabledOnly compose: a disabled source filtered to enabled-only is empty', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const agent = await createAgentWithHeartbeat(
            request,
            user.access_token,
            `Compose ${stamp()}`,
            '0 * * * *',
        );

        // The one agent_heartbeat is draft/disabled → the intersection is empty.
        const list = await getSchedules(
            request,
            user.access_token,
            '?sourceType=agent_heartbeat&enabledOnly=true',
        );
        expect(list).toEqual([]);
        expect(list.map((r) => r.id)).not.toContain(`agent_heartbeat:${agent.id}`);
    });
});

test.describe('Schedules — validation & auth', () => {
    test("a typo'd sourceType or entityKind → 400; a valid value → 200", async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const H = { headers: authedHeaders(user.access_token) };

        expect((await request.get(`${SCHEDULES_BASE}?sourceType=bogus`, H)).status()).toBe(400);
        expect((await request.get(`${SCHEDULES_BASE}?entityKind=bogus`, H)).status()).toBe(400);
        // The valid enum members are accepted.
        expect((await request.get(`${SCHEDULES_BASE}?sourceType=mission_tick`, H)).status()).toBe(
            200,
        );
        expect((await request.get(`${SCHEDULES_BASE}?entityKind=work`, H)).status()).toBe(200);
    });

    test('a non-boolean enabledOnly → 400; an unknown query param → 400 (forbidNonWhitelisted); true → 200', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const H = { headers: authedHeaders(user.access_token) };

        expect((await request.get(`${SCHEDULES_BASE}?enabledOnly=maybe`, H)).status()).toBe(400);
        expect((await request.get(`${SCHEDULES_BASE}?bogusParam=1`, H)).status()).toBe(400);
        // The 'true'/'false' tokens are coerced and accepted.
        expect((await request.get(`${SCHEDULES_BASE}?enabledOnly=true`, H)).status()).toBe(200);
        expect((await request.get(`${SCHEDULES_BASE}?enabledOnly=false`, H)).status()).toBe(200);
    });

    test('the JWT guard fires first: unauth is 401 on both the bare and the filtered endpoint', async ({
        request,
    }) => {
        expect((await request.get(SCHEDULES_BASE)).status()).toBe(401);
        expect((await request.get(`${SCHEDULES_BASE}?sourceType=mission_tick`)).status()).toBe(401);
        // Even a would-be-400 (invalid param) is still 401 without a token — auth precedes validation.
        expect((await request.get(`${SCHEDULES_BASE}?sourceType=bogus`)).status()).toBe(401);
    });
});

test.describe('Schedules — isolation, ordering, lifecycle & id contract', () => {
    test("structural cross-user isolation: a user's read-model contains ONLY their own rows", async ({
        request,
    }) => {
        const alice = await registerUserViaAPI(request);
        const bob = await registerUserViaAPI(request);
        const aliceMission = await createScheduledMission(
            request,
            alice.access_token,
            `Alice ${stamp()}`,
        );
        const bobMission = await createScheduledMission(
            request,
            bob.access_token,
            `Bob ${stamp()}`,
        );

        const aliceIds = (await getSchedules(request, alice.access_token)).map((r) => r.id);
        const bobIds = (await getSchedules(request, bob.access_token)).map((r) => r.id);

        expect(aliceIds).toContain(`mission_tick:${aliceMission}`);
        expect(aliceIds).not.toContain(`mission_tick:${bobMission}`);
        expect(bobIds).toContain(`mission_tick:${bobMission}`);
        expect(bobIds).not.toContain(`mission_tick:${aliceMission}`);
    });

    test('rows are sorted by nextRunAt ascending, nulls last', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        // Mix a computed-next-run source (mission), a "due now" source (work data_sync),
        // and a null-next-run source (inbound trigger).
        await createScheduledMission(request, user.access_token, `Sort M ${stamp()}`, '0 9 * * *');
        await createWorkViaAPI(request, user.access_token, {
            name: `Sort W ${stamp()}`,
            slug: `sort-w-${stamp()}`,
        });
        await createTriggerViaAPI(request, user.access_token, {
            name: `Sort T ${stamp()}`,
            kind: 'webhook',
        });

        const times = (await getSchedules(request, user.access_token)).map((r) => r.nextRunAt);
        // Once a null appears, everything after it is null too (nulls sort last).
        const firstNull = times.findIndex((t) => t === null);
        if (firstNull !== -1) {
            expect(times.slice(firstNull).every((t) => t === null)).toBe(true);
        }
        // The non-null timestamps are in non-decreasing ISO order.
        const nonNull = times.filter((t): t is string => t !== null);
        const sorted = [...nonNull].sort((a, b) => a.localeCompare(b));
        expect(nonNull).toEqual(sorted);
    });

    test('pausing then resuming a scheduled Mission toggles its row status/enabled/nextRunAt', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const missionId = await createScheduledMission(
            request,
            user.access_token,
            `Toggle ${stamp()}`,
            '0 9 * * *',
        );
        const id = `mission_tick:${missionId}`;
        const H = { headers: authedHeaders(user.access_token) };

        const active = findRow(await getSchedules(request, user.access_token), id);
        expect(active!.status).toBe('active');
        expect(active!.enabled).toBe(true);
        expect(active!.nextRunAt).not.toBeNull();

        expect(
            (await request.post(`${API_BASE}/api/me/missions/${missionId}/pause`, H)).status(),
        ).toBe(200);
        const paused = findRow(await getSchedules(request, user.access_token), id);
        expect(paused!.status).toBe('paused');
        expect(paused!.enabled).toBe(false);
        // A paused Mission has no computed next fire.
        expect(paused!.nextRunAt).toBeNull();
        // …and enabledOnly drops it entirely.
        expect(
            (await getSchedules(request, user.access_token, '?enabledOnly=true')).map((r) => r.id),
        ).not.toContain(id);

        expect(
            (await request.post(`${API_BASE}/api/me/missions/${missionId}/resume`, H)).status(),
        ).toBe(200);
        const resumed = findRow(await getSchedules(request, user.access_token), id);
        expect(resumed!.status).toBe('active');
        expect(resumed!.enabled).toBe(true);
        expect(resumed!.nextRunAt).not.toBeNull();
    });

    test('the synthetic id is a stable ${sourceType}:${ownerId}, unique per row, drawn from the source vocabulary', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        await createScheduledMission(request, user.access_token, `IdC M ${stamp()}`);
        const task = await createTaskViaAPI(request, user.access_token, {
            title: `IdC T ${stamp()}`,
        });
        await makeTaskRecurring(request, user.access_token, task.id);
        await createWorkViaAPI(request, user.access_token, {
            name: `IdC W ${stamp()}`,
            slug: `idc-w-${stamp()}`,
        });

        const list = await getSchedules(request, user.access_token);
        expect(list.length).toBeGreaterThanOrEqual(3);
        const ids = list.map((r) => r.id);
        // Ids are unique across the read-model.
        expect(new Set(ids).size).toBe(ids.length);
        for (const row of list) {
            expect(row.id).toBe(`${row.sourceType}:${row.ownerId}`);
            expect(SOURCE_TYPES).toContain(row.sourceType);
            expect(typeof row.ownerName).toBe('string');
            expect(row.ownerName.length).toBeGreaterThan(0);
        }
    });
});
