import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { GitFacadeService } from '../../facades/git.facade';
import { BranchSyncService, BranchSyncSummary } from './branch-sync.service';
import { Work } from '../../entities/work.entity';
import { User } from '../../entities/user.entity';
import { getWebsiteTemplateBranch } from './config/website-template.config';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { getWorkOwner } from '../../utils/work.utils';
import { WebsiteTemplateResolverService } from './website-template-resolver.service';

@Injectable()
export class WebsiteUpdateService {
    private readonly logger = new Logger(WebsiteUpdateService.name);

    constructor(
        private readonly gitFacade: GitFacadeService,
        private readonly branchSyncService: BranchSyncService,
        private readonly websiteTemplateResolver: WebsiteTemplateResolverService,
    ) {}

    private async ensureTemplateDefaultBranch(work: Work, userId: string): Promise<void> {
        const template = await this.websiteTemplateResolver.resolveForWork(work);
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

    /**
     * Updates an existing website repository based on the original creation method
     * @param work - The work to update
     * @param user - The user performing the update
     * @param options - Optional configuration (branch to use from template)
     */
    async updateRepository(
        work: Work,
        user: User,
        options?: { branch?: string },
    ): Promise<{
        method: string;
        message: string;
        commitSha?: string;
        branchSync?: BranchSyncSummary;
    }> {
        const workOwner = getWorkOwner(work);
        const websiteOwner = work.getRepoOwner('website');
        const websiteRepo = work.getWebsiteRepo();
        const template = await this.websiteTemplateResolver.resolveForWork(work);
        const branch = options?.branch || template.branch;

        // Check if the target repository exists
        const repositoryExists = await this.gitFacade.repositoryExists(websiteOwner, websiteRepo, {
            userId: workOwner.id,
            providerId: work.gitProvider,
            workId: work.id,
        });
        if (!repositoryExists) {
            throw new NotFoundException(
                `Website repository '${websiteOwner}/${websiteRepo}' does not exist`,
            );
        }

        // Get the latest commit SHA from the template branch
        const latestCommit = await this.gitFacade.getLatestCommit(
            template.owner,
            template.repo,
            branch,
            {
                userId: workOwner.id,
                providerId: work.gitProvider,
                workId: work.id,
            },
        );

        let updateResult: { method: string; message: string; commitSha?: string };

        try {
            // If fork fails, try duplicate method (clone original, replace remote)
            await this.updateDuplicate(work, user, branch);
            updateResult = {
                method: 'duplicate',
                message: 'Successfully updated using duplicate method',
                commitSha: latestCommit?.sha,
            };
        } catch (error) {
            this.logger.warn(`Duplicate update failed: ${error.message}`);

            try {
                // If duplicate fails, try template method (clone both, replace files)
                await this.updateTemplate(work, user, branch);
                updateResult = {
                    method: 'create-using-template',
                    message: 'Successfully updated using template method',
                    commitSha: latestCommit?.sha,
                };
            } catch (templateError) {
                this.logger.error(`Template update failed: ${templateError.message}`);
                throw new Error(`All update methods failed. Last error: ${templateError.message}`);
            }
        }

        // Sync all branches from template to website repo
        const branchSync = await this.syncAllBranchesFromTemplate(work, user);
        await this.ensureTemplateDefaultBranch(work, workOwner.id);

        return {
            ...updateResult,
            branchSync: branchSync || undefined,
        };
    }

    /** Sync all branches from template to work's website repo */
    async syncAllBranchesFromTemplate(work: Work, user: User): Promise<BranchSyncSummary | null> {
        return this.branchSyncService.syncFromTemplate(work, user);
    }

    /**
     * Checks if an update is available from the template repository
     * @param work - The work to check
     * @returns Information about whether an update is available
     */
    async checkForUpdate(work: Work): Promise<{
        updateAvailable: boolean;
        latestCommit?: string;
        currentCommit?: string;
        branch: string;
        error?: string;
    }> {
        const workOwner = getWorkOwner(work);
        const template = await this.websiteTemplateResolver.resolveForWork(work);
        const branch = getWebsiteTemplateBranch(template, work.websiteTemplateUseBeta);

        const hasCredentials = await this.gitFacade.hasValidCredentials({
            userId: workOwner.id,
            providerId: work.gitProvider,
            workId: work.id,
        });

        if (!hasCredentials) {
            return {
                updateAvailable: false,
                branch,
                error: 'Git provider credentials not available',
            };
        }

        const latestCommit = await this.gitFacade.getLatestCommit(
            template.owner,
            template.repo,
            branch,
            {
                userId: workOwner.id,
                providerId: work.gitProvider,
                workId: work.id,
            },
        );

        if (!latestCommit) {
            return { updateAvailable: false, branch };
        }

        return {
            updateAvailable: latestCommit.sha !== work.websiteTemplateLastCommit,
            latestCommit: latestCommit.sha,
            currentCommit: work.websiteTemplateLastCommit || undefined,
            branch,
        };
    }

    /**
     * Updates a forked repository by pulling from upstream
     */
    private async updateFork(work: Work, user: User): Promise<boolean> {
        const workOwner = getWorkOwner(work);
        const committer = work.resolveCommitter(user);
        const websiteOwner = work.getRepoOwner('website');
        const websiteRepo = work.getWebsiteRepo();
        const template = await this.websiteTemplateResolver.resolveForWork(work);

        try {
            // Clone the target repository
            const targetDir = await this.gitFacade.cloneOrPull(
                {
                    owner: websiteOwner,
                    repo: websiteRepo,
                    committer,
                },
                {
                    userId: workOwner.id,
                    providerId: work.gitProvider,
                    workId: work.id,
                },
            );

            // Check if this is actually a fork by looking for upstream remote
            const isActualFork = await this.gitFacade.hasForkRelationship(
                websiteOwner,
                websiteRepo,
                template.owner,
                template.repo,
                {
                    userId: workOwner.id,
                    providerId: work.gitProvider,
                    workId: work.id,
                },
            );

            if (!isActualFork) {
                return false; // Not a fork, can't use this method
            }

            // For fork updates, we need to pull from upstream and push
            // This is handled by creating a fresh clone and pushing
            return true;
        } catch (error) {
            this.logger.error(`Fork update failed: ${error.message}`);
            return false;
        }
    }

    /**
     * Updates using duplicate method: clone original, replace remote, push
     */
    private async updateDuplicate(work: Work, user: User, branch?: string): Promise<void> {
        const workOwner = getWorkOwner(work);
        const websiteOwner = work.getRepoOwner('website');
        const websiteRepo = work.getWebsiteRepo();
        const template = await this.websiteTemplateResolver.resolveForWork(work);
        const resolvedBranch = branch || template.branch;

        await this.gitFacade.removeLocalDir(work.gitProvider, template.owner, template.repo);

        // Clone the original template repository
        const originalDir = await this.gitFacade.cloneOrPull(
            {
                owner: template.owner,
                repo: template.repo,
                branch: resolvedBranch,
                committer: work.resolveCommitter(user),
            },
            {
                userId: workOwner.id,
                providerId: work.gitProvider,
                workId: work.id,
            },
        );

        // Get the target repository URL
        const targetRepoUrl = this.gitFacade.getCloneUrl(
            work.gitProvider,
            websiteOwner,
            websiteRepo,
        );

        // Remove existing origin and add new one
        await this.gitFacade.switchBranch(work.gitProvider, originalDir, resolvedBranch);
        await this.gitFacade.replaceRemote(work.gitProvider, originalDir, 'origin', targetRepoUrl);

        // Push to the target repository
        await this.gitFacade.push(
            { dir: originalDir, force: true },
            {
                userId: workOwner.id,
                providerId: work.gitProvider,
                workId: work.id,
            },
        );

        this.logger.log(
            `Successfully updated ${websiteOwner}/${websiteRepo} using duplicate method (branch: ${resolvedBranch})`,
        );
    }

    /**
     * Updates using template method: clone both repos, replace files, commit and push
     */
    private async updateTemplate(work: Work, user: User, branch?: string): Promise<void> {
        const workOwner = getWorkOwner(work);
        const committer = work.resolveCommitter(user);
        const websiteOwner = work.getRepoOwner('website');
        const websiteRepo = work.getWebsiteRepo();
        const template = await this.websiteTemplateResolver.resolveForWork(work);
        const resolvedBranch = branch || template.branch;

        // Clone both repositories
        const [originalDir, targetDir] = await Promise.all([
            this.gitFacade.cloneOrPull(
                {
                    owner: template.owner,
                    repo: template.repo,
                    branch: resolvedBranch,
                    committer,
                },
                {
                    userId: workOwner.id,
                    providerId: work.gitProvider,
                    workId: work.id,
                },
            ),

            this.gitFacade.cloneOrPull(
                {
                    owner: websiteOwner,
                    repo: websiteRepo,
                    branch: resolvedBranch,
                    committer,
                },
                {
                    userId: workOwner.id,
                    providerId: work.gitProvider,
                    workId: work.id,
                },
            ),
        ]);

        // Copy files from original to target (excluding .git work)
        await this.copyRepositoryFiles(originalDir, targetDir);

        // Add, commit, and push changes
        await this.gitFacade.add(work.gitProvider, targetDir, '.');

        await this.gitFacade.commit(
            work.gitProvider,
            targetDir,
            `Update website from template (${resolvedBranch})`,
            committer,
        );

        await this.gitFacade.push(
            { dir: targetDir, force: true },
            {
                userId: workOwner.id,
                providerId: work.gitProvider,
                workId: work.id,
            },
        );

        this.logger.log(
            `Successfully updated ${websiteOwner}/${websiteRepo} using template method (branch: ${resolvedBranch})`,
        );
    }

    /**
     * Copies files from source to destination, excluding .git work
     */
    private async copyRepositoryFiles(sourceDir: string, targetDir: string): Promise<void> {
        const entries = await fs.readdir(sourceDir, { withFileTypes: true });

        for (const entry of entries) {
            if (entry.name === '.git') {
                continue; // Skip .git work
            }

            const sourcePath = path.join(sourceDir, entry.name);
            const targetPath = path.join(targetDir, entry.name);

            if (entry.isDirectory()) {
                // Remove existing work if it exists
                try {
                    await fs.rm(targetPath, { recursive: true, force: true });
                } catch (error) {
                    // Work might not exist, which is fine
                }

                // Create new work and copy contents
                await fs.mkdir(targetPath, { recursive: true });
                await this.copyRepositoryFiles(sourcePath, targetPath);
            } else {
                // Copy file
                await fs.copyFile(sourcePath, targetPath);
            }
        }
    }
}
