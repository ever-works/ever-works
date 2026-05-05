import { Injectable, Logger } from '@nestjs/common';
import { GitFacadeService } from '../../facades/git.facade';
import { BranchSyncService } from './branch-sync.service';
import { WebsiteRepositoryCreationMethod } from '../../items-generator/dto/create-items-generator.dto';
import { Work } from '../../entities/work.entity';
import { User } from '../../entities/user.entity';
import { getWorkOwner } from '../../utils/work.utils';
import * as fs from 'node:fs/promises';
import { cloneFreshRepository } from '../../utils/fresh-repository-clone.utils';
import { assertCreatedRepositoryTarget } from '../../utils/git-repository.utils';
import { throwIfGenerationCancelled } from '../../utils/generation-cancellation.utils';
import { WebsiteTemplateResolverService } from './website-template-resolver.service';

type WebsiteGenerationOptions = {
    signal?: AbortSignal;
};

@Injectable()
export class WebsiteGeneratorService {
    private readonly logger = new Logger(WebsiteGeneratorService.name);

    constructor(
        private readonly gitFacade: GitFacadeService,
        private readonly branchSyncService: BranchSyncService,
        private readonly websiteTemplateResolver: WebsiteTemplateResolverService,
    ) {}

    private async waitForTargetRepository(
        work: Work,
        user: User,
        owner: string,
        repo: string,
        options: WebsiteGenerationOptions = {},
    ) {
        throwIfGenerationCancelled(options.signal);

        const workOwner = getWorkOwner(work);
        const committer = work.resolveCommitter(user);

        const repoDir = await cloneFreshRepository(
            this.gitFacade,
            {
                owner,
                repo,
                committer,
                userId: workOwner.id,
                providerId: work.gitProvider,
                workId: work.id,
            },
            this.logger,
        );
        throwIfGenerationCancelled(options.signal);

        await fs.rm(repoDir, { recursive: true, force: true }).catch(() => {});
    }

