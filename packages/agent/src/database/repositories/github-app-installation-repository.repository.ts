import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GitHubAppInstallationRepository as GitHubAppInstallationRepositoryEntity } from '../../entities/github-app-installation-repository.entity';
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

    /**
     * Every installation snapshot row for `owner/repo`, matched
     * CASE-INSENSITIVELY.
     *
     * GitHub repository names are case-insensitive, but `fullName` is
     * stored verbatim from GitHub's `full_name` (see
     * `GitHubAppSyncService`), so the column holds whatever casing the
     * repository declares — `Ever-Works/Directory-Web-Template` as readily
     * as `ever-works/ever-works`. A plain `where: { fullName }` is an exact
     * varchar comparison, which is case-SENSITIVE on Postgres.
     *
     * That mattered: the fleet's scoped push credential normalizes the
     * repositories it wants to lower case before asking, so any repository
     * with an upper-case character in its name resolved to ZERO rows, the
     * scope came back `push-scope-unresolved`, and the planner refused the
     * Task at plan time — indistinguishably from a repository no
     * installation covers — silently removing fleet execution for an
     * entire class of repositories the installation did in fact cover.
     *
     * `LOWER(...)` on both sides rather than a `citext` column or a
     * functional index: this is a small per-installation table read once
     * per plan, and changing the column type is a migration every
     * deployment would have to take for no other benefit.
     */
    async findByFullName(fullName: string): Promise<GitHubAppInstallationRepositoryEntity[]> {
        return this.repository
            .createQueryBuilder('installationRepository')
            .where('LOWER(installationRepository.fullName) = LOWER(:fullName)', { fullName })
            .orderBy('installationRepository.createdAt', 'DESC')
            .getMany();
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
