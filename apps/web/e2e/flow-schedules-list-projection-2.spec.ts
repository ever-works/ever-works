/**
 * Schedules ("Cadence") list projection — GET /api/schedules, SCALE + PROJECTION angles.
 *
 * Companion to `flow-schedules-view-deep.spec.ts` (which pins each of the seven
 * single-source projections byte-for-byte). This file deliberately targets the
 * ANGLES that only surface once you project ACROSS all sources with N seeded
 * entities at once — none of which the view-deep file exercises:
 *
 *   • N-seeded scale & the un-paginated contract (spec §4.1 — P1 is deliberately
 *     un-paginated): a fresh user who seeds N scheduled entities gets ALL N rows
 *     back in one bare JSON array — no {data,meta} envelope, no default page cap
 *     truncating at 10, and every pagination/cursor/sort param
 *     (limit/offset/page/cursor/take/sort/order/q) is REJECTED with 400 by the
 *     whitelist (forbidNonWhitelisted) rather than silently ignored.
 *   • entityKind is an OWNER-TYPE filter, not a source filter — its sharpest
 *     consequence is the inbound_trigger split: a trigger WITH a targetAgentId
 *     projects ownerType 'agent' (and is caught by entityKind=agent, hidden from
 *     entityKind=trigger), while a standalone trigger projects ownerType
 *     'trigger'. The agent-owned trigger also breaks the naïve
 *     `id === ${sourceType}:${ownerId}` identity — its id keeps the trigger id
 *     while ownerId becomes the agent id.
 *   • ordering with N rows — the equal-nextRunAt tiebreak on ownerName, a
 *     distinct-cadence multi-row sort, and "due-now precedes a future fire".
 *   • the LIVE-computed nextRunAt field — a never-polled Work's data_sync
 *     nextRunAt tracks wall-clock `now` and ADVANCES between two sequential
 *     requests (it is recomputed, never persisted), whereas a cron mission's
 *     next fire is pinned to the cron minute and stays in the future.
 *
 * ── Verified live against http://127.0.0.1:3100 (sqlite in-memory, all flags
 *    ON) before assertions were written. Observed shapes/status/ordering:
 *      - every pagination/sort param → 400; a fresh user's N=10 missions all
 *        project (len 10); duplicate/array + wrong-case + empty-string enum → 400;
 *        enabledOnly coerces ONLY lowercase 'true'/'false' ('1'/'0'/'TRUE'/bare → 400);
 *      - a targetAgentId trigger → { id:'inbound_trigger:<trigId>', ownerType:'agent',
 *        ownerId:'<agentId>', ownerLink:'/agents/<agentId>' }; entityKind=agent len 1,
 *        entityKind=trigger len 0;
 *      - data_sync never-polled nextRunAt = request instant (advanced 16:56:41→16:56:43
 *        across a 2s gap); a five-minute-interval cron mission next fire ~196s ahead, minute-aligned;
 *      - equal-cron missions sort A < M < Z by ownerName; distinct-hour missions sort
 *        by computed nextRunAt; the null-next-run inbound_trigger sorts last.
 *    Backed by apps/api/src/schedules/schedules.controller.ts +
 *    apps/api/src/schedules/dto/schedules-query.dto.ts +
 *    packages/agent/src/schedules/schedules.service.ts.
 *
 * Isolation discipline: every test builds FRESH registerUserViaAPI() owners, so
 * each caller's schedule read-model is EXACTLY the rows that test created — which
 * makes per-user exact-count assertions deterministic (isolation is by userId).
 * Fully API-orchestrated (safe `flow-` prefix), never contends on the UI.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, createWorkViaAPI } from './helpers/api';
import { createAgentViaAPI, createTaskViaAPI } from './helpers/agents-tasks';
import { createTriggerViaAPI } from './helpers/triggers';

const SCHEDULES_BASE = `${API_BASE}/api/schedules`;
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

/** Raw GET so a test can assert the HTTP status/body itself. */
function getRaw(request: APIRequestContext, token: string, query = '') {
    return request.get(`${SCHEDULES_BASE}${query}`, { headers: authedHeaders(token) });
}