    private async ensureTemplateDefaultBranch(work: Work, userId: string): Promise<void> {
        const template = await this.websiteTemplateResolver.resolve(work.websiteTemplateId);
        const targetBranch = template.branch;
        const websiteOwner = work.getRepoOwner('website');
        const websiteRepo = work.getWebsiteRepo();

        try {
            const branches = await this.gitFacade.listBranches(websiteOwner, websiteRepo, {
                userId,
                providerId: work.gitProvider,
                workId: work.id,
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
                { userId, providerId: work.gitProvider, workId: work.id },
            );
        } catch (error) {
            this.logger.warn(
                `Failed to set default branch for ${websiteOwner}/${websiteRepo}: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    private async duplicate(work: Work, user: User, options: WebsiteGenerationOptions = {}) {
        throwIfGenerationCancelled(options.signal);

        const workOwner = getWorkOwner(work);
        const committer = work.resolveCommitter(user);
        const template = await this.websiteTemplateResolver.resolve(work.websiteTemplateId);

        await this.cleanup(work);
        throwIfGenerationCancelled(options.signal);

        // Clone template repo
        const templateDir = await this.gitFacade.cloneOrPull(
            {
                owner: template.owner,
                repo: template.repo,
                branch: template.branch,
                committer,
            },
            {
                userId: workOwner.id,
                providerId: work.gitProvider,
                workId: work.id,
            },
        );
        throwIfGenerationCancelled(options.signal);

        // Create target repo
        const websiteOwner = work.getRepoOwner('website');
        const websiteRepo = work.getWebsiteRepo();
        const websiteRepository = assertCreatedRepositoryTarget(
            await this.gitFacade.createRepository(
                {
                    name: websiteRepo,
                    description: `Website for ${work.name}`,
                    organization: work.organization ? websiteOwner : undefined,
                    isPrivate: true,
                },
                {
                    userId: workOwner.id,
                    providerId: work.gitProvider,
                    workId: work.id,
                },
            ),
            websiteOwner,
            websiteRepo,
            'Website repository',
        );

        await this.waitForTargetRepository(
            work,
            user,
            websiteRepository.owner,
            websiteRepository.name,
            options,
        );
        throwIfGenerationCancelled(options.signal);

        // Push template to target repo
        const targetCloneUrl = this.gitFacade.getCloneUrl(
            work.gitProvider,
            websiteRepository.owner,
            websiteRepository.name,
        );

        // Remove origin and add new one pointing to target
        await this.gitFacade.replaceRemote(work.gitProvider, templateDir, 'origin', targetCloneUrl);

        // Push to target
        await this.gitFacade.push(
            { dir: templateDir, force: true },
            {
                userId: workOwner.id,
                providerId: work.gitProvider,
                workId: work.id,
            },
        );
        throwIfGenerationCancelled(options.signal);

        await this.ensureTemplateDefaultBranch(work, workOwner.id);

        return templateDir;
    }

    private async createUsingTemplate(
        work: Work,
        user: User,
        options: WebsiteGenerationOptions = {},
    ) {
        throwIfGenerationCancelled(options.signal);

        const workOwner = getWorkOwner(work);
        const websiteOwner = work.getRepoOwner('website');
        const websiteRepo = work.getWebsiteRepo();
        const template = await this.websiteTemplateResolver.resolve(work.websiteTemplateId);

        const createdWebsiteRepository = await this.gitFacade.createRepositoryFromTemplate(
            template.owner,
            template.repo,
            {
                name: websiteRepo,
                organization: work.organization ? websiteOwner : undefined,
                isPrivate: true,
            },
            {
                userId: workOwner.id,
                providerId: work.gitProvider,
                workId: work.id,
            },
        );
        throwIfGenerationCancelled(options.signal);

        if (createdWebsiteRepository) {
            assertCreatedRepositoryTarget(
                createdWebsiteRepository,
                websiteOwner,
                websiteRepo,
                'Website repository',
            );

            await this.waitForTargetRepository(
                work,
                user,
                createdWebsiteRepository.owner,
                createdWebsiteRepository.name,
                options,
            );
        }
    }

    async initialize(
        work: Work,
        user: User,
        operation: WebsiteRepositoryCreationMethod = WebsiteRepositoryCreationMethod.DUPLICATE,
        options: WebsiteGenerationOptions = {},
    ) {
        let path: string | undefined;
        const workOwner = getWorkOwner(work);

        try {
            throwIfGenerationCancelled(options.signal);

            if (operation === WebsiteRepositoryCreationMethod.DUPLICATE) {
                path = await this.duplicate(work, user, options);
            } else if (operation === WebsiteRepositoryCreationMethod.CREATE_USING_TEMPLATE) {
                try {
                    await this.createUsingTemplate(work, user, options);
                } catch {
                    throwIfGenerationCancelled(options.signal);
                    path = await this.duplicate(work, user, options);
                }
            } else {
                path = await this.duplicate(work, user, options);
            }

            throwIfGenerationCancelled(options.signal);
            await this.syncAllBranchesFromTemplate(work, user, true);
            throwIfGenerationCancelled(options.signal);
            await this.ensureTemplateDefaultBranch(work, workOwner.id);
        } finally {
            if (path) {
                await fs.rm(path, { recursive: true, force: true });
            }
        }
    }

    /** Sync all branches from template to work's website repo */
    async syncAllBranchesFromTemplate(work: Work, user: User, cleanupExtraBranches = false) {
        return this.branchSyncService.syncFromTemplate(work, user, cleanupExtraBranches);
    }

    async removeRepository(work: Work, _user: User): Promise<void> {
        const workOwner = getWorkOwner(work);

        await this.gitFacade.deleteRepository(work.getRepoOwner('website'), work.getWebsiteRepo(), {
            userId: workOwner.id,
            providerId: work.gitProvider,
            workId: work.id,
        });
    }

    public cleanup(work: Work) {
        const dataDir = this.gitFacade.getLocalDir(
            work.gitProvider,
            work.getRepoOwner('website'),
            work.getWebsiteRepo(),
        );

        return fs.rm(dataDir, { recursive: true, force: true });
    }
}
