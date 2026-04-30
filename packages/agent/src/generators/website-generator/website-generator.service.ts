import { Injectable, Logger } from '@nestjs/common';
import { GitFacadeService } from '../../facades/git.facade';
import { BranchSyncService } from './branch-sync.service';
import { WebsiteRepositoryCreationMethod } from '../../items-generator/dto/create-items-generator.dto';
import { Directory } from '../../entities/directory.entity';
import { User } from '../../entities/user.entity';
import { WEBSITE_TEMPLATE_CONFIG } from './config/website-template.config';
import { getDirectoryOwner } from '../../utils/directory.utils';
import * as fs from 'node:fs/promises';
import { cloneFreshRepository } from '../../utils/fresh-repository-clone.utils';
import { assertCreatedRepositoryTarget } from '../../utils/git-repository.utils';

@Injectable()
export class WebsiteGeneratorService {
    private readonly logger = new Logger(WebsiteGeneratorService.name);

    constructor(
        private readonly gitFacade: GitFacadeService,
        private readonly branchSyncService: BranchSyncService,
    ) {}

    private async waitForTargetRepository(
        directory: Directory,
        user: User,
        owner: string,
        repo: string,
    ) {
        const directoryOwner = getDirectoryOwner(directory);
        const committer = directory.resolveCommitter(user);

        const repoDir = await cloneFreshRepository(
            this.gitFacade,
            {
                owner,
                repo,
                committer,
                userId: directoryOwner.id,
                providerId: directory.gitProvider,
                directoryId: directory.id,
            },
            this.logger,
        );

        await fs.rm(repoDir, { recursive: true, force: true }).catch(() => {});
    }

