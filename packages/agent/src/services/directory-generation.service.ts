import {
    BadRequestException,
    ConflictException,
    HttpException,
    Inject,
    Injectable,
    Logger,
    NotFoundException,
    Optional,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
    DataGeneratorService,
    GenerationStats,
} from '@src/generators/data-generator/data-generator.service';
import { MarkdownGeneratorService } from '@src/generators/markdown-generator/markdown-generator.service';
import { WebsiteGeneratorService } from '@src/generators/website-generator/website-generator.service';
import { WebsiteUpdateService } from '@src/generators/website-generator/website-update.service';
import {
    CreateItemsGeneratorDto,
    GenerationMethod,
    UpdateItemsGeneratorDto,
} from '@src/items-generator/dto/create-items-generator.dto';
import {
    SubmitItemDto,
    RemoveItemDto,
    RemoveItemResponseDto,
    ExtractItemDetailsDto,
    ExtractItemDetailsResponseDto,
    UpdateItemDto,
} from '@src/items-generator/dto';
import {
    CancelGenerationResponseDto,
    ItemsGeneratorResponseDto,
} from '@src/items-generator/dto/items-generator-response.dto';
import { ItemSubmissionService } from '@src/items-generator/item-submission.service';
import { Directory } from '@src/entities/directory.entity';
import { User } from '@src/entities/user.entity';
import { DirectoryRepository } from '@src/database/repositories/directory.repository';
import { DirectoryGenerationHistoryRepository } from '@src/database/repositories/directory-generation-history.repository';
import { DirectoryGenerationHistory } from '@src/entities/directory-generation-history.entity';
import { DirectoryGenerationCompletedEvent } from '@src/events';
import { UpdateWebsiteRepositoryResponseDto } from '@src/generators/website-generator/dto/update-website-repository.dto';
import {
    DIRECTORY_GENERATION_MODE,
    DirectoryGenerationMode,
    DirectoryGenerationPayload,
    DIRECTORY_GENERATION_DISPATCHER,
    DirectoryGenerationDispatcher,
} from '@src/tasks';
import { DirectoryScheduleBillingMode, GenerateStatusType } from '@src/entities/types';
import { DirectoryOwnershipService } from './directory-ownership.service';
import { normalizeGeneratorError } from './utils/error.utils';
import {
    classifyGenerationError,
    notifyForClassifiedError,
} from './utils/error-classification.utils';
import { DirectorySchedule } from '@src/entities/directory-schedule.entity';
import { DirectoryScheduleService } from './directory-schedule.service';
import { UserRepository } from '@src/database/repositories/user.repository';
import { DirectoryImportService } from './directory-import.service';
import { supportsDirectorySourceSync } from '@src/import/source-sync-support';
import { NotificationService } from '@src/notifications/notification.service';
import {
    ScreenshotFacadeService,
    AiFacadeService,
    ContentExtractorFacadeService,
} from '@src/facades';
import { z } from 'zod';
import { GeneratorFormSchemaService } from './generator-form-schema.service';
import { buildStatsUpdate } from '../directory-operations/directory-operations.service';
import { calculateDurationSeconds } from '../utils/time.utils';
import { PluginOperationsService } from '@src/plugins/services/plugin-operations.service';
import { PluginRegistryService } from '@src/plugins/services/plugin-registry.service';
import { getCapabilityFromUIKey, SELECTABLE_PROVIDER_CATEGORIES } from '@ever-works/plugin';
import { ProvidersDto } from '@src/items-generator/dto/create-items-generator.dto';
import {
    DirectoryHistoryActivityType,
    type DirectoryHistoryChangeEntry,
} from '@ever-works/contracts/api';
import { buildDirectoryChangelog } from '../utils/directory-changelog.utils';
import { GenerationLogCollector } from '@src/generators/data-generator/generation-log-collector';
import { GENERATION_CANCELLED } from '@src/constants/messages';
import {
    createGenerationCancelledError,
    isGenerationCancelledError,
    throwIfGenerationCancelled,
} from '@src/utils';

export interface BulkCaptureImagesDto {
    itemSlugs?: string[];
    mode: 'missing' | 'all';
}

export interface BulkCaptureResultDto {
    itemSlug?: string;
    itemName?: string;
    primaryImage: string | null;
    source: 'screenshot' | 'scraped' | 'vision_selected';
    confidence?: number;
    error?: string;
}

export interface BulkCaptureImagesResponseDto {
    status: 'success' | 'partial' | 'error';
    results: BulkCaptureResultDto[];
    totalProcessed: number;
    successCount: number;
    errorCount: number;
    message?: string;
}

import {
    GenerationTriggerContext,
    DEFAULT_TRIGGER_CONTEXT,
    type ScheduleRunOutcome,
} from './types/trigger-context.types';

export type UpdateItemsGeneratorOptions = {
    directoryId: string;
    updateDto: UpdateItemsGeneratorDto;
    user: User;
    awaitCompletion?: boolean;
    context?: GenerationTriggerContext;
};

@Injectable()
export class DirectoryGenerationService {
    private readonly logger = new Logger(DirectoryGenerationService.name);
    private readonly generationAbortControllers = new Map<string, AbortController>();

    constructor(
        private readonly dataGenerator: DataGeneratorService,
        private readonly markdownGenerator: MarkdownGeneratorService,
        private readonly websiteGenerator: WebsiteGeneratorService,
        private readonly websiteUpdateService: WebsiteUpdateService,
        private readonly itemSubmissionService: ItemSubmissionService,
        private readonly directoryRepository: DirectoryRepository,
        private readonly eventEmitter: EventEmitter2,
        private readonly generationHistoryRepository: DirectoryGenerationHistoryRepository,
        private readonly ownershipService: DirectoryOwnershipService,
        private readonly directoryScheduleService: DirectoryScheduleService,
        private readonly directoryImportService: DirectoryImportService,
        private readonly userRepository: UserRepository,
        private readonly screenshotFacade: ScreenshotFacadeService,
        private readonly aiFacade: AiFacadeService,
        private readonly contentExtractorFacade: ContentExtractorFacadeService,
        private readonly generatorFormSchemaService: GeneratorFormSchemaService,
        private readonly pluginOperationsService: PluginOperationsService,
        private readonly pluginRegistryService: PluginRegistryService,
        @Optional()
        @Inject(DIRECTORY_GENERATION_DISPATCHER)
        private readonly generationDispatcher?: DirectoryGenerationDispatcher,
        @Optional()
        private readonly notificationService?: NotificationService,
    ) {}

