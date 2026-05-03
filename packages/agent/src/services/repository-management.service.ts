import { Injectable, Logger } from '@nestjs/common';
import { GitFacadeService } from '../facades/git.facade';
import { Work, RepoVisibility } from '../entities/work.entity';
import { User } from '../entities/user.entity';
import { WorkRepository } from '../database/repositories/work.repository';

export type RepositoryType = 'data' | 'work' | 'website';

export interface RepositoryStatus {
    type: RepositoryType;
    name: string;
    url: string;
    isPrivate: boolean;
    exists: boolean;
}

@Injectable()
export class RepositoryManagementService {
    private readonly logger = new Logger(RepositoryManagementService.name);

    constructor(
        private readonly gitFacade: GitFacadeService,
        private readonly workRepository: WorkRepository,
    ) {}

    async getRepositoriesStatus(work: Work, user: User): Promise<RepositoryStatus[]> {
        const repos: { type: RepositoryType; name: string }[] = [
            { type: 'data', name: work.getDataRepo() },
            { type: 'work', name: work.getMainRepo() },
            { type: 'website', name: work.getWebsiteRepo() },
        ];

        const results = await Promise.all(
            repos.map(async (repo) => {
                const owner = work.getRepoOwner(repo.type);
                try {
                    const data = await this.gitFacade.getRepository(owner, repo.name, {
                        userId: user.id,
                        providerId: work.gitProvider,
                        workId: work.id,
                    });
                    if (data) {
                        return {
                            type: repo.type,
                            name: repo.name,
                            url: data.url,
                            isPrivate: data.isPrivate,
                            exists: true,
                        };
                    }
                } catch (error) {
                    // Ignore 404, treat as not exists
                }
                return {
                    type: repo.type,
                    name: repo.name,
                    url: '',
                    isPrivate: true, // Default safe assumption
                    exists: false,
                };
            }),
        );

        // Update DB cache
        const newVisibility: RepoVisibility = {
            data: results.find((r) => r.type === 'data')?.isPrivate ?? true,
            work: results.find((r) => r.type === 'work')?.isPrivate ?? true,
            website: results.find((r) => r.type === 'website')?.isPrivate ?? true,
        };

        // Only update if changed
        const currentVisibility = work.repoVisibility;
        if (
            !currentVisibility ||
            currentVisibility.data !== newVisibility.data ||
            currentVisibility.work !== newVisibility.work ||
            currentVisibility.website !== newVisibility.website
        ) {
            await this.workRepository.update(work.id, {
                repoVisibility: newVisibility,
            });
        }

        return results;
    }

    async updateRepositoryVisibility(
        work: Work,
        user: User,
        repoType: RepositoryType,
        isPrivate: boolean,
    ): Promise<RepositoryStatus> {
        const owner = work.getRepoOwner(repoType);
        let repoName: string;

        switch (repoType) {
            case 'data':
                repoName = work.getDataRepo();
                break;
            case 'work':
                repoName = work.getMainRepo();
                break;
            case 'website':
                repoName = work.getWebsiteRepo();
                break;
            default:
                throw new Error('Invalid repository type');
        }

        const updated = await this.gitFacade.updateRepository(
            owner,
            repoName,
            { isPrivate },
            { userId: user.id, providerId: work.gitProvider, workId: work.id },
        );

        // Update DB cache
        const currentVisibility = work.repoVisibility || {
            data: true,
            work: true,
            website: true,
        };
        const newVisibility = { ...currentVisibility };
        newVisibility[repoType] = updated.isPrivate;

        await this.workRepository.update(work.id, {
            repoVisibility: newVisibility,
        });

        return {
            type: repoType,
            name: repoName,
            url: updated.url,
            isPrivate: updated.isPrivate,
            exists: true,
        };
    }
}
