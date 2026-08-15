import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AgentRunLog } from '../../entities/agent-run-log.entity';

@Injectable()
export class AgentRunLogRepository {
    constructor(
        @InjectRepository(AgentRunLog)
        private readonly repository: Repository<AgentRunLog>,
    ) {}

    async append(args: {
        runId: string;
        level: 'INFO' | 'WARN' | 'ERROR';
        step: string;
        message: string;
        metadata?: Record<string, unknown> | null;
    }): Promise<AgentRunLog> {
        const row = this.repository.create({
            runId: args.runId,
            level: args.level,
            step: args.step,
            message: args.message,
            metadata: args.metadata ?? null,
        });
        return this.repository.save(row);
    }

    async findByRun(runId: string, limit = 200, offset = 0): Promise<AgentRunLog[]> {
        return this.repository.find({
            where: { runId },
            order: { createdAt: 'ASC' },
            take: limit,
            skip: offset,
        });
    }

    /**
     * Session detail (Feature K) — count rows per step-name subset, one
     * query per subset. Powers the "N messages / N tool calls" chips.
     */
    async countByRunSteps(runId: string, steps: readonly string[]): Promise<number> {
        if (steps.length === 0) return 0;
        return this.repository
            .createQueryBuilder('log')
            .where('log.runId = :runId', { runId })
            .andWhere('log.step IN (:...steps)', { steps: [...steps] })
            .getCount();
    }

    /**
     * Session detail (Feature K) — one cursor page of the run's timeline
     * (message + tool-invocation rows), oldest first.
     *
     * The cursor is (createdAt, id): `createdAt` alone is not unique — a
     * tool round can append several rows in the same millisecond — so
     * `id` breaks ties with a stable (if arbitrary) uuid ordering. Both
     * comparisons are portable across postgres + better-sqlite3.
     */
    async findTimelineByRun(
        runId: string,
        steps: readonly string[],
        limit: number,
        after?: { createdAt: Date; id: string },
    ): Promise<AgentRunLog[]> {
        if (steps.length === 0) return [];
        const qb = this.repository
            .createQueryBuilder('log')
            .where('log.runId = :runId', { runId })
            .andWhere('log.step IN (:...steps)', { steps: [...steps] });
        if (after) {
            qb.andWhere(
                '(log.createdAt > :afterCreatedAt OR (log.createdAt = :afterCreatedAt AND log.id > :afterId))',
                { afterCreatedAt: after.createdAt, afterId: after.id },
            );
        }
        return qb.orderBy('log.createdAt', 'ASC').addOrderBy('log.id', 'ASC').take(limit).getMany();
    }
}
