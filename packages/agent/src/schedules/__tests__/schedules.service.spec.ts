import { SchedulesService } from '../schedules.service';
import { AgentStatus } from '../../entities/agent.entity';
import { MissionType, MissionStatus } from '../../entities/mission.entity';
import { WorkScheduleStatus, WorkScheduleCadence } from '../../entities/types';

function makeRepo(rows: unknown[]) {
    return {
        find: jest.fn().mockResolvedValue(rows),
    };
}

function makeWorkScheduleRepo(rows: unknown[]) {
    const qb = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(rows),
    };
    return { createQueryBuilder: jest.fn().mockReturnValue(qb), _qb: qb };
}

/**
 * A repository that behaves like the database for the options the service
 * sends: it honours `take`, `order: { id: 'ASC' }` and an `id > afterId`
 * keyset, and nothing else. `rows` is read live, so a test can change it
 * between two batches.
 */
function makeKeysetRepo(rows: Array<{ id: string }>) {
    return {
        find: jest.fn(
            async (opts: {
                where?: { id?: { value?: string } };
                order?: { id?: 'ASC' };
                take?: number;
            }) => {
                let out = [...rows];
                if (opts?.order?.id === 'ASC') out.sort((a, b) => a.id.localeCompare(b.id));
                const afterId = opts?.where?.id?.value;
                if (afterId) out = out.filter((row) => row.id > afterId);
                return out.slice(0, opts?.take ?? out.length);
            },
        ),
    };
}

const SCOPE = { userId: 'user-1', organizationId: null };

