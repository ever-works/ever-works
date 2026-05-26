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
}