    private async ensureTemplateDefaultBranch(directory: Directory, userId: string): Promise<void> {
        const targetBranch = WEBSITE_TEMPLATE_CONFIG.branch;
        const websiteOwner = directory.getRepoOwner('website');
        const websiteRepo = directory.getWebsiteRepo();

        try {
            const branches = await this.gitFacade.listBranches(websiteOwner, websiteRepo, {
                userId,
                providerId: directory.gitProvider,
                directoryId: directory.id,
            });

            if (!branches.some((branch) => branch.name === targetBranch)) {
                this.logger.warn(
                    `Cannot set default branch to '${targetBranch}' for ${websiteOwner}/${websiteRepo} because the branch does not exist yet`,
                );
                return;
            }

            await this.gitFacade.updateRepository(
                websiteOwner,
                websiteRepo,
                { defaultBranch: targetBranch },
                { userId, providerId: directory.gitProvider, directoryId: directory.id },
            );
        } catch (error) {
            this.logger.warn(
                `Failed to set default branch for ${websiteOwner}/${websiteRepo}: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    private async duplicate(directory: Directory, user: User) {
        const directoryOwner = getDirectoryOwner(directory);
        const committer = directory.resolveCommitter(user);

        await this.cleanup(directory);

        // Clone template repo
        const templateDir = await this.gitFacade.cloneOrPull(
            {
                owner: WEBSITE_TEMPLATE_CONFIG.owner,
                repo: WEBSITE_TEMPLATE_CONFIG.repo,
                branch: WEBSITE_TEMPLATE_CONFIG.branch,
                committer,
            },
            {
                userId: directoryOwner.id,
                providerId: directory.gitProvider,
                directoryId: directory.id,
            },
        );

        // Create target repo
        const websiteOwner = directory.getRepoOwner('website');
        const websiteRepo = directory.getWebsiteRepo();
        const websiteRepository = assertCreatedRepositoryTarget(
            await this.gitFacade.createRepository(
                {
                    name: websiteRepo,
                    description: `Website for ${directory.name}`,
                    organization: directory.organization ? websiteOwner : undefined,
                    isPrivate: true,
                },
                {
                    userId: directoryOwner.id,
                    providerId: directory.gitProvider,
                    directoryId: directory.id,
                },
            ),
            websiteOwner,
            websiteRepo,
            'Website repository',
        );

        await this.waitForTargetRepository(
            directory,
            user,
            websiteRepository.owner,
            websiteRepository.name,
        );

        // Push template to target repo
        const targetCloneUrl = this.gitFacade.getCloneUrl(
            directory.gitProvider,
            websiteRepository.owner,
            websiteRepository.name,
        );

        // Remove origin and add new one pointing to target
        await this.gitFacade.replaceRemote(
            directory.gitProvider,
            templateDir,
            'origin',
            targetCloneUrl,
        );

        // Push to target
        await this.gitFacade.push(
            { dir: templateDir, force: true },
            {
                userId: directoryOwner.id,
                providerId: directory.gitProvider,
                directoryId: directory.id,
            },
        );

        await this.ensureTemplateDefaultBranch(directory, directoryOwner.id);

        return templateDir;
    }

    private async createUsingTemplate(directory: Directory, user: User) {
        const directoryOwner = getDirectoryOwner(directory);
        const websiteOwner = directory.getRepoOwner('website');
        const websiteRepo = directory.getWebsiteRepo();

        const createdWebsiteRepository = await this.gitFacade.createRepositoryFromTemplate(
            WEBSITE_TEMPLATE_CONFIG.owner,
            WEBSITE_TEMPLATE_CONFIG.repo,
            {
                name: websiteRepo,
                organization: directory.organization ? websiteOwner : undefined,
                isPrivate: true,
            },
            {
                userId: directoryOwner.id,
                providerId: directory.gitProvider,
                directoryId: directory.id,
            },
        );

        if (createdWebsiteRepository) {
            assertCreatedRepositoryTarget(
                createdWebsiteRepository,
                websiteOwner,
                websiteRepo,
                'Website repository',
            );

            await this.waitForTargetRepository(
                directory,
                user,
                createdWebsiteRepository.owner,
                createdWebsiteRepository.name,
            );
        }
    }

    async initialize(
        directory: Directory,
        user: User,
        operation: WebsiteRepositoryCreationMethod = WebsiteRepositoryCreationMethod.DUPLICATE,
    ) {
        let path: string | undefined;
        const directoryOwner = getDirectoryOwner(directory);

        try {
            if (operation === WebsiteRepositoryCreationMethod.DUPLICATE) {
                path = await this.duplicate(directory, user);
            } else if (operation === WebsiteRepositoryCreationMethod.CREATE_USING_TEMPLATE) {
                try {
                    await this.createUsingTemplate(directory, user);
                } catch {
                    path = await this.duplicate(directory, user);
                }
            } else {
                path = await this.duplicate(directory, user);
            }

            await this.syncAllBranchesFromTemplate(directory, user, true);
            await this.ensureTemplateDefaultBranch(directory, directoryOwner.id);
        } finally {
            if (path) {
                await fs.rm(path, { recursive: true, force: true });
            }
        }
    }

    /** Sync all branches from template to directory's website repo */
    async syncAllBranchesFromTemplate(
        directory: Directory,
        user: User,
        cleanupExtraBranches = false,
    ) {
        return this.branchSyncService.syncFromTemplate(directory, user, cleanupExtraBranches);
    }

    async removeRepository(directory: Directory, _user: User): Promise<void> {
        const directoryOwner = getDirectoryOwner(directory);

        await this.gitFacade.deleteRepository(
            directory.getRepoOwner('website'),
            directory.getWebsiteRepo(),
            {
                userId: directoryOwner.id,
                providerId: directory.gitProvider,
                directoryId: directory.id,
            },
        );
    }

    public cleanup(directory: Directory) {
        const dataDir = this.gitFacade.getLocalDir(
            directory.gitProvider,
            directory.getRepoOwner('website'),
            directory.getWebsiteRepo(),
        );

        return fs.rm(dataDir, { recursive: true, force: true });
    }
}
