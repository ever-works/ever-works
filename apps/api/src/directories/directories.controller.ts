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
    CreateDirectoryDto,
    UpdateDirectoryDto,
    UpdateDirectoryAdvancedPromptsDto,
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
    DeleteDirectoryDto,
    DeleteDirectoryResponseDto,
    ExtractItemDetailsDto,
    ExtractItemDetailsResponseDto,
    ItemsGeneratorResponseDto,
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
    DirectoryDetailService,
    DirectoryGenerationService,
    DirectoryLifecycleService,
    DirectoryQueryService,
    DirectoryScheduleService,
    DirectoryImportService,
    RepositoryManagementService,
    RepositoryStatus,
    RepositoryType,
    DirectoryOwnershipService,
    DirectoryAdvancedPromptsService,
    DirectoryTaxonomyService,
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
    ImportDirectoryDto,
    ImportDirectoryResponseDto,
    GetUserRepositoriesDto,
    GetUserRepositoriesResponseDto,
} from '@ever-works/agent/dto';
import { UpdateWebsiteRepositoryResponseDto } from '@ever-works/agent/generators';
import { CommunityPrProcessorService } from '@ever-works/agent/community-pr';
import { DirectoryRepository } from '@ever-works/agent/database';
import { AuthService, CurrentUser, JwtAuthGuard } from '../auth';
import { AuthenticatedUser } from '@src/auth/types/jwt.types';
import { GenerateDirectoryDetailDto } from './dto/generate-detail.dto';
import { GenerateManualComparisonDto } from './dto/generate-manual-comparison.dto';
import { CACHE_MANAGER, Cache } from '@ever-works/agent/cache';
import { UpdateDirectoryScheduleDto, UpdateSourceValidationDto } from '@ever-works/agent/dto';
import { DirectoryScheduleStatus } from '@ever-works/agent/entities';
import { SubscriptionService } from '@ever-works/agent/subscriptions';

let CACHE_TTL = 1000 * 60 * 10; // 10 minutes

@ApiTags('Directories')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard)
export class DirectoriesController {
    constructor(
        @Inject(CACHE_MANAGER) private cacheManager: Cache,
        private readonly directoryQueryService: DirectoryQueryService,
        private readonly directoryLifecycleService: DirectoryLifecycleService,
        private readonly directoryGenerationService: DirectoryGenerationService,
        private readonly authService: AuthService,
        private readonly directoryDetailService: DirectoryDetailService,
        private readonly directoryScheduleService: DirectoryScheduleService,
        private readonly directoryImportService: DirectoryImportService,
        private readonly repositoryManagementService: RepositoryManagementService,
        private readonly directoryOwnershipService: DirectoryOwnershipService,
        private readonly directoryAdvancedPromptsService: DirectoryAdvancedPromptsService,
        private readonly directoryTaxonomyService: DirectoryTaxonomyService,
        private readonly generatorFormSchemaService: GeneratorFormSchemaService,
        private readonly itemHealthService: ItemHealthService,
        private readonly communityPrProcessorService: CommunityPrProcessorService,
        private readonly comparisonGenerationService: ComparisonGenerationService,
        private readonly directoryRepository: DirectoryRepository,
        private readonly sourceValidationService: ItemSourceValidationSchedulerService,
        private readonly subscriptionService: SubscriptionService,
    ) {}

