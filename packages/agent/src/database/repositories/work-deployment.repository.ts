import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
    WorkDeployment,
    DeploymentEnvironment,
} from '../../entities/work-deployment.entity';

@Injectable()
export class WorkDeploymentRepository {
    constructor(
        @InjectRepository(WorkDeployment)
        private readonly repository: Repository<WorkDeployment>,
    ) {}

    async create(input: Partial<WorkDeployment>): Promise<WorkDeployment> {
        const row = this.repository.create({
            startedAt: new Date(),
            ...input,
        });
        return this.repository.save(row);
    }

    findById(id: string): Promise<WorkDeployment | null> {
        return this.repository.findOne({ where: { id } });
    }

    findByWork(
        workId: string,
        opts: { environment?: DeploymentEnvironment; limit?: number } = {},
    ): Promise<WorkDeployment[]> {
        return this.repository.find({
            where: opts.environment ? { workId, environment: opts.environment } : { workId },
            order: { createdAt: 'DESC' },
            take: opts.limit ?? 50,
        });
    }

    findLatest(
        workId: string,
        environment: DeploymentEnvironment,
    ): Promise<WorkDeployment | null> {
        return this.repository.findOne({
            where: { workId, environment },
            order: { createdAt: 'DESC' },
        });
    }

    findByPr(workId: string, prNumber: number): Promise<WorkDeployment | null> {
        return this.repository.findOne({
            where: { workId, prNumber },
            order: { createdAt: 'DESC' },
        });
    }

    async update(id: string, fields: Partial<WorkDeployment>): Promise<void> {
        await this.repository.update({ id }, fields);
    }

    async markTerminal(
        id: string,
        state: 'READY' | 'ERROR' | 'CANCELED' | 'TIMEOUT',
        fields: Partial<WorkDeployment> = {},
    ): Promise<void> {
        await this.repository.update(
            { id },
            { state, completedAt: new Date(), ...fields },
        );
    }

    async deleteOlderThan(cutoff: Date, environment: DeploymentEnvironment): Promise<number> {
        const result = await this.repository
            .createQueryBuilder()
            .delete()
            .where('environment = :env', { env: environment })
            .andWhere('createdAt < :cutoff', { cutoff })
            .execute();
        return result.affected ?? 0;
    }
}