describe('SchedulesService', () => {
    it('aggregates all seven sources into a unified sorted read-model', async () => {
        const now = new Date('2026-07-18T08:00:00.000Z');
        jest.useFakeTimers().setSystemTime(now);

        const taskRepo = makeRepo([
            {
                id: 'task-1',
                title: 'Weekly report',
                recurrenceRule: 'FREQ=WEEKLY',
                nextOccurrenceAt: new Date('2026-07-20T09:00:00.000Z'),
                recurrenceEndsAt: null,
                recurrenceMaxOccurrences: null,
                recurrenceOccurredCount: 2,
            },
        ]);
        // 'manual' heartbeats are excluded at the DB layer now (WHERE
        // heartbeatCadence IS NOT NULL AND != 'manual'), so the mocked repo
        // returns only the scheduled agent — mirroring the real query result.
        const agentRepo = makeRepo([
            {
                id: 'agent-1',
                name: 'Nightly agent',
                heartbeatCadence: '0 9 * * *',
                nextHeartbeatAt: new Date('2026-07-18T09:00:00.000Z'),
                lastRunAt: new Date('2026-07-17T09:00:00.000Z'),
                lastRunStatus: 'completed',
                status: AgentStatus.ACTIVE,
            },
        ]);
        const workScheduleRepo = makeWorkScheduleRepo([
            {
                workId: 'work-1',
                work: { id: 'work-1', name: 'Directory A' },
                cadence: WorkScheduleCadence.DAILY,
                nextRunAt: new Date('2026-07-18T12:00:00.000Z'),
                lastRunAt: null,
                lastRunStatus: null,
                status: WorkScheduleStatus.ACTIVE,
            },
        ]);
        const missionRepo = makeRepo([
            {
                id: 'mission-1',
                title: 'Growth mission',
                schedule: '0 10 * * *',
                type: MissionType.SCHEDULED,
                status: MissionStatus.ACTIVE,
            },
        ]);
        const workRepo = {
            find: jest
                .fn()
                // source_validation query
                .mockResolvedValueOnce([
                    {
                        id: 'work-2',
                        name: 'Directory B',
                        sourceValidationEnabled: true,
                        sourceValidationCadence: WorkScheduleCadence.WEEKLY,
                        sourceValidationNextRunAt: new Date('2026-07-25T00:00:00.000Z'),
                        sourceValidationLastRunAt: null,
                    },
                ])
                // data_sync query
                .mockResolvedValueOnce([
                    {
                        id: 'work-3',
                        name: 'Directory C',
                        syncIntervalMinutes: 5,
                        lastPolledAt: new Date('2026-07-18T07:58:00.000Z'),
                    },
                ]),
        };
        const inboundTriggerRepo = makeRepo([
            {
                id: 'trigger-1',
                name: 'CRM lead created',
                status: 'active',
                targetAgentId: 'agent-7',
                lastFiredAt: new Date('2026-07-17T22:00:00.000Z'),
                fireCount: 12,
            },
        ]);

        const service = new SchedulesService(
            taskRepo as never,
            agentRepo as never,
            workScheduleRepo as never,
            missionRepo as never,
            workRepo as never,
            inboundTriggerRepo as never,
        );

        const views = await service.getSchedules(SCOPE);

        // One row per source → 7 rows.
        expect(views).toHaveLength(7);
        const bySource = Object.fromEntries(views.map((v) => [v.sourceType, v]));

        // The 'manual' exclusion is pushed into the heartbeat query so the
        // MAX_PER_SOURCE limit counts only real scheduled heartbeats.
        expect(agentRepo.find.mock.calls[0][0].where.heartbeatCadence).toBeDefined();

        expect(bySource.recurring_task.ownerLink).toBe('/tasks/task-1');
        expect(bySource.recurring_task.cadenceHuman.toLowerCase()).toContain('week');
        expect(bySource.agent_heartbeat.ownerId).toBe('agent-1');
        expect(bySource.agent_heartbeat.enabled).toBe(true);
        expect(bySource.work_schedule.ownerLink).toBe('/works/work-1/generator/schedule');
        // Mission has no persisted next-run — it is computed from the cron.
        expect(bySource.mission_tick.nextRunAt).toBe('2026-07-18T10:00:00.000Z');
        expect(bySource.mission_tick.lastRunAt).toBeNull();
        expect(bySource.source_validation.ownerLink).toBe('/works/work-2');
        expect(bySource.data_sync.cadenceHuman).toBe('Every 5 minutes');
        // Inbound triggers are event-driven: fixed 'On event' cadence, no
        // next-run, lastFiredAt surfaces as lastRunAt, agent owner reuse.
        expect(bySource.inbound_trigger.cadenceHuman).toBe('On event');
        expect(bySource.inbound_trigger.nextRunAt).toBeNull();
        expect(bySource.inbound_trigger.lastRunAt).toBe('2026-07-17T22:00:00.000Z');
        expect(bySource.inbound_trigger.ownerType).toBe('agent');
        expect(bySource.inbound_trigger.ownerId).toBe('agent-7');
        expect(bySource.inbound_trigger.ownerLink).toBe('/agents/agent-7');
        expect(bySource.inbound_trigger.enabled).toBe(true);

        // Sorted ascending by nextRunAt with nulls last.
        const order = views.map((v) => v.nextRunAt);
        const nonNull = order.filter((v): v is string => v !== null);
        const sorted = [...nonNull].sort((a, b) => a.localeCompare(b));
        expect(nonNull).toEqual(sorted);

        jest.useRealTimers();
    });

    it('applies the scope predicate (org IS NULL for personal scope)', async () => {
        const taskRepo = makeRepo([]);
        const agentRepo = makeRepo([]);
        const missionRepo = makeRepo([]);
        const workRepo = { find: jest.fn().mockResolvedValue([]) };
        const workScheduleRepo = makeWorkScheduleRepo([]);
        const inboundTriggerRepo = makeRepo([]);

        const service = new SchedulesService(
            taskRepo as never,
            agentRepo as never,
            workScheduleRepo as never,
            missionRepo as never,
            workRepo as never,
            inboundTriggerRepo as never,
        );

        await service.getSchedules({ userId: 'user-9', organizationId: null });

        const taskWhere = taskRepo.find.mock.calls[0][0].where;
        expect(taskWhere.userId).toBe('user-9');
        // IsNull() is an object with a `@instanceof` marker — assert it is not a bare value.
        expect(taskWhere.organizationId).toBeDefined();
        expect(workScheduleRepo._qb.andWhere).toHaveBeenCalledWith('ws.organizationId IS NULL');
        // Inbound triggers share the same scope predicate.
        const triggerWhere = inboundTriggerRepo.find.mock.calls[0][0].where;
        expect(triggerWhere.userId).toBe('user-9');
        expect(triggerWhere.organizationId).toBeDefined();
    });

    it('projects agent-less inbound triggers as their own trigger owner (paused → disabled-by-filter)', async () => {
        const inboundTriggerRepo = makeRepo([
            {
                id: 'trigger-2',
                name: 'Standalone hook',
                status: 'paused',
                targetAgentId: null,
                lastFiredAt: null,
                fireCount: 0,
            },
        ]);
        const service = new SchedulesService(
            makeRepo([]) as never,
            makeRepo([]) as never,
            makeWorkScheduleRepo([]) as never,
            makeRepo([]) as never,
            { find: jest.fn().mockResolvedValue([]) } as never,
            inboundTriggerRepo as never,
        );

        const views = await service.getSchedules(SCOPE);
        expect(views).toHaveLength(1);
        const row = views[0];
        expect(row.id).toBe('inbound_trigger:trigger-2');
        expect(row.ownerType).toBe('trigger');
        expect(row.ownerId).toBe('trigger-2');
        expect(row.ownerLink).toBe('/activity?view=schedules');
        expect(row.status).toBe('paused');
        expect(row.enabled).toBe(false);
        expect(row.lastRunAt).toBeNull();

        const enabledOnly = await service.getSchedules(SCOPE, { enabledOnly: true });
        expect(enabledOnly).toHaveLength(0);
    });

    it('filters by sourceType and enabledOnly', async () => {
        const taskRepo = makeRepo([
            {
                id: 'task-ended',
                title: 'Done task',
                recurrenceRule: 'FREQ=DAILY',
                nextOccurrenceAt: null,
                recurrenceEndsAt: null,
                recurrenceMaxOccurrences: 3,
                recurrenceOccurredCount: 3,
            },
        ]);
        const service = new SchedulesService(
            taskRepo as never,
            makeRepo([]) as never,
            makeWorkScheduleRepo([]) as never,
            makeRepo([]) as never,
            { find: jest.fn().mockResolvedValue([]) } as never,
            makeRepo([]) as never,
        );

        const all = await service.getSchedules(SCOPE, { sourceType: 'recurring_task' });
        expect(all).toHaveLength(1);
        expect(all[0].status).toBe('ended');
        expect(all[0].enabled).toBe(false);

        const enabledOnly = await service.getSchedules(SCOPE, {
            sourceType: 'recurring_task',
            enabledOnly: true,
        });
        expect(enabledOnly).toHaveLength(0);
    });

    // Schedule-modes upgrade — a recurring Task may carry EITHER an RRULE
    // or a 5-field cron (XOR). Reading only `recurrenceRule` rendered the
    // cron dialect with a blank cadence on this page.
    it('renders the cron cadence of a cron-recurring Task', async () => {
        const taskRepo = makeRepo([
            {
                id: 'task-cron',
                title: 'Monday standup',
                recurrenceRule: null,
                recurrenceCron: '0 9 * * 1',
                nextOccurrenceAt: new Date('2026-07-20T09:00:00.000Z'),
                recurrenceEndsAt: null,
                recurrenceMaxOccurrences: null,
                recurrenceOccurredCount: 0,
            },
        ]);
        const service = new SchedulesService(
            taskRepo as never,
            makeRepo([]) as never,
            makeWorkScheduleRepo([]) as never,
            makeRepo([]) as never,
            { find: jest.fn().mockResolvedValue([]) } as never,
            makeRepo([]) as never,
        );

        const views = await service.getSchedules(SCOPE, { sourceType: 'recurring_task' });
        expect(views).toHaveLength(1);
        expect(views[0].cadenceRaw).toBe('0 9 * * 1');
        expect(views[0].cadenceHuman).toBe('Every Monday at 09:00');
    });

    it('still renders the RRULE cadence when that is the dialect in use', async () => {
        const taskRepo = makeRepo([
            {
                id: 'task-rrule',
                title: 'Weekly report',
                recurrenceRule: 'FREQ=WEEKLY',
                recurrenceCron: null,
                nextOccurrenceAt: new Date('2026-07-20T09:00:00.000Z'),
                recurrenceEndsAt: null,
                recurrenceMaxOccurrences: null,
                recurrenceOccurredCount: 0,
            },
        ]);
        const service = new SchedulesService(
            taskRepo as never,
            makeRepo([]) as never,
            makeWorkScheduleRepo([]) as never,
            makeRepo([]) as never,
            { find: jest.fn().mockResolvedValue([]) } as never,
            makeRepo([]) as never,
        );

        const views = await service.getSchedules(SCOPE, { sourceType: 'recurring_task' });
        expect(views[0].cadenceRaw).toBe('FREQ=WEEKLY');
        expect(views[0].cadenceHuman.toLowerCase()).toContain('week');
    });
});

