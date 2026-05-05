import {
    BadRequestException,
    HttpException,
    Injectable,
    Logger,
    NotFoundException,
} from '@nestjs/common';
import { WorkRepository } from '@src/database/repositories/work.repository';
import { DataGeneratorService } from '@src/generators/data-generator/data-generator.service';
import { MarkdownGeneratorService } from '@src/generators/markdown-generator/markdown-generator.service';
import { WebsiteGeneratorService } from '@src/generators/website-generator/website-generator.service';
import { WebsiteUpdateService } from '@src/generators/website-generator/website-update.service';
import { CreateWorkDto } from '@src/dto/create-work.dto';
import { UpdateWorkDto } from '@src/dto';
import { DeleteWorkDto, DeleteWorkResponseDto } from '@src/items-generator/dto';
import { Work } from '@src/entities/work.entity';
import { User } from '@src/entities/user.entity';
import { WorkOwnershipService } from './work-ownership.service';
import { rethrowAsNormalized } from './utils/error.utils';
import { GenerateStatusType } from '@src/entities/types';
import { DeployFacadeService } from '@src/facades/deploy.facade';
import {
    getDefaultWebsiteTemplateId,
    SwitchWebsiteTemplateResponseDto,
} from '@src/generators/website-generator';
import { GitFacadeService } from '@src/facades/git.facade';
import { WebsiteRepositoryCreationMethod } from '@src/items-generator/dto/create-items-generator.dto';
import { TemplateCatalogService } from './template-catalog.service';

@Injectable()
export class WorkLifecycleService {
    private readonly logger = new Logger(WorkLifecycleService.name);

    constructor(
        private readonly workRepository: WorkRepository,
        private readonly dataGenerator: DataGeneratorService,
        private readonly markdownGenerator: MarkdownGeneratorService,
        private readonly websiteGenerator: WebsiteGeneratorService,
        private readonly websiteUpdateService: WebsiteUpdateService,
        private readonly ownershipService: WorkOwnershipService,
        private readonly deployFacade: DeployFacadeService,
        private readonly gitFacade: GitFacadeService,
        private readonly templateCatalogService: TemplateCatalogService,
    ) {}

    private normalizeWebsiteTemplateSelection(value?: string | null): string | null {
        const normalized = value?.trim();
        return normalized ? normalized : null;
    }

    private async getEffectiveWebsiteTemplateId(
        work: Pick<Work, 'websiteTemplateId'>,
        userId: string,
    ): Promise<string> {
        return (
            this.normalizeWebsiteTemplateSelection(work.websiteTemplateId) ||
            (await this.templateCatalogService.getDefaultTemplateIdForUser('website', userId)) ||
            getDefaultWebsiteTemplateId()
        );
    }

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

