import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { GithubService } from '../git/github.service';
import { Directory } from '../entities/directory.entity';
import { User } from '../entities/user.entity';
import { WEBSITE_TEMPLATE_CONFIG } from './config/website-template.config';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

@Injectable()
export class WebsiteUpdateService {
    private readonly logger = new Logger(WebsiteUpdateService.name);

    constructor(private readonly githubService: GithubService) {}

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
    ): Promise<{ method: string; message: string; commitSha?: string }> {
        // Use directory owner's Git token (they set up the repos)
        const directoryOwner = directory.user as User;
        const token = directoryOwner.getGitToken();
        const websiteRepo = directory.getWebsiteRepo();
        const branch = options?.branch || WEBSITE_TEMPLATE_CONFIG.branch;

        // Check if the target repository exists
        const repositoryExists = await this.githubService.repositoryExists(
            directory.getRepoOwner(),
            websiteRepo,
            token,
        );
        if (!repositoryExists) {
            throw new NotFoundException(
                `Website repository '${directory.getRepoOwner()}/${websiteRepo}' does not exist`,
            );
        }

        // Get the latest commit SHA from the template branch
        const latestCommit = await this.githubService.getLatestCommit(
            WEBSITE_TEMPLATE_CONFIG.owner,
            WEBSITE_TEMPLATE_CONFIG.repo,
            branch,
            token,
        );

        try {
            // If fork fails, try duplicate method (clone original, replace remote)
            await this.updateDuplicate(directory, user, branch);
            return {
                method: 'duplicate',
                message: 'Successfully updated using duplicate method',
                commitSha: latestCommit?.sha,
            };
        } catch (error) {
            this.logger.warn(`Duplicate update failed: ${error.message}`);
        }

        try {
            // If duplicate fails, try template method (clone both, replace files)
            await this.updateTemplate(directory, user, branch);
            return {
                method: 'create-using-template',
                message: 'Successfully updated using template method',
                commitSha: latestCommit?.sha,
            };
        } catch (error) {
            this.logger.error(`Template update failed: ${error.message}`);
            throw new Error(`All update methods failed. Last error: ${error.message}`);
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
    }> {
        const directoryOwner = directory.user as User;
        const token = directoryOwner.getGitToken();
        const branch = directory.websiteTemplateUseBeta ? 'stage' : WEBSITE_TEMPLATE_CONFIG.branch;

        const latestCommit = await this.githubService.getLatestCommit(
            WEBSITE_TEMPLATE_CONFIG.owner,
            WEBSITE_TEMPLATE_CONFIG.repo,
            branch,
            token,
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
        // Use directory owner's Git token (they set up the repos)
        // but use current user as committer for attribution
        const directoryOwner = directory.user as User;
        const token = directoryOwner.getGitToken();
        const committer = user.asCommitter();

        const websiteRepo = directory.getWebsiteRepo();

        try {
            // Clone the target repository
            const targetDir = await this.githubService.cloneOrPull({
                owner: directory.getRepoOwner(),
                repo: websiteRepo,
                token,
                committer,
            });

            // Check if this is actually a fork by looking for upstream remote
            const isActualFork = await this.githubService.hasForkRelationship(
                directory.getRepoOwner(),
                websiteRepo,
                WEBSITE_TEMPLATE_CONFIG.owner,
                WEBSITE_TEMPLATE_CONFIG.repo,
                token,
            );

            if (!isActualFork) {
                return false; // Not a fork, can't use this method
            }

            // Add upstream remote if it doesn't exist
            await this.githubService.addUpstreamRemote(
                targetDir,
                WEBSITE_TEMPLATE_CONFIG.owner,
                WEBSITE_TEMPLATE_CONFIG.repo,
            );

            // Pull from upstream
            await this.githubService.pullFromUpstream(targetDir, token);

            // Push changes to origin
            await this.githubService.push(targetDir, token);

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
        // Use directory owner's Git token (they set up the repos)
        const directoryOwner = directory.user as User;
        const token = directoryOwner.getGitToken();
        const websiteRepo = directory.getWebsiteRepo();

        await this.githubService.removeDir(
            WEBSITE_TEMPLATE_CONFIG.owner,
            WEBSITE_TEMPLATE_CONFIG.repo,
        );

        // Clone the original template repository
        const originalDir = await this.githubService.cloneOrPull({
            owner: WEBSITE_TEMPLATE_CONFIG.owner,
            repo: WEBSITE_TEMPLATE_CONFIG.repo,
            branch,
            token,
            committer: user.asCommitter(),
        });

        // Get the target repository URL
        const targetRepoUrl = this.githubService.getURL(directory.getRepoOwner(), websiteRepo);

        // Remove existing origin and add new one
        await this.githubService.switchToBranch(originalDir, branch);
        await this.githubService.remoteRemove(originalDir, 'origin');
        await this.githubService.remoteAdd(originalDir, 'origin', targetRepoUrl);

        // Push to the target repository
        await this.githubService.push(originalDir, token, true);

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
        // Use directory owner's Git token (they set up the repos)
        // but use current user as committer for attribution
        const directoryOwner = directory.user as User;
        const token = directoryOwner.getGitToken();
        const committer = user.asCommitter();

        const websiteRepo = directory.getWebsiteRepo();

        // Clone both repositories
        const [originalDir, targetDir] = await Promise.all([
            this.githubService.cloneOrPull({
                owner: WEBSITE_TEMPLATE_CONFIG.owner,
                repo: WEBSITE_TEMPLATE_CONFIG.repo,
                branch,
                token,
                committer,
            }),

            this.githubService.cloneOrPull({
                owner: directory.getRepoOwner(),
                branch,
                repo: websiteRepo,
                token,
                committer,
            }),
        ]);

        // Copy files from original to target (excluding .git directory)
        await this.copyRepositoryFiles(originalDir, targetDir);

        // Add, commit, and push changes
        await this.githubService.add(targetDir, '.');

        await this.githubService.commit(
            targetDir,
            `Update website from template (${branch})`,
            committer,
        );

        await this.githubService.push(targetDir, token);

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
}
