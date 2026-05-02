import {
    BadRequestException,
    HttpException,
    Injectable,
    Logger,
    NotFoundException,
} from '@nestjs/common';
import { DirectoryRepository } from '@src/database/repositories/directory.repository';
import { DataGeneratorService } from '@src/generators/data-generator/data-generator.service';
import { MarkdownGeneratorService } from '@src/generators/markdown-generator/markdown-generator.service';
import { WebsiteGeneratorService } from '@src/generators/website-generator/website-generator.service';
import { WebsiteUpdateService } from '@src/generators/website-generator/website-update.service';
import { CreateDirectoryDto } from '@src/dto/create-directory.dto';
import { UpdateDirectoryDto } from '@src/dto';
import { DeleteDirectoryDto, DeleteDirectoryResponseDto } from '@src/items-generator/dto';
import { Directory } from '@src/entities/directory.entity';
import { User } from '@src/entities/user.entity';
import { DirectoryOwnershipService } from './directory-ownership.service';
import { rethrowAsNormalized } from './utils/error.utils';
import { GenerateStatusType } from '@src/entities/types';
import { DeployFacadeService } from '@src/facades/deploy.facade';
import {
    findWebsiteTemplateConfig,
    getDefaultWebsiteTemplateId,
    SwitchWebsiteTemplateResponseDto,
} from '@src/generators/website-generator';
import { GitFacadeService } from '@src/facades/git.facade';
import { WebsiteRepositoryCreationMethod } from '@src/items-generator/dto/create-items-generator.dto';

@Injectable()
export class DirectoryLifecycleService {
    private readonly logger = new Logger(DirectoryLifecycleService.name);

    constructor(
        private readonly directoryRepository: DirectoryRepository,
        private readonly dataGenerator: DataGeneratorService,
        private readonly markdownGenerator: MarkdownGeneratorService,
        private readonly websiteGenerator: WebsiteGeneratorService,
        private readonly websiteUpdateService: WebsiteUpdateService,
        private readonly ownershipService: DirectoryOwnershipService,
        private readonly deployFacade: DeployFacadeService,
        private readonly gitFacade: GitFacadeService,
    ) {}

    private isMissingWebsiteRepositoryError(error: unknown): boolean {
        if (error instanceof NotFoundException) {
            return true;
        }

        const errorStatus =
            typeof error === 'object' && error !== null && 'status' in error
                ? Number((error as { status?: unknown }).status)
                : undefined;
        const errorMessage = error instanceof Error ? error.message : String(error);
        const normalizedMessage = errorMessage.toLowerCase();

        return (
            errorStatus === 404 ||
            errorMessage.includes('404') ||
            normalizedMessage.includes('not found') ||
            normalizedMessage.includes('does not exist')
        );
    }

