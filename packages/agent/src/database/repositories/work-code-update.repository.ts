import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import {
    WorkCodeUpdate,
    WorkCodeUpdateStatus,
} from '../../entities/work-code-update.entity';

@Injectable()
export class WorkCodeUpdateRepository {
    constructor(
        @InjectRepository(WorkCodeUpdate)
        private readonly repository: Repository<WorkCodeUpdate>,
    ) {}

    async create(input: Partial<WorkCodeUpdate>): Promise<WorkCodeUpdate> {
        const row = this.repository.create(input);
        return this.repository.save(row);
    }

    findById(id: string): Promise<WorkCodeUpdate | null> {
        return this.repository.findOne({ where: { id } });
    }

    findByWork(
        workId: string,
        opts: { statuses?: WorkCodeUpdateStatus[]; limit?: number } = {},
    ): Promise<WorkCodeUpdate[]> {
        return this.repository.find({
            where: opts.statuses?.length
                ? { workId, status: In(opts.statuses) }
                : { workId },
            order: { createdAt: 'DESC' },
            take: opts.limit ?? 50,
        });
    }

    async update(id: string, fields: Partial<WorkCodeUpdate>): Promise<void> {
        await this.repository.update({ id }, fields);
    }

    async markApplied(id: string): Promise<void> {
        await this.repository.update(
            { id },
            { status: WorkCodeUpdateStatus.APPLIED, appliedAt: new Date() },
        );
    }

    async markRejected(id: string): Promise<void> {
        await this.repository.update(
            { id },
            { status: WorkCodeUpdateStatus.REJECTED, rejectedAt: new Date() },
        );
    }

    async markFailed(id: string, error: string): Promise<void> {
        await this.repository.update(
            { id },
            { status: WorkCodeUpdateStatus.FAILED, lastError: error },
        );
    }
}
