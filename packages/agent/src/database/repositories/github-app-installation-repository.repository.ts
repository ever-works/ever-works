import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GitHubAppInstallationRepository as GitHubAppInstallationRepositoryEntity } from '../../entities';

export type GitHubAppRepositoryRecord = {
    githubRepoId: string;
    owner: string;
    repo: string;
    fullName: string;
    isPrivate: boolean;
    defaultBranch?: string | null;
    selected?: boolean;
};

@Injectable()
export class GitHubAppInstallationRepoRepository {
    constructor(
        @InjectRepository(GitHubAppInstallationRepositoryEntity)
        private readonly repository: Repository<GitHubAppInstallationRepositoryEntity>,
    ) {}

    async listForInstallation(
        installationEntityId: string,
    ): Promise<GitHubAppInstallationRepositoryEntity[]> {
        return this.repository.find({
            where: { installationEntityId },
            order: {
                fullName: 'ASC',
            },
        });
    }

    async findById(id: string): Promise<GitHubAppInstallationRepositoryEntity | null> {
        return this.repository.findOne({
            where: { id },
        });
    }

    async findByFullName(fullName: string): Promise<GitHubAppInstallationRepositoryEntity[]> {
        return this.repository.find({
            where: { fullName },
            order: {
                createdAt: 'DESC',
            },
        });
    }

    async replaceForInstallation(
        installationEntityId: string,
        repositories: GitHubAppRepositoryRecord[],
    ): Promise<GitHubAppInstallationRepositoryEntity[]> {
        return this.repository.manager.transaction(async (manager) => {
            const transactionalRepository = manager.getRepository(
                GitHubAppInstallationRepositoryEntity,
            );

            await transactionalRepository.delete({ installationEntityId });

            if (repositories.length === 0) {
                return [];
            }

            const entities = repositories.map((repositoryRecord) =>
                transactionalRepository.create({
                    installationEntityId,
                    githubRepoId: repositoryRecord.githubRepoId,
                    owner: repositoryRecord.owner,
                    repo: repositoryRecord.repo,
                    fullName: repositoryRecord.fullName,
                    isPrivate: repositoryRecord.isPrivate,
                    defaultBranch: repositoryRecord.defaultBranch ?? null,
                    selected: repositoryRecord.selected ?? true,
                }),
            );

            return transactionalRepository.save(entities);
        });
    }
}
