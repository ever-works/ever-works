import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RepoConnection } from '../../entities/repo-connection.entity';

/**
 * Repository registry (Feature G) — persistence for `repo_connections`.
 * Every read is owner-scoped: cross-user access resolves to null (the
 * API layer turns that into a 404, per the house authz rule).
 */
@Injectable()
export class RepoConnectionRepository {
    constructor(
        @InjectRepository(RepoConnection)
        private readonly repository: Repository<RepoConnection>,
    ) {}

    async listByUser(userId: string): Promise<RepoConnection[]> {
        return this.repository.find({
            where: { userId },
            order: { name: 'ASC' },
        });
    }

    async findByIdAndUser(id: string, userId: string): Promise<RepoConnection | null> {
        return this.repository.findOne({ where: { id, userId } });
    }

    async findByUserAndName(userId: string, name: string): Promise<RepoConnection | null> {
        return this.repository.findOne({ where: { userId, name } });
    }

    async findByUserAndSourceInstallationRepoId(
        userId: string,
        sourceInstallationRepoId: string,
    ): Promise<RepoConnection | null> {
        return this.repository.findOne({ where: { userId, sourceInstallationRepoId } });
    }

    async create(data: Partial<RepoConnection>): Promise<RepoConnection> {
        const entity = this.repository.create(data);
        return this.repository.save(entity);
    }

    async save(entity: RepoConnection): Promise<RepoConnection> {
        return this.repository.save(entity);
    }

    async deleteByIdAndUser(id: string, userId: string): Promise<boolean> {
        const result = await this.repository.delete({ id, userId });
        return (result.affected ?? 0) > 0;
    }
}
