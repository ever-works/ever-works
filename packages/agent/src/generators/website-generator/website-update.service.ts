import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { GitFacadeService } from '../../facades/git.facade';
import { BranchSyncService, BranchSyncSummary } from './branch-sync.service';
import { Directory } from '../../entities/directory.entity';
import { User } from '../../entities/user.entity';
import { WEBSITE_TEMPLATE_CONFIG } from './config/website-template.config';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { config } from '@src/config';

@Injectable()
export class WebsiteUpdateService {
    private readonly logger = new Logger(WebsiteUpdateService.name);

    constructor(
        private readonly gitFacade: GitFacadeService,
        private readonly branchSyncService: BranchSyncService,
    ) {}

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
        const directoryOwner = directory.user as User;
        const websiteRepo = directory.getWebsiteRepo();
        const branch = options?.branch || WEBSITE_TEMPLATE_CONFIG.branch;

        // Check if the target repository exists
        const repositoryExists = await this.gitFacade.repositoryExists(
            directory.getRepoOwner(),
            websiteRepo,
            { userId: directoryOwner.id, providerId: directory.gitProvider },
        );
        if (!repositoryExists) {
            throw new NotFoundException(
                `Website repository '${directory.getRepoOwner()}/${websiteRepo}' does not exist`,
            );
        }

        // Get the latest commit SHA from the template branch
        const latestCommit = await this.gitFacade.getLatestCommit(
            WEBSITE_TEMPLATE_CONFIG.owner,
            WEBSITE_TEMPLATE_CONFIG.repo,
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
        const directoryOwner = directory.user as User;

        const branchMapping = directory.websiteTemplateUseBeta
            ? { [config.websiteTemplate.getBetaBranch()]: 'main' }
            : undefined;

        this.logger.log(
            `Syncing all branches from template to ${directory.getRepoOwner()}/${directory.getWebsiteRepo()}` +
                (branchMapping ? ` (beta: ${Object.keys(branchMapping)[0]}→main)` : ''),
        );

        try {
            const result = await this.branchSyncService.syncAllBranches({
                targetOwner: directory.getRepoOwner(),
                targetRepo: directory.getWebsiteRepo(),
                userId: directoryOwner.id,
                committer: user.asCommitter(),
                forcePush: true,
                branchMapping,
                providerId: directory.gitProvider,
            });

            this.logger.log(
                `Branch sync completed: ${result.synced} synced, ${result.errors} errors`,
            );

            return result;
        } catch (error) {
            this.logger.error(`Failed to sync branches from template: ${error.message}`);
            // Don't throw - branch sync failure shouldn't fail the entire update
            return null;
        }
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
        const directoryOwner = directory.user as User;
        const branch = directory.websiteTemplateUseBeta
            ? config.websiteTemplate.getBetaBranch()
            : WEBSITE_TEMPLATE_CONFIG.branch;

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
            WEBSITE_TEMPLATE_CONFIG.owner,
            WEBSITE_TEMPLATE_CONFIG.repo,
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
        const directoryOwner = directory.user as User;
        const committer = user.asCommitter();
        const websiteRepo = directory.getWebsiteRepo();

        try {
            // Clone the target repository
            const targetDir = await this.gitFacade.cloneOrPull(
                {
                    owner: directory.getRepoOwner(),
                    repo: websiteRepo,
                    committer,
                },
                { userId: directoryOwner.id, providerId: directory.gitProvider },
            );

            // Check if this is actually a fork by looking for upstream remote
            const isActualFork = await this.gitFacade.hasForkRelationship(
                directory.getRepoOwner(),
                websiteRepo,
                WEBSITE_TEMPLATE_CONFIG.owner,
                WEBSITE_TEMPLATE_CONFIG.repo,
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
        branch: string = WEBSITE_TEMPLATE_CONFIG.branch,
    ): Promise<void> {
        const directoryOwner = directory.user as User;
        const websiteRepo = directory.getWebsiteRepo();

        await this.gitFacade.removeLocalDir(
            directory.gitProvider,
            WEBSITE_TEMPLATE_CONFIG.owner,
            WEBSITE_TEMPLATE_CONFIG.repo,
        );

        // Clone the original template repository
        const originalDir = await this.gitFacade.cloneOrPull(
            {
                owner: WEBSITE_TEMPLATE_CONFIG.owner,
                repo: WEBSITE_TEMPLATE_CONFIG.repo,
                branch,
                committer: user.asCommitter(),
            },
            { userId: directoryOwner.id, providerId: directory.gitProvider },
        );

        // Get the target repository URL
        const targetRepoUrl = this.gitFacade.getCloneUrl(
            directory.gitProvider,
            directory.getRepoOwner(),
            websiteRepo,
        );

        // Remove existing origin and add new one
        await this.gitFacade.switchBranch(directory.gitProvider, originalDir, branch);
        await this.updateRemote(originalDir, targetRepoUrl);

        // Push to the target repository
        await this.gitFacade.push(
            { dir: originalDir, force: true },
            { userId: directoryOwner.id, providerId: directory.gitProvider },
        );

        this.logger.log(
            `Successfully updated ${directory.getRepoOwner()}/${websiteRepo} using duplicate method (branch: ${branch})`,
        );
    }

    /**
     * Updates using template method: clone both repos, replace files, commit and push
     */
    private async updateTemplate(
        directory: Directory,
        user: User,
        branch: string = WEBSITE_TEMPLATE_CONFIG.branch,
    ): Promise<void> {
        const directoryOwner = directory.user as User;
        const committer = user.asCommitter();
        const websiteRepo = directory.getWebsiteRepo();

        // Clone both repositories
        const [originalDir, targetDir] = await Promise.all([
            this.gitFacade.cloneOrPull(
                {
                    owner: WEBSITE_TEMPLATE_CONFIG.owner,
                    repo: WEBSITE_TEMPLATE_CONFIG.repo,
                    branch,
                    committer,
                },
                { userId: directoryOwner.id, providerId: directory.gitProvider },
            ),

            this.gitFacade.cloneOrPull(
                {
                    owner: directory.getRepoOwner(),
                    repo: websiteRepo,
                    branch,
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
            `Update website from template (${branch})`,
            committer,
        );

        await this.gitFacade.push(
            { dir: targetDir, force: true },
            { userId: directoryOwner.id, providerId: directory.gitProvider },
        );

        this.logger.log(
            `Successfully updated ${directory.getRepoOwner()}/${websiteRepo} using template method (branch: ${branch})`,
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

    private async updateRemote(dir: string, newRemoteUrl: string): Promise<void> {
        const git = await import('isomorphic-git');
        const nodeFs = await import('node:fs');

        try {
            await git.deleteRemote({ fs: nodeFs.default, dir, remote: 'origin' });
        } catch {
            // Remote might not exist
        }

        await git.addRemote({ fs: nodeFs.default, dir, remote: 'origin', url: newRemoteUrl });
    }
}
