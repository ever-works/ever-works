import {
    BadRequestException,
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    HttpStatus,
    Inject,
    Param,
    Post,
    Put,
    Query,
    UseGuards,
} from '@nestjs/common';
import { CreateDirectoryDto, UpdateDirectoryDto } from '@packages/agent/dto';
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
} from '@packages/agent/items-generator';
import {
    DirectoryDetailService,
    DirectoryGenerationService,
    DirectoryLifecycleService,
    DirectoryQueryService,
    DirectoryScheduleService,
} from '@packages/agent/services';
import { UpdateWebsiteRepositoryResponseDto } from '@packages/agent/website-generator';
import { AuthService, CurrentUser, JwtAuthGuard } from '../auth';
import { AuthenticatedUser } from '@src/auth/types/jwt.types';
import { GenerateDirectoryDetailDto } from './dto/generate-detail.dto';
import { CACHE_MANAGER, Cache } from '@packages/agent/cache';
import { UpdateDirectoryScheduleDto } from '@packages/agent/dto';
import { DirectoryScheduleStatus } from '@packages/agent/entities';

let CACHE_TTL = 1000 * 60 * 10; // 10 minutes

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
    ) {}

    @Get('directories')
    @HttpCode(HttpStatus.OK)
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

    @Post('directories')
    @HttpCode(HttpStatus.OK)
    async createDirectory(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() createDirectoryDto: CreateDirectoryDto,
    ) {
        const user = await this.authService.getUser(auth.userId);
        return this.directoryLifecycleService.createDirectory(createDirectoryDto, user);
    }

    @Get('directories/:id')
    @HttpCode(HttpStatus.OK)
    async getDirectory(@CurrentUser() auth: AuthenticatedUser, @Param('id') id: string) {
        const user = await this.authService.getUser(auth.userId);
        return this.directoryQueryService.getDirectory(id, user);
    }

    @Put('directories/:id')
    @HttpCode(HttpStatus.OK)
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
    async getDirectoryHistory(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Query('limit') limit?: string,
        @Query('offset') offset?: string,
    ) {
        const user = await this.authService.getUser(auth.userId);

        const parsedLimit = limit !== undefined ? Number(limit) : undefined;
        const parsedOffset = offset !== undefined ? Number(offset) : undefined;

        const result = await this.directoryQueryService.directoryGenerationHistory(id, user, {
            limit: parsedLimit && !isNaN(parsedLimit) ? parsedLimit : undefined,
            offset: parsedOffset && !isNaN(parsedOffset) ? parsedOffset : undefined,
        });

        return {
            status: 'success',
            ...result,
        };
    }

    @Post('directories/generate-details')
    @HttpCode(HttpStatus.OK)
    async generateDirectoryDetails(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() generateDirectoryDetailDto: GenerateDirectoryDetailDto,
    ) {
        const user = await this.authService.getUser(auth.userId);
        return this.directoryDetailService.generateDirectoryDetails(
            generateDirectoryDetailDto.directory_name,
            generateDirectoryDetailDto.prompt,
            user,
        );
    }

    @Post('directories/:id/generate')
    @HttpCode(HttpStatus.ACCEPTED)
    async generateItems(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Body() createItemsGeneratorDto: CreateItemsGeneratorDto,
    ): Promise<ItemsGeneratorResponseDto> {
        const user = await this.authService.getUser(auth.userId);

        // We don't await completion here, as the request can take a long time
        const response = await this.directoryGenerationService.generateItems(
            id,
            createItemsGeneratorDto,
            user,
            false,
        );

        // Wait a little while to ensure the process has started.
        await this.wait(2);

        return response;
    }

    @Post('directories/:id/update')
    @HttpCode(HttpStatus.ACCEPTED)
    async updateItemsGenerator(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Body() updateItemsGeneratorDto: UpdateItemsGeneratorDto,
    ): Promise<ItemsGeneratorResponseDto> {
        const user = await this.authService.getUser(auth.userId);

        // We don't await completion here, as the request can take a long time
        const response = await this.directoryGenerationService.updateItemsGenerator(
            id,
            updateItemsGeneratorDto,
            user,
            false,
        );

        // Wait a little while to ensure the process has started.
        await this.wait(2);

        return response;
    }

    @Get('directories/:id/schedule')
    @HttpCode(HttpStatus.OK)
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
    async updateItemMetadata(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Body() updateItemDto: UpdateItemDto,
    ) {
        const user = await this.authService.getUser(auth.userId);

        return this.directoryGenerationService.updateItemMetadata(id, updateItemDto, user);
    }

    @Post('extract-item-details')
    @HttpCode(HttpStatus.OK)
    async extractItemDetails(
        @Body() extractItemDetailsDto: ExtractItemDetailsDto,
    ): Promise<ExtractItemDetailsResponseDto> {
        return this.directoryGenerationService.extractItemDetails(extractItemDetailsDto);
    }

    @Post('directories/:id/regenerate-markdown')
    @HttpCode(HttpStatus.OK)
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
    async updateWebsiteRepository(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
    ): Promise<UpdateWebsiteRepositoryResponseDto> {
        const user = await this.authService.getUser(auth.userId);

        return this.directoryGenerationService.updateWebsiteRepository(id, user);
    }

    @Post('directories/:id/delete')
    @HttpCode(HttpStatus.OK)
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

    private wait(sec = 2) {
        return new Promise((resolve) => setTimeout(resolve, sec * 1000));
    }
}
