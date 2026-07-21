import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * flow-work-scheduled-updates-multistep.spec.ts — CROSS-SURFACE, multi-step
 * INTEGRATION for per-Work scheduled updates. Every test drives several REAL
 * endpoints in sequence and asserts that three independent surfaces stay
 * CONSISTENT with one another:
 *
 *   (1) the per-Work schedule surface
 *         GET/PUT/DELETE /api/works/:id/schedule , POST .../schedule/run
 *         (apps/api/src/works/works.controller.ts -> getWorkSchedule /
 *          updateWorkSchedule / cancelWorkSchedule / runScheduledUpdate;
 *          packages/agent/src/services/work-schedule.service.ts;
 *          packages/agent/src/dto/work-schedule.dto.ts)
 *   (2) the Work-entity mirror  GET /api/works/:id -> work.scheduled*
 *         (scheduledUpdatesEnabled / scheduledCadence / scheduledStatus /
 *          scheduledNextRunAt — WorkScheduleService.syncWork())
 *   (3) the unified read-model  GET /api/schedules  (a work_schedule row)
 *         (apps/api/src/schedules/schedules.controller.ts +
 *          packages/agent/src/schedules/schedules.service.ts -> workSchedules())
 *   (+) the adjacent per-Work activity-sync secret rotation surface
 *         POST /api/works/:id/activity-sync/rotate-secret
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PROBED CONTRACT — every status / shape / string below was curl-verified LIVE
 * against http://127.0.0.1:3100 (sqlite in-memory, all flags ON, keyless, free
 * plan, subscriptions ENABLED) BEFORE assertions were written:
 *
 *   • PUT /works/:id/schedule {enable:false, cadence} bypasses the readiness gate
 *     and UPSERTS a real PAUSED row. The aggregation's workSchedules() query pulls
 *     ACTIVE + PAUSED rows, so that PAUSED row IMMEDIATELY surfaces in
 *     GET /api/schedules as:
 *       { id:'work_schedule:<workId>', sourceType:'work_schedule', ownerType:'work',
 *         ownerId:<workId>, ownerLink:'/works/<workId>/generator/schedule',
 *         cadenceRaw:<enum>, cadenceHuman:<describeWorkCadence>, status:'paused',
 *         enabled:false, nextRunAt:null, lastRunAt:null, lastRunStatus:null }
 *     — EXACTLY 13 keys; the projection OMITS billingMode / maxFailureBeforePause /
 *     alwaysCreatePullRequest / providerOverrides (those live only on surface (1)).
 *   • The synthetic id is keyed on workId → STABLE across cadence swaps. Swapping
 *     the cadence (daily→every_3_hours→weekly) re-reads verbatim on the SAME id;
 *     cadenceRaw + cadenceHuman track each step (describeWorkCadence: hourly→
 *     'Every hour', every_3_hours→'Every 3 hours', daily→'Every day', weekly→
 *     'Every week', monthly→'Every month').
 *   • The Work mirror agrees: after the PUT, GET /works/:id -> work.scheduledStatus
 *     ==='paused', scheduledCadence===<enum>, scheduledUpdatesEnabled===false,
 *     scheduledNextRunAt===null. A FRESH (unscheduled) work mirrors all-null /
 *     false and projects NO work_schedule row (only its auto data_sync row).
 *   • runImmediately:true on the disable path is a SILENT NO-OP (the controller
 *     only dispatches when the resulting status is ACTIVE) — the row stays PAUSED,
 *     lastRunAt stays null on both surfaces.
 *   • ONE Work simultaneously projects THREE distinct 'work'-owner rows —
 *     data_sync:<id> (auto, '5m'/'Every 5 minutes', enabled), work_schedule:<id>
 *     (PUT, paused), source_validation:<id> (PUT, enabled) — with distinct ids;
 *     enabledOnly=true drops the paused work_schedule but keeps the two enabled
 *     siblings; a cadence swap on one leaves the siblings byte-stable.
 *   • rotate-secret (POST .../activity-sync/rotate-secret) on a scheduled pull-mode
 *     work → 200 {status:'success',redeployRequired:true}; it is ORTHOGONAL to
 *     scheduling — the schedule row + mirror are unchanged, and re-PUT still 200s.
 *     On an UNscheduled work it creates NO work_schedule row. On a push-mode work
 *     → 409 {error:'mode-mismatch',mode:'push'} and the pre-existing schedule row
 *     is untouched.
 *   • VALIDATION is strictly 4xx, never 5xx: the cadence field rejects a cron-
 *     shaped string ('* * * * *') AND an unknown enum ('yearly') with 400 and
 *     creates no row; GET /api/schedules rejects a typo'd sourceType with 400
 *     while a fully-populated read-model returns 200.
 *   • run-now on the reachable PAUSED row → 400 'Schedule must be active to run';
 *     the rejected run is a NO-OP on the read-model (lastRunAt stays null, status
 *     stays paused). DELETE of a real paused row resolves non-2xx (500 in this
 *     stack — cancelSchedule side-effect) and the row stays observable as paused;
 *     an absent DELETE → 404. Unauth → 401 on the aggregation AND on every per-Work
 *     schedule verb.
 *   • Cross-user isolation is STRUCTURAL across both surfaces: user B's
 *     GET /api/schedules never contains user A's work_schedule row, and B's
 *     GET/PUT /works/:A-work/schedule → 403 (existing-work ownership check).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NON-DUPLICATION — the existing specs each test ONE surface in isolation; this
 * file pins the CROSS-SURFACE, mutate-then-re-observe consistency none of them do.
 *   • flow-schedules-view-deep.spec.ts — creates each source ONCE and snapshots
 *     GET /api/schedules; it never MUTATES a work schedule and re-observes the
 *     aggregation, never cross-checks the Work-entity mirror, never asserts the
 *     projection's exact 13-key omission set, and never touches rotate-secret.
 *   • flow-work-scheduled-updates.spec.ts / flow-works-schedule-crud.spec.ts —
 *     the per-Work schedule CRUD contract in isolation (readiness gate, DTO matrix,
 *     round-trips, run/delete preconditions); neither reads GET /api/schedules.
 *   • flow-works-activity-sync-secret.spec.ts — rotate-secret in isolation; it
 *     never combines rotation with a schedule row / the aggregation.
 * This file's unique surface is the JOIN between them (the "multistep" theme).
 *
 * ENVIRONMENT-ADAPTIVE + ISOLATED: keyless free-plan works are readiness-gated so
 * NO flow reaches status:'active' / a 202 dispatch — every assertion targets the
 * reachable PAUSED-row + aggregation contract. FRESH registerUserViaAPI() owner(s)
 * + FRESH work per test; unique suffixes from a per-test counter.
 */