    async generateItems(
        directoryId: string,
        dto: CreateItemsGeneratorDto,
        user: User,
        awaitCompletion = true,
        context: GenerationTriggerContext = DEFAULT_TRIGGER_CONTEXT,
    ): Promise<ItemsGeneratorResponseDto> {
        // Require editor role to generate/update items
        const { directory } = await this.ownershipService.ensureCanEdit(directoryId, user.id);
        this.ensureNotAlreadyGenerating(directory);
        const triggerContext = this.resolveContext(context);

        const scopeOptions = { userId: user.id, directoryId };

        await this.prepareProviders(dto, scopeOptions);

        const history = await this.createGenerationHistoryRecord(
            directory,
            user,
            dto,
            triggerContext,
        );

        if (awaitCompletion) {
            await this.runInProcessGeneration(directory, user, dto, history, triggerContext);
        } else {
            await this.dispatchGenerationTask(
                DIRECTORY_GENERATION_MODE.CREATE,
                directory,
                user,
                dto,
                history.id,
                history,
                triggerContext,
            );
        }

        return {
            status: 'pending',
            slug: directory.slug,
            parameters: dto,
            message: `Processing request for '${dto.name}'. Check logs or data directory for updates.`,
            historyId: history.id,
        };
    }

    async updateItemsGenerator(
        options: UpdateItemsGeneratorOptions,
    ): Promise<ItemsGeneratorResponseDto> {
        const {
            directoryId,
            updateDto,
            user,
            awaitCompletion = true,
            context = DEFAULT_TRIGGER_CONTEXT,
        } = options;

        // Require editor role to generate/update items
        const { directory } = await this.ownershipService.ensureCanEdit(directoryId, user.id);

        // For scheduled runs, skip gracefully if directory is busy (don't penalize the schedule)
        if (
            directory.generateStatus?.status === GenerateStatusType.GENERATING &&
            context.triggeredBy === 'schedule' &&
            context.scheduleId
        ) {
            await this.directoryScheduleService.finalizeScheduleRun(context.scheduleId, {
                status: 'skipped',
                reason: 'Directory already has a generation in progress',
            });
            return {
                slug: directory.slug,
                status: 'skipped' as any,
                message: 'Skipped — directory already generating',
            };
        }
        this.ensureNotAlreadyGenerating(directory);
        const triggerContext = this.resolveContext(context);

        let lastRequestData;
        try {
            const config = await this.dataGenerator.getConfig(directory, user);

            if (!config?.metadata?.last_request_data) {
                throw new Error('No previous request data found');
            }

            // change the last request data prompt to use initial prompt if the update is triggered by schedule,
            // to prevent unpredictable results caused by using the last run prompt
            // which may have been modified by the user in a way that is incompatible with the schedule's expectations.
            lastRequestData = {
                ...config.metadata.last_request_data,
                prompt: config.metadata.initial_prompt ?? config.metadata.last_request_data.prompt,
            };
        } catch (error) {
            this.logger.error(
                `Failed to load last request data for directory ${directoryId}`,
                error,
            );

            if (context.triggeredBy === 'schedule' && context.scheduleId) {
                await this.directoryScheduleService.finalizeScheduleRun(context.scheduleId, {
                    status: 'failed',
                    reason: 'Invalid configuration (stale data). Please run a manual generation to fix.',
                });
                // Force pause immediately if config is broken
                await this.directoryScheduleService.pauseSchedule(context.scheduleId);
            }

            throw new BadRequestException({
                status: 'error',
                slug: directory.slug,
                message: 'Configuration invalid or missing. Please run a manual generation first.',
            });
        }

        // Reset operational flags to safe defaults before merging user overrides
        // This prevents scheduled runs from inheriting RECREATE mode from manual runs
        const perRunDefaults = {
            generation_method: GenerationMethod.CREATE_UPDATE,
            update_with_pull_request: true,
        };

        const payload = {
            ...lastRequestData,
            ...perRunDefaults,
            ...updateDto,
        };

        // Deep-merge providers: overrides win per-field, but unset fields inherit from last run
        if (lastRequestData.providers && updateDto.providers) {
            payload.providers = {
                ...lastRequestData.providers,
                ...updateDto.providers,
            };
        }

        const scopeOptions = { userId: user.id, directoryId };

        await this.prepareProviders(payload, scopeOptions);

        if (context.triggeredBy === 'schedule') {
            payload.config = {
                ...payload.config,
                max_search_queries: 10,
                max_results_per_query: 5,
                max_pages_to_process: 10,
                ai_first_generation_enabled: false,
            };
        }

        const history = await this.createGenerationHistoryRecord(
            directory,
            user,
            payload,
            triggerContext,
        );

        if (awaitCompletion) {
            await this.runInProcessGeneration(directory, user, payload, history, triggerContext);
        } else {
            await this.dispatchGenerationTask(
                DIRECTORY_GENERATION_MODE.UPDATE,
                directory,
                user,
                payload,
                history.id,
                history,
                triggerContext,
            );
        }

        return {
            slug: directory.slug,
            status: 'pending',
            parameters: payload,
            message: `Processing update for '${directory.name}'. Check logs or data directory for updates.`,
            historyId: history.id,
        };
    }