/** GET /api/schedules (optionally `?...`) as the given user, asserting 200. */
async function getSchedules(
    request: APIRequestContext,
    token: string,
    query = '',
): Promise<ScheduleView[]> {
    const res = await getRaw(request, token, query);
    expect(res.status(), `schedules body=${await res.text().catch(() => '')}`).toBe(200);
    return res.json();
}

function idsOf(list: ScheduleView[]): string[] {
    return list.map((r) => r.id);
}
function byId(list: ScheduleView[], id: string): ScheduleView | undefined {
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
        data: { title, description: 'schedules list-projection e2e', type: 'scheduled', schedule },
    });
    expect(res.status(), `createScheduledMission body=${await res.text().catch(() => '')}`).toBe(
        201,
    );
    return (await res.json()).id as string;
}

/** Seed N scheduled missions SEQUENTIALLY (sqlite write-serialization safe) → ids. */
async function seedMissions(
    request: APIRequestContext,
    token: string,
    n: number,
    schedule: string,
    prefix: string,
): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
        ids.push(await createScheduledMission(request, token, `${prefix}-${i}`, schedule));
    }
    return ids;
}

/** Make an existing Task recurring (RRULE) → 200. */
async function makeTaskRecurring(
    request: APIRequestContext,
    token: string,
    taskId: string,
): Promise<void> {
    const res = await request.post(`${API_BASE}/api/tasks/${taskId}/recurring`, {
        headers: authedHeaders(token),
        data: { recurrenceRule: 'FREQ=DAILY;INTERVAL=1' },
    });
    expect(res.status(), `makeTaskRecurring body=${await res.text().catch(() => '')}`).toBe(200);
}

test.describe('Schedules projection — N seeded across all sources (un-paginated)', () => {
    test('the read-model is a bare JSON array with NO pagination envelope; empty for a fresh user', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const res = await getRaw(request, user.access_token);
        expect(res.status()).toBe(200);
        const body = (await res.json()) as unknown;
        // A bare array — not a { data, meta } / { items, total } page envelope.
        expect(Array.isArray(body)).toBe(true);
        const asObj = body as Record<string, unknown>;
        expect(asObj.data).toBeUndefined();
        expect(asObj.items).toBeUndefined();
        expect(asObj.meta).toBeUndefined();
        expect(asObj.total).toBeUndefined();
        // Fresh user owns no scheduled entities → exactly [].
        expect(body).toEqual([]);
    });

    test('N=11 scheduled missions ALL project — no default page limit truncates at 10', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const prefix = `Bulk-${stamp()}`;
        const missionIds = await seedMissions(request, user.access_token, 11, '0 8 * * *', prefix);

        const list = await getSchedules(request, user.access_token);
        // Fresh user's ONLY rows are these 11 mission_ticks → exact per-user count.
        expect(list.length).toBe(11);
        const ids = idsOf(list);
        for (const mid of missionIds) {
            expect(ids).toContain(`mission_tick:${mid}`);
        }
        // Ids are unique across the read-model.
        expect(new Set(ids).size).toBe(ids.length);
        // Every row is the mission source.
        expect(new Set(list.map((r) => r.sourceType))).toEqual(new Set(['mission_tick']));
    });

    test('a mix of four distinct sources projects EVERY row in one array (exact total + id set)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const s = stamp();
        const [m1, m2] = await seedMissions(request, user.access_token, 2, '0 9 * * *', `Mix-${s}`);
        const task = await createTaskViaAPI(request, user.access_token, { title: `MixT-${s}` });
        await makeTaskRecurring(request, user.access_token, task.id);
        const w1 = (
            await createWorkViaAPI(request, user.access_token, {
                name: `MixW1 ${s}`,
                slug: `mixw1-${s}`,
            })
        ).id;
        const w2 = (
            await createWorkViaAPI(request, user.access_token, {
                name: `MixW2 ${s}`,
                slug: `mixw2-${s}`,
            })
        ).id;
        const { trigger } = await createTriggerViaAPI(request, user.access_token, {
            name: `MixTrig ${s}`,
            kind: 'webhook',
        });

        const list = await getSchedules(request, user.access_token);
        const ids = idsOf(list);
        // 2 missions + 1 recurring task + 2 works(→data_sync) + 1 trigger = 6 rows, nothing else.
        expect(list.length).toBe(6);
        expect(ids).toContain(`mission_tick:${m1}`);
        expect(ids).toContain(`mission_tick:${m2}`);
        expect(ids).toContain(`recurring_task:${task.id}`);
        expect(ids).toContain(`data_sync:${w1}`);
        expect(ids).toContain(`data_sync:${w2}`);
        expect(ids).toContain(`inbound_trigger:${trigger.id}`);
        expect(new Set(list.map((r) => r.sourceType))).toEqual(
            new Set(['mission_tick', 'recurring_task', 'data_sync', 'inbound_trigger']),
        );
        // Every row's source label is drawn from the fixed vocabulary.
        for (const r of list) expect(SOURCE_TYPES).toContain(r.sourceType);
    });
});