    @Get('directories')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'List directories',
        description: 'Get all directories accessible to the authenticated user',
    })
    @ApiQuery({ name: 'limit', required: false, description: 'Maximum number of results' })
    @ApiQuery({ name: 'offset', required: false, description: 'Number of results to skip' })
    @ApiQuery({ name: 'search', required: false, description: 'Search term to filter directories' })
    @ApiResponse({ status: 200, description: 'List of directories' })
    async getDirectories(
        @CurrentUser() auth: AuthenticatedUser,
        @Query('limit') limit?: string,
        @Query('offset') offset?: string,
        @Query('search') search?: string,
    ) {
        const parsedLimit = limit !== undefined ? Number(limit) : undefined;
        const parsedOffset = offset !== undefined ? Number(offset) : undefined;

        const user = await this.authService.getUser(auth.userId);

        return this.directoryQueryService.getDirectories(
            {
                limit: parsedLimit && !isNaN(parsedLimit) ? parsedLimit : undefined,
                offset: parsedOffset && !isNaN(parsedOffset) ? parsedOffset : undefined,
                search: search || undefined,
            },
            user,
        );
    }

    @Get('directories/stats')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Get directory stats',
        description:
            'Get aggregated stats (total directories, total items, active websites) for the authenticated user',
    })
    @ApiResponse({ status: 200, description: 'Directory stats' })
    async getDirectoryStats(@CurrentUser() auth: AuthenticatedUser) {
        const user = await this.authService.getUser(auth.userId);
        return this.directoryQueryService.getStats(user);
    }

    @Post('directories')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Create directory', description: 'Create a new directory' })
    @ApiResponse({ status: 200, description: 'Directory created successfully' })
    @ApiResponse({ status: 400, description: 'Invalid input data' })
    async createDirectory(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() createDirectoryDto: CreateDirectoryDto,
    ) {
        const user = await this.authService.getUser(auth.userId);
        return this.directoryLifecycleService.createDirectory(createDirectoryDto, user);
    }

    @Get('directories/:id')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Get directory', description: 'Get a specific directory by ID' })
    @ApiParam({ name: 'id', description: 'Directory ID' })
    @ApiResponse({ status: 200, description: 'Directory details' })
    @ApiResponse({ status: 404, description: 'Directory not found' })
    async getDirectory(@CurrentUser() auth: AuthenticatedUser, @Param('id') id: string) {
        const user = await this.authService.getUser(auth.userId);
        return this.directoryQueryService.getDirectory(id, user);
    }

    @Put('directories/:id')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Update directory',
        description: 'Update directory settings and configuration',
    })
    @ApiParam({ name: 'id', description: 'Directory ID' })
    @ApiResponse({ status: 200, description: 'Directory updated successfully' })
    async updateDirectory(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Body() updateDirectoryDto: UpdateDirectoryDto,
    ) {
        const user = await this.authService.getUser(auth.userId);
        return this.directoryLifecycleService.updateDirectory(id, updateDirectoryDto, user);
    }

    @Get('directories/:id/items')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Get directory items', description: 'Get all items in a directory' })
    @ApiParam({ name: 'id', description: 'Directory ID' })
    @ApiResponse({ status: 200, description: 'List of directory items' })
    async getDirectoryItems(@CurrentUser() auth: AuthenticatedUser, @Param('id') id: string) {
        const cacheKey = `directory-items-${id}-${auth.userId}`;

        return this.cacheManager.wrap(
            cacheKey,
            async () => {
                const user = await this.authService.getUser(auth.userId);
                return this.directoryQueryService.directoryItems(id, user);
            },
            CACHE_TTL,
        );
    }

    @Get('directories/:id/config')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Get directory config',
        description: 'Get directory configuration and metadata',
    })
    @ApiParam({ name: 'id', description: 'Directory ID' })
    @ApiResponse({ status: 200, description: 'Directory configuration' })
    async getDirectoryConfig(@CurrentUser() auth: AuthenticatedUser, @Param('id') id: string) {
        const cacheKey = `directory-config-${id}-${auth.userId}`;

        return this.cacheManager.wrap(
            cacheKey,
            async () => {
                const user = await this.authService.getUser(auth.userId);
                return this.directoryQueryService.directoryConfig(id, user);
            },
            CACHE_TTL,
        );
    }

    @Get('directories/:id/website-settings')
    @HttpCode(HttpStatus.OK)
    async getWebsiteSettings(@CurrentUser() auth: AuthenticatedUser, @Param('id') id: string) {
        const user = await this.authService.getUser(auth.userId);
        return this.directoryQueryService.getWebsiteSettings(id, user);
    }

    @Put('directories/:id/website-settings')
    @HttpCode(HttpStatus.OK)
    async updateWebsiteSettings(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Body() dto: UpdateWebsiteSettingsDto,
    ) {
        const user = await this.authService.getUser(auth.userId);
        return this.directoryQueryService.updateWebsiteSettings(id, user, dto);
    }

    @Get('directories/:id/count')
    @HttpCode(HttpStatus.OK)
    async getDirectoryStatus(@CurrentUser() auth: AuthenticatedUser, @Param('id') id: string) {
        const cacheKey = `directory-count-${id}-${auth.userId}`;

        return this.cacheManager.wrap(
            cacheKey,
            async () => {
                const user = await this.authService.getUser(auth.userId);
                return this.directoryQueryService.directoryCount(id, user);
            },
            CACHE_TTL,
        );
    }

    @Get('directories/:id/categories-tags')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Get categories and tags',
        description: 'Get categories and tags for a directory',
    })
    @ApiParam({ name: 'id', description: 'Directory ID' })
    @ApiResponse({ status: 200, description: 'Categories and tags' })
    async getDirectoryCategoriesTags(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
    ) {
        const cacheKey = `directory-categories-tags-${id}-${auth.userId}`;

        return this.cacheManager.wrap(
            cacheKey,
            async () => {
                const user = await this.authService.getUser(auth.userId);
                return this.directoryQueryService.directoryCategoriesTags(id, user);
            },
            CACHE_TTL,
        );
    }

    @Get('directories/:id/history')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Get directory history',
        description: 'Get generation and update history for a directory',
    })
    @ApiParam({ name: 'id', description: 'Directory ID' })
    @ApiQuery({ name: 'limit', required: false, description: 'Maximum number of results' })
    @ApiQuery({ name: 'offset', required: false, description: 'Number of results to skip' })
    @ApiQuery({
        name: 'activityType',
        required: false,
        description:
            'Optional history activity filter (generation, items, comparisons, taxonomy, community_pr)',
    })
    @ApiResponse({ status: 200, description: 'Generation history' })
    async getDirectoryHistory(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Query('limit') limit?: string,
        @Query('offset') offset?: string,
        @Query('activityType') activityType?: string,
    ) {
        const user = await this.authService.getUser(auth.userId);

        const parsedLimit = limit !== undefined ? Number(limit) : undefined;
        const parsedOffset = offset !== undefined ? Number(offset) : undefined;

        const result = await this.directoryQueryService.directoryGenerationHistory(id, user, {
            limit: parsedLimit && !isNaN(parsedLimit) ? parsedLimit : undefined,
            offset: parsedOffset && !isNaN(parsedOffset) ? parsedOffset : undefined,
            activityType,
        });

        return {
            status: 'success',
            ...result,
        };
    }

    @Post('directories/generate-details')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Generate directory details',
        description: 'AI-generate directory name, description, and categories from a prompt',
    })
    @ApiResponse({ status: 200, description: 'Generated directory details' })
    async generateDirectoryDetails(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() generateDirectoryDetailDto: GenerateDirectoryDetailDto,
    ) {
        const user = await this.authService.getUser(auth.userId);
        return this.directoryDetailService.generateDirectoryDetails(
            generateDirectoryDetailDto.directory_name,
            generateDirectoryDetailDto.prompt,
            user,
            generateDirectoryDetailDto.ai_provider,
        );
    }

    @Get('generator-form')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Get global generator form schema',
        description:
            'Get the dynamic form schema for the generator without a specific directory context',
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

    @Get('directories/:id/generator-form')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Get generator form schema',
        description:
            'Get the dynamic form schema for the generator based on the selected pipeline plugin',
    })
    @ApiParam({ name: 'id', description: 'Directory ID' })
    @ApiQuery({ name: 'pipelineId', required: false, description: 'Selected pipeline plugin ID' })
    @ApiResponse({ status: 200, description: 'Generator form schema' })
    async getGeneratorFormSchema(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Query('pipelineId') pipelineId?: string,
    ) {
        const user = await this.authService.getUser(auth.userId);
        await this.directoryOwnershipService.ensureAccess(id, user.id);

        return this.generatorFormSchemaService.getFormSchema(pipelineId, {
            directoryId: id,
            userId: user.id,
        });
    }

    @Post('directories/:id/generate')
    @HttpCode(HttpStatus.ACCEPTED)
    @ApiOperation({
        summary: 'Generate items',
        description: 'Start AI-powered item generation for a directory',
    })
    @ApiParam({ name: 'id', description: 'Directory ID' })
    @ApiResponse({ status: 202, description: 'Generation started' })
    async generateItems(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Body() createItemsGeneratorDto: CreateItemsGeneratorDto,
    ): Promise<ItemsGeneratorResponseDto> {
        const user = await this.authService.getUser(auth.userId);

        return this.directoryGenerationService.generateItems(
            id,
            createItemsGeneratorDto,
            user,
            false,
        );
    }

    @Post('directories/:id/update')
    @HttpCode(HttpStatus.ACCEPTED)
    @ApiOperation({
        summary: 'Update items',
        description: 'Update existing items in a directory using AI',
    })
    @ApiParam({ name: 'id', description: 'Directory ID' })
    @ApiResponse({ status: 202, description: 'Update started' })
    async updateItemsGenerator(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Body() updateItemsGeneratorDto: UpdateItemsGeneratorDto,
    ): Promise<ItemsGeneratorResponseDto> {
        const user = await this.authService.getUser(auth.userId);

        return this.directoryGenerationService.updateItemsGenerator({
            directoryId: id,
            updateDto: updateItemsGeneratorDto,
            user,
            awaitCompletion: false,
        });
    }

    @Get('directories/:id/schedule')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Get schedule',
        description: 'Get scheduled update configuration for a directory',
    })
    @ApiParam({ name: 'id', description: 'Directory ID' })
    @ApiResponse({ status: 200, description: 'Schedule configuration' })
    async getDirectorySchedule(@CurrentUser() auth: AuthenticatedUser, @Param('id') id: string) {
        const user = await this.authService.getUser(auth.userId);
        const result = await this.directoryScheduleService.getSchedule(id, user);

        return {
            status: 'success',
            ...result,
        };
    }

    @Put('directories/:id/schedule')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Update schedule',
        description:
            'Update scheduled update configuration (cadence, enable/disable, billing mode)',
    })
    @ApiParam({ name: 'id', description: 'Directory ID' })
    @ApiResponse({ status: 200, description: 'Schedule updated' })
    async updateDirectorySchedule(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Body() updateScheduleDto: UpdateDirectoryScheduleDto,
    ) {
        const user = await this.authService.getUser(auth.userId);
        const schedule = await this.directoryScheduleService.updateSchedule(
            id,
            updateScheduleDto,
            user,
        );

        return {
            status: 'success',
            schedule,
        };
    }

    @Delete('directories/:id/schedule')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Cancel schedule',
        description: 'Cancel and remove scheduled updates for a directory',
    })
    @ApiParam({ name: 'id', description: 'Directory ID' })
    @ApiResponse({ status: 200, description: 'Schedule cancelled' })
    async cancelDirectorySchedule(@CurrentUser() auth: AuthenticatedUser, @Param('id') id: string) {
        const user = await this.authService.getUser(auth.userId);
        const schedule = await this.directoryScheduleService.cancelSchedule(id, user);

        return {
            status: 'success',
            schedule,
        };
    }

    @Post('directories/:id/schedule/run')
    @HttpCode(HttpStatus.ACCEPTED)
    @ApiOperation({
        summary: 'Run scheduled update',
        description: 'Manually trigger a scheduled update now',
    })
    @ApiParam({ name: 'id', description: 'Directory ID' })
    @ApiResponse({ status: 202, description: 'Scheduled update triggered' })
    @ApiResponse({ status: 400, description: 'Schedule must be active to run' })
    async runScheduledUpdate(@CurrentUser() auth: AuthenticatedUser, @Param('id') id: string) {
        const user = await this.authService.getUser(auth.userId);
        const schedule = await this.directoryScheduleService.getScheduleEntity(id, user);

        if (schedule.status !== DirectoryScheduleStatus.ACTIVE) {
            throw new BadRequestException({
                status: 'error',
                message: 'Schedule must be active to run',
            });
        }

        const response = await this.directoryGenerationService.runScheduledUpdate(schedule);
        return response;
    }

    @Post('directories/:id/submit-item')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Submit item', description: 'Add a single item to a directory' })
    @ApiParam({ name: 'id', description: 'Directory ID' })
    @ApiResponse({ status: 200, description: 'Item submitted successfully' })
    async submitItem(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Body() submitItemDto: SubmitItemDto,
    ): Promise<SubmitItemResponseDto> {
        const user = await this.authService.getUser(auth.userId);

        return this.directoryGenerationService.submitItem(id, submitItemDto, user);
    }

    @Post('directories/:id/remove-item')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Remove item', description: 'Remove an item from a directory' })
    @ApiParam({ name: 'id', description: 'Directory ID' })
    @ApiResponse({ status: 200, description: 'Item removed successfully' })
    async removeItem(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Body() removeItemDto: RemoveItemDto,
    ): Promise<RemoveItemResponseDto> {
        const user = await this.authService.getUser(auth.userId);

        return this.directoryGenerationService.removeItem(id, removeItemDto, user);
    }

    @Post('directories/:id/update-item')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Update item',
        description: 'Update item metadata (featured status, display order)',
    })
    @ApiParam({ name: 'id', description: 'Directory ID' })
    @ApiResponse({ status: 200, description: 'Item updated successfully' })
    async updateItemMetadata(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Body() updateItemDto: UpdateItemDto,
    ) {
        const user = await this.authService.getUser(auth.userId);

        return this.directoryGenerationService.updateItemMetadata(id, updateItemDto, user);
    }

    @Post('directories/:id/check-item-health')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Check item health',
        description: 'Run a source URL health check for a single item and persist the result',
    })
    @ApiParam({ name: 'id', description: 'Directory ID' })
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
        await this.cacheManager.del(`directory-items-${id}-${auth.userId}`);
        return result;
    }

    @Get('directories/:id/source-validation')
    @ApiOperation({ summary: 'Get source validation settings' })
    @ApiParam({ name: 'id', description: 'Directory ID' })
    async getSourceValidationSettings(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
    ): Promise<SourceValidationSettingsDto> {
        const user = await this.authService.getUser(auth.userId);
        const allowances = await this.subscriptionService.getCadenceAllowances(user);
        return this.sourceValidationService.getSettings(id, allowances);
    }

    @Put('directories/:id/source-validation')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Update source validation settings' })
    @ApiParam({ name: 'id', description: 'Directory ID' })
    async updateSourceValidationSettings(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Body() dto: UpdateSourceValidationDto,
    ): Promise<SourceValidationSettingsDto> {
        const user = await this.authService.getUser(auth.userId);
        await this.directoryOwnershipService.ensureCanEdit(id, user.id);
        const allowances = await this.subscriptionService.getCadenceAllowances(user);
        return this.sourceValidationService.updateSettings(id, dto, allowances);
    }

    @Post('extract-item-details')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Extract item details',
        description: 'Extract item details from a URL using AI',
    })
    @ApiResponse({ status: 200, description: 'Extracted item details' })
    async extractItemDetails(
        @Body() extractItemDetailsDto: ExtractItemDetailsDto,
    ): Promise<ExtractItemDetailsResponseDto> {
        return this.directoryGenerationService.extractItemDetails(extractItemDetailsDto);
    }

    // ============================================
    // Bulk Image Capture Endpoints
    // ============================================

    @Post('directories/:id/bulk-capture-images')
    @HttpCode(HttpStatus.OK)
    async bulkCaptureImages(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Body() dto: BulkCaptureImagesDto,
    ): Promise<BulkCaptureImagesResponseDto> {
        const user = await this.authService.getUser(auth.userId);

        return this.directoryGenerationService.bulkCaptureImages(id, dto, user);
    }

    @Put('directories/:id/domain-type')
    @HttpCode(HttpStatus.OK)
    async updateDomainType(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Body() dto: { domainType: string; manuallySet?: boolean },
    ) {
        const user = await this.authService.getUser(auth.userId);

        return this.directoryGenerationService.updateDomainType(
            id,
            dto.domainType,
            user,
            dto.manuallySet ?? true,
        );
    }

    @Post('directories/:id/regenerate-markdown')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Regenerate markdown',
        description: 'Regenerate markdown files for all items in a directory',
    })
    @ApiParam({ name: 'id', description: 'Directory ID' })
    @ApiResponse({ status: 200, description: 'Markdown regenerated' })
    async regenerateMarkdown(@CurrentUser() auth: AuthenticatedUser, @Param('id') id: string) {
        const user = await this.authService.getUser(auth.userId);

        return this.directoryGenerationService.regenerateMarkdown(id, user);
    }

    @Post('directories/:id/update-readme')
    @HttpCode(HttpStatus.OK)
    async updateReadme(@CurrentUser() auth: AuthenticatedUser, @Param('id') id: string) {
        const user = await this.authService.getUser(auth.userId);

        return this.directoryGenerationService.updateReadme(id, user);
    }

    @Post('directories/:id/update-website')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Update website',
        description: 'Trigger a website rebuild and update',
    })
    @ApiParam({ name: 'id', description: 'Directory ID' })
    @ApiResponse({ status: 200, description: 'Website update triggered' })
    async updateWebsiteRepository(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
    ): Promise<UpdateWebsiteRepositoryResponseDto> {
        const user = await this.authService.getUser(auth.userId);

        return this.directoryGenerationService.updateWebsiteRepository(id, user);
    }

    @Post('directories/:id/delete')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Delete directory',
        description: 'Delete a directory and optionally its repositories',
    })
    @ApiParam({ name: 'id', description: 'Directory ID' })
    @ApiResponse({ status: 200, description: 'Directory deleted' })
    async deleteDirectory(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Body() deleteDirectoryDto: DeleteDirectoryDto,
    ): Promise<DeleteDirectoryResponseDto> {
        const user = await this.authService.getUser(auth.userId);

        return this.directoryLifecycleService.deleteDirectory(id, deleteDirectoryDto, user);
    }

    @Post('directories/:id/sync-data')
    @HttpCode(HttpStatus.OK)
    async syncDirectoryData(@CurrentUser() auth: AuthenticatedUser, @Param('id') id: string) {
        const user = await this.authService.getUser(auth.userId);

        return this.directoryLifecycleService.syncFromDataRepository(id, user);
    }

    // ============================================
    // Repository Visibility Endpoints
    // ============================================

    @Get('directories/:id/repositories/visibility')
    @HttpCode(HttpStatus.OK)
    async getRepositoryVisibility(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
    ): Promise<RepositoryStatus[]> {
        const user = await this.authService.getUser(auth.userId);
        const { directory } = await this.directoryOwnershipService.ensureAccess(id, user.id);

        return this.repositoryManagementService.getRepositoriesStatus(directory, user);
    }

    @Put('directories/:id/repositories/visibility')
    @HttpCode(HttpStatus.OK)
    async updateRepositoryVisibility(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Body() body: { repoType: RepositoryType; isPrivate: boolean },
    ): Promise<RepositoryStatus> {
        const user = await this.authService.getUser(auth.userId);
        const { directory } = await this.directoryOwnershipService.ensureAccess(id, user.id);

        return this.repositoryManagementService.updateRepositoryVisibility(
            directory,
            user,
            body.repoType,
            body.isPrivate,
        );
    }

    // ============================================
    // Advanced Prompts Endpoints
    // ============================================

    @Get('directories/:id/advanced-prompts')
    @HttpCode(HttpStatus.OK)
    async getAdvancedPrompts(@CurrentUser() auth: AuthenticatedUser, @Param('id') id: string) {
        return this.directoryAdvancedPromptsService.getAdvancedPrompts(id, auth.userId);
    }

    @Put('directories/:id/advanced-prompts')
    @HttpCode(HttpStatus.OK)
    async updateAdvancedPrompts(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Body() dto: UpdateDirectoryAdvancedPromptsDto,
    ) {
        return this.directoryAdvancedPromptsService.updateAdvancedPrompts(id, dto, auth.userId);
    }

    // ============================================
    // Import endpoints
    // ============================================

    @Post('directories/import/analyze')
    @HttpCode(HttpStatus.OK)
    async analyzeRepository(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() analyzeDto: AnalyzeRepositoryDto,
    ): Promise<AnalyzeRepositoryResponseDto> {
        const user = await this.authService.getUser(auth.userId);
        return this.directoryImportService.analyzeRepository(analyzeDto, user);
    }

    @Post('directories/import/analyze-for-linking')
    @HttpCode(HttpStatus.OK)
    async analyzeForLinking(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() analyzeDto: AnalyzeRepositoryDto,
    ): Promise<AnalyzeForLinkingResponseDto> {
        const user = await this.authService.getUser(auth.userId);
        return this.directoryImportService.analyzeForLinking(analyzeDto, user);
    }

    @Post('directories/import')
    @HttpCode(HttpStatus.ACCEPTED)
    async importDirectory(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() importDto: ImportDirectoryDto,
    ): Promise<ImportDirectoryResponseDto> {
        const user = await this.authService.getUser(auth.userId);
        return this.directoryImportService.initiateImport(importDto, user);
    }

    @Get('directories/import/repositories')
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

        return this.directoryImportService.getUserRepositories(dto, user);
    }

    // ============================================
    // Taxonomy CRUD Endpoints (Categories & Tags)
    // ============================================

    // Categories
    @Post('directories/:id/categories')
    @HttpCode(HttpStatus.OK)
    async createCategory(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Body() dto: CreateCategoryDto,
    ) {
        const result = await this.directoryTaxonomyService.createCategory(id, dto, auth.userId);
        await this.cacheManager.del(`directory-categories-tags-${id}-${auth.userId}`);
        return result;
    }

    @Put('directories/:id/categories/:categoryId')
    @HttpCode(HttpStatus.OK)
    async updateCategory(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Param('categoryId') categoryId: string,
        @Body() dto: UpdateCategoryDto,
    ) {
        const result = await this.directoryTaxonomyService.updateCategory(
            id,
            categoryId,
            dto,
            auth.userId,
        );
        await this.cacheManager.del(`directory-categories-tags-${id}-${auth.userId}`);
        return result;
    }

    @Delete('directories/:id/categories/:categoryId')
    @HttpCode(HttpStatus.OK)
    async deleteCategory(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Param('categoryId') categoryId: string,
    ) {
        const result = await this.directoryTaxonomyService.deleteCategory(
            id,
            categoryId,
            auth.userId,
        );
        await this.cacheManager.del(`directory-categories-tags-${id}-${auth.userId}`);
        return result;
    }

    // Tags
    @Post('directories/:id/tags')
    @HttpCode(HttpStatus.OK)
    async createTag(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Body() dto: CreateTagDto,
    ) {
        const result = await this.directoryTaxonomyService.createTag(id, dto, auth.userId);
        await this.cacheManager.del(`directory-categories-tags-${id}-${auth.userId}`);
        return result;
    }

    @Put('directories/:id/tags/:tagId')
    @HttpCode(HttpStatus.OK)
    async updateTag(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Param('tagId') tagId: string,
        @Body() dto: UpdateTagDto,
    ) {
        const result = await this.directoryTaxonomyService.updateTag(id, tagId, dto, auth.userId);
        await this.cacheManager.del(`directory-categories-tags-${id}-${auth.userId}`);
        return result;
    }

    @Delete('directories/:id/tags/:tagId')
    @HttpCode(HttpStatus.OK)
    async deleteTag(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Param('tagId') tagId: string,
    ) {
        const result = await this.directoryTaxonomyService.deleteTag(id, tagId, auth.userId);
        await this.cacheManager.del(`directory-categories-tags-${id}-${auth.userId}`);
        return result;
    }

    @Post('directories/:id/collections')
    @HttpCode(HttpStatus.OK)
    async createCollection(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Body() dto: CreateCollectionDto,
    ) {
        const result = await this.directoryTaxonomyService.createCollection(id, dto, auth.userId);
        await this.cacheManager.del(`directory-categories-tags-${id}-${auth.userId}`);
        return result;
    }

    @Put('directories/:id/collections/:collectionId')
    @HttpCode(HttpStatus.OK)
    async updateCollection(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Param('collectionId') collectionId: string,
        @Body() dto: UpdateCollectionDto,
    ) {
        const result = await this.directoryTaxonomyService.updateCollection(
            id,
            collectionId,
            dto,
            auth.userId,
        );
        await this.cacheManager.del(`directory-categories-tags-${id}-${auth.userId}`);
        return result;
    }

    @Delete('directories/:id/collections/:collectionId')
    @HttpCode(HttpStatus.OK)
    async deleteCollection(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Param('collectionId') collectionId: string,
    ) {
        const result = await this.directoryTaxonomyService.deleteCollection(
            id,
            collectionId,
            auth.userId,
        );
        await this.cacheManager.del(`directory-categories-tags-${id}-${auth.userId}`);
        return result;
    }

    @Post('directories/:id/process-community-prs')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Process community PRs',
        description: 'Manually trigger processing of community pull requests for a directory',
    })
    @ApiParam({ name: 'id', description: 'Directory ID' })
    @ApiResponse({ status: 200, description: 'Community PRs processed' })
    @ApiResponse({ status: 400, description: 'Community PR processing not enabled' })
    async processCommunityPrs(@CurrentUser() auth: AuthenticatedUser, @Param('id') id: string) {
        // Verify user has access
        const user = await this.authService.getUser(auth.userId);
        await this.directoryQueryService.getDirectory(id, user);

        // Get full entity and check if community PR processing is enabled
        const directory = await this.directoryRepository.findById(id);
        if (!directory) {
            throw new NotFoundException('Directory not found');
        }
        if (!directory.communityPrEnabled) {
            throw new BadRequestException(
                'Community PR processing is not enabled for this directory.',
            );
        }

        const itemsAdded = await this.communityPrProcessorService.processDirectory(directory);
        return { itemsAdded };
    }

    // ─── Comparisons ────────────────────────────────────────────────

    @Get('directories/:id/comparisons')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'List comparisons',
        description: 'List all generated comparisons for a directory',
    })
    @ApiParam({ name: 'id', description: 'Directory ID' })
    async listComparisons(@CurrentUser() auth: AuthenticatedUser, @Param('id') id: string) {
        const user = await this.authService.getUser(auth.userId);
        await this.directoryQueryService.getDirectory(id, user);

        return this.comparisonGenerationService.listComparisons(id, user.id);
    }

    @Get('directories/:id/comparisons/remaining-count')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Get remaining comparison count',
        description: 'Count how many un-generated comparison pairs remain',
    })
    @ApiParam({ name: 'id', description: 'Directory ID' })
    async getRemainingComparisonCount(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
    ) {
        const user = await this.authService.getUser(auth.userId);
        await this.directoryQueryService.getDirectory(id, user);

        const count = await this.comparisonGenerationService.getRemainingCount(id, user.id);
        return { count };
    }

    @Get('directories/:id/comparisons/:slug')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Get comparison', description: 'Get a single comparison by slug' })
    @ApiParam({ name: 'id', description: 'Directory ID' })
    @ApiParam({ name: 'slug', description: 'Comparison slug' })
    async getComparison(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Param('slug') slug: string,
    ) {
        const user = await this.authService.getUser(auth.userId);
        await this.directoryQueryService.getDirectory(id, user);

        const result = await this.comparisonGenerationService.getComparison(id, user.id, slug);
        if (!result.comparison) {
            throw new NotFoundException('Comparison not found');
        }

        return result;
    }

    @Post('directories/:id/comparisons/generate')
    @HttpCode(HttpStatus.ACCEPTED)
    @ApiOperation({
        summary: 'Generate next comparison',
        description: 'Auto-pick the next best pair and generate a comparison',
    })
    @ApiParam({ name: 'id', description: 'Directory ID' })
    async generateNextComparison(@CurrentUser() auth: AuthenticatedUser, @Param('id') id: string) {
        const user = await this.authService.getUser(auth.userId);
        await this.directoryOwnershipService.ensureCanEdit(id, user.id);

        const result = await this.comparisonGenerationService.generateNextComparison(id, user.id);
        await this.cacheManager.del(`directory-count-${id}-${auth.userId}`);
        return result;
    }

    @Post('directories/:id/comparisons/generate-manual')
    @HttpCode(HttpStatus.ACCEPTED)
    @ApiOperation({
        summary: 'Generate manual comparison',
        description: 'Generate a comparison between two specific items',
    })
    @ApiParam({ name: 'id', description: 'Directory ID' })
    @ApiResponse({ status: 202, description: 'Comparison generation started' })
    async generateManualComparison(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Body() body: GenerateManualComparisonDto,
    ) {
        const user = await this.authService.getUser(auth.userId);
        await this.directoryOwnershipService.ensureCanEdit(id, user.id);

        if (body.itemASlug === body.itemBSlug) {
            throw new BadRequestException('Cannot compare an item with itself');
        }

        const result = await this.comparisonGenerationService.generateManualComparison(
            id,
            user.id,
            body.itemASlug,
            body.itemBSlug,
        );
        await this.cacheManager.del(`directory-count-${id}-${auth.userId}`);
        return result;
    }

    @Delete('directories/:id/comparisons/:slug')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Delete comparison', description: 'Remove a generated comparison' })
    @ApiParam({ name: 'id', description: 'Directory ID' })
    @ApiParam({ name: 'slug', description: 'Comparison slug' })
    async deleteComparison(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Param('slug') slug: string,
    ) {
        const user = await this.authService.getUser(auth.userId);
        await this.directoryOwnershipService.ensureCanEdit(id, user.id);

        const result = await this.comparisonGenerationService.deleteComparison(id, user.id, slug);
        await this.cacheManager.del(`directory-count-${id}-${auth.userId}`);
        return result;
    }
}
