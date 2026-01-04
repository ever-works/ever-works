import { Injectable, Logger } from '@nestjs/common';
import { GithubService } from '../git/github.service';
import { BranchSyncService } from '../git/branch-sync.service';
import { WebsiteRepositoryCreationMethod } from '../items-generator/dto/create-items-generator.dto';
import { Directory } from '../entities/directory.entity';
import { User } from '../entities/user.entity';
import { WEBSITE_TEMPLATE_CONFIG } from './config/website-template.config';
import { config } from '@src/config';
import * as fs from 'node:fs/promises';

@Injectable()
export class WebsiteGeneratorService {
    private readonly logger = new Logger(WebsiteGeneratorService.name);

    constructor(
        private readonly githubService: GithubService,
        private readonly branchSyncService: BranchSyncService,
    ) {}

    private async duplicate(directory: Directory, user: User) {
        // Use directory owner's Git token (they set up the repos)
        // but use current user as committer for attribution
        const directoryOwner = directory.user as User;
        const token = directoryOwner.getGitToken();
        const committer = user.asCommitter();

        await this.cleanup(directory);

        if (directory.organization) {
            return this.githubService.duplicateAsOrg({
                originalRepoOwner: WEBSITE_TEMPLATE_CONFIG.owner,
                originalRepoName: WEBSITE_TEMPLATE_CONFIG.repo,
                branch: WEBSITE_TEMPLATE_CONFIG.branch,
                targetOrg: directory.getRepoOwner(),
                targetRepoName: directory.getWebsiteRepo(),
                token,
                committer,
            });
        }

        return this.githubService.duplicate({
            originalRepoOwner: WEBSITE_TEMPLATE_CONFIG.owner,
            originalRepoName: WEBSITE_TEMPLATE_CONFIG.repo,
            branch: WEBSITE_TEMPLATE_CONFIG.branch,
            targetRepoName: directory.getWebsiteRepo(),
            token,
            committer,
            forcePush: true,
        });
    }

    private async fork(directory: Directory, user: User) {
        // Use directory owner's Git token (they set up the repos)
        const directoryOwner = directory.user as User;
        const token = directoryOwner.getGitToken();

        return this.githubService.fork(
            {
                owner: WEBSITE_TEMPLATE_CONFIG.owner,
                repo: WEBSITE_TEMPLATE_CONFIG.repo,
                name: directory.getWebsiteRepo(),
                isOrganization: directory.organization,
            },
            token,
        );
    }

    private async createUsingTemplate(directory: Directory, user: User) {
        // Use directory owner's Git token (they set up the repos)
        const directoryOwner = directory.user as User;
        const token = directoryOwner.getGitToken();

        return this.githubService.createRepoFromTemplate(
            WEBSITE_TEMPLATE_CONFIG.owner,
            WEBSITE_TEMPLATE_CONFIG.repo,
            directory.getRepoOwner(),
            directory.getWebsiteRepo(),
            token,
        );
    }

    async initialize(
        directory: Directory,
        user: User,
        operation: WebsiteRepositoryCreationMethod = WebsiteRepositoryCreationMethod.DUPLICATE,
    ) {
        let path: any;
        try {
            if (operation === WebsiteRepositoryCreationMethod.DUPLICATE) {
                path = await this.duplicate(directory, user);
            } else if (operation === WebsiteRepositoryCreationMethod.CREATE_USING_TEMPLATE) {
                try {
                    path = await this.createUsingTemplate(directory, user);
                } catch {
                    path = await this.duplicate(directory, user);
                }
            } else {
                // Default to duplicate if an unknown operation is somehow passed
                path = await this.duplicate(directory, user);
            }

            // Sync all branches from template after initial setup
            await this.syncAllBranchesFromTemplate(directory, user);
        } finally {
            if (path && typeof path === 'string') {
                // cleanup
                await fs.rm(path, { recursive: true, force: true });
            }
        }
    }

    /** Sync all branches from template to directory's website repo */
    async syncAllBranchesFromTemplate(directory: Directory, user: User) {
        const directoryOwner = directory.user as User;
        const token = directoryOwner.getGitToken();

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
                token,
                committer: user.asCommitter(),
                forcePush: true,
                branchMapping,
            });

            this.logger.log(
                `Branch sync completed: ${result.synced} synced, ${result.errors} errors`,
            );

            return result;
        } catch (error) {
            this.logger.error(`Failed to sync branches from template: ${error.message}`);
            // Don't throw - branch sync failure shouldn't fail the entire initialization
            return null;
        }
    }

    /**
     * Remove repository for a directory
     */
    async removeRepository(directory: Directory, user: User): Promise<void> {
        // Use directory owner's Git token (they set up the repos)
        const directoryOwner = directory.user as User;
        const token = directoryOwner.getGitToken();
        const websiteRepo = directory.getWebsiteRepo();

        try {
            // Delete the GitHub repository
            await this.githubService.deleteRepository(directory.getRepoOwner(), websiteRepo, token);
        } catch (error) {
            throw error;
        }
    }

    public cleanup(directory: Directory) {
        const dataDir = this.githubService.getDir(
            directory.getRepoOwner(),
            directory.getWebsiteRepo(),
        );

        return fs.rm(dataDir, { recursive: true, force: true });
    }
}