test.describe('Schedules — pagination / cursor params are rejected (un-paginated by design)', () => {
    test('offset-style params (limit / offset / page / cursor / take) each → 400', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        for (const q of ['?limit=5', '?offset=0', '?page=1', '?cursor=abc', '?take=3']) {
            const res = await getRaw(request, user.access_token, q);
            expect(res.status(), `${q} should be rejected`).toBe(400);
        }
    });

    test('sort / order / q params each → 400 (no sorting or search surface exists)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        for (const q of ['?sort=nextRunAt', '?order=desc', '?q=foo', '?search=foo']) {
            const res = await getRaw(request, user.access_token, q);
            expect(res.status(), `${q} should be rejected`).toBe(400);
        }
    });

    test('a pagination param 400s even when paired with an otherwise-valid filter', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        // sourceType alone is valid…
        expect(
            (await getRaw(request, user.access_token, '?sourceType=mission_tick')).status(),
        ).toBe(200);
        // …but adding an unknown pagination param taints the whole query (forbidNonWhitelisted).
        expect(
            (await getRaw(request, user.access_token, '?sourceType=mission_tick&limit=2')).status(),
        ).toBe(400);
    });
});

test.describe('Schedules — entityKind is an OWNER-TYPE filter', () => {
    test('entityKind=mission returns only mission_tick rows (ownerType mission)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const missionId = await createScheduledMission(
            request,
            user.access_token,
            `EKm-${stamp()}`,
        );
        // A recurring task + a work exist too, but must be filtered out.
        const task = await createTaskViaAPI(request, user.access_token, {
            title: `EKmT-${stamp()}`,
        });
        await makeTaskRecurring(request, user.access_token, task.id);

        const list = await getSchedules(request, user.access_token, '?entityKind=mission');
        expect(list.length).toBeGreaterThan(0);
        expect(new Set(list.map((r) => r.sourceType))).toEqual(new Set(['mission_tick']));
        expect(new Set(list.map((r) => r.ownerType))).toEqual(new Set(['mission']));
        expect(idsOf(list)).toContain(`mission_tick:${missionId}`);
    });

    test('entityKind=task returns only recurring_task rows (ownerType task)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const task = await createTaskViaAPI(request, user.access_token, {
            title: `EKt-${stamp()}`,
        });
        await makeTaskRecurring(request, user.access_token, task.id);
        await createScheduledMission(request, user.access_token, `EKtM-${stamp()}`);

        const list = await getSchedules(request, user.access_token, '?entityKind=task');
        expect(list.length).toBeGreaterThan(0);
        expect(new Set(list.map((r) => r.sourceType))).toEqual(new Set(['recurring_task']));
        expect(new Set(list.map((r) => r.ownerType))).toEqual(new Set(['task']));
        expect(idsOf(list)).toContain(`recurring_task:${task.id}`);
    });

    test('a targetAgentId trigger projects ownerType=agent and is caught by entityKind=agent', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, user.access_token, {
            scope: 'tenant',
            name: `TA ${stamp()}`,
        });
        const { trigger } = await createTriggerViaAPI(request, user.access_token, {
            name: `TrigToAgent ${stamp()}`,
            kind: 'webhook',
            targetAgentId: agent.id,
        });

        const list = await getSchedules(request, user.access_token, '?entityKind=agent');
        const row = byId(list, `inbound_trigger:${trigger.id}`);
        expect(row, 'agent-owned trigger should appear under entityKind=agent').toBeTruthy();
        expect(row!.sourceType).toBe('inbound_trigger');
        // The owner rebinds to the target Agent — including link + ownerId.
        expect(row!.ownerType).toBe('agent');
        expect(row!.ownerId).toBe(agent.id);
        expect(row!.ownerLink).toBe(`/agents/${agent.id}`);
        // …but the synthetic id keeps the TRIGGER id, so id !== `${sourceType}:${ownerId}` here.
        expect(row!.id).toBe(`inbound_trigger:${trigger.id}`);
        expect(row!.id).not.toBe(`inbound_trigger:${agent.id}`);
        // Every row under entityKind=agent is owned by an agent.
        expect(new Set(list.map((r) => r.ownerType))).toEqual(new Set(['agent']));
    });

    test('entityKind=trigger includes a standalone trigger but EXCLUDES the agent-owned one', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, user.access_token, {
            scope: 'tenant',
            name: `Excl ${stamp()}`,
        });
        const { trigger: agentOwned } = await createTriggerViaAPI(request, user.access_token, {
            name: `AgentOwned ${stamp()}`,
            kind: 'webhook',
            targetAgentId: agent.id,
        });
        const { trigger: standalone } = await createTriggerViaAPI(request, user.access_token, {
            name: `Standalone ${stamp()}`,
            kind: 'webhook',
        });

        const list = await getSchedules(request, user.access_token, '?entityKind=trigger');
        const ids = idsOf(list);
        // Standalone trigger is its own owner (ownerType 'trigger') → id === sourceType:ownerId.
        expect(ids).toContain(`inbound_trigger:${standalone.id}`);
        const standaloneRow = byId(list, `inbound_trigger:${standalone.id}`)!;
        expect(standaloneRow.ownerType).toBe('trigger');
        expect(standaloneRow.ownerId).toBe(standalone.id);
        expect(standaloneRow.id).toBe(`${standaloneRow.sourceType}:${standaloneRow.ownerId}`);
        // The agent-owned trigger has ownerType 'agent' → filtered OUT of entityKind=trigger.
        expect(ids).not.toContain(`inbound_trigger:${agentOwned.id}`);
        expect(new Set(list.map((r) => r.ownerType))).toEqual(new Set(['trigger']));
    });

    test('entityKind with no matching owner returns an empty array', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        await createScheduledMission(request, user.access_token, `NoMatch ${stamp()}`);
        // Only a mission exists → filtering to agents yields nothing.
        const list = await getSchedules(request, user.access_token, '?entityKind=agent');
        expect(list).toEqual([]);
    });

    test('sourceType + entityKind that contradict → 200 with an empty array', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const missionId = await createScheduledMission(
            request,
            user.access_token,
            `Contra ${stamp()}`,
        );
        // mission_tick rows are ownerType 'mission' — asking for ownerType 'work' is unsatisfiable.
        const list = await getSchedules(
            request,
            user.access_token,
            '?sourceType=mission_tick&entityKind=work',
        );
        expect(list).toEqual([]);
        expect(idsOf(list)).not.toContain(`mission_tick:${missionId}`);
    });

    test('sourceType + entityKind that AGREE both resolve to the same row', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, user.access_token, {
            scope: 'tenant',
            name: `Agree ${stamp()}`,
        });
        const { trigger } = await createTriggerViaAPI(request, user.access_token, {
            name: `AgreeTrig ${stamp()}`,
            kind: 'webhook',
            targetAgentId: agent.id,
        });
        // sourceType inbound_trigger AND ownerType agent both describe this one row.
        const list = await getSchedules(
            request,
            user.access_token,
            '?sourceType=inbound_trigger&entityKind=agent',
        );
        expect(idsOf(list)).toEqual([`inbound_trigger:${trigger.id}`]);
    });
});

