import {
    BadRequestException,
    HttpException,
    Injectable,
    Logger,
    NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataGeneratorService } from '@src/data-generator/data-generator.service';
import { MarkdownGeneratorService } from '@src/markdown-generator/markdown-generator.service';
import { WebsiteGeneratorService } from '@src/website-generator/website-generator.service';
import { WebsiteUpdateService } from '@src/website-generator/website-update.service';
import {
    CreateItemsGeneratorDto,
    GenerationMethod,
    UpdateItemsGeneratorDto,
} from '@src/items-generator/dto/create-items-generator.dto';
import {
    SubmitItemDto,
    SubmitItemResponseDto,
    RemoveItemDto,
    RemoveItemResponseDto,
    ExtractItemDetailsDto,
    ExtractItemDetailsResponseDto,
} from '@src/items-generator/dto';
import {
    ItemsGeneratorMetrics,
    ItemsGeneratorResponseDto,
} from '@src/items-generator/dto/items-generator-response.dto';
import { ItemSubmissionService } from '@src/items-generator/item-submission.service';
import { ItemsGeneratorService } from '@src/items-generator/items-generator.service';
import { Directory } from '@src/entities/directory.entity';
import { User } from '@src/entities/user.entity';
import { DirectoryRepository } from '@src/database/repositories/directory.repository';
import { DirectoryGenerationHistoryRepository } from '@src/database/repositories/directory-generation-history.repository';
import { DirectoryGenerationHistory } from '@src/entities/directory-generation-history.entity';
import { DirectoryGenerationCompletedEvent } from '@src/events';
import { UpdateWebsiteRepositoryResponseDto } from '@src/website-generator/dto/update-website-repository.dto';
import { TriggerService } from '@src/trigger';
import {
    DIRECTORY_GENERATION_MODE,
    DirectoryGenerationMode,
    DirectoryGenerationPayload,
} from '@src/tasks/trigger/directory-generation.task';
import { DirectoryScheduleBillingMode, GenerateStatusType } from '@src/entities/types';
import { DirectoryOwnershipService } from './directory-ownership.service';
import { normalizeGeneratorError } from './utils/error.utils';
import { DirectorySchedule } from '@src/entities/directory-schedule.entity';
import { DirectoryScheduleService } from './directory-schedule.service';
import { UserRepository } from '@src/database/repositories/user.repository';

type GenerationStats = {
    newItemsCount: number;
    updatedItemsCount: number;
    totalItemsCount: number;
    metrics?: ItemsGeneratorMetrics;
};

type GenerationTriggerContext = {
    triggeredBy: 'user' | 'schedule' | 'api';
    scheduleId?: string;
    billingMode?: DirectoryScheduleBillingMode;
};

const DEFAULT_GENERATION_CONTEXT: GenerationTriggerContext = {
    triggeredBy: 'user',
};

@Injectable()
export class DirectoryGenerationService {
    private readonly logger = new Logger(DirectoryGenerationService.name);

    constructor(
        private readonly dataGenerator: DataGeneratorService,
        private readonly markdownGenerator: MarkdownGeneratorService,
        private readonly websiteGenerator: WebsiteGeneratorService,
        private readonly websiteUpdateService: WebsiteUpdateService,
        private readonly itemSubmissionService: ItemSubmissionService,
        private readonly itemsGeneratorService: ItemsGeneratorService,
        private readonly directoryRepository: DirectoryRepository,
        private readonly eventEmitter: EventEmitter2,
        private readonly triggerService: TriggerService,
        private readonly generationHistoryRepository: DirectoryGenerationHistoryRepository,
        private readonly ownershipService: DirectoryOwnershipService,
        private readonly directoryScheduleService: DirectoryScheduleService,
        private readonly userRepository: UserRepository,
    ) {}

