import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { GitFacadeService } from '../../facades/git.facade';
import { BranchSyncService, BranchSyncSummary } from './branch-sync.service';
import { Directory } from '../../entities/directory.entity';
import { User } from '../../entities/user.entity';
import {
    getWebsiteTemplateBranch,
    getWebsiteTemplateConfig,
} from './config/website-template.config';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { getDirectoryOwner } from '../../utils/directory.utils';

@Injectable()
export class WebsiteUpdateService {
    private readonly logger = new Logger(WebsiteUpdateService.name);

    constructor(
        private readonly gitFacade: GitFacadeService,
        private readonly branchSyncService: BranchSyncService,
    ) {}

    private async ensureTemplateDefaultBranch(directory: Directory, userId: string): Promise<void> {
        const template = getWebsiteTemplateConfig(directory.websiteTemplateId);
        const targetBranch = template.branch;
        const websiteOwner = directory.getRepoOwner('website');
        const websiteRepo = directory.getWebsiteRepo();

        try {
            const branches = await this.gitFacade.listBranches(websiteOwner, websiteRepo, {
                userId,
                providerId: directory.gitProvider,
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
                { userId, providerId: directory.gitProvider },
            );
        } catch (error) {
            this.logger.warn(
                `Failed to set default branch for ${websiteOwner}/${websiteRepo}: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    /**
     * Updates an existing website repository based on the original creation method
     * @param directory - The directory to update
     * @param user - The user performing the update
     * @param options - Optional configuration (branch to use from template)
     */
    async updateRepository(
        directory: Directory,
        user: User,
        options?: { branch?: string },
    ): Promise<{
        method: string;
        message: string;
        commitSha?: string;
        branchSync?: BranchSyncSummary;
    }> {
        const directoryOwner = getDirectoryOwner(directory);
        const websiteOwner = directory.getRepoOwner('website');
        const websiteRepo = directory.getWebsiteRepo();
        const template = getWebsiteTemplateConfig(directory.websiteTemplateId);
        const branch = options?.branch || template.branch;

        // Check if the target repository exists
        const repositoryExists = await this.gitFacade.repositoryExists(websiteOwner, websiteRepo, {
            userId: directoryOwner.id,
            providerId: directory.gitProvider,
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
            { userId: directoryOwner.id, providerId: directory.gitProvider },
        );

        let updateResult: { method: string; message: string; commitSha?: string };

        try {
            // If fork fails, try duplicate method (clone original, replace remote)
            await this.updateDuplicate(directory, user, branch);
            updateResult = {
                method: 'duplicate',
                message: 'Successfully updated using duplicate method',
                commitSha: latestCommit?.sha,
            };
        } catch (error) {
            this.logger.warn(`Duplicate update failed: ${error.message}`);

            try {
                // If duplicate fails, try template method (clone both, replace files)
                await this.updateTemplate(directory, user, branch);
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
        const branchSync = await this.syncAllBranchesFromTemplate(directory, user);
        await this.ensureTemplateDefaultBranch(directory, directoryOwner.id);

        return {
            ...updateResult,
            branchSync: branchSync || undefined,
        };
    }

    /** Sync all branches from template to directory's website repo */
    async syncAllBranchesFromTemplate(
        directory: Directory,
        user: User,
    ): Promise<BranchSyncSummary | null> {
        return this.branchSyncService.syncFromTemplate(directory, user);
    }

    /**
     * Checks if an update is available from the template repository
     * @param directory - The directory to check
     * @returns Information about whether an update is available
     */
    async checkForUpdate(directory: Directory): Promise<{
        updateAvailable: boolean;
        latestCommit?: string;
        currentCommit?: string;
        branch: string;
        error?: string;
    }> {
        const directoryOwner = getDirectoryOwner(directory);
        const template = getWebsiteTemplateConfig(directory.websiteTemplateId);
        const branch = getWebsiteTemplateBranch(template, directory.websiteTemplateUseBeta);

        const hasCredentials = await this.gitFacade.hasValidCredentials({
            userId: directoryOwner.id,
            providerId: directory.gitProvider,
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
            { userId: directoryOwner.id, providerId: directory.gitProvider },
        );

        if (!latestCommit) {
            return { updateAvailable: false, branch };
        }

        return {
            updateAvailable: latestCommit.sha !== directory.websiteTemplateLastCommit,
            latestCommit: latestCommit.sha,
            currentCommit: directory.websiteTemplateLastCommit || undefined,
            branch,
        };
    }

    /**
     * Updates a forked repository by pulling from upstream
     */
    private async updateFork(directory: Directory, user: User): Promise<boolean> {
        const directoryOwner = getDirectoryOwner(directory);
        const committer = directory.resolveCommitter(user);
        const websiteOwner = directory.getRepoOwner('website');
        const websiteRepo = directory.getWebsiteRepo();
        const template = getWebsiteTemplateConfig(directory.websiteTemplateId);

        try {
            // Clone the target repository
            const targetDir = await this.gitFacade.cloneOrPull(
                {
                    owner: websiteOwner,
                    repo: websiteRepo,
                    committer,
                },
                { userId: directoryOwner.id, providerId: directory.gitProvider },
            );

            // Check if this is actually a fork by looking for upstream remote
            const isActualFork = await this.gitFacade.hasForkRelationship(
                websiteOwner,
                websiteRepo,
                template.owner,
                template.repo,
                { userId: directoryOwner.id, providerId: directory.gitProvider },
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
    private async updateDuplicate(
        directory: Directory,
        user: User,
        branch?: string,
    ): Promise<void> {
        const directoryOwner = getDirectoryOwner(directory);
        const websiteOwner = directory.getRepoOwner('website');
        const websiteRepo = directory.getWebsiteRepo();
        const template = getWebsiteTemplateConfig(directory.websiteTemplateId);
        const resolvedBranch = branch || template.branch;

        await this.gitFacade.removeLocalDir(directory.gitProvider, template.owner, template.repo);

        // Clone the original template repository
        const originalDir = await this.gitFacade.cloneOrPull(
            {
                owner: template.owner,
                repo: template.repo,
                branch: resolvedBranch,
                committer: directory.resolveCommitter(user),
            },
            { userId: directoryOwner.id, providerId: directory.gitProvider },
        );

        // Get the target repository URL
        const targetRepoUrl = this.gitFacade.getCloneUrl(
            directory.gitProvider,
            websiteOwner,
            websiteRepo,
        );

        // Remove existing origin and add new one
        await this.gitFacade.switchBranch(directory.gitProvider, originalDir, branch);
        await this.gitFacade.replaceRemote(
            directory.gitProvider,
            originalDir,
            'origin',
            targetRepoUrl,
        );

        // Push to the target repository
        await this.gitFacade.push(
            { dir: originalDir, force: true },
            { userId: directoryOwner.id, providerId: directory.gitProvider },
        );

        this.logger.log(
            `Successfully updated ${websiteOwner}/${websiteRepo} using duplicate method (branch: ${resolvedBranch})`,
        );
    }

    /**
     * Updates using template method: clone both repos, replace files, commit and push
     */
    private async updateTemplate(directory: Directory, user: User, branch?: string): Promise<void> {
        const directoryOwner = getDirectoryOwner(directory);
        const committer = directory.resolveCommitter(user);
        const websiteOwner = directory.getRepoOwner('website');
        const websiteRepo = directory.getWebsiteRepo();
        const template = getWebsiteTemplateConfig(directory.websiteTemplateId);
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
                { userId: directoryOwner.id, providerId: directory.gitProvider },
            ),

            this.gitFacade.cloneOrPull(
                {
                    owner: websiteOwner,
                    repo: websiteRepo,
                    branch: resolvedBranch,
                    committer,
                },
                { userId: directoryOwner.id, providerId: directory.gitProvider },
            ),
        ]);

        // Copy files from original to target (excluding .git directory)
        await this.copyRepositoryFiles(originalDir, targetDir);

        // Add, commit, and push changes
        await this.gitFacade.add(directory.gitProvider, targetDir, '.');

        await this.gitFacade.commit(
            directory.gitProvider,
            targetDir,
            `Update website from template (${resolvedBranch})`,
            committer,
        );

        await this.gitFacade.push(
            { dir: targetDir, force: true },
            { userId: directoryOwner.id, providerId: directory.gitProvider },
        );

        this.logger.log(
            `Successfully updated ${websiteOwner}/${websiteRepo} using template method (branch: ${resolvedBranch})`,
        );
    }

    /**
     * Copies files from source to destination, excluding .git directory
     */
    private async copyRepositoryFiles(sourceDir: string, targetDir: string): Promise<void> {
        const entries = await fs.readdir(sourceDir, { withFileTypes: true });

        for (const entry of entries) {
            if (entry.name === '.git') {
                continue; // Skip .git directory
            }

            const sourcePath = path.join(sourceDir, entry.name);
            const targetPath = path.join(targetDir, entry.name);

            if (entry.isDirectory()) {
                // Remove existing directory if it exists
                try {
                    await fs.rm(targetPath, { recursive: true, force: true });
                } catch (error) {
                    // Directory might not exist, which is fine
                }

                // Create new directory and copy contents
                await fs.mkdir(targetPath, { recursive: true });
                await this.copyRepositoryFiles(sourcePath, targetPath);
            } else {
                // Copy file
                await fs.copyFile(sourcePath, targetPath);
            }
        }
    }
}
