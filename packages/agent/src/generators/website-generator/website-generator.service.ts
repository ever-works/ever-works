import { Injectable, Logger } from '@nestjs/common';
import { GitFacadeService } from '../../facades/git.facade';
import { BranchSyncService } from './branch-sync.service';
import { WebsiteRepositoryCreationMethod } from '../../items-generator/dto/create-items-generator.dto';
import { Directory } from '../../entities/directory.entity';
import { User } from '../../entities/user.entity';
import { WEBSITE_TEMPLATE_CONFIG } from './config/website-template.config';
import { getDirectoryOwner } from '../../utils/directory.utils';
import * as fs from 'node:fs/promises';

@Injectable()
export class WebsiteGeneratorService {
    private readonly logger = new Logger(WebsiteGeneratorService.name);

    constructor(
        private readonly gitFacade: GitFacadeService,
        private readonly branchSyncService: BranchSyncService,
    ) {}

    private async duplicate(directory: Directory, user: User) {
        const directoryOwner = getDirectoryOwner(directory);
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
            { userId: directoryOwner.id, providerId: directory.gitProvider },
        );

        // Create target repo
        await this.gitFacade.createRepository(
            {
                name: directory.getWebsiteRepo(),
                description: `Website for ${directory.name}`,
                organization: directory.organization ? directory.getRepoOwner() : undefined,
                isPrivate: true,
            },
            { userId: directoryOwner.id, providerId: directory.gitProvider },
        );

        // Push template to target repo
        const targetCloneUrl = this.gitFacade.getCloneUrl(
            directory.gitProvider,
            directory.getRepoOwner(),
            directory.getWebsiteRepo(),
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
            { userId: directoryOwner.id, providerId: directory.gitProvider },
        );

        return templateDir;
    }

    private async createUsingTemplate(directory: Directory, user: User) {
        const directoryOwner = getDirectoryOwner(directory);

        return this.gitFacade.createRepositoryFromTemplate(
            WEBSITE_TEMPLATE_CONFIG.owner,
            WEBSITE_TEMPLATE_CONFIG.repo,
            {
                name: directory.getWebsiteRepo(),
                organization: directory.organization ? directory.getRepoOwner() : undefined,
                isPrivate: true,
            },
            { userId: directoryOwner.id, providerId: directory.gitProvider },
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
            await this.syncAllBranchesFromTemplate(directory, user, true);
        } finally {
            if (path && typeof path === 'string') {
                // cleanup
                await fs.rm(path, { recursive: true, force: true });
            }
        }
    }

    /** Sync all branches from template to directory's website repo */
    async syncAllBranchesFromTemplate(directory: Directory, user: User, cleanupExtraBranches = false) {
        return this.branchSyncService.syncFromTemplate(directory, user, cleanupExtraBranches);
    }

    /**
     * Remove repository for a directory
     */
    async removeRepository(directory: Directory, user: User): Promise<void> {
        const directoryOwner = getDirectoryOwner(directory);
        const websiteRepo = directory.getWebsiteRepo();

        try {
            await this.gitFacade.deleteRepository(directory.getRepoOwner(), websiteRepo, {
                userId: directoryOwner.id,
                providerId: directory.gitProvider,
            });
        } catch (error) {
            throw error;
        }
    }

    public cleanup(directory: Directory) {
        const dataDir = this.gitFacade.getLocalDir(
            directory.gitProvider,
            directory.getRepoOwner(),
            directory.getWebsiteRepo(),
        );

        return fs.rm(dataDir, { recursive: true, force: true });
    }
}