    async generateItems(
        directoryId: string,
        dto: CreateItemsGeneratorDto,
        user: User,
        awaitCompletion = true,
        context: GenerationTriggerContext = DEFAULT_GENERATION_CONTEXT,
    ): Promise<ItemsGeneratorResponseDto> {
        const directory = await this.ownershipService.ensure(directoryId, user.id);
        const triggerContext = this.resolveContext(context);

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
        directoryId: string,
        updateDto: UpdateItemsGeneratorDto,
        user: User,
        awaitCompletion = true,
        context: GenerationTriggerContext = DEFAULT_GENERATION_CONTEXT,
    ): Promise<ItemsGeneratorResponseDto> {
        const directory = await this.ownershipService.ensure(directoryId, user.id);
        const triggerContext = this.resolveContext(context);

        let lastRequestData = await this.dataGenerator
            .getLastRequestData(directory, user)
            .catch(() => null);

        if (!lastRequestData) {
            throw new BadRequestException({
                status: 'error',
                slug: directory.slug,
                message: 'No previous request data found',
            });
        }

        const payload = {
            ...lastRequestData,
            ...updateDto,
        };

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

    async submitItem(directoryId: string, dto: SubmitItemDto, user: User) {
        try {
            const directory = await this.ownershipService.ensure(directoryId, user.id);

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
            const directory = await this.ownershipService.ensure(directoryId, user.id);

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

    async extractItemDetails(dto: ExtractItemDetailsDto): Promise<ExtractItemDetailsResponseDto> {
        try {
            const item = await this.itemsGeneratorService.extractItemDetailsFromUrl(
                dto.source_url,
                dto.existing_categories || [],
            );

            if (!item) {
                throw new BadRequestException({
                    status: 'error',
                    source_url: dto.source_url,
                    message: 'No item data could be extracted from the URL content',
                });
            }

            return {
                status: 'success',
                item,
                source_url: dto.source_url,
                message: `Successfully extracted item details: "${item.name}"`,
            };
        } catch (error) {
            if (error instanceof HttpException) {
                throw error;
            }

            this.logger.error('Error extracting item details:', error);

            throw new BadRequestException({
                status: 'error',
                source_url: dto.source_url,
                message: normalizeGeneratorError(error),
            });
        }
    }

    async regenerateMarkdown(directoryId: string, user: User) {
        try {
            const directory = await this.ownershipService.ensure(directoryId, user.id);

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

    async updateWebsiteRepository(
        directoryId: string,
        user: User,
    ): Promise<UpdateWebsiteRepositoryResponseDto> {
        try {
            const directory = await this.ownershipService.ensure(directoryId, user.id);

            const result = await this.websiteUpdateService.updateRepository(directory, user);

            return {
                status: 'success',
                slug: directory.slug,
                owner: directory.getRepoOwner(),
                repository: `${directory.getRepoOwner()}/${directory.getWebsiteRepo()}`,
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

    async runScheduledUpdate(schedule: DirectorySchedule) {
        const user =
            (schedule.user as User) || (await this.userRepository.findById(schedule.userId));

        if (!user) {
            throw new NotFoundException('User not found for scheduled update');
        }

        await this.directoryScheduleService.markRunDispatched(schedule.id);

        return this.updateItemsGenerator(schedule.directoryId, {}, user, false, {
            triggeredBy: 'schedule',
            scheduleId: schedule.id,
            billingMode: schedule.billingMode,
        });
    }

    private async runInProcessGeneration(
        directory: Directory,
        user: User,
        dto: CreateItemsGeneratorDto,
        history?: DirectoryGenerationHistory,
        context: GenerationTriggerContext = DEFAULT_GENERATION_CONTEXT,
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

        const dispatched = await this.triggerService.dispatchDirectoryGeneration(payload);

        if (!dispatched) {
            this.logger.warn(
                `Trigger dispatch failed, falling back to in-process generation for directory ${directory.id} (${mode})`,
            );

            void this.processGeneration(directory, user, dto, history);
        }
    }

    private async processGeneration(
        directory: Directory,
        user: User,
        dto: CreateItemsGeneratorDto,
        history?: DirectoryGenerationHistory,
        context: GenerationTriggerContext = DEFAULT_GENERATION_CONTEXT,
    ) {
        const startTime = new Date();

        await Promise.all([
            this.directoryRepository.recordGenerationStartTime(directory.id, startTime),
            this.directoryRepository.updateGenerateStatus(directory.id, {
                status: GenerateStatusType.GENERATING,
            }),
        ]);

        if (history) {
            await this.generationHistoryRepository.updateEntry(history.id, {
                startedAt: startTime,
                status: GenerateStatusType.GENERATING,
            });
        }

        let hasError = false;
        let generationStats: GenerationStats | null = null;

        try {
            const generated = await this.dataGenerator.initialize(directory, user, dto);

            if (generated !== false && generated?.stats) {
                generationStats = generated.stats as GenerationStats;
            }

            if (generated !== false && (generated.stats?.totalItemsCount ?? 0) > 0) {
                await this.markdownGenerator.initialize(directory, user, {
                    repository_description: dto.repository_description,
                    generation_method: generated.generation_method,
                    pr_update: generated.prUpdate,
                });
            }

            await this.websiteGenerator.initialize(
                directory,
                user,
                dto.website_repository_creation_method,
            );

            if (history) {
                await this.generationHistoryRepository.updateEntry(history.id, {
                    newItemsCount: generationStats?.newItemsCount ?? 0,
                    updatedItemsCount: generationStats?.updatedItemsCount ?? 0,
                    totalItemsCount: generationStats?.totalItemsCount ?? 0,
                    metrics: generationStats?.metrics,
                });
            }
        } catch (error) {
            await Promise.all([
                this.directoryRepository.recordGenerationFinishTime(directory.id, new Date()),
                this.directoryRepository.updateGenerateStatus(directory.id, {
                    status: GenerateStatusType.ERROR,
                    error: normalizeGeneratorError(error),
                }),
            ]);

            if (history) {
                const endTime = new Date();
                const duration = Math.round((endTime.getTime() - startTime.getTime()) / 1000);
                await this.generationHistoryRepository.updateEntry(history.id, {
                    status: GenerateStatusType.ERROR,
                    finishedAt: endTime,
                    durationInSeconds: duration,
                    errorMessage: normalizeGeneratorError(error),
                    newItemsCount: generationStats?.newItemsCount ?? 0,
                    updatedItemsCount: generationStats?.updatedItemsCount ?? 0,
                    totalItemsCount: generationStats?.totalItemsCount ?? 0,
                    metrics: generationStats?.metrics,
                });
            }

            if (error instanceof HttpException) {
                throw error;
            }

            hasError = true;

            this.logger.error('Error during generation:', error);
        }

        if (!hasError) {
            await Promise.all([
                this.directoryRepository.recordGenerationFinishTime(directory.id, new Date()),
                this.directoryRepository.updateGenerateStatus(directory.id, {
                    status: GenerateStatusType.GENERATED,
                    step: null,
                }),
            ]);

            if (history) {
                const endTime = new Date();
                const duration = Math.round((endTime.getTime() - startTime.getTime()) / 1000);
                await this.generationHistoryRepository.updateEntry(history.id, {
                    status: GenerateStatusType.GENERATED,
                    finishedAt: endTime,
                    durationInSeconds: duration,
                    newItemsCount: generationStats?.newItemsCount ?? 0,
                    updatedItemsCount: generationStats?.updatedItemsCount ?? 0,
                    totalItemsCount: generationStats?.totalItemsCount ?? 0,
                    metrics: generationStats?.metrics,
                });
            }
        }

        if (context.triggeredBy === 'schedule' && context.scheduleId) {
            if (!hasError) {
                await this.directoryScheduleService.markRunCompleted({
                    scheduleId: context.scheduleId,
                    historyId: history?.id,
                    status: GenerateStatusType.GENERATED,
                });
            } else {
                await this.directoryScheduleService.markRunFailed(context.scheduleId);
            }
        }

        this.eventEmitter.emit(
            DirectoryGenerationCompletedEvent.EVENT_NAME,
            new DirectoryGenerationCompletedEvent(directory),
        );
    }

    private resolveContext(context?: GenerationTriggerContext): GenerationTriggerContext {
        if (!context) {
            return { ...DEFAULT_GENERATION_CONTEXT };
        }

        return {
            triggeredBy: context.triggeredBy || DEFAULT_GENERATION_CONTEXT.triggeredBy,
            scheduleId: context.scheduleId,
            billingMode: context.billingMode,
        };
    }
}