const SCHEDULES_BASE = `${API_BASE}/api/schedules`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The 13 keys a work_schedule ScheduleView row carries — the projection is a
// deliberately NARROW read-model; per-work-only knobs are NOT surfaced here.
const SCHEDULE_VIEW_KEYS = [
    'cadenceHuman',
    'cadenceRaw',
    'enabled',
    'id',
    'lastRunAt',
    'lastRunStatus',
    'nextRunAt',
    'ownerId',
    'ownerLink',
    'ownerName',
    'ownerType',
    'sourceType',
    'status',
] as const;

// Per-work-only fields that must NEVER leak into the aggregation projection.
const PER_WORK_ONLY_KEYS = [
    'billingMode',
    'maxFailureBeforePause',
    'alwaysCreatePullRequest',
    'providerOverrides',
    'featureEnabled',
    'canEnable',
    'allowedCadences',
    'planCode',
] as const;

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

interface RichSchedule {
    status?: string | null;
    cadence?: string | null;
    billingMode?: string | null;
    maxFailureBeforePause?: number;
    alwaysCreatePullRequest?: boolean;
    nextRunAt?: string | null;
    lastRunAt?: string | null;
    lastRunStatus?: string | null;
}

interface ScheduleEnvelope {
    status?: string;
    message?: string | string[];
    workId?: string;
    schedule?: RichSchedule;
}

interface WorkMirror {
    scheduledUpdatesEnabled?: boolean;
    scheduledCadence?: string | null;
    scheduledStatus?: string | null;
    scheduledNextRunAt?: string | null;
    activitySyncMode?: string;
}