    async cancelGeneration(directoryId: string, user: User): Promise<CancelGenerationResponseDto> {
        const { directory } = await this.ownershipService.ensureCanEdit(directoryId, user.id);

        if (directory.generateStatus?.status !== GenerateStatusType.GENERATING) {
            return {
                status: 'success',
                message: `Directory "${directory.name}" is no longer generating.`,
                mode: 'already_finished',
            };
        }

        const history =
            await this.generationHistoryRepository.findLatestInProgressByDirectory(directoryId);

        if (history?.triggerRunId) {
            if (!this.generationDispatcher) {
                throw new BadRequestException({
                    status: 'error',
                    message: 'Generation cancellation is not available in this environment.',
                });
            }

            const cancelled = await this.generationDispatcher.cancelDirectoryGeneration(
                history.triggerRunId,
            );

            if (cancelled) {
                return {
                    status: 'success',
                    message: 'Cancellation requested. The generation will stop shortly.',
                    mode: 'trigger',
                };
            }

            const refreshedDirectory = await this.directoryRepository.findById(directoryId);

            if (
                refreshedDirectory?.generateStatus?.status &&
                refreshedDirectory.generateStatus.status !== GenerateStatusType.GENERATING
            ) {
                return {
                    status: 'success',
                    message: `Directory "${refreshedDirectory.name}" is no longer generating.`,
                    mode: 'already_finished',
                };
            }

            throw new BadRequestException({
                status: 'error',
                message: 'Failed to cancel the active generation run. Please try again.',
            });
        }

        const controller = this.generationAbortControllers.get(directoryId);
        if (controller) {
            controller.abort(createGenerationCancelledError());
            return {
                status: 'success',
                message: 'Cancellation requested. The generation will stop shortly.',
                mode: 'in_process',
            };
        }

        await this.finalizeCancelledGeneration(directory.id, history, history?.scheduleId ?? null);

        return {
            status: 'success',
            message: 'Generation was marked as cancelled.',
            mode: 'stale',
        };
    }

    async submitItem(directoryId: string, dto: SubmitItemDto, user: User) {
        try {
            // Require editor role to generate/update items
            const { directory } = await this.ownershipService.ensureCanEdit(directoryId, user.id);

            const result = await this.itemSubmissionService.submitItem(directory, user, dto);

            if (result.status === 'success') {
                await this.markdownGenerator.initialize(directory, user, {
                    generation_method: result.auto_merged
                        ? GenerationMethod.RECREATE
                        : GenerationMethod.CREATE_UPDATE,
                    pr_update: {
                        branch: result.pr_branch_name,
                        title: result.pr_title,
                        body: result.pr_body,
                    },
                });

                if (!result.pr_number && result.item_name && result.item_slug) {
                    await this.recordActivityHistory({
                        directoryId: directory.id,
                        userId: user.id,
                        activityType: DirectoryHistoryActivityType.ITEM_ADDED,
                        newItemsCount: 1,
                        entries: [
                            {
                                entityType: 'item',
                                action: 'added',
                                name: result.item_name,
                                slug: result.item_slug,
                            },
                        ],
                        summary: `Item added: ${result.item_name}`,
                    });
                }
            }

            if (result.status === 'error') {
                result.message = normalizeGeneratorError(result.message);
                throw new BadRequestException(result);
            }

            return result;
        } catch (error) {
            if (error instanceof HttpException) {
                throw error;
            }

            this.logger.error('Error submitting item:', error);

            throw new BadRequestException({
                status: 'error',
                directoryId,
                item_name: dto.name,
                message: normalizeGeneratorError(error),
            });
        }
    }

    async removeItem(
        directoryId: string,
        dto: RemoveItemDto,
        user: User,
    ): Promise<RemoveItemResponseDto> {
        try {
            // Require editor role to generate/update items
            const { directory } = await this.ownershipService.ensureCanEdit(directoryId, user.id);

            const result = await this.itemSubmissionService.removeItem(directory, user, dto);

            if (result.status === 'success') {
                await this.markdownGenerator.initialize(directory, user, {
                    generation_method: GenerationMethod.CREATE_UPDATE,
                    pr_update: {
                        branch: result.pr_branch_name,
                        title: result.pr_title,
                        body: result.pr_body,
                    },
                });

                if (!result.pr_number && result.item_name && result.item_slug) {
                    await this.recordActivityHistory({
                        directoryId: directory.id,
                        userId: user.id,
                        activityType: DirectoryHistoryActivityType.ITEM_REMOVED,
                        entries: [
                            {
                                entityType: 'item',
                                action: 'removed',
                                name: result.item_name,
                                slug: result.item_slug,
                            },
                        ],
                        summary: `Item removed: ${result.item_name}`,
                    });
                }
            }

            if (result.status === 'error') {
                result.message = normalizeGeneratorError(result.message);
                throw new BadRequestException(result);
            }

            return { ...result, status: 'success' };
        } catch (error) {
            if (error instanceof HttpException) {
                throw error;
            }

            this.logger.error('Error removing item:', error);

            throw new BadRequestException({
                status: 'error',
                slug: directoryId,
                item_slug: dto.item_slug,
                message: normalizeGeneratorError(error),
            });
        }
    }

    async updateItemMetadata(directoryId: string, dto: UpdateItemDto, user: User) {
        try {
            // Require editor role to generate/update items
            const { directory } = await this.ownershipService.ensureCanEdit(directoryId, user.id);

            const result = await this.itemSubmissionService.updateItem(directory, user, dto);

            if (result.status === 'success') {
                await this.markdownGenerator.initialize(directory, user, {
                    generation_method: GenerationMethod.CREATE_UPDATE,
                });

                if (!result.pr_number && result.item_name && result.item_slug) {
                    const fieldsChanged = [
                        ...(dto.featured !== undefined ? ['featured'] : []),
                        ...(dto.order !== undefined ? ['order'] : []),
                        ...(dto.source_url !== undefined ? ['source_url'] : []),
                    ];

                    await this.recordActivityHistory({
                        directoryId: directory.id,
                        userId: user.id,
                        activityType: DirectoryHistoryActivityType.ITEM_UPDATED,
                        updatedItemsCount: 1,
                        entries: [
                            {
                                entityType: 'item',
                                action: 'updated',
                                name: result.item_name,
                                slug: result.item_slug,
                                fieldsChanged,
                            },
                        ],
                        summary: `Item updated: ${result.item_name}`,
                    });
                }
            }

            if (result.status === 'error') {
                result.message = normalizeGeneratorError(result.message);
                throw new BadRequestException(result);
            }

            return result;
        } catch (error) {
            if (error instanceof HttpException) {
                throw error;
            }

            this.logger.error('Error updating item metadata:', error);

            throw new BadRequestException({
                status: 'error',
                slug: directoryId,
                message: normalizeGeneratorError(error),
            });
        }
    }

