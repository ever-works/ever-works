import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AgentsService } from '../agents.service';
import { AgentRepository } from '../../database/repositories/agent.repository';
import { AgentStatus, type Agent } from '../../entities/agent.entity';

/**
 * Schedules — pause an Agent's heartbeat without pausing the Agent.
 *
 *  1. The heartbeat due-scan (the one every job runtime reaches through
 *     `AgentScheduleDispatcherService.dispatchDue`) skips a paused heartbeat
 *     and changes no other selection criterion.
 *  2. Pausing writes only `heartbeatPausedAt`: the Agent stays ACTIVE and its
 *     cadence and next slot survive, so assigned Task work is unaffected.
 */

describe('AgentRepository.findDueForHeartbeat — honours the heartbeat pause', () => {
    it('adds the pause predicate and keeps every other criterion', async () => {
        const qb = {
            where: jest.fn().mockReturnThis(),
            andWhere: jest.fn().mockReturnThis(),
            orderBy: jest.fn().mockReturnThis(),
            take: jest.fn().mockReturnThis(),
            getMany: jest.fn().mockResolvedValue([]),
        };
        const repository = new AgentRepository({ createQueryBuilder: jest.fn(() => qb) } as never);
        const now = new Date('2026-09-14T10:00:00Z');
        await repository.findDueForHeartbeat(10, now);

        expect(qb.where).toHaveBeenCalledWith('agent.status = :active', {
            active: AgentStatus.ACTIVE,
        });
        expect(qb.andWhere.mock.calls).toEqual([
            ['agent.heartbeatPausedAt IS NULL'],
            ['agent.heartbeatCadence IS NOT NULL'],
            ["agent.heartbeatCadence != 'manual'"],
            ['agent.nextHeartbeatAt IS NOT NULL'],
            ['agent.nextHeartbeatAt <= :now', { now }],
        ]);
        expect(qb.take).toHaveBeenCalledWith(10);
    });

    it('the CAS claim refuses an Agent whose heartbeat was paused after the scan', async () => {
        const qb = {
            update: jest.fn().mockReturnThis(),
            set: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            andWhere: jest.fn().mockReturnThis(),
            execute: jest.fn().mockResolvedValue({ affected: 1 }),
        };
        const inner = {
            findOne: jest.fn().mockResolvedValue({
                id: 'agent-1',
                status: AgentStatus.ACTIVE,
                nextHeartbeatAt: new Date('2026-09-14T09:45:00Z'),
                heartbeatPausedAt: new Date('2026-09-14T09:50:00Z'),
            }),
            createQueryBuilder: jest.fn(() => qb),
        };
        const repository = new AgentRepository(inner as never);
        expect(await repository.tryClaimForRun('agent-1')).toBeNull();
        expect(qb.execute).not.toHaveBeenCalled();

        inner.findOne.mockResolvedValueOnce({
            id: 'agent-1',
            status: AgentStatus.ACTIVE,
            nextHeartbeatAt: new Date('2026-09-14T09:45:00Z'),
            heartbeatPausedAt: null,
        });
        await repository.tryClaimForRun('agent-1');
        expect(qb.andWhere).toHaveBeenCalledWith('heartbeatPausedAt IS NULL');
    });
});

describe('AgentsService — heartbeat pause / resume', () => {
    function agentRow(over: Partial<Agent> = {}): Agent {
        return {
            id: 'agent-1',
            userId: 'user-1',
            name: 'Analyst',
            slug: 'analyst',
            status: AgentStatus.ACTIVE,
            heartbeatCadence: '*/15 * * * *',
            nextHeartbeatAt: new Date(Date.now() + 10 * 60_000),
            heartbeatPausedAt: null,
            permissions: {},
            errorCount: 0,
            pauseAfterFailures: 3,
            createdAt: new Date('2026-01-01T00:00:00Z'),
            updatedAt: new Date('2026-01-01T00:00:00Z'),
            ...over,
        } as Agent;
    }

    function build(agent: Agent | null) {
        let current = agent;
        const agents = {
            findByIdAndUser: jest.fn(async () => current),
            findById: jest.fn(async () => current),
            updateById: jest.fn(async (_id: string, patch: Partial<Agent>) => {
                current = { ...(current as Agent), ...patch } as Agent;
            }),
        };
        const service = new AgentsService(agents as never, {} as never, {} as never);
        return { service, agents, current: () => current };
    }

    it('pause writes only heartbeatPausedAt — status, cadence and next slot survive', async () => {
        const original = agentRow();
        const { service, agents, current } = build(original);
        const dto = await service.pauseHeartbeat('user-1', 'agent-1');

        expect(agents.updateById).toHaveBeenCalledTimes(1);
        expect(Object.keys(agents.updateById.mock.calls[0][1])).toEqual(['heartbeatPausedAt']);
        expect(current()?.status).toBe(AgentStatus.ACTIVE);
        expect(current()?.heartbeatCadence).toBe(original.heartbeatCadence);
        expect(current()?.nextHeartbeatAt).toEqual(original.nextHeartbeatAt);
        expect(dto.heartbeatPausedAt).toBeInstanceOf(Date);
        expect(dto.status).toBe(AgentStatus.ACTIVE);
    });

    it('pause is idempotent', async () => {
        const { service, agents } = build(agentRow({ heartbeatPausedAt: new Date() }));
        await service.pauseHeartbeat('user-1', 'agent-1');
        expect(agents.updateById).not.toHaveBeenCalled();
    });

    it('refuses to pause an Agent with no scheduled heartbeat', async () => {
        for (const heartbeatCadence of [null, 'manual']) {
            const { service, agents } = build(agentRow({ heartbeatCadence }));
            await expect(service.pauseHeartbeat('user-1', 'agent-1')).rejects.toBeInstanceOf(
                BadRequestException,
            );
            expect(agents.updateById).not.toHaveBeenCalled();
        }
    });

    it('a foreign or missing Agent is a 404', async () => {
        const { service } = build(null);
        await expect(service.pauseHeartbeat('user-2', 'agent-1')).rejects.toBeInstanceOf(
            NotFoundException,
        );
        await expect(service.resumeHeartbeat('user-2', 'agent-1')).rejects.toBeInstanceOf(
            NotFoundException,
        );
    });

    it('resume clears the pause and keeps a future next slot', async () => {
        const next = new Date(Date.now() + 5 * 60_000);
        const { service, agents } = build(
            agentRow({ heartbeatPausedAt: new Date(), nextHeartbeatAt: next }),
        );
        await service.resumeHeartbeat('user-1', 'agent-1');
        expect(agents.updateById).toHaveBeenCalledWith('agent-1', { heartbeatPausedAt: null });
    });

    it('resume moves a slot that fell due while paused to the next one after now', async () => {
        const { service, agents } = build(
            agentRow({
                heartbeatPausedAt: new Date('2026-01-01T00:00:00Z'),
                nextHeartbeatAt: new Date('2026-01-01T00:15:00Z'),
            }),
        );
        const before = Date.now();
        await service.resumeHeartbeat('user-1', 'agent-1');
        const patch = agents.updateById.mock.calls[0][1];
        expect(patch.heartbeatPausedAt).toBeNull();
        expect((patch.nextHeartbeatAt as Date).getTime()).toBeGreaterThan(before);
        expect((patch.nextHeartbeatAt as Date).getUTCMinutes() % 15).toBe(0);
    });

    it('resume on an un-paused heartbeat writes nothing', async () => {
        const { service, agents } = build(agentRow());
        await service.resumeHeartbeat('user-1', 'agent-1');
        expect(agents.updateById).not.toHaveBeenCalled();
    });
});