// ── Schedules workspace — paging, attribution, health, controls ──────────

function emptyService(
    over: {
        tasks?: unknown[];
        agents?: unknown[];
        agentRepo?: { find: jest.Mock };
        missions?: unknown[];
        triggers?: unknown[];
        assignees?: unknown[];
    } = {},
) {
    return new SchedulesService(
        makeRepo(over.tasks ?? []) as never,
        (over.agentRepo ?? makeRepo(over.agents ?? [])) as never,
        makeWorkScheduleRepo([]) as never,
        makeRepo(over.missions ?? []) as never,
        { find: jest.fn().mockResolvedValue([]) } as never,
        makeRepo(over.triggers ?? []) as never,
        over.assignees ? (makeRepo(over.assignees) as never) : undefined,
    );
}

function recurringTask(id: string, over: Record<string, unknown> = {}) {
    return {
        id,
        title: id,
        recurrenceCron: '0 7 * * *',
        recurrenceRule: null,
        nextOccurrenceAt: new Date('2026-09-15T07:00:00.000Z'),
        recurrenceEndsAt: null,
        recurrenceMaxOccurrences: null,
        recurrenceOccurredCount: 0,
        agentId: null,
        ...over,
    };
}

function manyTriggers(count: number) {
    return Array.from({ length: count }, (_, index) => {
        const n = String(index).padStart(3, '0');
        return {
            id: 'trigger-' + n,
            name: 'Hook ' + n,
            status: index % 3 === 0 ? 'paused' : 'active',
            targetAgentId: null,
            lastFiredAt: null,
        };
    });
}