    async extractItemDetails(
        dto: ExtractItemDetailsDto,
        user: User,
    ): Promise<ExtractItemDetailsResponseDto> {
        const { source_url, existing_categories } = dto;
        const facadeOptions = { userId: user.id };

        try {
            // 1. Extract page content
            const extracted = await this.contentExtractorFacade.extractContent(
                source_url,
                undefined,
                facadeOptions,
            );

            if (!extracted || !extracted.rawContent) {
                return {
                    status: 'error',
                    source_url,
                    message: 'Could not extract content from the provided URL',
                };
            }

            // 2. Use AI to extract structured item data from the content
            const itemSchema = z.object({
                name: z.string().describe('The name or title of the item/product/tool'),
                description: z.string().describe('A concise description (1-3 sentences)'),
                category: z.string().describe('The most appropriate category for this item'),
                tags: z.array(z.string()).describe('Relevant tags or keywords (3-8 tags)'),
                brand: z
                    .string()
                    .nullable()
                    .describe('The brand or company behind this item, or null'),
                brand_logo_url: z
                    .string()
                    .nullable()
                    .describe('URL to the brand logo if found on the page, or null'),
                images: z.array(z.string()).describe('URLs of relevant images found on the page'),
            });

            const categoriesHint = existing_categories?.length
                ? `\nPrefer matching one of these existing categories: ${existing_categories.join(', ')}`
                : '';

            const prompt = `Extract structured item details from this web page content.
The source URL is: {{source_url}}
${categoriesHint}

Page content:
{{content}}

Extract the item name, a concise description, an appropriate category, relevant tags, brand info, and image URLs.
If the page is about a product/tool/service, extract its details.
If the page is a general article, extract the main subject as the item.
Only include image URLs that are absolute URLs (starting with http).`;

            const { result } = await this.aiFacade.askJson(
                prompt,
                itemSchema,
                {
                    temperature: 0.1,
                    variables: {
                        source_url,
                        content: extracted.rawContent.slice(0, 12_000),
                    },
                    routing: { complexity: 'simple' as const },
                },
                facadeOptions,
            );

            return {
                status: 'success',
                source_url,
                item: {
                    name: result.name,
                    description: result.description,
                    source_url,
                    category: result.category,
                    tags: result.tags,
                    brand: result.brand || undefined,
                    brand_logo_url: result.brand_logo_url,
                    images: result.images?.filter((url) => url.startsWith('http')) || [],
                },
                message: 'Item details extracted successfully',
            };
        } catch (error) {
            this.logger.error(`Failed to extract item details from ${source_url}:`, error);

            throw new BadRequestException({
                status: 'error',
                source_url,
                message: normalizeGeneratorError(error),
            });
        }
    }

    async bulkCaptureImages(
        directoryId: string,
        dto: BulkCaptureImagesDto,
        user: User,
    ): Promise<BulkCaptureImagesResponseDto> {
        try {
            // Require editor role to capture images
            const { directory } = await this.ownershipService.ensureCanEdit(directoryId, user.id);

            // Get all items from the directory
            const items = await this.dataGenerator.getItems(directory, user);

            if (!items || items.length === 0) {
                return {
                    status: 'success',
                    results: [],
                    totalProcessed: 0,
                    successCount: 0,
                    errorCount: 0,
                    message: 'No items found in directory',
                };
            }

            // Filter items based on mode and itemSlugs
            let itemsToProcess = items;

            if (dto.itemSlugs && dto.itemSlugs.length > 0) {
                itemsToProcess = items.filter((item) => dto.itemSlugs!.includes(item.slug));
            }

            if (dto.mode === 'missing') {
                // Only process items without images
                itemsToProcess = itemsToProcess.filter(
                    (item) => !item.images || item.images.length === 0,
                );
            }

            // Filter items that have source_url
            itemsToProcess = itemsToProcess.filter((item) => item.source_url);

            if (itemsToProcess.length === 0) {
                return {
                    status: 'success',
                    results: [],
                    totalProcessed: 0,
                    successCount: 0,
                    errorCount: 0,
                    message:
                        dto.mode === 'missing'
                            ? 'No items without images found'
                            : 'No items with source URLs found',
                };
            }

            // Check if screenshot facade is available
            if (!this.screenshotFacade.isAvailable()) {
                return {
                    status: 'error',
                    results: [],
                    totalProcessed: 0,
                    successCount: 0,
                    errorCount: 0,
                    message: 'Screenshot service is not available',
                };
            }

            // Process items sequentially using facade
            const bulkResults: BulkCaptureResultDto[] = [];

            for (const item of itemsToProcess) {
                try {
                    const result = await this.screenshotFacade.capture(
                        {
                            url: item.source_url,
                            blockAds: true,
                            blockCookieBanners: true,
                            cache: true,
                        },
                        {
                            userId: user.id,
                            directoryId: directory.id,
                        },
                    );

                    bulkResults.push({
                        itemSlug: item.slug,
                        itemName: item.name,
                        primaryImage: result.cacheUrl || result.imageUrl,
                        source: 'screenshot',
                    });
                } catch (error) {
                    bulkResults.push({
                        itemSlug: item.slug,
                        itemName: item.name,
                        primaryImage: null,
                        source: 'screenshot',
                        error: error instanceof Error ? error.message : 'Unknown error',
                    });
                }
            }

            // Calculate stats
            const successCount = bulkResults.filter((r) => r.primaryImage !== null).length;
            const errorCount = bulkResults.filter((r) => r.error).length;

            return {
                status: errorCount === 0 ? 'success' : successCount > 0 ? 'partial' : 'error',
                results: bulkResults,
                totalProcessed: bulkResults.length,
                successCount,
                errorCount,
                message: `Processed ${bulkResults.length} items: ${successCount} successful, ${errorCount} failed`,
            };
        } catch (error) {
            if (error instanceof HttpException) {
                throw error;
            }

            this.logger.error('Error in bulk capture images:', error);

            throw new BadRequestException({
                status: 'error',
                message: normalizeGeneratorError(error),
            });
        }
    }

    async updateDomainType(
        directoryId: string,
        domainType: string,
        user: User,
        manuallySet = true,
    ): Promise<{ status: string; domainType: string; domainTypeManuallySet: boolean }> {
        try {
            // Require editor role to update domain type
            await this.ownershipService.ensureCanEdit(directoryId, user.id);

            // Update the directory
            await this.directoryRepository.update(directoryId, {
                domainType,
                domainTypeManuallySet: manuallySet,
            });

            return {
                status: 'success',
                domainType,
                domainTypeManuallySet: manuallySet,
            };
        } catch (error) {
            if (error instanceof HttpException) {
                throw error;
            }

            this.logger.error('Error updating domain type:', error);

            throw new BadRequestException({
                status: 'error',
                message: normalizeGeneratorError(error),
            });
        }
    }

