import { Injectable, Logger } from '@nestjs/common';
import { GitFacadeService } from '../facades/git.facade';
import { Directory, RepoVisibility } from '../entities/directory.entity';
import { User } from '../entities/user.entity';
import { DirectoryRepository } from '../database/repositories/directory.repository';

export type RepositoryType = 'data' | 'directory' | 'website';

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
        private readonly directoryRepository: DirectoryRepository,
    ) {}

    async getRepositoriesStatus(directory: Directory, user: User): Promise<RepositoryStatus[]> {
        const repos: { type: RepositoryType; name: string }[] = [
            { type: 'data', name: directory.getDataRepo() },
            { type: 'directory', name: directory.getMainRepo() },
            { type: 'website', name: directory.getWebsiteRepo() },
        ];

        const results = await Promise.all(
            repos.map(async (repo) => {
                const owner = directory.getRepoOwner(repo.type);
                try {
                    const data = await this.gitFacade.getRepository(owner, repo.name, {
                        userId: user.id,
                        providerId: directory.gitProvider,
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
            directory: results.find((r) => r.type === 'directory')?.isPrivate ?? true,
            website: results.find((r) => r.type === 'website')?.isPrivate ?? true,
        };

        // Only update if changed
        const currentVisibility = directory.repoVisibility;
        if (
            !currentVisibility ||
            currentVisibility.data !== newVisibility.data ||
            currentVisibility.directory !== newVisibility.directory ||
            currentVisibility.website !== newVisibility.website
        ) {
            await this.directoryRepository.update(directory.id, {
                repoVisibility: newVisibility,
            });
        }

        return results;
    }

    async updateRepositoryVisibility(
        directory: Directory,
        user: User,
        repoType: RepositoryType,
        isPrivate: boolean,
    ): Promise<RepositoryStatus> {
        const owner = directory.getRepoOwner(repoType);
        let repoName: string;

        switch (repoType) {
            case 'data':
                repoName = directory.getDataRepo();
                break;
            case 'directory':
                repoName = directory.getMainRepo();
                break;
            case 'website':
                repoName = directory.getWebsiteRepo();
                break;
            default:
                throw new Error('Invalid repository type');
        }

        const updated = await this.gitFacade.updateRepository(
            owner,
            repoName,
            { isPrivate },
            { userId: user.id, providerId: directory.gitProvider },
        );

        // Update DB cache
        const currentVisibility = directory.repoVisibility || {
            data: true,
            directory: true,
            website: true,
        };
        const newVisibility = { ...currentVisibility };
        newVisibility[repoType] = updated.isPrivate;

        await this.directoryRepository.update(directory.id, {
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