describe('SchedulesService — workspace additions', () => {
    const now = new Date('2026-09-14T08:00:00.000Z');
    beforeEach(() => jest.useFakeTimers().setSystemTime(now));
    afterEach(() => jest.useRealTimers());

    /**
     * The workspace additions (agent, health, controls, pausedAt, reason) are
     * served by the PAGE read, so the tests below ask the surface that serves
     * them. They used to read `getSchedules`, which carried the fields only
     * because a row built for the workspace was being handed to the flat list
     * by reference — the defect these tests now sit beside.
     */
    const workspaceRow = async (
        service: SchedulesService,
        filters: Parameters<SchedulesService['getPage']>[1] = {},
    ) => (await service.getPage(SCOPE, filters)).items;

    it('getSchedules still returns a bare array whose original keys are all present', async () => {
        const service = emptyService({ triggers: manyTriggers(1) });
        const views = await service.getSchedules(SCOPE);
        expect(Array.isArray(views)).toBe(true);
        for (const key of [
            'id',
            'sourceType',
            'ownerType',
            'ownerId',
            'ownerName',
            'ownerLink',
            'cadenceRaw',
            'cadenceHuman',
            'nextRunAt',
            'lastRunAt',
            'lastRunStatus',
            'status',
            'enabled',
        ]) {
            expect(views[0]).toHaveProperty(key);
        }
        // …and NOTHING else. This assertion used to say the opposite — that the
        // flat list also carried the workspace additions — which is what let
        // `health.checkedAt` (a `new Date()` per request) into a read-model that
        // two end-to-end specs assert is byte-identical across two GETs with no
        // write between them. The workspace reads them from `/page`.
        expect(Object.keys(views[0]!).sort()).toEqual(
            [
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
            ].sort(),
        );
    });

    it('serves the workspace additions on the page read, where the workspace asks for them', async () => {
        const service = emptyService({ triggers: manyTriggers(1) });
        const page = await service.getPage(SCOPE, {});
        const item = page.items[0]!;
        expect(item.health).toMatchObject({ ok: true });
        expect(item.controls).toMatchObject({ runNow: false, resume: true });
    });

    it('returns an identical flat row for two reads with no write between them', async () => {
        // The invariant the e2e specs assert, pinned here where it is cheap to
        // run: the flat list is a projection of stored state, so nothing in it
        // may be derived from the current clock.
        const service = emptyService({ triggers: manyTriggers(1) });
        const before = await service.getSchedules(SCOPE);
        jest.setSystemTime(new Date(now.getTime() + 60_000));
        const after = await service.getSchedules(SCOPE);
        expect(after).toEqual(before);
    });

    it('a paused recurring Task keeps its cadence, reads paused, and is not flagged', async () => {
        const service = emptyService({
            tasks: [
                recurringTask('task-p', {
                    title: 'Morning inbox scan',
                    recurrenceOccurredCount: 4,
                    recurrencePausedAt: new Date('2026-09-13T12:00:00.000Z'),
                }),
            ],
        });
        const [view] = await workspaceRow(service);
        expect(view).toMatchObject({
            status: 'paused',
            enabled: false,
            cadenceRaw: '0 7 * * *',
            cadenceHuman: 'Every day at 07:00',
            nextRunAt: null,
            nextRunReasonKey: 'paused',
            pausedAt: '2026-09-13T12:00:00.000Z',
        });
        // Paused is a choice, not a defect — even with no Agent.
        expect(view.health?.ok).toBe(true);
        expect(view.controls).toMatchObject({ pause: false, resume: true });
        // …and Home's enabledOnly read drops it like any other inactive row.
        expect(await service.getSchedules(SCOPE, { enabledOnly: true })).toHaveLength(0);
    });

    it('attributes a recurring Task to its agent assignee, then to its own agentId', async () => {
        const agentRepo = {
            find: jest.fn().mockResolvedValue([
                { id: 'agent-a', name: 'Inbox agent', status: 'active' },
                { id: 'agent-b', name: 'Analyst agent', status: 'active' },
            ]),
        };
        const service = emptyService({
            tasks: [
                recurringTask('assigned', { agentId: 'agent-b' }),
                recurringTask('own', { agentId: 'agent-b' }),
                recurringTask('none'),
            ],
            agentRepo,
            assignees: [{ taskId: 'assigned', assigneeType: 'agent', assigneeId: 'agent-a' }],
        });
        const views = await workspaceRow(service, { sourceType: 'recurring_task' });
        const byId = Object.fromEntries(views.map((v) => [v.ownerId, v]));
        expect(byId.assigned).toMatchObject({ agentId: 'agent-a', agentName: 'Inbox agent' });
        expect(byId.own).toMatchObject({ agentId: 'agent-b', agentName: 'Analyst agent' });
        expect(byId.none).toMatchObject({ agentId: null });
        expect(byId.none.health).toMatchObject({ ok: false, reason: 'no-agent' });
        expect(byId.none.controls?.disabledReasons.runNow).toBe('noAgent');
        // The Agent lookup is always scoped to the caller.
        const lookup = agentRepo.find.mock.calls.find((call) => call[0]?.where?.id);
        expect(lookup?.[0].where.userId).toBe('user-1');
    });

    it('flags a recurring Task whose only Agent is archived as owner-archived', async () => {
        const service = emptyService({
            tasks: [recurringTask('task-a', { agentId: 'agent-z' })],
            agents: [{ id: 'agent-z', name: 'Old agent', status: 'archived' }],
        });
        const [view] = await workspaceRow(service, { sourceType: 'recurring_task' });
        expect(view.health).toMatchObject({ ok: false, reason: 'owner-archived' });
    });

    it('does not flag the Agent as gone when the Agent lookup itself fails', async () => {
        const agentRepo = {
            find: jest
                .fn()
                .mockImplementation((opts: { where?: { id?: unknown } }) =>
                    opts?.where?.id ? Promise.reject(new Error('db down')) : Promise.resolve([]),
                ),
        };
        const service = emptyService({
            tasks: [recurringTask('task-u', { agentId: 'agent-q' })],
            agentRepo,
        });
        const [view] = await workspaceRow(service, { sourceType: 'recurring_task' });
        expect(view.health?.ok).toBe(true);
    });

    it('a paused heartbeat reads paused while its Agent stays active', async () => {
        const service = emptyService({
            agents: [
                {
                    id: 'agent-h',
                    name: 'Analyst',
                    heartbeatCadence: '*/15 * * * *',
                    nextHeartbeatAt: new Date('2026-09-14T08:15:00.000Z'),
                    heartbeatPausedAt: new Date('2026-09-14T07:00:00.000Z'),
                    lastRunAt: null,
                    lastRunStatus: null,
                    status: AgentStatus.ACTIVE,
                },
            ],
        });
        const [view] = await workspaceRow(service);
        expect(view).toMatchObject({
            sourceType: 'agent_heartbeat',
            status: 'paused',
            enabled: false,
            nextRunAt: null,
            cadenceRaw: '*/15 * * * *',
            agentId: 'agent-h',
            pausedAt: '2026-09-14T07:00:00.000Z',
        });
        expect(view.controls).toMatchObject({ runNow: true, pause: false, resume: true });
    });

    it('a completed Mission tick is Ended, never NEVER RUNS', async () => {
        const service = emptyService({
            missions: [
                {
                    id: 'mission-done',
                    title: 'Launch',
                    schedule: '0 9 * * *',
                    type: MissionType.SCHEDULED,
                    status: MissionStatus.COMPLETED,
                },
            ],
        });
        // Status is a flat-list field; health is a workspace one. Reading both
        // from the surface that serves each is the point of the split.
        const [flat] = await service.getSchedules(SCOPE);
        expect(flat!.status).toBe('ended');
        const [view] = await workspaceRow(service);
        expect(view!.health?.ok).toBe(true);
    });

    it('pages every row exactly once, 50 at a time, in a stable order', async () => {
        const service = emptyService({ triggers: manyTriggers(120) });
        const seen: string[] = [];
        let cursor: string | null = null;
        let pages = 0;
        do {
            const page = await service.getPage(SCOPE, {}, cursor);
            expect(page.items.length).toBeLessThanOrEqual(50);
            expect(page.total).toBe(120);
            seen.push(...page.items.map((item) => item.id));
            cursor = page.nextCursor;
            pages += 1;
        } while (cursor && pages < 10);
        expect(pages).toBe(3);
        expect(seen).toHaveLength(120);
        expect(new Set(seen).size).toBe(120);
    });

    it('caps a requested page size at 50 and treats a garbage cursor as the first page', async () => {
        const service = emptyService({ triggers: manyTriggers(60) });
        const page = await service.getPage(SCOPE, {}, 'not-a-cursor', 500);
        expect(page.items).toHaveLength(50);
        expect(page.items[0].ownerName).toBe('Hook 000');
    });

    it('applies status, health, agent and text filters and reports counts', async () => {
        const service = emptyService({ triggers: manyTriggers(9) });
        const paused = await service.getPage(SCOPE, { status: 'paused' });
        expect(paused.total).toBe(3);
        expect(paused.unfilteredTotal).toBe(9);
        expect(paused.countsByStatus.paused).toBe(3);
        expect(paused.countsBySourceType.inbound_trigger).toBe(3);
        // The pre-filter breakdown is the one a source picker can offer, and
        // it is unaffected by the status filter above.
        expect(paused.unfilteredCountsBySourceType.inbound_trigger).toBe(9);

        const text = await service.getPage(SCOPE, { q: 'hook 004' });
        expect(text.items.map((item) => item.id)).toEqual(['inbound_trigger:trigger-004']);

        const neverRuns = await service.getPage(SCOPE, { health: 'never-runs' });
        expect(neverRuns.total).toBe(0);
        expect(neverRuns.healthCounts).toEqual({ ok: 0, neverRuns: 0 });

        const byAgent = await service.getPage(SCOPE, { agentId: 'agent-x' });
        expect(byAgent.total).toBe(0);
    });

    it('keeps the pre-filter source breakdown complete while a source is selected', async () => {
        // The trap this field exists for: `countsBySourceType` is taken AFTER
        // `sourceType` is applied, so selecting one source zeroes every other
        // entry and a picker built on it collapses to a single usable chip.
        const service = emptyService({ triggers: manyTriggers(4) });
        const page = await service.getPage(SCOPE, { sourceType: 'inbound_trigger' });

        expect(page.countsBySourceType.inbound_trigger).toBe(4);
        expect(page.countsBySourceType.recurring_task).toBe(0);
        expect(page.unfilteredCountsBySourceType.inbound_trigger).toBe(4);
        // Every known source is present, so a picker never reads `undefined`.
        expect(Object.keys(page.unfilteredCountsBySourceType).sort()).toEqual(
            [
                'agent_heartbeat',
                'data_sync',
                'inbound_trigger',
                'mission_tick',
                'recurring_task',
                'source_validation',
                'work_schedule',
            ].sort(),
        );

        const none = await service.getPage(SCOPE, { sourceType: 'recurring_task' });
        expect(none.total).toBe(0);
        expect(none.unfilteredCountsBySourceType.inbound_trigger).toBe(4);
    });

    it('names a source whose query failed instead of blanking the page', async () => {
        const service = new SchedulesService(
            makeRepo([]) as never,
            makeRepo([]) as never,
            makeWorkScheduleRepo([]) as never,
            { find: jest.fn().mockRejectedValue(new Error('mission table down')) } as never,
            { find: jest.fn().mockResolvedValue([]) } as never,
            makeRepo(manyTriggers(2)) as never,
        );
        const page = await service.getPage(SCOPE);
        expect(page.degradedSources).toEqual(['mission_tick']);
        expect(page.items).toHaveLength(2);
        expect(page.generatedAt).toBe(now.toISOString());
    });

    it('health summary is a dry run listing every flagged row with its proposed repair', async () => {
        const taskRepo = makeRepo([
            recurringTask('feb30', {
                title: 'Month-end rollup',
                recurrenceCron: '0 18 30 2 *',
                nextOccurrenceAt: null,
                agentId: 'agent-a',
            }),
        ]);
        const service = new SchedulesService(
            taskRepo as never,
            {
                // Only the id lookup finds the Agent; the heartbeat query finds none.
                find: jest
                    .fn()
                    .mockImplementation((opts: { where?: { id?: unknown } }) =>
                        Promise.resolve(
                            opts?.where?.id
                                ? [{ id: 'agent-a', name: 'Finance', status: 'active' }]
                                : [],
                        ),
                    ),
            } as never,
            makeWorkScheduleRepo([]) as never,
            makeRepo([]) as never,
            { find: jest.fn().mockResolvedValue([]) } as never,
            makeRepo([]) as never,
        );
        const summary = await service.getHealthSummary(SCOPE);
        expect(summary.counts).toMatchObject({ neverRuns: 1, byReason: { 'impossible-date': 1 } });
        expect(summary.flagged).toEqual([
            expect.objectContaining({
                id: 'recurring_task:feb30',
                reason: 'impossible-date',
                reasonKey: 'impossibleDate',
                repair: 'automatic',
                before: '0 18 30 2 *',
                after: '0 18 28 2 *',
            }),
        ]);
        // Read-only: the only repository method the summary can reach is find.
        expect(Object.keys(taskRepo)).toEqual(['find']);

        const clean = await emptyService().getHealthSummary(SCOPE);
        expect(clean.counts.neverRuns).toBe(0);
        expect(clean.flagged).toEqual([]);
    });

    it('findOne resolves only the caller rows and returns null for anything else', async () => {
        const service = emptyService({ triggers: manyTriggers(1) });
        expect((await service.findOne(SCOPE, 'inbound_trigger:trigger-000'))?.ownerName).toBe(
            'Hook 000',
        );
        expect(await service.findOne(SCOPE, 'inbound_trigger:someone-else')).toBeNull();
    });
});