    async regenerateMarkdown(directoryId: string, user: User) {
        try {
            // Require editor role to generate/update items
            const { directory } = await this.ownershipService.ensureCanEdit(directoryId, user.id);

            await this.markdownGenerator.initialize(directory, user, {
                generation_method: GenerationMethod.RECREATE,
            });

            return { status: 'success' };
        } catch (error) {
            if (error instanceof HttpException) {
                throw error;
            }

            this.logger.error('Error regenerating markdown:', error);

            throw new BadRequestException({
                status: 'error',
                id: directoryId,
                message: normalizeGeneratorError(error),
            });
        }
    }

    async updateReadme(directoryId: string, user: User) {
        try {
            // Require editor role to generate/update items
            const { directory } = await this.ownershipService.ensureCanEdit(directoryId, user.id);

            const templateUpdate = await this.dataGenerator.updateMarkdownTemplate(directory, user);

            // If repository is not initialized yet, exit gracefully with a clear message.
            if (!templateUpdate.updated && templateUpdate.reason === 'not_initialized') {
                return {
                    status: 'skipped',
                    updated: false,
                    slug: directory.slug,
                    message: templateUpdate.message,
                };
            }

            if (templateUpdate.updated) {
                await this.markdownGenerator.initialize(directory, user, {
                    generation_method: GenerationMethod.CREATE_UPDATE,
                });
            }

            return {
                status: 'success',
                updated: templateUpdate.updated,
                slug: directory.slug,
                message:
                    templateUpdate.message ||
                    (templateUpdate.updated
                        ? 'README updated successfully.'
                        : 'README already up to date.'),
            };
        } catch (error) {
            if (error instanceof HttpException) {
                throw error;
            }

            this.logger.error('Error updating README:', error);

            throw new BadRequestException({
                status: 'error',
                directoryId,
                message: normalizeGeneratorError(error),
            });
        }
    }

    async updateWebsiteRepository(
        directoryId: string,
        user: User,
    ): Promise<UpdateWebsiteRepositoryResponseDto> {
        try {
            // Require editor role to generate/update items
            const { directory } = await this.ownershipService.ensureCanEdit(directoryId, user.id);

            const result = await this.websiteUpdateService.updateRepository(directory, user);
            const websiteOwner = directory.getRepoOwner('website');
            const websiteRepo = directory.getWebsiteRepo();

            return {
                status: 'success',
                slug: directory.slug,
                owner: websiteOwner,
                repository: `${websiteOwner}/${websiteRepo}`,
                message: result.message,
                method_used: result.method,
            };
        } catch (error) {
            if (error instanceof HttpException) {
                throw error;
            }

            this.logger.error('Error updating website repository:', error);

            throw new BadRequestException({
                status: 'error',
                directoryId,
                message: normalizeGeneratorError(error),
            });
        }
    }

    async runScheduledUpdate(
        schedule: DirectorySchedule,
    ): Promise<ItemsGeneratorResponseDto | void> {
        let user: User | null = null;
        try {
            user = (schedule.user as User) || (await this.userRepository.findById(schedule.userId));

            if (!user) {
                throw new NotFoundException('User not found for scheduled update');
            }

            // Enforce plan limits (e.g. if user downgraded)
            const allowed = await this.directoryScheduleService.validateRunEntitlement(
                schedule,
                user,
            );
            if (!allowed) {
                // validateRunEntitlement pauses the schedule, but doesn't clear
                // lastRunStatus from GENERATING or scheduledFor — finalize explicitly.
                await this.directoryScheduleService.finalizeScheduleRun(schedule.id, {
                    status: 'skipped',
                    reason: 'Entitlement check failed — schedule paused',
                });
                return {
                    slug: schedule.directory?.slug ?? schedule.directoryId,
                    status: 'skipped',
                    message: 'Entitlement check failed — schedule paused',
                };
            }

            const directory =
                (schedule.directory as Directory) ||
                (await this.directoryRepository.findById(schedule.directoryId));

            // Handle sync for directories imported from a separate source repository.
            if (
                directory?.sourceRepository &&
                supportsDirectorySourceSync(directory.sourceRepository.type)
            ) {
                return await this.runScheduledSync(directory, user, schedule);
            }

            const updateDto: UpdateItemsGeneratorDto = {
                update_with_pull_request: schedule.alwaysCreatePullRequest ?? false,
            };

            if (schedule.providerOverrides) {
                updateDto.providers = schedule.providerOverrides;
            }

            return await this.updateItemsGenerator({
                directoryId: schedule.directoryId,
                updateDto,
                user,
                awaitCompletion: false,
                context: {
                    triggeredBy: 'schedule',
                    scheduleId: schedule.id,
                    billingMode: schedule.billingMode,
                },
            });
        } catch (error) {
            // Ensure the schedule is finalized even for early failures (e.g. user deleted,
            // entitlement check throws). Inner methods handle their own finalization,
            // and markRunFailed is idempotent, so a duplicate call here is harmless.
            await this.directoryScheduleService.finalizeScheduleRun(schedule.id, {
                status: 'failed',
                reason: (error as Error)?.message,
            });
            throw error;
        }
    }

