import {
    BadRequestException,
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    HttpStatus,
    Inject,
    NotFoundException,
    Param,
    Post,
    Put,
    Query,
    Logger,
    UseGuards,
} from '@nestjs/common';
import {
    ApiTags,
    ApiBearerAuth,
    ApiOperation,
    ApiResponse,
    ApiParam,
    ApiQuery,
} from '@nestjs/swagger';
import {
    CreateWorkDto,
    UpdateWorkDto,
    UpdateWorkAdvancedPromptsDto,
    CreateCategoryDto,
    UpdateCategoryDto,
    CreateCollectionDto,
    UpdateCollectionDto,
    CreateTagDto,
    UpdateTagDto,
    UpdateWebsiteSettingsDto,
} from '@ever-works/agent/dto';
import {
    CreateItemsGeneratorDto,
    DeleteWorkDto,
    DeleteWorkResponseDto,
    ExtractItemDetailsDto,
    ExtractItemDetailsResponseDto,
    ItemsGeneratorResponseDto,
    CancelGenerationResponseDto,
    RemoveItemDto,
    RemoveItemResponseDto,
    SubmitItemDto,
    SubmitItemResponseDto,
    UpdateItemsGeneratorDto,
    UpdateItemDto,
    CheckItemHealthDto,
    CheckItemHealthResponseDto,
} from '@ever-works/agent/items-generator';
import { BulkCaptureImagesDto, BulkCaptureImagesResponseDto } from '@ever-works/agent/services';
import {
    WorkDetailService,
    WorkGenerationService,
    WorkLifecycleService,
    WorkQueryService,
    WorkScheduleService,
    WorkImportService,
    RepositoryManagementService,
    RepositoryStatus,
    RepositoryType,
    WorkOwnershipService,
    WorkAdvancedPromptsService,
    WorkTaxonomyService,
    GeneratorFormSchemaService,
    ItemHealthService,
    ItemSourceValidationSchedulerService,
    type SourceValidationSettingsDto,
} from '@ever-works/agent/services';
import { ComparisonGenerationService } from '@ever-works/agent/comparison-generator';
import {
    AnalyzeRepositoryDto,
    AnalyzeRepositoryResponseDto,
    AnalyzeForLinkingResponseDto,
    ImportWorkDto,
    ImportWorkResponseDto,
    GetUserRepositoriesDto,
    GetUserRepositoriesResponseDto,
} from '@ever-works/agent/dto';
import {
    SwitchWebsiteTemplateResponseDto,
    UpdateWebsiteRepositoryResponseDto,
} from '@ever-works/agent/generators';
import { getDefaultWebsiteTemplateId, listWebsiteTemplates } from '@ever-works/agent/generators';
import { CommunityPrProcessorService } from '@ever-works/agent/community-pr';
import { WorkRepository } from '@ever-works/agent/database';
import { AuthService, CurrentUser, AuthSessionGuard } from '../auth';
import { AuthenticatedUser } from '@src/auth/types/auth.types';
import { GenerateWorkDetailDto } from './dto/generate-detail.dto';
import { GenerateManualComparisonDto } from './dto/generate-manual-comparison.dto';
import { CACHE_MANAGER, Cache, CacheEntryRepository } from '@ever-works/agent/cache';
import { UpdateWorkScheduleDto, UpdateSourceValidationDto } from '@ever-works/agent/dto';
import { WorkScheduleStatus } from '@ever-works/agent/entities';
import { SubscriptionService } from '@ever-works/agent/subscriptions';
import { ActivityLogService } from '@ever-works/agent/activity-log';
import { ActivityActionType, ActivityStatus } from '@ever-works/agent/entities';
import {
    WORK_CACHE_TTL_MS,
    getWorkCategoriesTagsCacheKey,
    getWorkConfigCacheKey,
    getWorkCountCacheKey,
    getWorkItemsCacheKey,
} from './work-cache.constants';

@ApiTags('Works')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(AuthSessionGuard)
export class WorksController {
    private readonly logger = new Logger(WorksController.name);

    constructor(
        @Inject(CACHE_MANAGER) private cacheManager: Cache,
        private readonly cacheEntryRepository: CacheEntryRepository,
        private readonly workQueryService: WorkQueryService,
        private readonly workLifecycleService: WorkLifecycleService,
        private readonly workGenerationService: WorkGenerationService,
        private readonly authService: AuthService,
        private readonly workDetailService: WorkDetailService,
        private readonly workScheduleService: WorkScheduleService,
        private readonly workImportService: WorkImportService,
        private readonly repositoryManagementService: RepositoryManagementService,
        private readonly workOwnershipService: WorkOwnershipService,
        private readonly workAdvancedPromptsService: WorkAdvancedPromptsService,
        private readonly workTaxonomyService: WorkTaxonomyService,
        private readonly generatorFormSchemaService: GeneratorFormSchemaService,
        private readonly itemHealthService: ItemHealthService,
        private readonly communityPrProcessorService: CommunityPrProcessorService,
        private readonly comparisonGenerationService: ComparisonGenerationService,
        private readonly workRepository: WorkRepository,
        private readonly sourceValidationService: ItemSourceValidationSchedulerService,
        private readonly subscriptionService: SubscriptionService,
        private readonly activityLogService: ActivityLogService,
    ) {}

    private async invalidateWorkCaches(workId: string): Promise<void> {
        await this.cacheEntryRepository.typeormAdapter.deleteUnscopedEntriesLike(workId);
    }