    private async hasInitializedWebsiteRepository(
        directory: Directory,
        user: User,
    ): Promise<boolean> {
        if (
            directory.website ||
            directory.deployProjectId ||
            directory.websiteTemplateLastCommit ||
            directory.websiteTemplateLastUpdatedAt ||
            directory.websiteTemplateLastCheckedAt
        ) {
            return true;
        }

        const userIds = [...new Set([user.id, directory.userId].filter(Boolean))];

        for (const userId of userIds) {
            const authOptions = {
                userId,
                providerId: directory.gitProvider,
                directoryId: directory.id,
            };

            const hasCredentials = await this.gitFacade.hasValidCredentials(authOptions);
            if (!hasCredentials) {
                continue;
            }

            try {
                const exists = await this.gitFacade.repositoryExists(
                    directory.getRepoOwner('website'),
                    directory.getWebsiteRepo(),
                    authOptions,
                );

                if (exists) {
                    return true;
                }
            } catch (error) {
                this.logger.warn(
                    `Failed to verify website repository initialization for directory ${directory.id}: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
            }
        }

        return false;
    }

    async createDirectory(createDirectoryDto: CreateDirectoryDto, user: User) {
        const {
            slug,
            name,
            description,
            owner,
            readmeConfig,
            organization,
            gitProvider,
            deployProvider,
            websiteTemplateId,
        } = createDirectoryDto;

        if (websiteTemplateId && !findWebsiteTemplateConfig(websiteTemplateId)) {
            throw new BadRequestException({
                status: 'error',
                message: `Unsupported website template: ${websiteTemplateId}`,
            });
        }

        const directoryData: Partial<CreateDirectoryDto & { userId: string }> = {
            slug,
            name,
            description,
            userId: user.id,
            owner,
            gitProvider,
            deployProvider,
            websiteTemplateId: websiteTemplateId || getDefaultWebsiteTemplateId(),
            readmeConfig,
            organization,
        };

        try {
            const dir = await this.directoryRepository.create(directoryData, user);
            dir.owner = dir.getRepoOwner();

            const items = await this.dataGenerator.getItems(dir, user).catch(() => []);
            if (items.length > 0) {
                await this.directoryRepository.updateGenerateStatus(dir.id, {
                    status: GenerateStatusType.GENERATED,
                });
            }

            return {
                status: 'success',
                directory: dir,
            };
        } catch (error) {
            rethrowAsNormalized(error, this.logger, 'creating directory');
        }
    }

    async updateDirectory(id: string, updateDto: UpdateDirectoryDto, user: User) {
        // Require at least editor role to update directory
        const { directory } = await this.ownershipService.ensureCanEdit(id, user.id);

        try {
            // Build update data object
            const updateData: Record<string, any> = {
                name: updateDto.name || directory.name,
                description: updateDto.description || directory.description,
                owner: updateDto.owner ?? directory.owner,
                organization:
                    updateDto.organization !== undefined
                        ? updateDto.organization
                        : directory.organization,
                readmeConfig: updateDto.readmeConfig ?? directory.readmeConfig,
            };

            // Handle deployProvider update with validation
            if (updateDto.deployProvider !== undefined) {
                if (updateDto.deployProvider) {
                    const availableProviders = this.deployFacade.getAvailableProviders();
                    const isSupported = availableProviders.some(
                        (p) => p.id === updateDto.deployProvider,
                    );
                    if (!isSupported) {
                        throw new BadRequestException({
                            status: 'error',
                            message: `Unsupported deploy provider: ${updateDto.deployProvider}`,
                        });
                    }
                }
                updateData.deployProvider = updateDto.deployProvider;
            }

            // Handle website template auto-update settings
            if (updateDto.websiteTemplateAutoUpdate !== undefined) {
                updateData.websiteTemplateAutoUpdate = updateDto.websiteTemplateAutoUpdate;
            }

            if (updateDto.websiteTemplateUseBeta !== undefined) {
                updateData.websiteTemplateUseBeta = updateDto.websiteTemplateUseBeta;
                // Clear last commit when switching branches to force re-check
                if (updateDto.websiteTemplateUseBeta !== directory.websiteTemplateUseBeta) {
                    updateData.websiteTemplateLastCommit = null;
                }
            }

            if (updateDto.websiteTemplateId !== undefined) {
                const nextTemplateId = updateDto.websiteTemplateId || getDefaultWebsiteTemplateId();

                if (!findWebsiteTemplateConfig(nextTemplateId)) {
                    throw new BadRequestException({
                        status: 'error',
                        message: `Unsupported website template: ${nextTemplateId}`,
                    });
                }

                if (nextTemplateId !== directory.websiteTemplateId) {
                    const websiteRepoInitialized = await this.hasInitializedWebsiteRepository(
                        directory,
                        user,
                    );

                    if (websiteRepoInitialized) {
                        throw new BadRequestException({
                            status: 'error',
                            message:
                                'Website template cannot be changed after the website repository has been initialized.',
                        });
                    }
                }

                updateData.websiteTemplateId = nextTemplateId;
            }

            // Handle community PR processing settings
            if (updateDto.communityPrEnabled !== undefined) {
                updateData.communityPrEnabled = updateDto.communityPrEnabled;
            }
            if (updateDto.communityPrAutoClose !== undefined) {
                updateData.communityPrAutoClose = updateDto.communityPrAutoClose;
            }

            // Handle committer overrides (allow null to clear them)
            if (updateDto.committerName !== undefined) {
                updateData.committerName = updateDto.committerName || null;
            }
            if (updateDto.committerEmail !== undefined) {
                updateData.committerEmail = updateDto.committerEmail || null;
            }

            const updatedDirectory = await this.directoryRepository.update(id, updateData);

            if (!updatedDirectory) {
                throw new NotFoundException({ status: 'error', message: 'Directory not found' });
            }

            updatedDirectory.owner = updatedDirectory.getRepoOwner();

            return {
                status: 'success',
                directory: updatedDirectory,
            };
        } catch (error) {
            rethrowAsNormalized(error, this.logger, 'updating directory');
        }
    }

    async switchWebsiteTemplate(
        id: string,
        websiteTemplateId: string,
        user: User,
    ): Promise<SwitchWebsiteTemplateResponseDto> {
        const { directory } = await this.ownershipService.ensureCanEdit(id, user.id);
        const nextTemplateId = websiteTemplateId || getDefaultWebsiteTemplateId();

        if (!findWebsiteTemplateConfig(nextTemplateId)) {
            throw new BadRequestException({
                status: 'error',
                message: `Unsupported website template: ${nextTemplateId}`,
            });
        }

        const websiteRepoInitialized = await this.hasInitializedWebsiteRepository(directory, user);
        const websiteOwner = directory.getRepoOwner('website');
        const websiteRepo = directory.getWebsiteRepo();

        if (nextTemplateId === directory.websiteTemplateId) {
            return {
                status: 'success',
                slug: directory.slug,
                owner: websiteOwner,
                repository: `${websiteOwner}/${websiteRepo}`,
                websiteTemplateId: directory.websiteTemplateId,
                repositoryRecreated: false,
                message: websiteRepoInitialized
                    ? 'Website template is already selected for this directory.'
                    : 'Website template saved. It will be used when the website repository is first created.',
            };
        }

        const updateData = {
            websiteTemplateId: nextTemplateId,
            websiteTemplateLastCommit: null,
            websiteTemplateLastError: null,
            websiteTemplateLastUpdatedAt: null,
            websiteTemplateLastCheckedAt: null,
        };

        const previousTemplateId = directory.websiteTemplateId;
        const previousTemplateLastCommit = directory.websiteTemplateLastCommit;
        const previousTemplateLastError = directory.websiteTemplateLastError;
        const previousTemplateLastUpdatedAt = directory.websiteTemplateLastUpdatedAt;
        const previousTemplateLastCheckedAt = directory.websiteTemplateLastCheckedAt;

        directory.websiteTemplateId = nextTemplateId;
        directory.websiteTemplateLastCommit = null;
        directory.websiteTemplateLastError = null;
        directory.websiteTemplateLastUpdatedAt = null;
        directory.websiteTemplateLastCheckedAt = null;

        if (websiteRepoInitialized) {
            try {
                await this.websiteUpdateService.updateRepository(directory, user);
            } catch (error) {
                if (!this.isMissingWebsiteRepositoryError(error)) {
                    directory.websiteTemplateId = previousTemplateId;
                    directory.websiteTemplateLastCommit = previousTemplateLastCommit;
                    directory.websiteTemplateLastError = previousTemplateLastError;
                    directory.websiteTemplateLastUpdatedAt = previousTemplateLastUpdatedAt;
                    directory.websiteTemplateLastCheckedAt = previousTemplateLastCheckedAt;
                    throw error;
                }

                this.logger.warn(
                    `Website repository for directory ${directory.id} was missing during template switch. Recreating from template.`,
                );

                try {
                    await this.websiteGenerator.initialize(
                        directory,
                        user,
                        WebsiteRepositoryCreationMethod.CREATE_USING_TEMPLATE,
                    );
                } catch (initializeError) {
                    directory.websiteTemplateId = previousTemplateId;
                    directory.websiteTemplateLastCommit = previousTemplateLastCommit;
                    directory.websiteTemplateLastError = previousTemplateLastError;
                    directory.websiteTemplateLastUpdatedAt = previousTemplateLastUpdatedAt;
                    directory.websiteTemplateLastCheckedAt = previousTemplateLastCheckedAt;
                    throw initializeError;
                }
            }

            await this.directoryRepository.update(id, updateData);

            return {
                status: 'success',
                slug: directory.slug,
                owner: websiteOwner,
                repository: `${websiteOwner}/${websiteRepo}`,
                websiteTemplateId: nextTemplateId,
                repositoryRecreated: true,
                message:
                    'Website template switched successfully. The website repository was reset from the selected template.',
            };
        }

        await this.directoryRepository.update(id, updateData);

        return {
            status: 'success',
            slug: directory.slug,
            owner: websiteOwner,
            repository: `${websiteOwner}/${websiteRepo}`,
            websiteTemplateId: nextTemplateId,
            repositoryRecreated: false,
            message:
                'Website template updated successfully. It will be used when the website repository is first created.',
        };
    }

    async syncFromDataRepository(directoryId: string, user: User) {
        // Require at least editor role to sync
        const { directory } = await this.ownershipService.ensureCanEdit(directoryId, user.id);
        const updates: Record<string, any> = {};

        try {
            const snapshot = await this.dataGenerator.getDataSyncSnapshot(directory, user);

            if (
                typeof snapshot.itemsCount === 'number' &&
                directory.itemsCount !== snapshot.itemsCount
            ) {
                updates.itemsCount = snapshot.itemsCount;
            }

            const prUpdate = snapshot.prUpdate;
            if (prUpdate && (!directory.lastPullRequest || !directory.lastPullRequest.data)) {
                updates.lastPullRequest = {
                    ...(directory.lastPullRequest || {}),
                    data: prUpdate,
                };
            }

            updates.readmeConfig = directory.readmeConfig || {};

            // Sync readme config from markdown templates
            const markdownTemplate = snapshot.readmeTemplate;
            if (markdownTemplate?.header && !directory.readmeConfig?.header) {
                updates.readmeConfig.header = markdownTemplate.header;
                updates.readmeConfig.overwriteDefaultHeader = true;
            }

            if (markdownTemplate?.footer && !directory.readmeConfig?.footer) {
                updates.readmeConfig.footer = markdownTemplate.footer;
                updates.readmeConfig.overwriteDefaultFooter = true;
            }

            if (Object.keys(updates).length > 0) {
                await this.directoryRepository.update(directory.id, updates);
            }

            return {
                status: 'success',
                updated: Object.keys(updates),
                message:
                    Object.keys(updates).length > 0
                        ? 'Directory synced from data repository.'
                        : 'Directory already up to date.',
            };
        } catch (error) {
            rethrowAsNormalized(error, this.logger, 'syncing directory from data repository');
        }
    }

    async deleteDirectory(
        directoryId: string,
        deleteDirectoryDto: DeleteDirectoryDto,
        user: User,
    ): Promise<DeleteDirectoryResponseDto> {
        // Only owners can delete directories
        const { directory } = await this.ownershipService.ensureIsOwner(directoryId, user.id);

        try {
            const deletedRepositories: string[] = [];

            if (deleteDirectoryDto.delete_data_repository !== false) {
                try {
                    await this.dataGenerator.removeRepository(directory, user);
                    deletedRepositories.push(
                        `${directory.getRepoOwner()}/${directory.getDataRepo()}`,
                    );
                } catch (error) {
                    if (error instanceof HttpException) {
                        throw error;
                    }

                    this.logger.error('Failed to delete data repository:', error);
                }
            }

            if (deleteDirectoryDto.delete_markdown_repository !== false) {
                try {
                    await this.markdownGenerator.removeRepository(directory, user);
                    deletedRepositories.push(
                        `${directory.getRepoOwner('directory')}/${directory.getMainRepo()}`,
                    );
                } catch (error) {
                    if (error instanceof HttpException) {
                        throw error;
                    }

                    this.logger.error('Failed to delete markdown repository:', error);
                }
            }

            if (deleteDirectoryDto.delete_website_repository !== false) {
                try {
                    await this.websiteGenerator.removeRepository(directory, user);
                    deletedRepositories.push(
                        `${directory.getRepoOwner('website')}/${directory.getWebsiteRepo()}`,
                    );
                } catch (error) {
                    if (error instanceof HttpException) {
                        throw error;
                    }

                    this.logger.error('Failed to delete website repository:', error);
                }
            }

            await this.directoryRepository.delete(directory.id);

            await Promise.all([
                this.dataGenerator.cleanup(directory),
                this.markdownGenerator.cleanup(directory),
                this.websiteGenerator.cleanup(directory),
            ]).catch((error) => this.logger.error('Failed to cleanup repositories:', error));

            return {
                status: 'success',
                slug: directory.slug,
                message: `Directory '${directory.slug}' and associated repositories have been deleted`,
                deleted_repositories: deletedRepositories,
            };
        } catch (error) {
            rethrowAsNormalized(error, this.logger, 'deleting directory', {
                slug: directory?.slug || '',
            });
        }
    }
}