test.describe('Schedules — ordering across N entities', () => {
    test('equal nextRunAt rows tiebreak on ownerName ascending', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const suffix = stamp();
        // Same cron → identical computed nextRunAt → the secondary sort decides.
        const zId = await createScheduledMission(
            request,
            user.access_token,
            `Z-${suffix}`,
            '0 9 * * *',
        );
        const aId = await createScheduledMission(
            request,
            user.access_token,
            `A-${suffix}`,
            '0 9 * * *',
        );
        const mId = await createScheduledMission(
            request,
            user.access_token,
            `M-${suffix}`,
            '0 9 * * *',
        );

        const list = await getSchedules(request, user.access_token, '?sourceType=mission_tick');
        // All three fire at the same instant.
        expect(new Set(list.map((r) => r.nextRunAt)).size).toBe(1);
        const order = idsOf(list);
        const iA = order.indexOf(`mission_tick:${aId}`);
        const iM = order.indexOf(`mission_tick:${mId}`);
        const iZ = order.indexOf(`mission_tick:${zId}`);
        expect(iA).toBeGreaterThanOrEqual(0);
        // A-… < M-… < Z-… by ownerName localeCompare (creation order was Z, A, M).
        expect(iA).toBeLessThan(iM);
        expect(iM).toBeLessThan(iZ);
    });

    test('distinct-cadence missions appear in ascending computed-nextRunAt order', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const s = stamp();
        // Three different daily hours → three DISTINCT next-fire instants. Create out of order.
        const h12 = await createScheduledMission(
            request,
            user.access_token,
            `H12-${s}`,
            '0 12 * * *',
        );
        const h6 = await createScheduledMission(request, user.access_token, `H6-${s}`, '0 6 * * *');
        const h9 = await createScheduledMission(request, user.access_token, `H9-${s}`, '0 9 * * *');

        const list = await getSchedules(request, user.access_token, '?sourceType=mission_tick');
        expect(list.length).toBe(3);
        // Distinct hours → three distinct computed next-fire timestamps.
        const times = list.map((r) => r.nextRunAt);
        expect(new Set(times).size).toBe(3);
        // The list is globally sorted by nextRunAt ascending — so it is strictly increasing here.
        for (let i = 1; i < times.length; i++) {
            expect(times[i - 1]!.localeCompare(times[i]!)).toBeLessThan(0);
        }
        // Sanity: all three seeded rows are present.
        const ids = idsOf(list);
        for (const id of [h6, h9, h12]) expect(ids).toContain(`mission_tick:${id}`);
    });

    test('a due-now source sorts ahead of a future cron fire', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const s = stamp();
        const workId = (
            await createWorkViaAPI(request, user.access_token, {
                name: `DueNow ${s}`,
                slug: `duenow-${s}`,
            })
        ).id;
        const missionId = await createScheduledMission(
            request,
            user.access_token,
            `Future ${s}`,
            '0 9 * * *',
        );

        const list = await getSchedules(request, user.access_token);
        const order = idsOf(list);
        const iSync = order.indexOf(`data_sync:${workId}`);
        const iMission = order.indexOf(`mission_tick:${missionId}`);
        expect(iSync).toBeGreaterThanOrEqual(0);
        expect(iMission).toBeGreaterThanOrEqual(0);
        // data_sync is due "now"; the mission's NEXT fire is always >= now → sync sorts first (or ties).
        expect(iSync).toBeLessThanOrEqual(iMission);
        const sync = byId(list, `data_sync:${workId}`)!;
        const mission = byId(list, `mission_tick:${missionId}`)!;
        expect(sync.nextRunAt!.localeCompare(mission.nextRunAt!)).toBeLessThanOrEqual(0);
    });

    test('mixed sources keep nextRunAt non-decreasing with every null at the tail', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const s = stamp();
        await createScheduledMission(request, user.access_token, `MixOrd M ${s}`, '0 9 * * *');
        await createWorkViaAPI(request, user.access_token, {
            name: `MixOrd W ${s}`,
            slug: `mixord-w-${s}`,
        });
        const { trigger } = await createTriggerViaAPI(request, user.access_token, {
            name: `MixOrd T ${s}`,
            kind: 'webhook',
        });

        const list = await getSchedules(request, user.access_token);
        const times = list.map((r) => r.nextRunAt);
        const firstNull = times.findIndex((t) => t === null);
        if (firstNull !== -1) {
            // Once a null appears, everything after it is null (nulls sort last).
            expect(times.slice(firstNull).every((t) => t === null)).toBe(true);
        }
        // The event-driven trigger (null next-run) is in the null tail.
        const trigRow = byId(list, `inbound_trigger:${trigger.id}`)!;
        expect(trigRow.nextRunAt).toBeNull();
        // Non-null timestamps are in non-decreasing ISO order.
        const nonNull = times.filter((t): t is string => t !== null);
        expect(nonNull).toEqual([...nonNull].sort((a, b) => a.localeCompare(b)));
    });
});