    /**
     * Run a scheduled sync for a directory that has a source repository.
     * This pulls updates from the original source (e.g., awesome-list or data repo).
     */
    private async runScheduledSync(
        directory: Directory,
        user: User,
        schedule: DirectorySchedule,
    ): Promise<void> {
        // Create history record for Sync
        const history = await this.generationHistoryRepository.createEntry({
            directoryId: directory.id,
            userId: user.id,
            generationMethod: null,
            parameters: {
                type: 'sync',
                sourceUrl: directory.sourceRepository!.url,
            },
            status: GenerateStatusType.GENERATING,
            startedAt: new Date(),
            triggeredBy: 'schedule',
            scheduleId: schedule.id,
        });

        // Update directory status
        await this.directoryRepository.recordGenerationStartTime(directory.id, new Date());
        await this.directoryRepository.updateGenerateStatus(directory.id, {
            status: GenerateStatusType.GENERATING,
            step: 'syncing',
        });

        try {
            const result = await this.directoryImportService.syncDirectory(
                directory,
                user,
                history.id,
            );

            if (result.success) {
                await this.handleSyncSuccess(directory.id, schedule.id, history.id);
            } else {
                await this.handleSyncFailure(directory.id, schedule.id, history.id, result.error);
            }
        } catch (error) {
            const errorMessage = (error as Error)?.message || 'Unknown sync error';
            await this.handleSyncFailure(directory.id, schedule.id, history.id, errorMessage);
            throw error;
        }
    }

    private async handleSyncSuccess(
        directoryId: string,
        scheduleId: string,
        historyId: string,
    ): Promise<void> {
        await Promise.all([
            this.directoryScheduleService.finalizeScheduleRun(scheduleId, {
                status: 'completed',
                historyId,
            }),
            this.directoryRepository.recordGenerationFinishTime(directoryId, new Date()),
            this.directoryRepository.updateGenerateStatus(directoryId, {
                status: GenerateStatusType.GENERATED,
                step: null,
            }),
        ]);
    }

    private async handleSyncFailure(
        directoryId: string,
        scheduleId: string,
        historyId: string,
        errorMessage?: string,
    ): Promise<void> {
        await Promise.all([
            this.directoryScheduleService.finalizeScheduleRun(scheduleId, {
                status: 'failed',
                reason: errorMessage,
            }),
            this.generationHistoryRepository.updateEntry(historyId, {
                status: GenerateStatusType.ERROR,
                errorMessage,
                finishedAt: new Date(),
            }),
            this.directoryRepository.recordGenerationFinishTime(directoryId, new Date()),
            this.directoryRepository.updateGenerateStatus(directoryId, {
                status: GenerateStatusType.ERROR,
                error: errorMessage,
            }),
        ]);
    }

    private async prepareProviders(
        dto: CreateItemsGeneratorDto,
        scopeOptions: { userId: string; directoryId: string },
    ): Promise<void> {
        await this.ensureProvidersEnabledForDirectory(
            dto.providers,
            scopeOptions.directoryId,
            scopeOptions.userId,
        );
        await this.generatorFormSchemaService.validateSelectedProviders(
            dto.providers,
            scopeOptions,
        );
        await this.generatorFormSchemaService.validateFormSchemaPlugins(scopeOptions);
        const processed = await this.generatorFormSchemaService.processFormConfig(
            dto.providers?.pipeline,
            dto.pluginConfig,
            scopeOptions,
        );
        dto.pluginConfig = processed.config;
        dto._processedPluginConfig = processed.pluginConfig;
    }

    /**
     * Auto-enable selected providers for a directory before generation starts.
     * Respects explicit disables: if a provider was explicitly disabled for this directory,
     * it is removed from the dto so the pipeline falls back to the default provider.
     */
    private async ensureProvidersEnabledForDirectory(
        providers: ProvidersDto | undefined,
        directoryId: string,
        userId: string,
    ): Promise<void> {
        if (!providers) return;

        const uiKeys = (
            Object.values(SELECTABLE_PROVIDER_CATEGORIES) as Array<{ uiKey: keyof ProvidersDto }>
        ).map((category) => category.uiKey);

        for (const uiKey of uiKeys) {
            const pluginId = providers[uiKey];
            if (!pluginId) continue;

            // Check if the plugin is currently enabled for this scope.
            // If it was explicitly disabled, don't re-enable — clear it so the system falls back.
            const isEnabled = await this.pluginRegistryService.isPluginEnabledForScope(
                pluginId,
                directoryId,
                userId,
            );

            if (!isEnabled) {
                this.logger.warn(
                    `Provider "${pluginId}" (${uiKey}) is disabled for directory ${directoryId}, removing from request`,
                );
                delete providers[uiKey];
                continue;
            }

            try {
                const capability = getCapabilityFromUIKey(uiKey);
                await this.pluginOperationsService.enablePluginForDirectory(
                    directoryId,
                    pluginId,
                    userId,
                    { activeCapability: capability },
                );
                this.logger.debug(
                    `Auto-enabled provider "${pluginId}" (${capability}) for directory ${directoryId}`,
                );
            } catch {
                // Skip silently — plugin may already be enabled or is a system plugin
            }
        }
    }

    private async runInProcessGeneration(
        directory: Directory,
        user: User,
        dto: CreateItemsGeneratorDto,
        history?: DirectoryGenerationHistory,
        context: GenerationTriggerContext = DEFAULT_TRIGGER_CONTEXT,
    ) {
        try {
            await this.processGeneration(directory, user, dto, history, context);
        } catch (error) {
            if (error instanceof HttpException) {
                throw error;
            }

            throw new BadRequestException({
                status: 'error',
                slug: directory.slug,
                message: normalizeGeneratorError(error),
            });
        }
    }

    private async createGenerationHistoryRecord(
        directory: Directory,
        user: User,
        dto: CreateItemsGeneratorDto,
        context: GenerationTriggerContext,
    ): Promise<DirectoryGenerationHistory> {
        const parameters = dto ? JSON.parse(JSON.stringify(dto)) : undefined;

        return this.generationHistoryRepository.createEntry({
            directoryId: directory.id,
            userId: user.id,
            generationMethod: dto?.generation_method ?? null,
            parameters,
            status: GenerateStatusType.GENERATING,
            startedAt: new Date(),
            triggeredBy: context.triggeredBy,
            scheduleId: context.scheduleId ?? null,
            activityType: DirectoryHistoryActivityType.GENERATION,
        });
    }

    private async recordActivityHistory(params: {
        directoryId: string;
        userId: string;
        activityType: DirectoryHistoryActivityType;
        entries: DirectoryHistoryChangeEntry[];
        summary?: string;
        newItemsCount?: number;
        updatedItemsCount?: number;
        totalItemsCount?: number;
    }): Promise<void> {
        const now = new Date();

        await this.generationHistoryRepository.createEntry({
            directoryId: params.directoryId,
            userId: params.userId,
            status: GenerateStatusType.GENERATED,
            startedAt: now,
            finishedAt: now,
            durationInSeconds: 0,
            newItemsCount: params.newItemsCount ?? 0,
            updatedItemsCount: params.updatedItemsCount ?? 0,
            totalItemsCount: params.totalItemsCount ?? 0,
            triggeredBy: 'user',
            activityType: params.activityType,
            changelog: buildDirectoryChangelog(params.entries, params.summary),
        });
    }