    @Get('works')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'List works',
        description: 'Get all works accessible to the authenticated user',
    })
    @ApiQuery({ name: 'limit', required: false, description: 'Maximum number of results' })
    @ApiQuery({ name: 'offset', required: false, description: 'Number of results to skip' })
    @ApiQuery({ name: 'search', required: false, description: 'Search term to filter works' })
    @ApiResponse({ status: 200, description: 'List of works' })
    async getWorks(
        @CurrentUser() auth: AuthenticatedUser,
        @Query('limit') limit?: string,
        @Query('offset') offset?: string,
        @Query('search') search?: string,
    ) {
        const parsedLimit = limit !== undefined ? Number(limit) : undefined;
        const parsedOffset = offset !== undefined ? Number(offset) : undefined;

        const user = await this.authService.getUser(auth.userId);

        return this.workQueryService.getWorks(
            {
                limit: parsedLimit && !isNaN(parsedLimit) ? parsedLimit : undefined,
                offset: parsedOffset && !isNaN(parsedOffset) ? parsedOffset : undefined,
                search: search || undefined,
            },
            user,
        );
    }

    @Get('works/stats')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Get work stats',
        description:
            'Get aggregated stats (total works, total items, active websites) for the authenticated user',
    })
    @ApiResponse({ status: 200, description: 'Work stats' })
    async getWorkStats(@CurrentUser() auth: AuthenticatedUser) {
        const user = await this.authService.getUser(auth.userId);
        return this.workQueryService.getStats(user);
    }

    @Get('works/website-templates')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'List website templates',
        description: 'Get the available website templates for work website generation',
    })
    @ApiResponse({ status: 200, description: 'Available website templates' })
    async getWebsiteTemplates() {
        const defaultTemplateId = getDefaultWebsiteTemplateId();

        return {
            status: 'success',
            templates: listWebsiteTemplates().map((template) => ({
                id: template.id,
                name: template.name,
                description: template.description,
                isDefault: template.id === defaultTemplateId,
            })),
        };
    }

    @Post('works')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Create work', description: 'Create a new work' })
    @ApiResponse({ status: 200, description: 'Work created successfully' })
    @ApiResponse({ status: 400, description: 'Invalid input data' })
    async createWork(@CurrentUser() auth: AuthenticatedUser, @Body() createWorkDto: CreateWorkDto) {
        const user = await this.authService.getUser(auth.userId);
        return this.workLifecycleService.createWork(createWorkDto, user);
    }

    @Get('works/:id')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Get work', description: 'Get a specific work by ID' })
    @ApiParam({ name: 'id', description: 'Work ID' })
    @ApiResponse({ status: 200, description: 'Work details' })
    @ApiResponse({ status: 404, description: 'Work not found' })
    async getWork(@CurrentUser() auth: AuthenticatedUser, @Param('id') id: string) {
        const user = await this.authService.getUser(auth.userId);
        return this.workQueryService.getWork(id, user);
    }

    @Put('works/:id')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Update work',
        description: 'Update work settings and configuration',
    })
    @ApiParam({ name: 'id', description: 'Work ID' })
    @ApiResponse({ status: 200, description: 'Work updated successfully' })
    async updateWork(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Body() updateWorkDto: UpdateWorkDto,
    ) {
        const user = await this.authService.getUser(auth.userId);
        const result = await this.workLifecycleService.updateWork(id, updateWorkDto, user);
        this.activityLogService
            .log({
                userId: auth.userId,
                workId: id,
                actionType: ActivityActionType.WORK_UPDATED,
                action: 'work.updated',
                status: ActivityStatus.COMPLETED,
                summary: `Updated work settings`,
            })
            .catch(() => {});
        return result;
    }

    @Get('works/:id/items')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Get work items', description: 'Get all items in a work' })
    @ApiParam({ name: 'id', description: 'Work ID' })
    @ApiResponse({ status: 200, description: 'List of work items' })
    async getWorkItems(@CurrentUser() auth: AuthenticatedUser, @Param('id') id: string) {
        const cacheKey = getWorkItemsCacheKey(id, auth.userId);

        return this.cacheManager.wrap(
            cacheKey,
            async () => {
                const user = await this.authService.getUser(auth.userId);
                return this.workQueryService.workItems(id, user);
            },
            WORK_CACHE_TTL_MS,
        );
    }

    @Get('works/:id/config')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Get work config',
        description: 'Get work configuration and metadata',
    })
    @ApiParam({ name: 'id', description: 'Work ID' })
    @ApiResponse({ status: 200, description: 'Work configuration' })
    async getWorkConfig(@CurrentUser() auth: AuthenticatedUser, @Param('id') id: string) {
        const cacheKey = getWorkConfigCacheKey(id, auth.userId);

        return this.cacheManager.wrap(
            cacheKey,
            async () => {
                const user = await this.authService.getUser(auth.userId);
                return this.workQueryService.workConfig(id, user);
            },
            WORK_CACHE_TTL_MS,
        );
    }

    @Get('works/:id/website-settings')
    @HttpCode(HttpStatus.OK)
    async getWebsiteSettings(@CurrentUser() auth: AuthenticatedUser, @Param('id') id: string) {
        const user = await this.authService.getUser(auth.userId);
        return this.workQueryService.getWebsiteSettings(id, user);
    }

    @Put('works/:id/website-settings')
    @HttpCode(HttpStatus.OK)
    async updateWebsiteSettings(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Body() dto: UpdateWebsiteSettingsDto,
    ) {
        const user = await this.authService.getUser(auth.userId);
        const result = await this.workQueryService.updateWebsiteSettings(id, user, dto);
        await this.invalidateWorkCaches(id);
        this.activityLogService
            .log({
                userId: auth.userId,
                workId: id,
                actionType: ActivityActionType.WEBSITE_SETTINGS_UPDATED,
                action: 'work.website_settings_updated',
                status: ActivityStatus.COMPLETED,
                summary: `Updated website settings`,
            })
            .catch(() => {});
        return result;
    }

    @Get('works/:id/count')
    @HttpCode(HttpStatus.OK)
    async getWorkStatus(@CurrentUser() auth: AuthenticatedUser, @Param('id') id: string) {
        const cacheKey = getWorkCountCacheKey(id, auth.userId);

        return this.cacheManager.wrap(
            cacheKey,
            async () => {
                const user = await this.authService.getUser(auth.userId);
                return this.workQueryService.workCount(id, user);
            },
            WORK_CACHE_TTL_MS,
        );
    }

    @Get('works/:id/categories-tags')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Get categories and tags',
        description: 'Get categories and tags for a work',
    })
    @ApiParam({ name: 'id', description: 'Work ID' })
    @ApiResponse({ status: 200, description: 'Categories and tags' })
    async getWorkCategoriesTags(@CurrentUser() auth: AuthenticatedUser, @Param('id') id: string) {
        const cacheKey = getWorkCategoriesTagsCacheKey(id, auth.userId);

        return this.cacheManager.wrap(
            cacheKey,
            async () => {
                const user = await this.authService.getUser(auth.userId);
                return this.workQueryService.workCategoriesTags(id, user);
            },
            WORK_CACHE_TTL_MS,
        );
    }

    @Get('works/:id/history')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Get work history',
        description: 'Get generation and update history for a work',
    })
    @ApiParam({ name: 'id', description: 'Work ID' })
    @ApiQuery({ name: 'limit', required: false, description: 'Maximum number of results' })
    @ApiQuery({ name: 'offset', required: false, description: 'Number of results to skip' })
    @ApiQuery({
        name: 'activityType',
        required: false,
        description:
            'Optional history activity filter (generation, items, comparisons, taxonomy, community_pr)',
    })
    @ApiResponse({ status: 200, description: 'Generation history' })
    async getWorkHistory(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Query('limit') limit?: string,
        @Query('offset') offset?: string,
        @Query('activityType') activityType?: string,
    ) {
        const user = await this.authService.getUser(auth.userId);

        const parsedLimit = limit !== undefined ? Number(limit) : undefined;
        const parsedOffset = offset !== undefined ? Number(offset) : undefined;

        const result = await this.workQueryService.workGenerationHistory(id, user, {
            limit: parsedLimit && !isNaN(parsedLimit) ? parsedLimit : undefined,
            offset: parsedOffset && !isNaN(parsedOffset) ? parsedOffset : undefined,
            activityType,
        });

        return {
            status: 'success',
            ...result,
        };
    }

    @Post('works/generate-details')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Generate work details',
        description: 'AI-generate work name, description, and categories from a prompt',
    })
    @ApiResponse({ status: 200, description: 'Generated work details' })
    async generateWorkDetails(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() generateWorkDetailDto: GenerateWorkDetailDto,
    ) {
        const user = await this.authService.getUser(auth.userId);
        return this.workDetailService.generateWorkDetails(
            generateWorkDetailDto.work_name,
            generateWorkDetailDto.prompt,
            user,
            generateWorkDetailDto.ai_provider,
        );
    }

    @Get('generator-form')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Get global generator form schema',
        description:
            'Get the dynamic form schema for the generator without a specific work context',
    })
    @ApiQuery({ name: 'pipelineId', required: false, description: 'Selected pipeline plugin ID' })
    @ApiResponse({ status: 200, description: 'Generator form schema' })
    async getGlobalGeneratorFormSchema(
        @CurrentUser() auth: AuthenticatedUser,
        @Query('pipelineId') pipelineId?: string,
    ) {
        const user = await this.authService.getUser(auth.userId);

        return this.generatorFormSchemaService.getFormSchema(pipelineId, {
            userId: user.id,
        });
    }

    @Get('works/:id/generator-form')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Get generator form schema',
        description:
            'Get the dynamic form schema for the generator based on the selected pipeline plugin',
    })
    @ApiParam({ name: 'id', description: 'Work ID' })
    @ApiQuery({ name: 'pipelineId', required: false, description: 'Selected pipeline plugin ID' })
    @ApiResponse({ status: 200, description: 'Generator form schema' })
    async getGeneratorFormSchema(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Query('pipelineId') pipelineId?: string,
    ) {
        const user = await this.authService.getUser(auth.userId);
        await this.workOwnershipService.ensureAccess(id, user.id);

        return this.generatorFormSchemaService.getFormSchema(pipelineId, {
            workId: id,
            userId: user.id,
        });
    }

    @Post('works/:id/generate')
    @HttpCode(HttpStatus.ACCEPTED)
    @ApiOperation({
        summary: 'Generate items',
        description: 'Start AI-powered item generation for a work',
    })
    @ApiParam({ name: 'id', description: 'Work ID' })
    @ApiResponse({ status: 202, description: 'Generation started' })
    async generateItems(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Body() createItemsGeneratorDto: CreateItemsGeneratorDto,
    ): Promise<ItemsGeneratorResponseDto> {
        const user = await this.authService.getUser(auth.userId);

        this.activityLogService
            .log({
                userId: auth.userId,
                workId: id,
                actionType: ActivityActionType.GENERATION,
                action: 'generation.started',
                status: ActivityStatus.IN_PROGRESS,
                summary: `Started item generation`,
            })
            .catch(() => {});

        return this.workGenerationService.generateItems(id, createItemsGeneratorDto, user, false);
    }

    @Post('works/:id/update')
    @HttpCode(HttpStatus.ACCEPTED)
    @ApiOperation({
        summary: 'Update items',
        description: 'Update existing items in a work using AI',
    })
    @ApiParam({ name: 'id', description: 'Work ID' })
    @ApiResponse({ status: 202, description: 'Update started' })
    async updateItemsGenerator(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Body() updateItemsGeneratorDto: UpdateItemsGeneratorDto,
    ): Promise<ItemsGeneratorResponseDto> {
        const user = await this.authService.getUser(auth.userId);

        this.activityLogService
            .log({
                userId: auth.userId,
                workId: id,
                actionType: ActivityActionType.GENERATION,
                action: 'generation.update_started',
                status: ActivityStatus.IN_PROGRESS,
                summary: `Started item update`,
            })
            .catch(() => {});

        return this.workGenerationService.updateItemsGenerator({
            workId: id,
            updateDto: updateItemsGeneratorDto,
            user,
            awaitCompletion: false,
        });
    }

    @Post('works/:id/cancel-generation')
    @HttpCode(HttpStatus.ACCEPTED)
    @ApiOperation({
        summary: 'Cancel generation',
        description: 'Request cancellation of the active generation for a work',
    })
    @ApiParam({ name: 'id', description: 'Work ID' })
    @ApiResponse({ status: 202, description: 'Generation cancellation requested' })
    async cancelGeneration(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
    ): Promise<CancelGenerationResponseDto> {
        const user = await this.authService.getUser(auth.userId);
        return this.workGenerationService.cancelGeneration(id, user);
    }

    @Get('works/:id/schedule')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Get schedule',
        description: 'Get scheduled update configuration for a work',
    })
    @ApiParam({ name: 'id', description: 'Work ID' })
    @ApiResponse({ status: 200, description: 'Schedule configuration' })
    async getWorkSchedule(@CurrentUser() auth: AuthenticatedUser, @Param('id') id: string) {
        const user = await this.authService.getUser(auth.userId);
        const result = await this.workScheduleService.getSchedule(id, user);

        return {
            status: 'success',
            ...result,
        };
    }

    @Put('works/:id/schedule')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Update schedule',
        description:
            'Update scheduled update configuration (cadence, enable/disable, billing mode)',
    })
    @ApiParam({ name: 'id', description: 'Work ID' })
    @ApiResponse({ status: 200, description: 'Schedule updated' })
    async updateWorkSchedule(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Body() updateScheduleDto: UpdateWorkScheduleDto,
    ) {
        const user = await this.authService.getUser(auth.userId);
        const schedule = await this.workScheduleService.updateSchedule(id, updateScheduleDto, user);

        if (updateScheduleDto.runImmediately && schedule.status === WorkScheduleStatus.ACTIVE) {
            const scheduleEntity = await this.workScheduleService.getScheduleEntity(id, user);
            void this.workGenerationService.runScheduledUpdate(scheduleEntity).catch((error) => {
                this.logger.error(
                    `Failed to start immediate scheduled update for work ${id}`,
                    error instanceof Error ? error.stack : String(error),
                );
            });
        }

        this.activityLogService
            .log({
                userId: auth.userId,
                workId: id,
                actionType: ActivityActionType.SCHEDULE_UPDATED,
                action: 'schedule.updated',
                status: ActivityStatus.COMPLETED,
                summary: `Updated schedule`,
            })
            .catch(() => {});

        return {
            status: 'success',
            schedule,
        };
    }

    @Delete('works/:id/schedule')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Cancel schedule',
        description: 'Cancel and remove scheduled updates for a work',
    })
    @ApiParam({ name: 'id', description: 'Work ID' })
    @ApiResponse({ status: 200, description: 'Schedule cancelled' })
    async cancelWorkSchedule(@CurrentUser() auth: AuthenticatedUser, @Param('id') id: string) {
        const user = await this.authService.getUser(auth.userId);
        const schedule = await this.workScheduleService.cancelSchedule(id, user);

        this.activityLogService
            .log({
                userId: auth.userId,
                workId: id,
                actionType: ActivityActionType.SCHEDULE_DELETED,
                action: 'schedule.deleted',
                status: ActivityStatus.COMPLETED,
                summary: `Deleted schedule`,
            })
            .catch(() => {});

        return {
            status: 'success',
            schedule,
        };
    }

    @Post('works/:id/schedule/run')
    @HttpCode(HttpStatus.ACCEPTED)
    @ApiOperation({
        summary: 'Run scheduled update',
        description: 'Manually trigger a scheduled update now',
    })
    @ApiParam({ name: 'id', description: 'Work ID' })
    @ApiResponse({ status: 202, description: 'Scheduled update triggered' })
    @ApiResponse({ status: 400, description: 'Schedule must be active to run' })
    async runScheduledUpdate(@CurrentUser() auth: AuthenticatedUser, @Param('id') id: string) {
        const user = await this.authService.getUser(auth.userId);
        const schedule = await this.workScheduleService.getScheduleEntity(id, user);

        if (schedule.status !== WorkScheduleStatus.ACTIVE) {
            throw new BadRequestException({
                status: 'error',
                message: 'Schedule must be active to run',
            });
        }

        this.activityLogService
            .log({
                userId: auth.userId,
                workId: id,
                actionType: ActivityActionType.SCHEDULE_EXECUTED,
                action: 'schedule.executed',
                status: ActivityStatus.COMPLETED,
                summary: `Triggered scheduled update`,
            })
            .catch(() => {});

        void this.workGenerationService.runScheduledUpdate(schedule).catch((error) => {
            this.logger.error(
                `Failed to run scheduled update for work ${id}`,
                error instanceof Error ? error.stack : String(error),
            );
        });

        return {
            status: 'pending',
            slug: schedule.work?.slug ?? id,
            message: 'Scheduled update started',
        };
    }

    @Post('works/:id/submit-item')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Submit item', description: 'Add a single item to a work' })
    @ApiParam({ name: 'id', description: 'Work ID' })
    @ApiResponse({ status: 200, description: 'Item submitted successfully' })
    async submitItem(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Body() submitItemDto: SubmitItemDto,
    ): Promise<SubmitItemResponseDto> {
        const user = await this.authService.getUser(auth.userId);
        const result = await this.workGenerationService.submitItem(id, submitItemDto, user);
        await this.invalidateWorkCaches(id);
        this.activityLogService
            .log({
                userId: auth.userId,
                workId: id,
                actionType: ActivityActionType.ITEM_ADDED,
                action: 'item.submitted',
                status: ActivityStatus.COMPLETED,
                summary: `Added item: ${submitItemDto.name || 'New item'}`,
            })
            .catch(() => {});
        return result;
    }

    @Post('works/:id/remove-item')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Remove item', description: 'Remove an item from a work' })
    @ApiParam({ name: 'id', description: 'Work ID' })
    @ApiResponse({ status: 200, description: 'Item removed successfully' })
    async removeItem(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Body() removeItemDto: RemoveItemDto,
    ): Promise<RemoveItemResponseDto> {
        const user = await this.authService.getUser(auth.userId);
        const result = await this.workGenerationService.removeItem(id, removeItemDto, user);
        await this.invalidateWorkCaches(id);
        this.activityLogService
            .log({
                userId: auth.userId,
                workId: id,
                actionType: ActivityActionType.ITEM_REMOVED,
                action: 'item.removed',
                status: ActivityStatus.COMPLETED,
                summary: `Removed item`,
            })
            .catch(() => {});
        return result;
    }

    @Post('works/:id/update-item')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Update item',
        description: 'Update item metadata (featured status, display order)',
    })
    @ApiParam({ name: 'id', description: 'Work ID' })
    @ApiResponse({ status: 200, description: 'Item updated successfully' })
    async updateItemMetadata(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Body() updateItemDto: UpdateItemDto,
    ) {
        const user = await this.authService.getUser(auth.userId);
        const result = await this.workGenerationService.updateItemMetadata(id, updateItemDto, user);
        await this.invalidateWorkCaches(id);

        this.activityLogService
            .log({
                userId: auth.userId,
                workId: id,
                actionType: ActivityActionType.ITEM_UPDATED,
                action: 'item.updated',
                status: ActivityStatus.COMPLETED,
                summary: `Updated item metadata`,
                details: {
                    itemSlug: updateItemDto.item_slug,
                    featured: updateItemDto.featured,
                    order: updateItemDto.order,
                },
            })
            .catch(() => {});

        return result;
    }

    @Post('works/:id/check-item-health')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Check item health',
        description: 'Run a source URL health check for a single item and persist the result',
    })
    @ApiParam({ name: 'id', description: 'Work ID' })
    @ApiResponse({ status: 200, description: 'Item health checked successfully' })
    async checkItemHealth(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Body() checkItemHealthDto: CheckItemHealthDto,
    ): Promise<CheckItemHealthResponseDto> {
        const user = await this.authService.getUser(auth.userId);
        const result = await this.itemHealthService.checkItem(
            id,
            checkItemHealthDto.item_slug,
            user,
        );
        await this.invalidateWorkCaches(id);

        this.activityLogService
            .log({
                userId: auth.userId,
                workId: id,
                actionType: ActivityActionType.ITEM_UPDATED,
                action: 'item.source_rechecked',
                status: ActivityStatus.COMPLETED,
                summary: `Re-checked item source: ${result.item_name || checkItemHealthDto.item_slug}`,
                details: {
                    itemSlug: result.item_slug,
                    itemName: result.item_name,
                    health: result.health,
                    message: result.message,
                },
            })
            .catch(() => {});

        return result;
    }

    @Get('works/:id/source-validation')
    @ApiOperation({ summary: 'Get source validation settings' })
    @ApiParam({ name: 'id', description: 'Work ID' })
    async getSourceValidationSettings(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
    ): Promise<SourceValidationSettingsDto> {
        const user = await this.authService.getUser(auth.userId);
        await this.workOwnershipService.ensureAccess(id, user.id);
        const allowances = await this.subscriptionService.getCadenceAllowances(user);
        return this.sourceValidationService.getSettings(id, allowances);
    }

    @Put('works/:id/source-validation')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Update source validation settings' })
    @ApiParam({ name: 'id', description: 'Work ID' })
    async updateSourceValidationSettings(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Body() dto: UpdateSourceValidationDto,
    ): Promise<SourceValidationSettingsDto> {
        const user = await this.authService.getUser(auth.userId);
        await this.workOwnershipService.ensureCanEdit(id, user.id);
        const allowances = await this.subscriptionService.getCadenceAllowances(user);
        const result = await this.sourceValidationService.updateSettings(id, dto, allowances);

        this.activityLogService
            .log({
                userId: auth.userId,
                workId: id,
                actionType: ActivityActionType.SETTINGS_UPDATED,
                action: 'work.source_validation_updated',
                status: ActivityStatus.COMPLETED,
                summary: `Updated source validation settings`,
                details: {
                    cadence: dto.cadence,
                    enabled: dto.enabled,
                },
            })
            .catch(() => {});

        return result;
    }

    @Post('extract-item-details')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Extract item details',
        description: 'Extract item details from a URL using AI',
    })
    @ApiResponse({ status: 200, description: 'Extracted item details' })
    async extractItemDetails(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() extractItemDetailsDto: ExtractItemDetailsDto,
    ): Promise<ExtractItemDetailsResponseDto> {
        const user = await this.authService.getUser(auth.userId);
        return this.workGenerationService.extractItemDetails(extractItemDetailsDto, user);
    }

    // ============================================
    // Bulk Image Capture Endpoints
    // ============================================

    @Post('works/:id/bulk-capture-images')
    @HttpCode(HttpStatus.OK)
    async bulkCaptureImages(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Body() dto: BulkCaptureImagesDto,
    ): Promise<BulkCaptureImagesResponseDto> {
        const user = await this.authService.getUser(auth.userId);

        const result = await this.workGenerationService.bulkCaptureImages(id, dto, user);

        this.activityLogService
            .log({
                userId: auth.userId,
                workId: id,
                actionType: ActivityActionType.ITEM_UPDATED,
                action: 'items.images_captured',
                status: ActivityStatus.COMPLETED,
                summary: `Captured item images`,
            })
            .catch(() => {});

        return result;
    }

    @Put('works/:id/domain-type')
    @HttpCode(HttpStatus.OK)
    async updateDomainType(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Body() dto: { domainType: string; manuallySet?: boolean },
    ) {
        const user = await this.authService.getUser(auth.userId);

        return this.workGenerationService.updateDomainType(
            id,
            dto.domainType,
            user,
            dto.manuallySet ?? true,
        );
    }

    @Post('works/:id/regenerate-markdown')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Regenerate markdown',
        description: 'Regenerate markdown files for all items in a work',
    })
    @ApiParam({ name: 'id', description: 'Work ID' })
    @ApiResponse({ status: 200, description: 'Markdown regenerated' })
    async regenerateMarkdown(@CurrentUser() auth: AuthenticatedUser, @Param('id') id: string) {
        const user = await this.authService.getUser(auth.userId);

        const result = await this.workGenerationService.regenerateMarkdown(id, user);

        this.activityLogService
            .log({
                userId: auth.userId,
                workId: id,
                actionType: ActivityActionType.SETTINGS_UPDATED,
                action: 'work.markdown_regenerated',
                status: ActivityStatus.COMPLETED,
                summary: `Regenerated markdown`,
            })
            .catch(() => {});

        return result;
    }

    @Post('works/:id/update-readme')
    @HttpCode(HttpStatus.OK)
    async updateReadme(@CurrentUser() auth: AuthenticatedUser, @Param('id') id: string) {
        const user = await this.authService.getUser(auth.userId);

        const result = await this.workGenerationService.updateReadme(id, user);

        this.activityLogService
            .log({
                userId: auth.userId,
                workId: id,
                actionType: ActivityActionType.SETTINGS_UPDATED,
                action: 'work.readme_updated',
                status: ActivityStatus.COMPLETED,
                summary: `Updated README`,
            })
            .catch(() => {});

        return result;
    }

    @Post('works/:id/update-website')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Update website',
        description: 'Trigger a website rebuild and update',
    })
    @ApiParam({ name: 'id', description: 'Work ID' })
    @ApiResponse({ status: 200, description: 'Website update triggered' })
    async updateWebsiteRepository(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
    ): Promise<UpdateWebsiteRepositoryResponseDto> {
        const user = await this.authService.getUser(auth.userId);

        const result = await this.workGenerationService.updateWebsiteRepository(id, user);

        this.activityLogService
            .log({
                userId: auth.userId,
                workId: id,
                actionType: ActivityActionType.WEBSITE_SETTINGS_UPDATED,
                action: 'work.website_updated',
                status: ActivityStatus.COMPLETED,
                summary: `Updated website repository`,
            })
            .catch(() => {});

        return result;
    }

    @Post('works/:id/switch-website-template')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Switch website template',
        description:
            'Update the selected website template and apply it to the existing website repository when it already exists',
    })
    @ApiParam({ name: 'id', description: 'Work ID' })
    @ApiResponse({ status: 200, description: 'Website template switched' })
    async switchWebsiteTemplate(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Body() body: { websiteTemplateId: string },
    ): Promise<SwitchWebsiteTemplateResponseDto> {
        const user = await this.authService.getUser(auth.userId);

        const result = await this.workLifecycleService.switchWebsiteTemplate(
            id,
            body.websiteTemplateId,
            user,
        );

        const summaryByMode = {
            no_change: result.message,
            saved_for_initialization: `Saved website template change from ${result.previousWebsiteTemplateId} to ${result.websiteTemplateId} for first website creation`,
            repository_reset: `Switched website template from ${result.previousWebsiteTemplateId} to ${result.websiteTemplateId} and reset the existing website repository`,
            repository_recreated: `Switched website template from ${result.previousWebsiteTemplateId} to ${result.websiteTemplateId} and recreated the website repository`,
        } as const;

        this.activityLogService
            .log({
                userId: auth.userId,
                workId: id,
                actionType: ActivityActionType.WEBSITE_SETTINGS_UPDATED,
                action: 'work.website_template_switched',
                status: ActivityStatus.COMPLETED,
                summary: summaryByMode[result.switchMode],
                details: {
                    previousWebsiteTemplateId: result.previousWebsiteTemplateId,
                    websiteTemplateId: result.websiteTemplateId,
                    switchMode: result.switchMode,
                    repositoryRecreated: result.repositoryRecreated,
                    repository: result.repository,
                },
            })
            .catch(() => {});

        return result;
    }

    @Post('works/:id/delete')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Delete work',
        description: 'Delete a work and optionally its repositories',
    })
    @ApiParam({ name: 'id', description: 'Work ID' })
    @ApiResponse({ status: 200, description: 'Work deleted' })
    async deleteWork(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Body() deleteWorkDto: DeleteWorkDto,
    ): Promise<DeleteWorkResponseDto> {
        const user = await this.authService.getUser(auth.userId);
        const result = await this.workLifecycleService.deleteWork(id, deleteWorkDto, user);
        this.activityLogService
            .log({
                userId: auth.userId,
                workId: id,
                actionType: ActivityActionType.WORK_DELETED,
                action: 'work.deleted',
                status: ActivityStatus.COMPLETED,
                summary: `Deleted work`,
            })
            .catch(() => {});
        return result;
    }

    @Post('works/:id/sync-data')
    @HttpCode(HttpStatus.OK)
    async syncWorkData(@CurrentUser() auth: AuthenticatedUser, @Param('id') id: string) {
        const user = await this.authService.getUser(auth.userId);

        const result = await this.workLifecycleService.syncFromDataRepository(id, user);
        await this.invalidateWorkCaches(id);

        this.activityLogService
            .log({
                userId: auth.userId,
                workId: id,
                actionType: ActivityActionType.WORK_UPDATED,
                action: 'work.synced_from_data_repo',
                status: ActivityStatus.COMPLETED,
                summary: `Synced work data`,
                details: {
                    syncStatus: result.status,
                    updatedFields: result.updated,
                    message: result.message,
                },
            })
            .catch(() => {});

        return result;
    }

    // ============================================
    // Repository Visibility Endpoints
    // ============================================

    @Get('works/:id/repositories/visibility')
    @HttpCode(HttpStatus.OK)
    async getRepositoryVisibility(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
    ): Promise<RepositoryStatus[]> {
        const user = await this.authService.getUser(auth.userId);
        const { work } = await this.workOwnershipService.ensureAccess(id, user.id);

        return this.repositoryManagementService.getRepositoriesStatus(work, user);
    }

    @Put('works/:id/repositories/visibility')
    @HttpCode(HttpStatus.OK)
    async updateRepositoryVisibility(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Body() body: { repoType: RepositoryType; isPrivate: boolean },
    ): Promise<RepositoryStatus> {
        const user = await this.authService.getUser(auth.userId);
        const { work } = await this.workOwnershipService.ensureAccess(id, user.id);

        return this.repositoryManagementService.updateRepositoryVisibility(
            work,
            user,
            body.repoType,
            body.isPrivate,
        );
    }

    // ============================================
    // Advanced Prompts Endpoints
    // ============================================

    @Get('works/:id/advanced-prompts')
    @HttpCode(HttpStatus.OK)
    async getAdvancedPrompts(@CurrentUser() auth: AuthenticatedUser, @Param('id') id: string) {
        return this.workAdvancedPromptsService.getAdvancedPrompts(id, auth.userId);
    }

    @Put('works/:id/advanced-prompts')
    @HttpCode(HttpStatus.OK)
    async updateAdvancedPrompts(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Body() dto: UpdateWorkAdvancedPromptsDto,
    ) {
        const result = await this.workAdvancedPromptsService.updateAdvancedPrompts(
            id,
            dto,
            auth.userId,
        );
        this.activityLogService
            .log({
                userId: auth.userId,
                workId: id,
                actionType: ActivityActionType.PROMPTS_UPDATED,
                action: 'work.prompts_updated',
                status: ActivityStatus.COMPLETED,
                summary: `Updated advanced prompts`,
            })
            .catch(() => {});
        return result;
    }

    // ============================================
    // Import endpoints
    // ============================================

    @Post('works/import/analyze')
    @HttpCode(HttpStatus.OK)
    async analyzeRepository(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() analyzeDto: AnalyzeRepositoryDto,
    ): Promise<AnalyzeRepositoryResponseDto> {
        const user = await this.authService.getUser(auth.userId);
        return this.workImportService.analyzeRepository(analyzeDto, user);
    }

    @Post('works/import/analyze-for-linking')
    @HttpCode(HttpStatus.OK)
    async analyzeForLinking(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() analyzeDto: AnalyzeRepositoryDto,
    ): Promise<AnalyzeForLinkingResponseDto> {
        const user = await this.authService.getUser(auth.userId);
        return this.workImportService.analyzeForLinking(analyzeDto, user);
    }

    @Post('works/import')
    @HttpCode(HttpStatus.ACCEPTED)
    async importWork(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() importDto: ImportWorkDto,
    ): Promise<ImportWorkResponseDto> {
        const user = await this.authService.getUser(auth.userId);
        const result = await this.workImportService.initiateImport(importDto, user);

        this.activityLogService
            .log({
                userId: auth.userId,
                actionType: ActivityActionType.IMPORT,
                action: 'work.import_started',
                status: ActivityStatus.COMPLETED,
                summary: `Triggered work import`,
                details: {
                    sourceUrl: importDto.sourceUrl,
                    sourceType: importDto.sourceType,
                    gitProvider: importDto.gitProvider,
                },
            })
            .catch(() => {});

        return result;
    }

    @Get('works/import/repositories')
    @HttpCode(HttpStatus.OK)
    async getUserRepositories(
        @CurrentUser() auth: AuthenticatedUser,
        @Query('gitProvider') gitProvider: string,
        @Query('page') page?: string,
        @Query('perPage') perPage?: string,
        @Query('search') search?: string,
        @Query('owner') owner?: string,
        @Query('type') type?: 'user' | 'org',
    ): Promise<GetUserRepositoriesResponseDto> {
        const user = await this.authService.getUser(auth.userId);

        const dto: GetUserRepositoriesDto = {
            gitProvider,
            page: page ? parseInt(page, 10) : undefined,
            perPage: perPage ? parseInt(perPage, 10) : undefined,
            search: search || undefined,
            owner: owner || undefined,
            type: type || undefined,
        };

        return this.workImportService.getUserRepositories(dto, user);
    }

    // ============================================
    // Taxonomy CRUD Endpoints (Categories & Tags)
    // ============================================

    // Categories
    @Post('works/:id/categories')
    @HttpCode(HttpStatus.OK)
    async createCategory(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Body() dto: CreateCategoryDto,
    ) {
        const result = await this.workTaxonomyService.createCategory(id, dto, auth.userId);
        await this.invalidateWorkCaches(id);

        this.activityLogService
            .log({
                userId: auth.userId,
                workId: id,
                actionType: ActivityActionType.SETTINGS_UPDATED,
                action: 'taxonomy.category_created',
                status: ActivityStatus.COMPLETED,
                summary: `Created category: ${dto.name}`,
            })
            .catch(() => {});

        return result;
    }

    @Put('works/:id/categories/:categoryId')
    @HttpCode(HttpStatus.OK)
    async updateCategory(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Param('categoryId') categoryId: string,
        @Body() dto: UpdateCategoryDto,
    ) {
        const result = await this.workTaxonomyService.updateCategory(
            id,
            categoryId,
            dto,
            auth.userId,
        );
        await this.invalidateWorkCaches(id);

        this.activityLogService
            .log({
                userId: auth.userId,
                workId: id,
                actionType: ActivityActionType.SETTINGS_UPDATED,
                action: 'taxonomy.category_updated',
                status: ActivityStatus.COMPLETED,
                summary: `Updated category`,
                details: { categoryId, name: dto.name },
            })
            .catch(() => {});

        return result;
    }

    @Delete('works/:id/categories/:categoryId')
    @HttpCode(HttpStatus.OK)
    async deleteCategory(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Param('categoryId') categoryId: string,
    ) {
        const result = await this.workTaxonomyService.deleteCategory(id, categoryId, auth.userId);
        await this.invalidateWorkCaches(id);

        this.activityLogService
            .log({
                userId: auth.userId,
                workId: id,
                actionType: ActivityActionType.SETTINGS_UPDATED,
                action: 'taxonomy.category_deleted',
                status: ActivityStatus.COMPLETED,
                summary: `Deleted category`,
                details: { categoryId },
            })
            .catch(() => {});

        return result;
    }

    // Tags
    @Post('works/:id/tags')
    @HttpCode(HttpStatus.OK)
    async createTag(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Body() dto: CreateTagDto,
    ) {
        const result = await this.workTaxonomyService.createTag(id, dto, auth.userId);
        await this.invalidateWorkCaches(id);

        this.activityLogService
            .log({
                userId: auth.userId,
                workId: id,
                actionType: ActivityActionType.SETTINGS_UPDATED,
                action: 'taxonomy.tag_created',
                status: ActivityStatus.COMPLETED,
                summary: `Created tag: ${dto.name}`,
            })
            .catch(() => {});

        return result;
    }

    @Put('works/:id/tags/:tagId')
    @HttpCode(HttpStatus.OK)
    async updateTag(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Param('tagId') tagId: string,
        @Body() dto: UpdateTagDto,
    ) {
        const result = await this.workTaxonomyService.updateTag(id, tagId, dto, auth.userId);
        await this.invalidateWorkCaches(id);

        this.activityLogService
            .log({
                userId: auth.userId,
                workId: id,
                actionType: ActivityActionType.SETTINGS_UPDATED,
                action: 'taxonomy.tag_updated',
                status: ActivityStatus.COMPLETED,
                summary: `Updated tag`,
                details: { tagId, name: dto.name },
            })
            .catch(() => {});

        return result;
    }

    @Delete('works/:id/tags/:tagId')
    @HttpCode(HttpStatus.OK)
    async deleteTag(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Param('tagId') tagId: string,
    ) {
        const result = await this.workTaxonomyService.deleteTag(id, tagId, auth.userId);
        await this.invalidateWorkCaches(id);

        this.activityLogService
            .log({
                userId: auth.userId,
                workId: id,
                actionType: ActivityActionType.SETTINGS_UPDATED,
                action: 'taxonomy.tag_deleted',
                status: ActivityStatus.COMPLETED,
                summary: `Deleted tag`,
                details: { tagId },
            })
            .catch(() => {});

        return result;
    }

    @Post('works/:id/collections')
    @HttpCode(HttpStatus.OK)
    async createCollection(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Body() dto: CreateCollectionDto,
    ) {
        const result = await this.workTaxonomyService.createCollection(id, dto, auth.userId);
        await this.invalidateWorkCaches(id);

        this.activityLogService
            .log({
                userId: auth.userId,
                workId: id,
                actionType: ActivityActionType.SETTINGS_UPDATED,
                action: 'taxonomy.collection_created',
                status: ActivityStatus.COMPLETED,
                summary: `Created collection: ${dto.name}`,
            })
            .catch(() => {});

        return result;
    }

    @Put('works/:id/collections/:collectionId')
    @HttpCode(HttpStatus.OK)
    async updateCollection(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Param('collectionId') collectionId: string,
        @Body() dto: UpdateCollectionDto,
    ) {
        const result = await this.workTaxonomyService.updateCollection(
            id,
            collectionId,
            dto,
            auth.userId,
        );
        await this.invalidateWorkCaches(id);

        this.activityLogService
            .log({
                userId: auth.userId,
                workId: id,
                actionType: ActivityActionType.SETTINGS_UPDATED,
                action: 'taxonomy.collection_updated',
                status: ActivityStatus.COMPLETED,
                summary: `Updated collection`,
                details: { collectionId, name: dto.name },
            })
            .catch(() => {});

        return result;
    }

    @Delete('works/:id/collections/:collectionId')
    @HttpCode(HttpStatus.OK)
    async deleteCollection(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Param('collectionId') collectionId: string,
    ) {
        const result = await this.workTaxonomyService.deleteCollection(
            id,
            collectionId,
            auth.userId,
        );
        await this.invalidateWorkCaches(id);

        this.activityLogService
            .log({
                userId: auth.userId,
                workId: id,
                actionType: ActivityActionType.SETTINGS_UPDATED,
                action: 'taxonomy.collection_deleted',
                status: ActivityStatus.COMPLETED,
                summary: `Deleted collection`,
                details: { collectionId },
            })
            .catch(() => {});

        return result;
    }

    @Post('works/:id/process-community-prs')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Process community PRs',
        description: 'Manually trigger processing of community pull requests for a work',
    })
    @ApiParam({ name: 'id', description: 'Work ID' })
    @ApiResponse({ status: 200, description: 'Community PRs processed' })
    @ApiResponse({ status: 400, description: 'Community PR processing not enabled' })
    async processCommunityPrs(@CurrentUser() auth: AuthenticatedUser, @Param('id') id: string) {
        // Verify user has access
        const user = await this.authService.getUser(auth.userId);
        await this.workQueryService.getWork(id, user);

        // Get full entity and check if community PR processing is enabled
        const work = await this.workRepository.findById(id);
        if (!work) {
            throw new NotFoundException('Work not found');
        }
        if (!work.communityPrEnabled) {
            throw new BadRequestException('Community PR processing is not enabled for this work.');
        }

        const itemsAdded = await this.communityPrProcessorService.processWork(work);
        await this.invalidateWorkCaches(id);

        this.activityLogService
            .log({
                userId: auth.userId,
                workId: id,
                actionType: ActivityActionType.COMMUNITY_PR_MERGED,
                action: 'community_pr.processed',
                status: ActivityStatus.COMPLETED,
                summary: `Processed community PRs`,
                details: { itemsAdded },
            })
            .catch(() => {});

        return { itemsAdded };
    }

    // ─── Comparisons ────────────────────────────────────────────────

    @Get('works/:id/comparisons')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'List comparisons',
        description: 'List all generated comparisons for a work',
    })
    @ApiParam({ name: 'id', description: 'Work ID' })
    async listComparisons(@CurrentUser() auth: AuthenticatedUser, @Param('id') id: string) {
        const user = await this.authService.getUser(auth.userId);
        await this.workQueryService.getWork(id, user);

        return this.comparisonGenerationService.listComparisons(id, user.id);
    }

    @Get('works/:id/comparisons/remaining-count')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Get remaining comparison count',
        description: 'Count how many un-generated comparison pairs remain',
    })
    @ApiParam({ name: 'id', description: 'Work ID' })
    async getRemainingComparisonCount(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
    ) {
        const user = await this.authService.getUser(auth.userId);
        await this.workQueryService.getWork(id, user);

        const count = await this.comparisonGenerationService.getRemainingCount(id, user.id);
        return { count };
    }

    @Get('works/:id/comparisons/generation-status')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Get comparison generation status',
        description: 'Check the current progress of an in-flight comparison generation',
    })
    @ApiParam({ name: 'id', description: 'Work ID' })
    async getComparisonGenerationStatus(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
    ) {
        await this.authService.getUser(auth.userId);
        return this.comparisonGenerationService.getGenerationStatus(id);
    }

    @Get('works/:id/comparisons/:slug')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Get comparison', description: 'Get a single comparison by slug' })
    @ApiParam({ name: 'id', description: 'Work ID' })
    @ApiParam({ name: 'slug', description: 'Comparison slug' })
    async getComparison(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Param('slug') slug: string,
    ) {
        const user = await this.authService.getUser(auth.userId);
        await this.workQueryService.getWork(id, user);

        const result = await this.comparisonGenerationService.getComparison(id, user.id, slug);
        if (!result.comparison) {
            throw new NotFoundException('Comparison not found');
        }

        return result;
    }

    @Post('works/:id/comparisons/generate')
    @HttpCode(HttpStatus.ACCEPTED)
    @ApiOperation({
        summary: 'Generate next comparison',
        description: 'Auto-pick the next best pair and generate a comparison',
    })
    @ApiParam({ name: 'id', description: 'Work ID' })
    async generateNextComparison(@CurrentUser() auth: AuthenticatedUser, @Param('id') id: string) {
        const user = await this.authService.getUser(auth.userId);
        await this.workOwnershipService.ensureCanEdit(id, user.id);

        const result = await this.comparisonGenerationService.generateNextComparison(id, user.id);
        await this.invalidateWorkCaches(id);
        this.activityLogService
            .log({
                userId: auth.userId,
                workId: id,
                actionType: ActivityActionType.COMPARISON_GENERATION,
                action: 'comparison.generated',
                status: ActivityStatus.COMPLETED,
                summary: `Generated comparison`,
                details: {
                    status: result.status,
                    slug: result.slug,
                    message: result.message,
                },
            })
            .catch(() => {});
        return result;
    }

    @Post('works/:id/comparisons/generate-manual')
    @HttpCode(HttpStatus.ACCEPTED)
    @ApiOperation({
        summary: 'Generate manual comparison',
        description: 'Generate a comparison between two specific items',
    })
    @ApiParam({ name: 'id', description: 'Work ID' })
    @ApiResponse({ status: 202, description: 'Comparison generation started' })
    async generateManualComparison(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Body() body: GenerateManualComparisonDto,
    ) {
        const user = await this.authService.getUser(auth.userId);
        await this.workOwnershipService.ensureCanEdit(id, user.id);

        if (body.itemASlug === body.itemBSlug) {
            throw new BadRequestException('Cannot compare an item with itself');
        }

        const result = await this.comparisonGenerationService.generateManualComparison(
            id,
            user.id,
            body.itemASlug,
            body.itemBSlug,
        );
        await this.invalidateWorkCaches(id);
        this.activityLogService
            .log({
                userId: auth.userId,
                workId: id,
                actionType: ActivityActionType.COMPARISON_GENERATION,
                action: 'comparison.generated_manual',
                status: ActivityStatus.COMPLETED,
                summary: `Generated comparison: ${body.itemASlug} vs ${body.itemBSlug}`,
                details: {
                    status: result.status,
                    slug: result.slug,
                    itemASlug: body.itemASlug,
                    itemBSlug: body.itemBSlug,
                    message: result.message,
                },
            })
            .catch(() => {});
        return result;
    }

    @Delete('works/:id/comparisons/:slug')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Delete comparison', description: 'Remove a generated comparison' })
    @ApiParam({ name: 'id', description: 'Work ID' })
    @ApiParam({ name: 'slug', description: 'Comparison slug' })
    async deleteComparison(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Param('slug') slug: string,
    ) {
        const user = await this.authService.getUser(auth.userId);
        await this.workOwnershipService.ensureCanEdit(id, user.id);

        const result = await this.comparisonGenerationService.deleteComparison(id, user.id, slug);
        await this.invalidateWorkCaches(id);
        this.activityLogService
            .log({
                userId: auth.userId,
                workId: id,
                actionType: ActivityActionType.COMPARISON_GENERATION,
                action: 'comparison.deleted',
                status: ActivityStatus.COMPLETED,
                summary: `Deleted comparison: ${slug}`,
            })
            .catch(() => {});
        return result;
    }
}
