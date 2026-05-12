import {
    BadRequestException,
    HttpException,
    Injectable,
    Logger,
    NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { WorkRepository } from '@src/database/repositories/work.repository';
import { UserRepository } from '@src/database/repositories/user.repository';
import { WorksConfigSyncRequestedEvent } from '@src/events';
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
import { WebsiteRepositoryCreationMethod } from '@src/items-generator/dto/create-items-generator.dto';
import { TemplateCatalogService } from '../template-catalog/template-catalog.service';
import { WorkWebsiteRepositoryStateService } from './work-website-repository-state.service';
import { EverWorksDeployQuotaService } from '@src/ever-works-providers';
import { config } from '@src/config';
import type { OnboardingWizardStateV2 } from '@ever-works/contracts/api';

/**
 * Map a wizard "storage" choice onto the existing `gitProvider` field.
 *
 * The Work entity still drives every repository operation off
 * `work.gitProvider` (see git facade + repository-management). The onboarding
 * wizard's storage step is a higher-level choice that needs to translate
 * back into a concrete git-provider plugin id, otherwise picking
 * `ever-works-git` would silently fall back to whatever `gitProvider` the
 * DTO carried (default `github`).
 */
function gitProviderFromStorageChoice(storage: string): string | undefined {
    switch (storage) {
        case 'ever-works-git':
            // Ever Works Git is a managed GitHub org, so the runtime git
            // provider is still GitHub.
            return 'github';
        case 'user-github':
            return 'github';
        case 'user-gitlab':
            return 'gitlab';
        case 'user-git':
            // Self-hosted Git is "planned" in the catalog. Until a concrete
            // plugin lands, fall through to the caller's default.
            return undefined;
        default:
            return undefined;
    }
}

@Injectable()
export class WorkLifecycleService {
    private readonly logger = new Logger(WorkLifecycleService.name);

    constructor(
        private readonly workRepository: WorkRepository,
        private readonly userRepository: UserRepository,
        private readonly dataGenerator: DataGeneratorService,
        private readonly markdownGenerator: MarkdownGeneratorService,
        private readonly websiteGenerator: WebsiteGeneratorService,
        private readonly websiteUpdateService: WebsiteUpdateService,
        private readonly ownershipService: WorkOwnershipService,
        private readonly deployFacade: DeployFacadeService,
        private readonly templateCatalogService: TemplateCatalogService,
        private readonly websiteRepositoryState: WorkWebsiteRepositoryStateService,
        private readonly everWorksDeployQuota: EverWorksDeployQuotaService,
        private readonly eventEmitter: EventEmitter2,
    ) {}

    /**
     * Resolve storage / deploy / git provider for a new Work. Precedence:
     *
     *   1. value the client passed in the DTO (explicit overrides win),
     *   2. the user's persisted onboarding choice (if any),
     *   3. the historical fallback (`user-github` / `vercel`).
     *
     * Two additional safeguards:
     *
     *   - `deployProvider === 'ever-works'` is only persisted when the env
     *     flag is on. There's no plugin registered with id `ever-works`, so
     *     the deploy facade would throw at deploy time on environments where
     *     the feature is off (which is the prod default until the tenant
     *     cluster is wired up). Fall back to `vercel` in that case.
     *   - The storage choice is translated back into a concrete `gitProvider`
     *     value, since repository operations still read `work.gitProvider`.
     *     Without this, picking `ever-works-git` in the wizard had no
     *     runtime effect.
     */
    private async resolveProviderDefaults(
        dto: Pick<CreateWorkDto, 'storageProvider' | 'deployProvider' | 'gitProvider'>,
        userId: string,
    ): Promise<{ storageProvider: string; deployProvider: string; gitProvider: string }> {
        let onboardingState: OnboardingWizardStateV2 | null | undefined;
        try {
            const user = await this.userRepository.findById(userId);
            onboardingState = user?.onboardingState;
        } catch (cause) {
            this.logger.warn(
                `Failed to read onboarding state for user ${userId}; falling back to defaults: ${(cause as Error).message}`,
            );
        }

        const storageProvider =
            dto.storageProvider ?? onboardingState?.storage?.choice ?? 'user-github';

        let deployProvider = dto.deployProvider ?? onboardingState?.deploy?.choice ?? 'vercel';
        if (deployProvider === 'ever-works' && !config.everWorks.deploy.isEnabled()) {
            this.logger.warn(
                `deployProvider 'ever-works' selected by user ${userId} but DEPLOY_EVER_WORKS_ENABLED is off — falling back to 'vercel' to avoid persisting an unresolvable provider id`,
            );
            deployProvider = 'vercel';
        }

        const gitProvider =
            dto.gitProvider ?? gitProviderFromStorageChoice(storageProvider) ?? 'github';

        return { storageProvider, deployProvider, gitProvider };
    }

    private normalizeWebsiteTemplateSelection(value?: string | null): string | null {
        const normalized = value?.trim();
        return normalized ? normalized : null;
    }

    private async resolveValidatedWebsiteTemplateSelection(
        value: string | null | undefined,
        userId: string,
    ): Promise<string | null> {
        const normalizedTemplateId = this.normalizeWebsiteTemplateSelection(value);

        if (!normalizedTemplateId) {
            return null;
        }

        const visibleTemplate = await this.templateCatalogService.getVisibleTemplateForUser(
            'website',
            normalizedTemplateId,
            userId,
        );
        if (!visibleTemplate) {
            throw new BadRequestException({
                status: 'error',
                message: `Unsupported website template: ${normalizedTemplateId}`,
            });
        }

        return normalizedTemplateId;
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
        return this.websiteRepositoryState.isInitialized(work, user);
    }

    async createWork(createWorkDto: CreateWorkDto, user: User) {
        const { slug, name, description, owner, readmeConfig, organization, websiteTemplateId } =
            createWorkDto;

        const selectedWebsiteTemplateId = await this.resolveValidatedWebsiteTemplateSelection(
            websiteTemplateId,
            user.id,
        );

        const { storageProvider, deployProvider, gitProvider } = await this.resolveProviderDefaults(
            createWorkDto,
            user.id,
        );

        // Ever Works Deploy is capped per user. The check is a no-op when
        // the user isn't picking it; we still want a hard fail BEFORE the
        // create-work side-effects (repo creation etc.) kick in.
        if (deployProvider === 'ever-works') {
            await this.everWorksDeployQuota.assertWithinQuota(user.id);
        }

        const workData: Partial<CreateWorkDto & { userId: string }> = {
            slug,
            name,
            description,
            userId: user.id,
            owner,
            gitProvider,
            storageProvider,
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
                const nextTemplateId = await this.resolveValidatedWebsiteTemplateSelection(
                    updateDto.websiteTemplateId,
                    user.id,
                );

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

            // EW-612: when `deployProvider` changes via the dashboard,
            // commit the new value to `.works/works.yml` in the data repo
            // so the next deploy doesn't hit the data-repo-wins precedence
            // and silently flip the provider back. We do this by emitting
            // the existing `WorksConfigSyncRequestedEvent`; the existing
            // `WorksConfigSyncListener` + `WorksConfigRepositorySyncService`
            // handle the YAML read-modify-write and the git commit/push.
            //
            // Only emit when the value actually changed — saving the same
            // provider should be a no-op for the data repo.
            if (
                updateDto.deployProvider !== undefined &&
                updateDto.deployProvider !== work.deployProvider
            ) {
                this.eventEmitter.emit(
                    WorksConfigSyncRequestedEvent.EVENT_NAME,
                    new WorksConfigSyncRequestedEvent(id, user.id, 'provider_changed'),
                );
            }

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
        websiteTemplateId: string | null | undefined,
        user: User,
    ): Promise<SwitchWebsiteTemplateResponseDto> {
        const { work } = await this.ownershipService.ensureCanEdit(id, user.id);
        const nextTemplateId = await this.resolveValidatedWebsiteTemplateSelection(
            websiteTemplateId,
            user.id,
        );

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