    private async dispatchGenerationTask(
        mode: DirectoryGenerationMode,
        directory: Directory,
        user: User,
        dto: CreateItemsGeneratorDto,
        historyId: string,
        history: DirectoryGenerationHistory,
        context: GenerationTriggerContext,
    ) {
        // Immediately set status to GENERATING so frontend shows progress UI right away
        // Don't wait for Trigger.dev to pick up the task - user needs instant feedback
        await Promise.all([
            this.directoryRepository.recordGenerationStartTime(directory.id, new Date()),
            this.directoryRepository.updateGenerateStatus(directory.id, {
                status: GenerateStatusType.GENERATING,
            }),
        ]);

        const payload: DirectoryGenerationPayload = {
            directoryId: directory.id,
            userId: user.id,
            mode,
            dto,
            historyId,
            historyStartedAt:
                history?.startedAt?.toISOString() ??
                history?.createdAt?.toISOString() ??
                new Date().toISOString(),
            triggerSource: context.triggeredBy,
            scheduleId: context.scheduleId,
        };

        const dispatchedId = this.generationDispatcher
            ? await this.generationDispatcher.dispatchDirectoryGeneration(payload)
            : null;

        if (dispatchedId) {
            await this.generationHistoryRepository.updateEntry(historyId, {
                triggerRunId: dispatchedId,
            });
        }

        if (!dispatchedId) {
            this.logger.warn(
                `Trigger dispatch failed, falling back to in-process generation for directory ${directory.id} (${mode})`,
            );

            // If triggered by schedule, await the process to prevent concurrency explosion (sequential fallback)
            // For user/api triggers, we can keep it async/fire-and-forget or let them wait if they opted for it (but this method is usually called when awaitCompletion=false)
            if (context.triggeredBy === 'schedule') {
                await this.processGeneration(directory, user, dto, history, context);
            } else {
                void this.processGeneration(directory, user, dto, history, context);
            }
        }
    }

    private async processGeneration(
        directory: Directory,
        user: User,
        dto: CreateItemsGeneratorDto,
        history?: DirectoryGenerationHistory,
        context: GenerationTriggerContext = DEFAULT_TRIGGER_CONTEXT,
    ) {
        const startTime = new Date();
        const abortController = new AbortController();

        await this.markGenerationStarted(directory.id, startTime, history);
        this.generationAbortControllers.set(directory.id, abortController);

        const acc: { stats: GenerationStats | null; warnings?: string[] } = {
            stats: null,
        };
        let generationError: unknown = null;
        const logCollector = history?.id
            ? new GenerationLogCollector(
                  history.id,
                  (historyId, logs) => this.generationHistoryRepository.appendLogs(historyId, logs),
                  {
                      onRecentLogsUpdated: async (logs) => {
                          const currentDirectory = await this.directoryRepository.findById(
                              directory.id,
                          );
                          if (!currentDirectory?.generateStatus) {
                              return;
                          }

                          await this.directoryRepository.updateGenerateStatus(directory.id, {
                              ...currentDirectory.generateStatus,
                              recentLogs: logs,
                          });
                      },
                  },
              )
            : undefined;

        try {
            await this.executeGenerationPipeline(
                directory,
                user,
                dto,
                context,
                acc,
                logCollector,
                abortController.signal,
            );
        } catch (error) {
            generationError = error;
        } finally {
            try {
                await logCollector?.dispose();
                await this.finalizeGeneration({
                    directoryId: directory.id,
                    startTime,
                    history,
                    error: generationError,
                    stats: acc.stats,
                    warnings: acc.warnings,
                    context,
                });
            } catch (finalizeError) {
                this.logger.error('Failed to finalize generation status:', finalizeError);
            } finally {
                this.generationAbortControllers.delete(directory.id);
            }
        }

        const completedDirectory = await this.directoryRepository.findById(directory.id);
        this.eventEmitter.emit(
            DirectoryGenerationCompletedEvent.EVENT_NAME,
            new DirectoryGenerationCompletedEvent(completedDirectory ?? directory),
        );

        if (generationError) {
            if (isGenerationCancelledError(generationError)) {
                return;
            }

            this.logger.error('Error during generation:', generationError);
            await this.handleErrorNotification(generationError, user, directory);

            if (generationError instanceof HttpException) {
                throw generationError;
            }
        }
    }

    /**
     * Runs the actual data → markdown → website pipeline.
     * Collects warnings/stats into the provided accumulator so they survive errors.
     */
    private async executeGenerationPipeline(
        directory: Directory,
        user: User,
        dto: CreateItemsGeneratorDto,
        context: GenerationTriggerContext,
        acc: { stats: GenerationStats | null; warnings?: string[] },
        logCollector?: GenerationLogCollector,
        signal?: AbortSignal,
    ): Promise<void> {
        const generated = await this.dataGenerator.initialize(directory, user, dto, {
            tryResume: context.triggeredBy === 'schedule',
            logCollector,
            signal,
        });

        acc.warnings = generated.warnings;

        if (generated.success === false) {
            const { error } = generated;
            this.logger.error(`Data generation failed: ${error.message}`);
            throw error.cause || new Error(error.message);
        }

        acc.stats = generated.stats;
        const newItemsCount = generated.stats?.newItemsCount ?? 0;
        const updatedItemsCount = generated.stats?.updatedItemsCount ?? 0;

        throwIfGenerationCancelled(signal);

        if (newItemsCount > 0 || updatedItemsCount > 0) {
            await this.markdownGenerator.initialize(directory, user, {
                generation_method: dto.generation_method,
                pr_update: generated.prUpdate,
                signal,
            });
        }

        throwIfGenerationCancelled(signal);

        if (generated.hasExistingItems || newItemsCount > 0) {
            try {
                await this.websiteGenerator.initialize(
                    directory,
                    user,
                    dto.website_repository_creation_method,
                    { signal },
                );
            } catch (error) {
                if (
                    this.isNonFatalWebsiteGenerationError(error, newItemsCount, updatedItemsCount)
                ) {
                    const warning = `Website repository setup skipped: ${normalizeGeneratorError(error)}`;
                    acc.warnings = [...(acc.warnings || []), warning];
                    this.logger.warn(warning);
                } else {
                    throw error;
                }
            }
        }
    }

