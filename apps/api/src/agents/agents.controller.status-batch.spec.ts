// Short-circuit the transitive `@ever-works/agent/*` import chain so the
// test doesn't pull `@src/entities` (which only resolves inside apps/api)
// through `packages/agent/src/database/repositories/...`. Mirrors the
// pattern `agents.controller.pause.spec.ts` uses.
jest.mock('@ever-works/agent/agents', () => ({
    __esModule: true,
    AGENT_HEARTBEAT_TRIGGER: 'AGENT_HEARTBEAT_TRIGGER',
    AGENT_RUN_CANCELLER: 'AGENT_RUN_CANCELLER',
    AGENT_FILE_NAMES: ['SOUL.md', 'AGENTS.md', 'HEARTBEAT.md', 'TOOLS.md', 'agent.yml'],
    AgentScope: { TENANT: 'tenant', MISSION: 'mission', IDEA: 'idea', WORK: 'work' },
    AgentStatus: {
        DRAFT: 'draft',
        ACTIVE: 'active',
        RUNNING: 'running',
        PAUSED: 'paused',
        ERROR: 'error',
        ARCHIVED: 'archived',
    },
    AgentHaltReason: {
        USER: 'user',
        CREDENTIAL: 'credential',
        FAILURES: 'failures',
        CAP: 'cap',
        PLATFORM: 'platform',
    },
    QUEUED_REASON_AGENT_PAUSED: 'agent-paused',
    AgentIdleBehavior: { PROPOSE: 'propose', NOOP: 'noop', OBSERVE: 'observe' },
    AgentAvatarMode: { INITIALS: 'initials', ICON: 'icon', IMAGE: 'image' },
    AGENT_PERMISSIONS_DEFAULT: {},
    AgentsService: class {},
    AgentFileService: class {},
    AgentExportService: class {},
    AgentHaltService: class {},
    AgentScheduleDispatcherService: class {},
    AgentRunRepository: class {},
    AgentRunLogRepository: class {},
    RunDispatchGateService: class {},
    RunSteeringService: class {},
    SkillBindingRepository: class {},
    PluginUsageRepository: class {},
}));
jest.mock('@ever-works/agent/tasks-domain', () => ({
    __esModule: true,
    AGENT_TASK_EXECUTE_DISPATCHER: 'AGENT_TASK_EXECUTE_DISPATCHER',
    TasksService: class {},
}));
jest.mock('@ever-works/agent/activity-log', () => ({
    __esModule: true,
    ActivityActionType: {
        AGENT_PAUSED: 'agent_paused',
        AGENT_RESUMED: 'agent_resumed',
        AGENT_UNARCHIVED: 'agent_unarchived',
        AGENT_RUN_TRIGGERED: 'agent_run_triggered',
        AGENT_RUN_CANCELLED: 'agent_run_cancelled',
        AGENT_TASK_ASSIGNED: 'agent_task_assigned',
        AGENT_RUN_HELD: 'agent_run_held',
        AGENT_RUNS_RELEASED: 'agent_runs_released',
        AGENT_BLOCKED_ON_CREDENTIAL: 'agent_blocked_on_credential',
        AGENT_CREATED: 'agent_created',
        AGENT_ARCHIVED: 'agent_archived',
        AGENT_EXPORTED: 'agent_exported',
        AGENT_IMPORTED: 'agent_imported',
        AGENT_BUDGET_EXCEEDED: 'agent_budget_exceeded',
        AGENT_COLLABORATOR_ENABLED: 'agent_collaborator_enabled',
        AGENT_COLLABORATOR_DISABLED: 'agent_collaborator_disabled',
        AGENT_COLLABORATOR_REMOVED: 'agent_collaborator_removed',
        AGENT_COMPUTER_CONTROLLED: 'agent_computer_controlled',
    },
    ActivityStatus: { COMPLETED: 'completed' },
}));

import { BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { AGENT_STATUS_BATCH_MAX } from '@ever-works/contracts';
import { AgentsController } from './agents.controller';

/* eslint-disable @typescript-eslint/no-explicit-any */

const uuid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

/**
 * AW-23 — the three read surfaces behind "why is this agent not working?".
 *
 * What these cases defend:
 *
 *  1. **A roster poll is ONE request, and one query.** Sixty agents on
 *     screen refreshing every ten seconds must not become six requests a
 *     second; the endpoint takes a list and the repository is asked once.
 *  2. **The batch never becomes an existence oracle.** An id the caller
 *     does not own is simply absent from the answer — it does not 404 the
 *     whole poll, and it does not confirm that someone else's agent exists.
 *  3. **Over the cap the request is REFUSED, not truncated.** A caller
 *     must never believe it polled more agents than it did.
 *  4. **Route ordering.** `GET /api/agents/status` is a static segment
 *     declared above `@Get(':id')`. If that ever flips, every poll turns
 *     into a lookup for an agent whose id is the literal string "status" —
 *     a 404 with no obvious cause. Pinned here as a declaration-order
 *     assertion so a reorder fails the suite instead of production.
 *  5. **The card reads in one round trip, and a missing input degrades one
 *     row rather than the response.**
 */
describe('AgentsController — the status batch, the identity card and held work (AW-23)', () => {
    const auth = { userId: 'u1' } as any;
    const agentId = uuid(1);

    const AGENT_DTO = {
        id: agentId,
        userId: 'u1',
        name: 'research-agent',
        slug: 'research-agent',
        title: 'Senior researcher',
        status: 'paused',
        errorCount: 0,
        haltReason: 'user',
        haltNote: 'Waiting on the new contract',
        haltedAt: new Date('2026-09-01T10:00:00.000Z'),
        haltedRunId: null,
        haltDetail: null,
        haltRepeatCount: 1,
        lastRunAt: new Date('2026-08-31T09:00:00.000Z'),
        nextHeartbeatAt: null,
        avatarMode: 'initials',
        avatarIcon: null,
    };

    let service: any;
    let agentRuns: any;
    let identity: any;
    let scopeContext: any;

    const makeController = (over: { identity?: any; scopeContext?: any } = {}) =>
        new AgentsController(
            service,
            {} as any,
            {} as any,
            { dispatchOne: jest.fn() } as any,
            agentRuns,
            {} as any,
            {} as any,
            {} as any,
            { getOne: jest.fn() } as any,
            { log: jest.fn() } as any,
            { enqueue: jest.fn() } as any,
            { enqueue: jest.fn() } as any,
            undefined,
            undefined,
            undefined,
            undefined,
            'scopeContext' in over ? over.scopeContext : scopeContext,
            undefined,
            'identity' in over ? over.identity : identity,
        );

    beforeEach(() => {
        service = {
            getOne: jest.fn().mockResolvedValue({ ...AGENT_DTO }),
            findStatusRows: jest.fn().mockResolvedValue([{ ...AGENT_DTO }]),
        };
        agentRuns = {};
        identity = {
            buildStatus: jest.fn().mockImplementation((row: any) => ({
                agentId: row.id,
                reason: 'pausedByYou',
                inFlightCount: 0,
                heldCount: 0,
            })),
            build: jest.fn().mockResolvedValue({
                agent: { id: agentId },
                status: { agentId, reason: 'pausedByYou', inFlightCount: 0, heldCount: 0 },
                level: { value: null, driftCount: 0, readiness: null },
                notesPreview: null,
                personalityPreview: null,
                workingOn: null,
                nextRunAt: null,
            }),
            listHeld: jest.fn().mockResolvedValue({ total: 0, items: [] }),
        };
        scopeContext = { getScope: jest.fn().mockReturnValue(undefined) };
    });

    describe('GET /status — the batched roster read', () => {
        it('asks the repository ONCE for the whole visible page', async () => {
            service.findStatusRows.mockResolvedValue([
                { ...AGENT_DTO, id: uuid(1) },
                { ...AGENT_DTO, id: uuid(2) },
                { ...AGENT_DTO, id: uuid(3) },
            ]);

            const result = await makeController().getStatuses(auth, {
                ids: [uuid(1), uuid(2), uuid(3)].join(','),
            } as any);

            expect(service.findStatusRows).toHaveBeenCalledTimes(1);
            expect(service.findStatusRows).toHaveBeenCalledWith(
                'u1',
                [uuid(1), uuid(2), uuid(3)],
                undefined,
            );
            expect(result.statuses.map((s) => s.agentId)).toEqual([uuid(1), uuid(2), uuid(3)]);
        });

        it(`accepts exactly ${AGENT_STATUS_BATCH_MAX} ids`, async () => {
            const ids = Array.from({ length: AGENT_STATUS_BATCH_MAX }, (_, i) => uuid(i + 1));
            service.findStatusRows.mockResolvedValue(ids.map((id) => ({ ...AGENT_DTO, id })));

            const result = await makeController().getStatuses(auth, { ids: ids.join(',') } as any);

            expect(service.findStatusRows).toHaveBeenCalledTimes(1);
            expect(result.statuses).toHaveLength(AGENT_STATUS_BATCH_MAX);
        });

        it(`REFUSES ${AGENT_STATUS_BATCH_MAX + 1} ids rather than silently truncating`, async () => {
            const ids = Array.from({ length: AGENT_STATUS_BATCH_MAX + 1 }, (_, i) => uuid(i + 1));

            await expect(
                makeController().getStatuses(auth, { ids: ids.join(',') } as any),
            ).rejects.toBeInstanceOf(BadRequestException);
            expect(service.findStatusRows).not.toHaveBeenCalled();
        });

        it('de-duplicates before measuring, so a repeated id is not a rejection', async () => {
            const ids = Array.from({ length: AGENT_STATUS_BATCH_MAX + 5 }, () => uuid(1));

            const result = await makeController().getStatuses(auth, { ids: ids.join(',') } as any);

            expect(service.findStatusRows).toHaveBeenCalledWith('u1', [uuid(1)], undefined);
            expect(result.statuses).toHaveLength(1);
        });

        it("filters another user's ids OUT instead of 404-ing the whole batch", async () => {
            // The repository is owner-bounded, so a foreign id simply has
            // no row. The poll degrades to a shorter list.
            service.findStatusRows.mockResolvedValue([{ ...AGENT_DTO, id: uuid(1) }]);

            const result = await makeController().getStatuses(auth, {
                ids: [uuid(1), uuid(99)].join(','),
            } as any);

            expect(result.statuses.map((s) => s.agentId)).toEqual([uuid(1)]);
        });

        it('tolerates blank segments and whitespace in the id list', async () => {
            await makeController().getStatuses(auth, {
                ids: ` ${uuid(1)} , , ${uuid(2)},`,
            } as any);

            expect(service.findStatusRows).toHaveBeenCalledWith(
                'u1',
                [uuid(1), uuid(2)],
                undefined,
            );
        });

        it('is an empty list, not an error, when every id is blank', async () => {
            const result = await makeController().getStatuses(auth, { ids: ' , ,' } as any);

            expect(result).toEqual({ statuses: [] });
            expect(service.findStatusRows).not.toHaveBeenCalled();
        });

        it('threads the ownership scope through so a scoped roster stays scoped', async () => {
            const scoped = { getScope: jest.fn().mockReturnValue({ kind: 'organization' }) };

            await makeController({ scopeContext: scoped }).getStatuses(auth, {
                ids: uuid(1),
            } as any);

            expect(service.findStatusRows).toHaveBeenCalledWith('u1', [uuid(1)], {
                kind: 'organization',
            });
        });
    });

    describe('route ordering', () => {
        /**
         * `GET /api/agents/status` MUST be declared before `GET /api/agents/:id`.
         * Nest matches in declaration order; below `:id` every poll becomes a
         * lookup for the agent whose id is the string "status".
         */
        it('declares `status` above the `:id` parameter route', () => {
            const source = AgentsController.prototype as unknown as Record<string, unknown>;
            const order = Object.getOwnPropertyNames(source);
            expect(order.indexOf('getStatuses')).toBeGreaterThan(-1);
            expect(order.indexOf('getOne')).toBeGreaterThan(-1);
            expect(order.indexOf('getStatuses')).toBeLessThan(order.indexOf('getOne'));
        });
    });

    describe('GET :id/identity', () => {
        it('checks access through the service, then composes in ONE call', async () => {
            const result = await makeController().getIdentity(auth, agentId);

            expect(service.getOne).toHaveBeenCalledWith('u1', agentId, undefined);
            expect(identity.build).toHaveBeenCalledTimes(1);
            expect(result.status.reason).toBe('pausedByYou');
        });

        it('404s for another user before any composition happens', async () => {
            const notFound = new Error('Agent not found');
            service.getOne.mockRejectedValue(notFound);

            await expect(makeController().getIdentity(auth, agentId)).rejects.toBe(notFound);
            expect(identity.build).not.toHaveBeenCalled();
        });

        it('reports that it is unavailable rather than inventing a card', async () => {
            await expect(
                makeController({ identity: undefined }).getIdentity(auth, agentId),
            ).rejects.toBeInstanceOf(InternalServerErrorException);
        });
    });

    describe('GET :id/held', () => {
        it('lists held work in the order a Resume will release it', async () => {
            identity.listHeld.mockResolvedValue({
                total: 3,
                items: [
                    { runId: 'r1', kind: 'task', title: 'Draft the brief', heldAt: 'a' },
                    { runId: 'r2', kind: 'chat', title: null, heldAt: 'b' },
                ],
            });

            const result = await makeController().listHeld(auth, agentId, { limit: 2 } as any);

            expect(service.getOne).toHaveBeenCalledWith('u1', agentId, undefined);
            expect(identity.listHeld).toHaveBeenCalledWith(agentId, 2);
            expect(result.total).toBe(3);
            expect(result.items).toHaveLength(2);
        });

        it('degrades to nothing held rather than failing when unbound', async () => {
            const result = await makeController({ identity: undefined }).listHeld(
                auth,
                agentId,
                {} as any,
            );

            expect(result).toEqual({ total: 0, items: [] });
        });

        it('still enforces access for another user', async () => {
            const notFound = new Error('Agent not found');
            service.getOne.mockRejectedValue(notFound);

            await expect(makeController().listHeld(auth, agentId, {} as any)).rejects.toBe(
                notFound,
            );
            expect(identity.listHeld).not.toHaveBeenCalled();
        });
    });
});
