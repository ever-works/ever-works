import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AgentRun, AgentRunStatus, AgentRunTriggerKind } from '../../entities/agent-run.entity';

@Injectable()
export class AgentRunRepository {
    constructor(
        @InjectRepository(AgentRun)
        private readonly repository: Repository<AgentRun>,
    ) {}

    async findById(id: string): Promise<AgentRun | null> {
        return this.repository.findOne({ where: { id } });
    }

    async findByAgent(agentId: string, limit = 25, offset = 0): Promise<AgentRun[]> {
        return this.repository.find({
            where: { agentId },
            order: { createdAt: 'DESC' },
            take: limit,
            skip: offset,
        });
    }

    async countByAgent(agentId: string): Promise<number> {
        return this.repository.count({ where: { agentId } });
    }

    /**
     * FU-2 — cancel a queued / running AgentRun. The (id, userId) guard
     * ensures cross-user runs return null (controller maps that to 404
     * per architecture/security §9, no-existence-leak).
     */
    async findByIdAndUser(runId: string, userId: string): Promise<AgentRun | null> {
        return this.repository.findOne({ where: { id: runId, userId } });
    }

    /**
     * FU-2 — flip a queued / running run to `cancelled`. Returns the
     * pre-update status so the controller can detect "already
     * terminal" (no-op) vs "actually cancelled".
     */
    async cancel(
        runId: string,
        userId: string,
    ): Promise<{ found: boolean; previousStatus?: AgentRunStatus }> {
        const run = await this.repository.findOne({ where: { id: runId, userId } });
        if (!run) return { found: false };
        if (run.status !== 'queued' && run.status !== 'running') {
            return { found: true, previousStatus: run.status };
        }
        await this.repository.update(runId, {
            status: 'cancelled',
            finishedAt: new Date(),
        });
        return { found: true, previousStatus: run.status };
    }

    async createQueued(args: {
        agentId: string;
        userId: string;
        triggerKind: AgentRunTriggerKind;
        taskId?: string | null;
        chatMessageId?: string | null;
    }): Promise<AgentRun> {
        const run = this.repository.create({
            agentId: args.agentId,
            userId: args.userId,
            triggerKind: args.triggerKind,
            status: 'queued',
            taskId: args.taskId ?? null,
            chatMessageId: args.chatMessageId ?? null,
        });
        return this.repository.save(run);
    }

    async markStarted(runId: string, triggerRunId: string | null): Promise<void> {
        await this.repository.update(runId, {
            status: 'running',
            startedAt: new Date(),
            triggerRunId,
        });
    }

    async markCompleted(runId: string, summary: string | null): Promise<void> {
        const now = new Date();
        const run = await this.repository.findOne({
            where: { id: runId },
            select: ['id', 'startedAt'],
        });
        const durationMs = run?.startedAt ? now.getTime() - run.startedAt.getTime() : null;
        await this.repository.update(runId, {
            status: 'completed',
            finishedAt: now,
            durationMs,
            summary,
        });
    }

    async markFailed(runId: string, errorMessage: string): Promise<void> {
        const now = new Date();
        const run = await this.repository.findOne({
            where: { id: runId },
            select: ['id', 'startedAt'],
        });
        const durationMs = run?.startedAt ? now.getTime() - run.startedAt.getTime() : null;
        await this.repository.update(runId, {
            status: 'failed',
            finishedAt: now,
            durationMs,
            errorMessage,
        });
    }

    async markCancelled(runId: string): Promise<void> {
        await this.repository.update(runId, {
            status: 'cancelled',
            finishedAt: new Date(),
        });
    }

    /**
     * Find an in-flight run for the (taskId, agentId) pair — used by
     * the agent-chat-reply dedup guard (architecture/security §8 — T6
     * mitigation): if a chat-triggered run is already running for the
     * same task + agent, the new mention appends context to the
     * in-flight run rather than dispatching a 2nd run.
     */
    async findInFlightForTaskAgent(taskId: string, agentId: string): Promise<AgentRun | null> {
        return this.repository
            .createQueryBuilder('run')
            .where('run.taskId = :taskId', { taskId })
            .andWhere('run.agentId = :agentId', { agentId })
            .andWhere('run.status IN (:...statuses)', {
                statuses: ['queued', 'running'] satisfies AgentRunStatus[],
            })
            .orderBy('run.createdAt', 'DESC')
            .getOne();
    }

    /**
     * Most-recent queued / running run for an Agent regardless of trigger
     * kind. Used by the `agent-heartbeat` Trigger.dev worker to find the
     * row the dispatcher created so it can mark it started + completed
     * without the caller having to pass the runId through the payload.
     */
    async findInFlightForAgent(agentId: string): Promise<AgentRun | null> {
        return this.repository
            .createQueryBuilder('run')
            .where('run.agentId = :agentId', { agentId })
            .andWhere('run.status IN (:...statuses)', {
                statuses: ['queued', 'running'] satisfies AgentRunStatus[],
            })
            .orderBy('run.createdAt', 'DESC')
            .getOne();
    }
}