    private async hasInitializedWebsiteRepository(work: Work, user: User): Promise<boolean> {
        if (
            work.website ||
            work.deployProjectId ||
            work.websiteTemplateLastCommit ||
            work.websiteTemplateLastUpdatedAt ||
            work.websiteTemplateLastCheckedAt
        ) {
            return true;
        }

        const userIds = [...new Set([user.id, work.userId].filter(Boolean))];

        for (const userId of userIds) {
            const authOptions = {
                userId,
                providerId: work.gitProvider,
                workId: work.id,
            };

            const hasCredentials = await this.gitFacade.hasValidCredentials(authOptions);
            if (!hasCredentials) {
                continue;
            }

            try {
                const exists = await this.gitFacade.repositoryExists(
                    work.getRepoOwner('website'),
                    work.getWebsiteRepo(),
                    authOptions,
                );

                if (exists) {
                    return true;
                }
            } catch (error) {
                this.logger.warn(
                    `Failed to verify website repository initialization for work ${work.id}: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
            }
        }

        return false;
    }

    async createWork(createWorkDto: CreateWorkDto, user: User) {
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
        } = createWorkDto;

        const selectedWebsiteTemplateId = this.normalizeWebsiteTemplateSelection(websiteTemplateId);

        if (selectedWebsiteTemplateId) {
            const visibleTemplate = await this.templateCatalogService.getVisibleTemplateForUser(
                'website',
                selectedWebsiteTemplateId,
                user.id,
            );
            if (!visibleTemplate) {
                throw new BadRequestException({
                    status: 'error',
                    message: `Unsupported website template: ${selectedWebsiteTemplateId}`,
                });
            }
        }

        const workData: Partial<CreateWorkDto & { userId: string }> = {
            slug,
            name,
            description,
            userId: user.id,
            owner,
            gitProvider,
            deployProvider,
            websiteTemplateId: selectedWebsiteTemplateId,
            readmeConfig,
            organization,
        };

        try {
            const dir = await this.workRepository.create(workData, user);
            dir.owner = dir.getRepoOwner();

            const items = await this.dataGenerator.getItems(dir, user).catch(() => []);
            if (items.length > 0) {
                await this.workRepository.updateGenerateStatus(dir.id, {
                    status: GenerateStatusType.GENERATED,
                });
            }

            return {
                status: 'success',
                work: dir,
            };
        } catch (error) {
            rethrowAsNormalized(error, this.logger, 'creating work');
        }
    }

    async updateWork(id: string, updateDto: UpdateWorkDto, user: User) {
        // Require at least editor role to update work
        const { work } = await this.ownershipService.ensureCanEdit(id, user.id);

        try {
            // Build update data object
            const updateData: Record<string, any> = {
                name: updateDto.name || work.name,
                description: updateDto.description || work.description,
                owner: updateDto.owner ?? work.owner,
                organization:
                    updateDto.organization !== undefined
                        ? updateDto.organization
                        : work.organization,
                readmeConfig: updateDto.readmeConfig ?? work.readmeConfig,
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
                if (updateDto.websiteTemplateUseBeta !== work.websiteTemplateUseBeta) {
                    updateData.websiteTemplateLastCommit = null;
                }
            }

            if (updateDto.websiteTemplateId !== undefined) {
                const nextTemplateId = this.normalizeWebsiteTemplateSelection(
                    updateDto.websiteTemplateId,
                );

                if (nextTemplateId) {
                    const visibleTemplate =
                        await this.templateCatalogService.getVisibleTemplateForUser(
                            'website',
                            nextTemplateId,
                            user.id,
                        );

                    if (!visibleTemplate) {
                        throw new BadRequestException({
                            status: 'error',
                            message: `Unsupported website template: ${nextTemplateId}`,
                        });
                    }
                }

                if (
                    nextTemplateId !==
                    this.normalizeWebsiteTemplateSelection(work.websiteTemplateId)
                ) {
                    const websiteRepoInitialized = await this.hasInitializedWebsiteRepository(
                        work,
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

            const updatedWork = await this.workRepository.update(id, updateData);

            if (!updatedWork) {
                throw new NotFoundException({ status: 'error', message: 'Work not found' });
            }

            updatedWork.owner = updatedWork.getRepoOwner();

            return {
                status: 'success',
                work: updatedWork,
            };
        } catch (error) {
            rethrowAsNormalized(error, this.logger, 'updating work');
        }
    }

    async switchWebsiteTemplate(
        id: string,
        websiteTemplateId: string,
        user: User,
    ): Promise<SwitchWebsiteTemplateResponseDto> {
        const { work } = await this.ownershipService.ensureCanEdit(id, user.id);
        const nextTemplateId = this.normalizeWebsiteTemplateSelection(websiteTemplateId);

        if (nextTemplateId) {
            const visibleTemplate = await this.templateCatalogService.getVisibleTemplateForUser(
                'website',
                nextTemplateId,
                user.id,
            );

            if (!visibleTemplate) {
                throw new BadRequestException({
                    status: 'error',
                    message: `Unsupported website template: ${nextTemplateId}`,
                });
            }
        }

        const websiteRepoInitialized = await this.hasInitializedWebsiteRepository(work, user);
        const websiteOwner = work.getRepoOwner('website');
        const websiteRepo = work.getWebsiteRepo();
        const currentExplicitTemplateId = this.normalizeWebsiteTemplateSelection(
            work.websiteTemplateId,
        );
        const currentEffectiveTemplateId = await this.getEffectiveWebsiteTemplateId(work, user.id);
        const nextEffectiveTemplateId =
            nextTemplateId ||
            (await this.templateCatalogService.getDefaultTemplateIdForUser('website', user.id)) ||
            getDefaultWebsiteTemplateId();

        if (
            nextTemplateId === currentExplicitTemplateId &&
            nextEffectiveTemplateId === currentEffectiveTemplateId
        ) {
            return {
                status: 'success',
                slug: work.slug,
                owner: websiteOwner,
                repository: `${websiteOwner}/${websiteRepo}`,
                previousWebsiteTemplateId: currentEffectiveTemplateId,
                websiteTemplateId: currentEffectiveTemplateId,
                repositoryRecreated: false,
                switchMode: 'no_change',
                message: websiteRepoInitialized
                    ? 'Website template is already selected for this work.'
                    : 'Website template preference is already saved for this work.',
            };
        }

        const updateData = {
            websiteTemplateId: nextTemplateId,
            websiteTemplateLastCommit: null,
            websiteTemplateLastError: null,
            websiteTemplateLastUpdatedAt: null,
            websiteTemplateLastCheckedAt: null,
        };

        const previousTemplateId = currentExplicitTemplateId;
        const previousTemplateLastCommit = work.websiteTemplateLastCommit;
        const previousTemplateLastError = work.websiteTemplateLastError;
        const previousTemplateLastUpdatedAt = work.websiteTemplateLastUpdatedAt;
        const previousTemplateLastCheckedAt = work.websiteTemplateLastCheckedAt;

        work.websiteTemplateId = nextTemplateId;

        if (nextEffectiveTemplateId === currentEffectiveTemplateId) {
            await this.workRepository.update(id, {
                websiteTemplateId: nextTemplateId,
            });

            return {
                status: 'success',
                slug: work.slug,
                owner: websiteOwner,
                repository: `${websiteOwner}/${websiteRepo}`,
                previousWebsiteTemplateId: currentEffectiveTemplateId,
                websiteTemplateId: nextEffectiveTemplateId,
                repositoryRecreated: false,
                switchMode: 'no_change',
                message: nextTemplateId
                    ? 'Website template is now pinned explicitly for this work.'
                    : 'Work now inherits your default website template.',
            };
        }

        work.websiteTemplateLastCommit = null;
        work.websiteTemplateLastError = null;
        work.websiteTemplateLastUpdatedAt = null;
        work.websiteTemplateLastCheckedAt = null;

        if (websiteRepoInitialized) {
            let repositoryRecreated = false;

            try {
                await this.websiteUpdateService.updateRepository(work, user);
            } catch (error) {
                if (!this.isMissingWebsiteRepositoryError(error)) {
                    work.websiteTemplateId = previousTemplateId;
                    work.websiteTemplateLastCommit = previousTemplateLastCommit;
                    work.websiteTemplateLastError = previousTemplateLastError;
                    work.websiteTemplateLastUpdatedAt = previousTemplateLastUpdatedAt;
                    work.websiteTemplateLastCheckedAt = previousTemplateLastCheckedAt;
                    throw error;
                }

                this.logger.warn(
                    `Website repository for work ${work.id} was missing during template switch. Recreating from template.`,
                );

                try {
                    await this.websiteGenerator.initialize(
                        work,
                        user,
                        WebsiteRepositoryCreationMethod.CREATE_USING_TEMPLATE,
                    );
                    repositoryRecreated = true;
                } catch (initializeError) {
                    work.websiteTemplateId = previousTemplateId;
                    work.websiteTemplateLastCommit = previousTemplateLastCommit;
                    work.websiteTemplateLastError = previousTemplateLastError;
                    work.websiteTemplateLastUpdatedAt = previousTemplateLastUpdatedAt;
                    work.websiteTemplateLastCheckedAt = previousTemplateLastCheckedAt;
                    throw initializeError;
                }
            }

            await this.workRepository.update(id, updateData);

            return {
                status: 'success',
                slug: work.slug,
                owner: websiteOwner,
                repository: `${websiteOwner}/${websiteRepo}`,
                previousWebsiteTemplateId: currentEffectiveTemplateId,
                websiteTemplateId: nextEffectiveTemplateId,
                repositoryRecreated,
                switchMode: repositoryRecreated ? 'repository_recreated' : 'repository_reset',
                message: repositoryRecreated
                    ? 'Website template switched successfully. The website repository was recreated from the selected template.'
                    : 'Website template switched successfully. The existing website repository was reset from the selected template.',
            };
        }

        await this.workRepository.update(id, updateData);

        return {
            status: 'success',
            slug: work.slug,
            owner: websiteOwner,
            repository: `${websiteOwner}/${websiteRepo}`,
            previousWebsiteTemplateId: currentEffectiveTemplateId,
            websiteTemplateId: nextEffectiveTemplateId,
            repositoryRecreated: false,
            switchMode: 'saved_for_initialization',
            message:
                'Website template updated successfully. It will be used when the website repository is first created.',
        };
    }

    async syncFromDataRepository(workId: string, user: User) {
        // Require at least editor role to sync
        const { work } = await this.ownershipService.ensureCanEdit(workId, user.id);
        const updates: Record<string, any> = {};

        try {
            const snapshot = await this.dataGenerator.getDataSyncSnapshot(work, user);

            if (
                typeof snapshot.itemsCount === 'number' &&
                work.itemsCount !== snapshot.itemsCount
            ) {
                updates.itemsCount = snapshot.itemsCount;
            }

            const prUpdate = snapshot.prUpdate;
            if (prUpdate && (!work.lastPullRequest || !work.lastPullRequest.data)) {
                updates.lastPullRequest = {
                    ...(work.lastPullRequest || {}),
                    data: prUpdate,
                };
            }

            updates.readmeConfig = work.readmeConfig || {};

            // Sync readme config from markdown templates
            const markdownTemplate = snapshot.readmeTemplate;
            if (markdownTemplate?.header && !work.readmeConfig?.header) {
                updates.readmeConfig.header = markdownTemplate.header;
                updates.readmeConfig.overwriteDefaultHeader = true;
            }

            if (markdownTemplate?.footer && !work.readmeConfig?.footer) {
                updates.readmeConfig.footer = markdownTemplate.footer;
                updates.readmeConfig.overwriteDefaultFooter = true;
            }

            if (Object.keys(updates).length > 0) {
                await this.workRepository.update(work.id, updates);
            }

            return {
                status: 'success',
                updated: Object.keys(updates),
                message:
                    Object.keys(updates).length > 0
                        ? 'Work synced from data repository.'
                        : 'Work already up to date.',
            };
        } catch (error) {
            rethrowAsNormalized(error, this.logger, 'syncing work from data repository');
        }
    }

    async deleteWork(
        workId: string,
        deleteWorkDto: DeleteWorkDto,
        user: User,
    ): Promise<DeleteWorkResponseDto> {
        // Only owners can delete works
        const { work } = await this.ownershipService.ensureIsOwner(workId, user.id);

        try {
            const deletedRepositories: string[] = [];

            if (deleteWorkDto.delete_data_repository !== false) {
                try {
                    await this.dataGenerator.removeRepository(work, user);
                    deletedRepositories.push(`${work.getRepoOwner()}/${work.getDataRepo()}`);
                } catch (error) {
                    if (error instanceof HttpException) {
                        throw error;
                    }

                    this.logger.error('Failed to delete data repository:', error);
                }
            }

            if (deleteWorkDto.delete_markdown_repository !== false) {
                try {
                    await this.markdownGenerator.removeRepository(work, user);
                    deletedRepositories.push(`${work.getRepoOwner('work')}/${work.getMainRepo()}`);
                } catch (error) {
                    if (error instanceof HttpException) {
                        throw error;
                    }

                    this.logger.error('Failed to delete markdown repository:', error);
                }
            }

            if (deleteWorkDto.delete_website_repository !== false) {
                try {
                    await this.websiteGenerator.removeRepository(work, user);
                    deletedRepositories.push(
                        `${work.getRepoOwner('website')}/${work.getWebsiteRepo()}`,
                    );
                } catch (error) {
                    if (error instanceof HttpException) {
                        throw error;
                    }

                    this.logger.error('Failed to delete website repository:', error);
                }
            }

            await this.workRepository.delete(work.id);

            await Promise.all([
                this.dataGenerator.cleanup(work),
                this.markdownGenerator.cleanup(work),
                this.websiteGenerator.cleanup(work),
            ]).catch((error) => this.logger.error('Failed to cleanup repositories:', error));

            return {
                status: 'success',
                slug: work.slug,
                message: `Work '${work.slug}' and associated repositories have been deleted`,
                deleted_repositories: deletedRepositories,
            };
        } catch (error) {
            rethrowAsNormalized(error, this.logger, 'deleting work', {
                slug: work?.slug || '',
            });
        }
    }
}