// ── Schedules workspace — every row is reachable past one query's worth ──

describe('SchedulesService — workspace reads are not capped at one source query', () => {
    const now = new Date('2026-09-14T08:00:00.000Z');
    beforeEach(() => jest.useFakeTimers().setSystemTime(now));
    afterEach(() => jest.useRealTimers());

    function serviceOver(
        triggerRepo: { find: jest.Mock },
        taskRepo?: unknown,
        assignees?: unknown,
    ) {
        return new SchedulesService(
            (taskRepo ?? makeRepo([])) as never,
            makeRepo([]) as never,
            makeWorkScheduleRepo([]) as never,
            makeRepo([]) as never,
            { find: jest.fn().mockResolvedValue([]) } as never,
            triggerRepo as never,
            assignees as never,
        );
    }

    it('pages, totals and counts all 501 rows of a source, and every cursor page is reachable', async () => {
        const triggerRepo = makeKeysetRepo(manyTriggers(501));
        const service = serviceOver(triggerRepo);

        const seen: string[] = [];
        let cursor: string | null = null;
        let pages = 0;
        do {
            const page = await service.getPage(SCOPE, {}, cursor);
            expect(page.total).toBe(501);
            expect(page.unfilteredTotal).toBe(501);
            expect(page.countsBySourceType.inbound_trigger).toBe(501);
            expect(page.countsByStatus.paused + page.countsByStatus.active).toBe(501);
            expect(page.healthCounts.ok).toBe(501);
            seen.push(...page.items.map((item) => item.id));
            cursor = page.nextCursor;
            pages += 1;
        } while (cursor && pages < 20);

        expect(pages).toBe(11);
        expect(new Set(seen).size).toBe(501);
        expect(seen).toContain('inbound_trigger:trigger-500');
        // Each read walked the source in id order, one bounded batch at a time.
        for (const [opts] of triggerRepo.find.mock.calls) {
            expect(opts.take).toBe(500);
            expect(opts.order).toEqual({ id: 'ASC' });
        }
    });

    it('resolves the 501st row for a control, and counts it in the health summary', async () => {
        const service = serviceOver(makeKeysetRepo(manyTriggers(501)));
        expect((await service.findOne(SCOPE, 'inbound_trigger:trigger-500'))?.ownerName).toBe(
            'Hook 500',
        );
        const summary = await service.getHealthSummary(SCOPE);
        expect(summary.counts.ok).toBe(501);
    });

    it('a row removed between two batches never makes the walk skip a row that is still there', async () => {
        const rows = manyTriggers(501);
        const triggerRepo = makeKeysetRepo(rows);
        const firstBatch = triggerRepo.find.getMockImplementation()!;
        triggerRepo.find.mockImplementationOnce(async (opts) => {
            const batch = await firstBatch(opts);
            rows.splice(0, 1); // trigger-000 is deleted while the walk is mid-way
            return batch;
        });
        const page = await serviceOver(triggerRepo).getPage(SCOPE, { q: 'hook 500' });
        expect(page.items.map((item) => item.id)).toEqual(['inbound_trigger:trigger-500']);
    });

    it('stops walking a repository that ignores the keyset instead of looping', async () => {
        const rows = manyTriggers(500);
        const triggerRepo = { find: jest.fn().mockResolvedValue(rows) };
        const page = await serviceOver(triggerRepo).getPage(SCOPE);
        expect(page.total).toBe(500);
        expect(triggerRepo.find).toHaveBeenCalledTimes(2);
    });

    it('keeps each IN list bounded when attributing more than one batch of recurring Tasks', async () => {
        const tasks = Array.from({ length: 501 }, (_, index) =>
            recurringTask('task-' + String(index).padStart(3, '0')),
        );
        const assignees = { find: jest.fn().mockResolvedValue([]) };
        const service = serviceOver(makeRepo([]), makeKeysetRepo(tasks), assignees);
        const page = await service.getPage(SCOPE, { sourceType: 'recurring_task' });
        expect(page.total).toBe(501);
        expect(assignees.find).toHaveBeenCalledTimes(2);
        for (const [opts] of assignees.find.mock.calls) {
            expect(opts.where.taskId.value.length).toBeLessThanOrEqual(500);
        }
    });

    it('leaves the flat getSchedules read exactly as it was — one query per source, capped', async () => {
        const triggerRepo = makeKeysetRepo(manyTriggers(501));
        const views = await serviceOver(triggerRepo).getSchedules(SCOPE);
        expect(views).toHaveLength(500);
        expect(triggerRepo.find).toHaveBeenCalledTimes(1);
        expect(triggerRepo.find.mock.calls[0][0]).toEqual({
            where: expect.objectContaining({ userId: 'user-1' }),
            take: 500,
        });
    });
});