test.describe('Schedules — nextRunAt is LIVE-computed, not persisted', () => {
    test('a never-polled Work data_sync nextRunAt tracks wall-clock now and ADVANCES between calls', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const s = stamp();
        const workId = (
            await createWorkViaAPI(request, user.access_token, {
                name: `Live ${s}`,
                slug: `live-${s}`,
            })
        ).id;
        const id = `data_sync:${workId}`;
        const before = Date.now();

        const first = byId(await getSchedules(request, user.access_token), id)!;
        expect(first.nextRunAt).not.toBeNull();
        // Due "now" — within a small window of the test's own clock (same host).
        const firstMs = Date.parse(first.nextRunAt!);
        expect(firstMs).toBeGreaterThanOrEqual(before - 60_000);
        expect(firstMs).toBeLessThanOrEqual(Date.now() + 60_000);

        // Wait > 1s so the recomputed "now" is a strictly later millisecond.
        await new Promise((resolve) => setTimeout(resolve, 1_200));

        const second = byId(await getSchedules(request, user.access_token), id)!;
        const secondMs = Date.parse(second.nextRunAt!);
        // It is recomputed each request, not read from a stored column → it moved forward.
        expect(secondMs).toBeGreaterThan(firstMs);
        // …but stays anchored to now, not jumped by a cadence window.
        expect(secondMs - firstMs).toBeLessThan(30_000);
        // The cadence label itself is the fixed 5-minute default.
        expect(second.cadenceRaw).toBe('5m');
        expect(second.cadenceHuman).toBe('Every 5 minutes');
    });

    test("a cron mission's nextRunAt is in the future and minute-aligned within one cadence window", async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const before = Date.now();
        const missionId = await createScheduledMission(
            request,
            user.access_token,
            `Every5 ${stamp()}`,
            '*/5 * * * *',
        );

        const row = byId(
            await getSchedules(request, user.access_token),
            `mission_tick:${missionId}`,
        )!;
        expect(row.nextRunAt).not.toBeNull();
        const nextMs = Date.parse(row.nextRunAt!);
        // Strictly in the future relative to when we started, within one 5-minute window (+slack).
        expect(nextMs).toBeGreaterThan(before);
        expect(nextMs - before).toBeLessThanOrEqual(6 * 60_000);
        // Cron fires land on a whole minute (no seconds/millis component).
        expect(row.nextRunAt).toMatch(/:00\.000Z$/);
        expect(row.cadenceRaw).toBe('*/5 * * * *');
        expect(row.cadenceHuman).toBe('Every 5 minutes');
    });

    test('a daily cron mission pins nextRunAt to T09:00:00.000Z, stable across two reads', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const missionId = await createScheduledMission(
            request,
            user.access_token,
            `Nine ${stamp()}`,
            '0 9 * * *',
        );
        const id = `mission_tick:${missionId}`;

        const a = byId(await getSchedules(request, user.access_token), id)!;
        const b = byId(await getSchedules(request, user.access_token), id)!;
        // Computed to the cron minute — 09:00 UTC — on both reads.
        expect(a.nextRunAt).toMatch(/T09:00:00\.000Z$/);
        expect(b.nextRunAt).toMatch(/T09:00:00\.000Z$/);
        // Deterministic for a fixed cadence: the same next fire (no boundary crossing in ~0s).
        expect(a.nextRunAt).toBe(b.nextRunAt);
    });

    test('event-driven and paused sources carry a null nextRunAt while enabled peers keep timestamps', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const s = stamp();
        const { trigger } = await createTriggerViaAPI(request, user.access_token, {
            name: `NullNext ${s}`,
            kind: 'webhook',
        });
        const keepId = await createScheduledMission(
            request,
            user.access_token,
            `Keep ${s}`,
            '0 9 * * *',
        );
        const pauseId = await createScheduledMission(
            request,
            user.access_token,
            `Pause ${s}`,
            '0 9 * * *',
        );
        // Pause one mission → its live-computed next fire collapses to null.
        expect(
            (
                await request.post(`${API_BASE}/api/me/missions/${pauseId}/pause`, {
                    headers: authedHeaders(user.access_token),
                })
            ).status(),
        ).toBe(200);

        const list = await getSchedules(request, user.access_token);
        // Event-driven trigger: no timer at all.
        expect(byId(list, `inbound_trigger:${trigger.id}`)!.nextRunAt).toBeNull();
        // Paused mission: enabled=false, nextRunAt null.
        const paused = byId(list, `mission_tick:${pauseId}`)!;
        expect(paused.enabled).toBe(false);
        expect(paused.nextRunAt).toBeNull();
        // The still-active peer keeps a real computed timestamp.
        const kept = byId(list, `mission_tick:${keepId}`)!;
        expect(kept.enabled).toBe(true);
        expect(kept.nextRunAt).toMatch(/T09:00:00\.000Z$/);
    });
});