    private isNonFatalWebsiteGenerationError(
        error: unknown,
        newItemsCount: number,
        updatedItemsCount: number,
    ): boolean {
        if (newItemsCount <= 0 && updatedItemsCount <= 0) {
            return false;
        }

        const normalizedError = normalizeGeneratorError(error).toLowerCase();
        return normalizedError.includes('repository not found');
    }

    private async markGenerationStarted(
        directoryId: string,
        startTime: Date,
        history?: DirectoryGenerationHistory,
    ): Promise<void> {
        await Promise.all([
            this.directoryRepository.recordGenerationStartTime(directoryId, startTime),
            this.directoryRepository.updateGenerateStatus(directoryId, {
                status: GenerateStatusType.GENERATING,
            }),
        ]);

        if (history) {
            await this.generationHistoryRepository.updateEntry(history.id, {
                startedAt: startTime,
                status: GenerateStatusType.GENERATING,
            });
        }
    }

    /**
     * Guarantees that directory, history, and schedule all reach a terminal state.
     * Called from finally — runs regardless of success or failure.
     */
    private async finalizeGeneration(params: {
        directoryId: string;
        startTime: Date;
        history?: DirectoryGenerationHistory;
        error: unknown;
        stats: GenerationStats | null;
        warnings?: string[];
        context: GenerationTriggerContext;
    }): Promise<void> {
        const { directoryId, startTime, history, error, stats, warnings, context } = params;
        const endTime = new Date();
        const durationInSeconds = calculateDurationSeconds(startTime, endTime);
        const finalStatus = this.resolveGenerationFinalStatus(error);
        const errorMessage = this.resolveGenerationErrorMessage(error);

        // 1. Finalize directory status
        await Promise.all([
            this.directoryRepository.recordGenerationFinishTime(directoryId, endTime),
            this.directoryRepository.updateGenerateStatus(directoryId, {
                status: finalStatus,
                ...(errorMessage ? { error: errorMessage } : { step: null }),
                warnings,
            }),
        ]);

        // 2. Finalize history record
        if (history) {
            await this.generationHistoryRepository.updateEntry(history.id, {
                status: finalStatus,
                finishedAt: endTime,
                durationInSeconds,
                ...(errorMessage ? { errorMessage } : {}),
                ...buildStatsUpdate(stats),
            });
        }

        // 3. Finalize schedule
        if (context.triggeredBy === 'schedule' && context.scheduleId) {
            await this.directoryScheduleService.finalizeScheduleRun(
                context.scheduleId,
                this.buildScheduleRunOutcome(error, history?.id),
            );
        }
    }

    private resolveGenerationFinalStatus(error: unknown): GenerateStatusType {
        if (isGenerationCancelledError(error)) {
            return GenerateStatusType.CANCELLED;
        }

        if (error) {
            return GenerateStatusType.ERROR;
        }

        return GenerateStatusType.GENERATED;
    }

    private resolveGenerationErrorMessage(error: unknown): string | undefined {
        if (!error) {
            return undefined;
        }

        if (isGenerationCancelledError(error)) {
            return GENERATION_CANCELLED;
        }

        return normalizeGeneratorError(error);
    }

    private buildScheduleRunOutcome(error: unknown, historyId?: string): ScheduleRunOutcome {
        const reason = this.resolveGenerationErrorMessage(error);

        if (reason) {
            return { status: 'failed', reason };
        }

        return { status: 'completed', historyId };
    }

    private async finalizeCancelledGeneration(
        directoryId: string,
        history?: DirectoryGenerationHistory | null,
        scheduleId?: string | null,
    ): Promise<void> {
        const finishedAt = new Date();
        const startedAt = history?.startedAt ?? finishedAt;

        await Promise.all([
            this.directoryRepository.recordGenerationFinishTime(directoryId, finishedAt),
            this.directoryRepository.updateGenerateStatus(directoryId, {
                status: GenerateStatusType.CANCELLED,
                error: GENERATION_CANCELLED,
                step: null,
            }),
            history
                ? this.generationHistoryRepository.updateEntry(history.id, {
                      status: GenerateStatusType.CANCELLED,
                      finishedAt,
                      durationInSeconds: calculateDurationSeconds(startedAt, finishedAt),
                      errorMessage: GENERATION_CANCELLED,
                  })
                : Promise.resolve(null),
            scheduleId
                ? this.directoryScheduleService.finalizeScheduleRun(scheduleId, {
                      status: 'failed',
                      reason: GENERATION_CANCELLED,
                  })
                : Promise.resolve(),
        ]);

        const completedDirectory = await this.directoryRepository.findById(directoryId);
        if (completedDirectory) {
            this.eventEmitter.emit(
                DirectoryGenerationCompletedEvent.EVENT_NAME,
                new DirectoryGenerationCompletedEvent(completedDirectory),
            );
        }
    }

    private ensureNotAlreadyGenerating(directory: Directory): void {
        if (directory.generateStatus?.status === GenerateStatusType.GENERATING) {
            throw new ConflictException(
                `Directory "${directory.name}" already has a generation in progress`,
            );
        }
    }

    private resolveContext(context?: GenerationTriggerContext): GenerationTriggerContext {
        if (!context) {
            return { ...DEFAULT_TRIGGER_CONTEXT };
        }

        return {
            triggeredBy: context.triggeredBy || DEFAULT_TRIGGER_CONTEXT.triggeredBy,
            scheduleId: context.scheduleId,
            billingMode: context.billingMode,
        };
    }

    private async handleErrorNotification(
        error: unknown,
        user: User,
        directory: Directory,
    ): Promise<void> {
        if (!this.notificationService) {
            return;
        }

        const classification = classifyGenerationError(error);

        if (classification.type !== 'unknown') {
            await notifyForClassifiedError(
                this.notificationService,
                user.id,
                directory.id,
                directory.name,
                classification,
            );
        }
    }
}
