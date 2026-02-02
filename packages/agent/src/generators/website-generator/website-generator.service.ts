import { Injectable, Logger } from '@nestjs/common';
import { GitFacadeService } from '../../facades/git.facade';
import { BranchSyncService } from './branch-sync.service';
import { WebsiteRepositoryCreationMethod } from '../../items-generator/dto/create-items-generator.dto';
import { Directory } from '../../entities/directory.entity';
import { User } from '../../entities/user.entity';
import { WEBSITE_TEMPLATE_CONFIG } from './config/website-template.config';
import { config } from '@src/config';
import * as fs from 'node:fs/promises';

@Injectable()
export class WebsiteGeneratorService {
    private readonly logger = new Logger(WebsiteGeneratorService.name);

    constructor(
        private readonly gitFacade: GitFacadeService,
        private readonly branchSyncService: BranchSyncService,
    ) {}

    private async duplicate(directory: Directory, user: User) {
        const directoryOwner = directory.user as User;
        const committer = user.asCommitter();

        await this.cleanup(directory);

        // Clone template repo
        const templateDir = await this.gitFacade.cloneOrPull(
            {
                owner: WEBSITE_TEMPLATE_CONFIG.owner,
                repo: WEBSITE_TEMPLATE_CONFIG.repo,
                branch: WEBSITE_TEMPLATE_CONFIG.branch,
                committer,
            },
            { userId: directoryOwner.id, providerId: directory.repoProvider },
        );

        // Create target repo
        await this.gitFacade.createRepository(
            {
                name: directory.getWebsiteRepo(),
                description: `Website for ${directory.name}`,
                organization: directory.organization ? directory.getRepoOwner() : undefined,
                isPrivate: true,
            },
            { userId: directoryOwner.id, providerId: directory.repoProvider },
        );

        // Push template to target repo
        const targetCloneUrl = this.gitFacade.getCloneUrl(
            directory.repoProvider,
            directory.getRepoOwner(),
            directory.getWebsiteRepo(),
        );

        // Remove origin and add new one pointing to target
        await this.removeAndAddRemote(templateDir, targetCloneUrl);

        // Push to target
        await this.gitFacade.push(
            { dir: templateDir, force: true },
            { userId: directoryOwner.id, providerId: directory.repoProvider },
        );

        return templateDir;
    }

    private async createUsingTemplate(directory: Directory, user: User) {
        const directoryOwner = directory.user as User;

        return this.gitFacade.createRepositoryFromTemplate(
            WEBSITE_TEMPLATE_CONFIG.owner,
            WEBSITE_TEMPLATE_CONFIG.repo,
            {
                name: directory.getWebsiteRepo(),
                organization: directory.organization ? directory.getRepoOwner() : undefined,
                isPrivate: true,
            },
            { userId: directoryOwner.id, providerId: directory.repoProvider },
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
                providerId: directory.repoProvider,
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
        const directoryOwner = directory.user as User;
        const websiteRepo = directory.getWebsiteRepo();

        try {
            await this.gitFacade.deleteRepository(directory.getRepoOwner(), websiteRepo, {
                userId: directoryOwner.id,
                providerId: directory.repoProvider,
            });
        } catch (error) {
            throw error;
        }
    }

    public cleanup(directory: Directory) {
        const dataDir = this.gitFacade.getLocalDir(
            directory.repoProvider,
            directory.getRepoOwner(),
            directory.getWebsiteRepo(),
        );

        return fs.rm(dataDir, { recursive: true, force: true });
    }

    private async removeAndAddRemote(dir: string, newRemoteUrl: string): Promise<void> {
        // Use isomorphic-git to remove and add remote
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
