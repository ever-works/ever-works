import { Injectable, Logger } from '@nestjs/common';
import { GithubService } from '../git/github.service';
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
        private readonly githubService: GithubService,
        private readonly directoryRepository: DirectoryRepository,
    ) {}

    async getRepositoriesStatus(directory: Directory, user: User): Promise<RepositoryStatus[]> {
        const token = user.getGitToken();
        const owner = directory.getRepoOwner();

        const repos: { type: RepositoryType; name: string }[] = [
            { type: 'data', name: directory.getDataRepo() },
            { type: 'directory', name: directory.getMainRepo() },
            { type: 'website', name: directory.getWebsiteRepo() },
        ];

        const results = await Promise.all(
            repos.map(async (repo) => {
                try {
                    const data = await this.githubService.getRepository(owner, repo.name, token);
                    if (data && data.data) {
                        return {
                            type: repo.type,
                            name: repo.name,
                            url: data.data.html_url,
                            isPrivate: data.data.private,
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
        const token = user.getGitToken();
        const owner = directory.getRepoOwner();
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

        const updated = await this.githubService.updateRepository(
            owner,
            repoName,
            { private: isPrivate },
            token,
        );

        // Update DB cache
        const currentVisibility = directory.repoVisibility || {
            data: true,
            directory: true,
            website: true,
        };
        const newVisibility = { ...currentVisibility };
        newVisibility[repoType] = updated.private;

        await this.directoryRepository.update(directory.id, {
            repoVisibility: newVisibility,
        });

        return {
            type: repoType,
            name: repoName,
            url: updated.html_url,
            isPrivate: updated.private,
            exists: true,
        };
    }
}