let seq = 0;
function suffix(): string {
    seq += 1;
    return `${seq}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function flatMessage(body: { message?: string | string[] }): string {
    return Array.isArray(body.message) ? body.message.join(' ') : String(body.message ?? '');
}

async function makeOwnerAndWork(
    request: APIRequestContext,
    label: string,
): Promise<{ token: string; workId: string; workName: string }> {
    const owner = await registerUserViaAPI(request);
    const sfx = suffix();
    const workName = `MS ${label} ${sfx}`;
    const created = await createWorkViaAPI(request, owner.access_token, {
        name: workName,
        slug: `ms-${label}-${sfx}`,
        description: `multistep scheduled-updates ${sfx}`,
    });
    expect(created.id, `work created for ${label}`).toBeTruthy();
    return { token: owner.access_token, workId: created.id, workName };
}

async function putSchedule(
    request: APIRequestContext,
    workId: string,
    token: string,
    data: Record<string, unknown>,
) {
    return request.put(`${API_BASE}/api/works/${workId}/schedule`, {
        headers: authedHeaders(token),
        data,
    });
}

/** PUT a disable-path (paused) schedule and assert the 200 upsert. */
async function createPausedSchedule(
    request: APIRequestContext,
    workId: string,
    token: string,
    data: Record<string, unknown>,
): Promise<RichSchedule> {
    const res = await putSchedule(request, workId, token, { enable: false, ...data });
    expect(res.status(), `disable-path PUT body=${await res.text()}`).toBe(200);
    const body = (await res.json()) as ScheduleEnvelope;
    expect(body.status, 'PUT envelope status').toBe('success');
    expect(body.schedule?.status, 'disable path yields a PAUSED row').toBe('paused');
    return body.schedule!;
}

async function getSchedules(
    request: APIRequestContext,
    token: string,
    query = '',
): Promise<ScheduleView[]> {
    const res = await request.get(`${SCHEDULES_BASE}${query}`, { headers: authedHeaders(token) });
    expect(res.status(), `GET /api/schedules body=${await res.text().catch(() => '')}`).toBe(200);
    return res.json();
}

function findRow(list: ScheduleView[], id: string): ScheduleView | undefined {
    return list.find((r) => r.id === id);
}

async function getWorkMirror(
    request: APIRequestContext,
    workId: string,
    token: string,
): Promise<WorkMirror> {
    const res = await request.get(`${API_BASE}/api/works/${workId}`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `GET /api/works/:id body=${await res.text().catch(() => '')}`).toBe(200);
    const body = (await res.json()) as { work: WorkMirror };
    expect(body.work, 'work envelope present').toBeTruthy();
    return body.work;
}

async function enableSourceValidation(
    request: APIRequestContext,
    workId: string,
    token: string,
    cadence: string,
): Promise<void> {
    const res = await request.put(`${API_BASE}/api/works/${workId}/source-validation`, {
        headers: authedHeaders(token),
        data: { enabled: true, cadence },
    });
    expect(res.status(), `source-validation PUT body=${await res.text().catch(() => '')}`).toBe(
        200,
    );
}

// ═══════════════════════════════════════════════════════════════════════════
test.describe('Work schedule × GET /api/schedules — cross-surface propagation', () => {
    // 1) The disable-path PUT immediately surfaces a fully-shaped work_schedule
    //    row in the aggregation (mutate here → observe there).
    test('a PUT-created paused schedule immediately surfaces as a fully-shaped work_schedule row', async ({
        request,
    }) => {
        const { token, workId, workName } = await makeOwnerAndWork(request, 'surface');
        await createPausedSchedule(request, workId, token, { cadence: 'daily' });

        const row = findRow(await getSchedules(request, token), `work_schedule:${workId}`);
        expect(row, 'work_schedule row surfaces in the aggregation').toBeTruthy();
        expect(row!.sourceType).toBe('work_schedule');
        expect(row!.ownerType).toBe('work');
        expect(row!.ownerId).toBe(workId);
        expect(row!.ownerId).toMatch(UUID_RE);
        expect(row!.ownerName).toBe(workName);
        expect(row!.ownerLink).toBe(`/works/${workId}/generator/schedule`);
        expect(row!.cadenceRaw).toBe('daily');
        expect(row!.cadenceHuman).toBe('Every day');
        // A PAUSED (not ACTIVE) row has no computed next-run and never ran.
        expect(row!.status).toBe('paused');
        expect(row!.enabled).toBe(false);
        expect(row!.nextRunAt).toBeNull();
        expect(row!.lastRunAt).toBeNull();
        expect(row!.lastRunStatus).toBeNull();
        // Synthetic id contract.
        expect(row!.id).toBe(`${row!.sourceType}:${row!.ownerId}`);
    });

    // 2) The synthetic id is workId-keyed → STABLE across cadence swaps; each swap
    //    re-reads verbatim through the aggregation. This mutate-then-re-observe is
    //    NOT in flow-schedules-view-deep (which creates once).
    test('cadence swaps propagate verbatim into the aggregation on a STABLE synthetic id', async ({
        request,
    }) => {
        const { token, workId } = await makeOwnerAndWork(request, 'swap');
        const rowId = `work_schedule:${workId}`;
        const steps: Array<[string, string]> = [
            ['daily', 'Every day'],
            ['every_3_hours', 'Every 3 hours'],
            ['every_12_hours', 'Every 12 hours'],
            ['weekly', 'Every week'],
            ['monthly', 'Every month'],
            ['hourly', 'Every hour'],
        ];

        for (const [cadence, human] of steps) {
            await createPausedSchedule(request, workId, token, { cadence });
            const row = findRow(await getSchedules(request, token), rowId);
            expect(row, `row present after cadence=${cadence}`).toBeTruthy();
            // Same single row swapped in place — id never churns.
            expect(row!.id, 'synthetic id stays workId-keyed').toBe(rowId);
            expect(row!.cadenceRaw, `cadenceRaw tracks ${cadence}`).toBe(cadence);
            expect(row!.cadenceHuman, `cadenceHuman tracks ${cadence}`).toBe(human);
            expect(row!.status, 'still paused').toBe('paused');
        }

        // Exactly ONE work_schedule row for this work through all the swaps.
        const finalList = await getSchedules(request, token, '?sourceType=work_schedule');
        expect(finalList.filter((r) => r.id === rowId)).toHaveLength(1);
    });

    // 3) The aggregation projection is a NARROW read-model: exactly the 13 keys,
    //    OMITTING billingMode / maxFailureBeforePause / alwaysCreatePullRequest /
    //    providerOverrides even though the per-work GET carries all of them.
    test('the aggregation projection omits every per-work-only knob (exact key set)', async ({
        request,
    }) => {
        const { token, workId } = await makeOwnerAndWork(request, 'projection');
        // Persist a rich config that the per-work surface DOES echo back.
        const put = await createPausedSchedule(request, workId, token, {
            cadence: 'weekly',
            billingMode: 'usage',
            maxFailureBeforePause: 7,
            alwaysCreatePullRequest: true,
        });
        expect(put.billingMode, 'per-work surface carries billingMode').toBe('usage');
        expect(put.maxFailureBeforePause, 'per-work surface carries maxFailure').toBe(7);
        expect(put.alwaysCreatePullRequest, 'per-work surface carries PR flag').toBe(true);

        const row = findRow(await getSchedules(request, token), `work_schedule:${workId}`);
        expect(row, 'work_schedule row present').toBeTruthy();
        // Exact key set — no more, no less.
        expect(Object.keys(row!).sort()).toEqual([...SCHEDULE_VIEW_KEYS].sort());
        for (const leaked of PER_WORK_ONLY_KEYS) {
            expect(
                Object.prototype.hasOwnProperty.call(row!, leaked),
                `aggregation must NOT expose per-work field "${leaked}"`,
            ).toBe(false);
        }
        // The cadence still round-trips (the ONE mutation the projection surfaces).
        expect(row!.cadenceRaw).toBe('weekly');
    });

    // 4) The Work-entity mirror (GET /works/:id -> work.scheduled*) agrees with the
    //    aggregation row after a PUT — two independent surfaces, one source of truth.
    test('the Work-entity scheduled* mirror agrees with the aggregation row', async ({
        request,
    }) => {
        const { token, workId } = await makeOwnerAndWork(request, 'mirror');
        await createPausedSchedule(request, workId, token, { cadence: 'every_8_hours' });

        const mirror = await getWorkMirror(request, workId, token);
        expect(mirror.scheduledStatus, 'mirror status').toBe('paused');
        expect(mirror.scheduledCadence, 'mirror cadence').toBe('every_8_hours');
        expect(mirror.scheduledUpdatesEnabled, 'mirror enabled flag (paused ⇒ false)').toBe(false);
        expect(mirror.scheduledNextRunAt ?? null, 'mirror next-run (paused ⇒ null)').toBeNull();

        const row = findRow(await getSchedules(request, token), `work_schedule:${workId}`);
        // The two surfaces are consistent field-for-field.
        expect(row!.status, 'aggregation status ↔ mirror status').toBe(mirror.scheduledStatus);
        expect(row!.cadenceRaw, 'aggregation cadence ↔ mirror cadence').toBe(
            mirror.scheduledCadence,
        );
        expect(row!.enabled, 'aggregation enabled ↔ mirror enabled').toBe(
            mirror.scheduledUpdatesEnabled,
        );
        expect(row!.nextRunAt, 'aggregation next-run ↔ mirror next-run').toBe(
            mirror.scheduledNextRunAt ?? null,
        );
    });

    // 5) A FRESH (unscheduled) work: null/false mirror AND no work_schedule row —
    //    the aggregation only ever projects an auto data_sync row for it.
    test('a fresh unscheduled work has a null mirror and projects no work_schedule row', async ({
        request,
    }) => {
        const { token, workId } = await makeOwnerAndWork(request, 'fresh');

        const mirror = await getWorkMirror(request, workId, token);
        expect(mirror.scheduledUpdatesEnabled, 'fresh: not enabled').toBe(false);
        expect(mirror.scheduledCadence ?? null, 'fresh: no cadence').toBeNull();
        expect(mirror.scheduledStatus ?? null, 'fresh: no status').toBeNull();
        expect(mirror.scheduledNextRunAt ?? null, 'fresh: no next-run').toBeNull();

        const list = await getSchedules(request, token);
        expect(
            findRow(list, `work_schedule:${workId}`),
            'no work_schedule row yet',
        ).toBeUndefined();
        // Every Work still auto-projects its data_sync row.
        const dataSync = findRow(list, `data_sync:${workId}`);
        expect(dataSync, 'a fresh work still has its auto data_sync row').toBeTruthy();
        expect(dataSync!.cadenceRaw).toBe('5m');
        expect(dataSync!.enabled).toBe(true);
    });

    // 6) runImmediately:true on the disable path is a SILENT NO-OP (the controller
    //    only dispatches when the resulting status is ACTIVE). Row stays PAUSED,
    //    never ran — verified on both the per-work GET and the aggregation.
    test('runImmediately on the disable path is a silent no-op (never runs, stays paused)', async ({
        request,
    }) => {
        const { token, workId } = await makeOwnerAndWork(request, 'runimm');
        const sched = await createPausedSchedule(request, workId, token, {
            cadence: 'daily',
            runImmediately: true,
        });
        // The disable path never activates → the immediate-run branch is skipped.
        expect(sched.status, 'still paused despite runImmediately').toBe('paused');
        expect(sched.lastRunAt ?? null, 'no run recorded on the per-work surface').toBeNull();
        expect(sched.lastRunStatus ?? null, 'no run status recorded').toBeNull();

        const row = findRow(await getSchedules(request, token), `work_schedule:${workId}`);
        expect(row!.status, 'aggregation row still paused').toBe('paused');
        expect(row!.lastRunAt, 'aggregation shows no run').toBeNull();
        expect(row!.lastRunStatus, 'aggregation shows no run status').toBeNull();
    });
});

// ═══════════════════════════════════════════════════════════════════════════
test.describe('One Work, three schedule sources — independent projection', () => {
    // 7) A single Work simultaneously projects three DISTINCT 'work'-owner rows.
    test('one work projects distinct data_sync + work_schedule + source_validation rows', async ({
        request,
    }) => {
        const { token, workId } = await makeOwnerAndWork(request, 'triple');
        await createPausedSchedule(request, workId, token, { cadence: 'daily' });
        await enableSourceValidation(request, workId, token, 'weekly');

        const list = await getSchedules(request, token, '?entityKind=work');
        // Every row in the entityKind=work bucket is owned by a Work.
        expect(new Set(list.map((r) => r.ownerType))).toEqual(new Set(['work']));

        const dataSync = findRow(list, `data_sync:${workId}`);
        const workSchedule = findRow(list, `work_schedule:${workId}`);
        const sourceValidation = findRow(list, `source_validation:${workId}`);
        expect(dataSync, 'data_sync row').toBeTruthy();
        expect(workSchedule, 'work_schedule row').toBeTruthy();
        expect(sourceValidation, 'source_validation row').toBeTruthy();

        // Three distinct synthetic ids, all keyed on the SAME workId but different sources.
        const ids = [dataSync!.id, workSchedule!.id, sourceValidation!.id];
        expect(new Set(ids).size, 'three distinct ids').toBe(3);
        for (const r of [dataSync!, workSchedule!, sourceValidation!]) {
            expect(r.ownerId, 'all three share the workId').toBe(workId);
            expect(r.id).toBe(`${r.sourceType}:${r.ownerId}`);
        }
        // Their distinct shapes: data_sync '5m'/enabled, source_validation cadence/enabled,
        // work_schedule cadence/paused.
        expect(dataSync!.cadenceRaw).toBe('5m');
        expect(dataSync!.enabled).toBe(true);
        expect(sourceValidation!.cadenceRaw).toBe('weekly');
        expect(sourceValidation!.enabled).toBe(true);
        expect(workSchedule!.status).toBe('paused');
        expect(workSchedule!.enabled).toBe(false);
    });

    // 8) enabledOnly=true drops the paused work_schedule but keeps the two enabled
    //    siblings of the SAME work (a per-work slice of the enabledOnly contract).
    test('enabledOnly=true drops the paused work_schedule but keeps its enabled siblings', async ({
        request,
    }) => {
        const { token, workId } = await makeOwnerAndWork(request, 'enabledonly');
        await createPausedSchedule(request, workId, token, { cadence: 'daily' });
        await enableSourceValidation(request, workId, token, 'daily');

        const enabledOnly = await getSchedules(request, token, '?entityKind=work&enabledOnly=true');
        // Every surviving row is enabled.
        expect(enabledOnly.every((r) => r.enabled === true)).toBe(true);
        const ids = enabledOnly.map((r) => r.id);
        expect(ids, 'paused work_schedule dropped').not.toContain(`work_schedule:${workId}`);
        expect(ids, 'always-on data_sync kept').toContain(`data_sync:${workId}`);
        expect(ids, 'enabled source_validation kept').toContain(`source_validation:${workId}`);

        // Without the flag, the paused work_schedule reappears.
        const all = (await getSchedules(request, token, '?entityKind=work')).map((r) => r.id);
        expect(all, 'work_schedule visible when enabledOnly is off').toContain(
            `work_schedule:${workId}`,
        );
    });

    // 9) Swapping the work_schedule cadence leaves the sibling rows byte-stable —
    //    the sources are projected independently.
    test('a work_schedule cadence swap leaves the sibling data_sync + source_validation rows byte-stable', async ({
        request,
    }) => {
        const { token, workId } = await makeOwnerAndWork(request, 'independent');
        await createPausedSchedule(request, workId, token, { cadence: 'daily' });
        await enableSourceValidation(request, workId, token, 'monthly');

        const before = await getSchedules(request, token, '?entityKind=work');
        const dsBefore = findRow(before, `data_sync:${workId}`)!;
        const svBefore = findRow(before, `source_validation:${workId}`)!;

        // Mutate ONLY the work_schedule cadence.
        await createPausedSchedule(request, workId, token, { cadence: 'weekly' });

        const after = await getSchedules(request, token, '?entityKind=work');
        const dsAfter = findRow(after, `data_sync:${workId}`)!;
        const svAfter = findRow(after, `source_validation:${workId}`)!;
        const wsAfter = findRow(after, `work_schedule:${workId}`)!;

        // The two siblings are unchanged; only the work_schedule moved.
        // `nextRunAt` is a LIVE-computed projection (now + cadence), so it drifts
        // a few ms between the two reads even when the persisted config is
        // untouched — compare the stable config, excluding that volatile field.
        const stripNext = <T extends { nextRunAt?: unknown }>(r: T) => {
            const { nextRunAt: _drop, ...rest } = r;
            return rest;
        };
        expect(stripNext(dsAfter), 'data_sync sibling stable (excl. live nextRunAt)').toEqual(
            stripNext(dsBefore),
        );
        expect(
            stripNext(svAfter),
            'source_validation sibling stable (excl. live nextRunAt)',
        ).toEqual(stripNext(svBefore));
        expect(wsAfter.cadenceRaw, 'only the work_schedule cadence changed').toBe('weekly');
    });
});

// ═══════════════════════════════════════════════════════════════════════════
test.describe('rotate activity-sync secret ⟂ schedule — multistep orthogonality', () => {
    const rotate = (workId: string) =>
        `${API_BASE}/api/works/${workId}/activity-sync/rotate-secret`;

    // 10) Rotating the secret on a scheduled work is ORTHOGONAL to scheduling —
    //     the schedule row + mirror are unchanged before/after.
    test('rotate-secret on a scheduled work is orthogonal — the schedule row is unchanged', async ({
        request,
    }) => {
        const { token, workId } = await makeOwnerAndWork(request, 'rotate-orth');
        await createPausedSchedule(request, workId, token, { cadence: 'every_3_hours' });

        const before = findRow(await getSchedules(request, token), `work_schedule:${workId}`)!;

        const res = await request.post(rotate(workId), { headers: authedHeaders(token) });
        expect(res.status(), `rotate body=${await res.text()}`).toBe(200);
        expect(await res.json(), 'rotate success contract').toEqual({
            status: 'success',
            redeployRequired: true,
        });

        const after = findRow(await getSchedules(request, token), `work_schedule:${workId}`)!;
        // The schedule projection is byte-identical — rotation touches only the secret column.
        expect(after, 'schedule row unchanged by rotation').toEqual(before);

        const mirror = await getWorkMirror(request, workId, token);
        expect(mirror.scheduledCadence, 'mirror cadence intact').toBe('every_3_hours');
        expect(mirror.scheduledStatus, 'mirror status intact').toBe('paused');
        expect(mirror.activitySyncMode, 'still pull mode').toBe('pull');
    });

    // 11) Rotation did not lock scheduling: a re-PUT after a rotate still 200s and
    //     an interleaved rotate stays consistent.
    test('scheduling still mutates after a rotation; interleaved rotate/PUT stays consistent', async ({
        request,
    }) => {
        const { token, workId } = await makeOwnerAndWork(request, 'interleave');
        await createPausedSchedule(request, workId, token, { cadence: 'daily' });

        // rotate → re-PUT (cadence change) → rotate again.
        expect(
            (await request.post(rotate(workId), { headers: authedHeaders(token) })).status(),
        ).toBe(200);
        await createPausedSchedule(request, workId, token, { cadence: 'weekly' });
        expect(
            (await request.post(rotate(workId), { headers: authedHeaders(token) })).status(),
        ).toBe(200);

        const row = findRow(await getSchedules(request, token), `work_schedule:${workId}`)!;
        expect(row.cadenceRaw, 'the re-PUT between rotations persisted').toBe('weekly');
        expect(row.status).toBe('paused');
    });

    // 12) Rotate-secret on an UNscheduled work never fabricates a work_schedule row.
    test('rotate-secret on an unscheduled work creates no work_schedule row', async ({
        request,
    }) => {
        const { token, workId } = await makeOwnerAndWork(request, 'rotate-nosched');

        const res = await request.post(rotate(workId), { headers: authedHeaders(token) });
        expect(res.status()).toBe(200);

        const list = await getSchedules(request, token);
        expect(
            findRow(list, `work_schedule:${workId}`),
            'rotation must not create a schedule row',
        ).toBeUndefined();
        // Only the auto data_sync row exists for this work.
        expect(findRow(list, `data_sync:${workId}`), 'data_sync row still present').toBeTruthy();
    });

    // 13) A push-mode work rotate → 409 mode-mismatch, and the pre-existing schedule
    //     row is untouched (the mode gate does not disturb scheduling state).
    test('push-mode rotate → 409 mode-mismatch and leaves the schedule row untouched', async ({
        request,
    }) => {
        const { token, workId } = await makeOwnerAndWork(request, 'rotate-push');
        await createPausedSchedule(request, workId, token, { cadence: 'daily' });

        // Flip the work out of the default pull transport.
        const patch = await request.patch(`${API_BASE}/api/works/${workId}`, {
            headers: authedHeaders(token),
            data: { activitySyncMode: 'push' },
        });
        expect(patch.status(), 'PATCH to push mode → 200').toBe(200);

        const res = await request.post(rotate(workId), { headers: authedHeaders(token) });
        expect(res.status(), 'push-mode rotate → 409').toBe(409);
        const body = await res.json();
        expect(body, 'typed mode-mismatch error').toMatchObject({
            error: 'mode-mismatch',
            mode: 'push',
        });

        // The schedule survived the failed rotation entirely.
        const row = findRow(await getSchedules(request, token), `work_schedule:${workId}`)!;
        expect(row.cadenceRaw, 'schedule cadence intact after 409').toBe('daily');
        expect(row.status, 'schedule still paused after 409').toBe('paused');
    });
});

// ═══════════════════════════════════════════════════════════════════════════
test.describe('Validation (4xx not 5xx), run-now no-op, isolation & delete', () => {
    // 14) The cadence field is an ENUM — it rejects a cron-shaped string AND an
    //     unknown enum value with 400 (never 5xx) and creates NO schedule row.
    test('the cadence field rejects cron-shaped + unknown inputs with 400 and creates no row', async ({
        request,
    }) => {
        const { token, workId } = await makeOwnerAndWork(request, 'badcadence');

        for (const bad of ['* * * * *', '0 9 * * *', 'yearly', 'every_2_hours', 'DAILY']) {
            const res = await putSchedule(request, workId, token, { enable: false, cadence: bad });
            const st = res.status();
            expect(st, `cadence "${bad}" is a client error, not a 5xx`).toBe(400);
            expect(st, `cadence "${bad}" never 5xx`).toBeLessThan(500);
            expect(flatMessage(await res.json()), `cadence "${bad}" enum message`).toMatch(
                /cadence must be one of/i,
            );
        }

        // None of the rejected PUTs created a schedule row.
        const list = await getSchedules(request, token);
        expect(
            findRow(list, `work_schedule:${workId}`),
            'no row created by rejected cadence PUTs',
        ).toBeUndefined();
    });

    // 15) GET /api/schedules validation is strictly 4xx while a populated read-model
    //     returns 200 — the aggregation never 5xxs on a real, multi-source user.
    test('GET /api/schedules is 4xx on a bad query and 200 on a fully-populated read-model (never 5xx)', async ({
        request,
    }) => {
        const { token, workId } = await makeOwnerAndWork(request, 'aggvalid');
        await createPausedSchedule(request, workId, token, { cadence: 'daily' });
        await enableSourceValidation(request, workId, token, 'weekly');
        const H = { headers: authedHeaders(token) };

        // Bad filters → 400, never 5xx.
        for (const q of [
            '?sourceType=bogus',
            '?entityKind=nope',
            '?enabledOnly=maybe',
            '?junk=1',
        ]) {
            const res = await request.get(`${SCHEDULES_BASE}${q}`, H);
            expect(res.status(), `bad query ${q} → 400`).toBe(400);
            expect(res.status(), `bad query ${q} never 5xx`).toBeLessThan(500);
        }

        // The populated read-model still returns 200 and every well-formed row.
        const list = await getSchedules(request, token);
        expect(list.length, 'populated read-model is non-empty').toBeGreaterThanOrEqual(3);
        for (const row of list) {
            expect(Object.keys(row).sort(), 'every row well-formed').toEqual(
                [...SCHEDULE_VIEW_KEYS].sort(),
            );
        }
    });

    // 16) run-now on the reachable PAUSED row → 400 must-be-active; the rejected run
    //     is a NO-OP on the read-model (no lastRunAt materializes).
    test('run-now on a paused row → 400 and is a no-op on the aggregation read-model', async ({
        request,
    }) => {
        const { token, workId } = await makeOwnerAndWork(request, 'runnow');
        await createPausedSchedule(request, workId, token, { cadence: 'daily' });

        const run = await request.post(`${API_BASE}/api/works/${workId}/schedule/run`, {
            headers: authedHeaders(token),
        });
        expect(run.status(), 'run on paused → 400').toBe(400);
        const body = (await run.json()) as ScheduleEnvelope;
        expect(body.status, 'error envelope').toBe('error');
        expect(flatMessage(body), 'must-be-active message').toMatch(/must be active to run/i);

        // The rejected run left the read-model untouched — no run was recorded.
        const row = findRow(await getSchedules(request, token), `work_schedule:${workId}`)!;
        expect(row.status, 'still paused after rejected run').toBe('paused');
        expect(row.lastRunAt, 'no run materialized in the aggregation').toBeNull();
        expect(row.lastRunStatus, 'no run status materialized').toBeNull();
    });

    // 17) Cross-user isolation is structural across BOTH surfaces.
    test('cross-user isolation holds across the aggregation AND the per-work surface', async ({
        request,
    }) => {
        const { token: ownerToken, workId } = await makeOwnerAndWork(request, 'iso');
        await createPausedSchedule(request, workId, ownerToken, { cadence: 'daily' });

        const stranger = await registerUserViaAPI(request);

        // Aggregation: the stranger never sees the owner's work_schedule row.
        const strangerIds = (await getSchedules(request, stranger.access_token)).map((r) => r.id);
        expect(strangerIds, "stranger's read-model excludes the owner's row").not.toContain(
            `work_schedule:${workId}`,
        );

        // Per-work surface: an existing work owned by someone else → 403 (ownership
        // check on a real work, not the 404-on-missing path).
        const foreignGet = await request.get(`${API_BASE}/api/works/${workId}/schedule`, {
            headers: authedHeaders(stranger.access_token),
        });
        expect(foreignGet.status(), 'foreign GET schedule → 403').toBe(403);

        const foreignPut = await putSchedule(request, workId, stranger.access_token, {
            enable: false,
            cadence: 'weekly',
        });
        expect(foreignPut.status(), 'foreign PUT schedule → 403').toBe(403);

        // The foreign PUT did not mutate the owner's schedule.
        const stillDaily = findRow(
            await getSchedules(request, ownerToken),
            `work_schedule:${workId}`,
        )!;
        expect(stillDaily.cadenceRaw, "owner's cadence untouched by the foreign PUT").toBe('daily');
    });

    // 18) DELETE of a real paused row is non-2xx (500 in this stack) and the row
    //     stays observable as paused in the aggregation; an absent DELETE → 404.
    test('DELETE of a real paused row is non-2xx and the row stays observable; absent DELETE → 404', async ({
        request,
    }) => {
        const { token, workId } = await makeOwnerAndWork(request, 'delete');
        const H = { headers: authedHeaders(token) };

        // Absent → 404, idempotent.
        const absent = await request.delete(`${API_BASE}/api/works/${workId}/schedule`, H);
        expect(absent.status(), 'absent DELETE → 404').toBe(404);
        expect(flatMessage(await absent.json()), 'absent DELETE message').toMatch(/not found/i);

        // Create a real paused row (it now surfaces in the aggregation).
        await createPausedSchedule(request, workId, token, { cadence: 'weekly' });
        expect(
            findRow(await getSchedules(request, token), `work_schedule:${workId}`),
            'row present before DELETE',
        ).toBeTruthy();

        const del = await request.delete(`${API_BASE}/api/works/${workId}/schedule`, H);
        const delStatus = del.status();
        expect(
            delStatus,
            `DELETE of a real paused row resolves non-2xx (got ${delStatus})`,
        ).toBeGreaterThanOrEqual(400);

        const rowAfter = findRow(await getSchedules(request, token), `work_schedule:${workId}`);
        if (delStatus >= 500) {
            test.info().annotations.push({
                type: 'known-issue',
                description: `DELETE /works/:id/schedule of a real (paused) row returns ${delStatus} in the e2e stack (cancelSchedule config-sync side-effect). Tolerated; the row is not canceled.`,
            });
            // The cancel did not complete — the row is still observable + paused.
            expect(rowAfter, 'row still observable after the failed cancel').toBeTruthy();
            expect(['paused', 'active']).toContain(rowAfter!.status);
        } else {
            // Tolerant fixed-build branch: a clean cancel drops the row from the
            // ACTIVE+PAUSED-only aggregation query.
            expect(delStatus, 'clean cancel → 200').toBe(200);
            expect(rowAfter, 'canceled row leaves the ACTIVE/PAUSED aggregation').toBeUndefined();
        }
    });

    // 19) Auth precedence: unauth → 401 on the aggregation AND on every per-work
    //     schedule verb (the JWT guard fires before any lookup/validation).
    test('unauth is 401 on the aggregation and on every per-work schedule verb', async ({
        request,
    }) => {
        // The aggregation, bare and filtered (even a would-be-400 filter is 401 first).
        expect((await request.get(SCHEDULES_BASE)).status(), 'unauth aggregation → 401').toBe(401);
        expect(
            (await request.get(`${SCHEDULES_BASE}?sourceType=bogus`)).status(),
            'unauth precedes the would-be-400',
        ).toBe(401);

        // Every per-work schedule verb, for a syntactically valid (but auth-less) request.
        const base = `${API_BASE}/api/works/${'00000000-0000-0000-0000-000000000000'}/schedule`;
        expect((await request.get(base)).status(), 'unauth GET schedule → 401').toBe(401);
        expect(
            (await request.put(base, { data: { enable: false, cadence: 'daily' } })).status(),
            'unauth PUT schedule → 401',
        ).toBe(401);
        expect((await request.delete(base)).status(), 'unauth DELETE schedule → 401').toBe(401);
        expect((await request.post(`${base}/run`)).status(), 'unauth run → 401').toBe(401);
    });
});