test.describe('Schedules — filter validation edges & isolation at scale', () => {
    test('wrong-case and empty-string enum values → 400', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        // IsEnum is case-sensitive.
        expect(
            (await getRaw(request, user.access_token, '?sourceType=MISSION_TICK')).status(),
        ).toBe(400);
        expect((await getRaw(request, user.access_token, '?entityKind=WORK')).status()).toBe(400);
        // An explicit empty value is NOT the same as an omitted optional param → 400.
        expect((await getRaw(request, user.access_token, '?sourceType=')).status()).toBe(400);
        expect((await getRaw(request, user.access_token, '?entityKind=')).status()).toBe(400);
    });

    test('a repeated (array) query param → 400', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        // Duplicated key arrives as an array — not a single enum member → validation fails.
        expect(
            (
                await getRaw(
                    request,
                    user.access_token,
                    '?sourceType=mission_tick&sourceType=data_sync',
                )
            ).status(),
        ).toBe(400);
    });

    test('enabledOnly coerces ONLY lowercase true/false; any other token → 400', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        // The two accepted tokens.
        expect((await getRaw(request, user.access_token, '?enabledOnly=true')).status()).toBe(200);
        expect((await getRaw(request, user.access_token, '?enabledOnly=false')).status()).toBe(200);
        // Everything else fails the @IsBoolean gate after the narrow @Transform.
        for (const bad of [
            '?enabledOnly=1',
            '?enabledOnly=0',
            '?enabledOnly=TRUE',
            '?enabledOnly=yes',
            '?enabledOnly',
        ]) {
            expect((await getRaw(request, user.access_token, bad)).status(), `${bad} → 400`).toBe(
                400,
            );
        }
    });

    test('two users each seed N missions → each read-model holds EXACTLY its own rows', async ({
        request,
    }) => {
        const alice = await registerUserViaAPI(request);
        const bob = await registerUserViaAPI(request);
        const aliceIds = await seedMissions(
            request,
            alice.access_token,
            3,
            '0 7 * * *',
            `Alice-${stamp()}`,
        );
        const bobIds = await seedMissions(
            request,
            bob.access_token,
            4,
            '0 8 * * *',
            `Bob-${stamp()}`,
        );

        const aliceList = await getSchedules(request, alice.access_token);
        const bobList = await getSchedules(request, bob.access_token);
        // Exact per-user counts (isolation is structural, by userId).
        expect(aliceList.length).toBe(3);
        expect(bobList.length).toBe(4);
        const aIds = idsOf(aliceList);
        const bIds = idsOf(bobList);
        for (const id of aliceIds) {
            expect(aIds).toContain(`mission_tick:${id}`);
            expect(bIds).not.toContain(`mission_tick:${id}`);
        }
        for (const id of bobIds) {
            expect(bIds).toContain(`mission_tick:${id}`);
            expect(aIds).not.toContain(`mission_tick:${id}`);
        }
    });
});
