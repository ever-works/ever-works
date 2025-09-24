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
     */
    async updateRepository(
        directory: Directory,
        user: User,
    ): Promise<{ method: string; message: string }> {
        const token = user.getGitToken();
        const websiteRepo = directory.getWebsiteRepo();

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

        // Try to determine the creation method and update accordingly
        // Since we can't reliably determine the original creation method from GitHub API,
        // we'll try different update strategies in order of preference

        try {
            // First, try the fork method (pull from upstream)
            const forkResult = await this.updateFork(directory, user);
            if (forkResult) {
                return { method: 'fork', message: 'Successfully updated fork from upstream' };
            }
        } catch (error) {
            this.logger.warn(`Fork update failed: ${error.message}`);
        }

        try {
            // If fork fails, try duplicate method (clone original, replace remote)
            await this.updateDuplicate(directory, user);
            return { method: 'duplicate', message: 'Successfully updated using duplicate method' };
        } catch (error) {
            this.logger.warn(`Duplicate update failed: ${error.message}`);
        }

        try {
            // If duplicate fails, try template method (clone both, replace files)
            await this.updateTemplate(directory, user);
            return {
                method: 'create-using-template',
                message: 'Successfully updated using template method',
            };
        } catch (error) {
            this.logger.error(`Template update failed: ${error.message}`);
            throw new Error(`All update methods failed. Last error: ${error.message}`);
        }
    }

    /**
     * Updates a forked repository by pulling from upstream
     */
    private async updateFork(directory: Directory, user: User): Promise<boolean> {
        const token = user.getGitToken();
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
    private async updateDuplicate(directory: Directory, user: User): Promise<void> {
        const token = user.getGitToken();
        const websiteRepo = directory.getWebsiteRepo();

        // Clone the original template repository
        const originalDir = await this.githubService.cloneOrPull({
            owner: WEBSITE_TEMPLATE_CONFIG.owner,
            repo: WEBSITE_TEMPLATE_CONFIG.repo,
            token,
            committer: user.asCommitter(),
        });

        // Get the target repository URL
        const targetRepoUrl = this.githubService.getURL(directory.getRepoOwner(), websiteRepo);

        // Remove existing origin and add new one
        await this.githubService.remoteRemove(originalDir, 'origin');
        await this.githubService.remoteAdd(originalDir, 'origin', targetRepoUrl);

        // Push to the target repository
        await this.githubService.push(originalDir, token, true);

        this.logger.log(
            `Successfully updated ${directory.getRepoOwner()}/${websiteRepo} using duplicate method`,
        );
    }

    /**
     * Updates using template method: clone both repos, replace files, commit and push
     */
    private async updateTemplate(directory: Directory, user: User): Promise<void> {
        const token = user.getGitToken();
        const committer = user.asCommitter();

        const websiteRepo = directory.getWebsiteRepo();

        // Clone both repositories
        const [originalDir, targetDir] = await Promise.all([
            this.githubService.cloneOrPull({
                owner: WEBSITE_TEMPLATE_CONFIG.owner,
                repo: WEBSITE_TEMPLATE_CONFIG.repo,
                token,
                committer,
            }),

            this.githubService.cloneOrPull({
                owner: directory.getRepoOwner(),
                repo: websiteRepo,
                token,
                committer,
            }),
        ]);

        // Copy files from original to target (excluding .git directory)
        await this.copyRepositoryFiles(originalDir, targetDir);

        // Add, commit, and push changes
        await this.githubService.add(targetDir, '.');

        await this.githubService.commit(targetDir, 'Update website from template', committer);

        await this.githubService.push(targetDir, token);

        this.logger.log(
            `Successfully updated ${directory.getRepoOwner()}/${websiteRepo} using template method`,
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
