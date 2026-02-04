import {
    Body,
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    NotFoundException,
    Param,
    Post,
    Query,
} from '@nestjs/common';
import { UserRepository } from '@packages/agent/database';
import { DeployVercelDto, VercelService } from '@packages/agent/deploy';
import { CreateDirectoryDto } from '@packages/agent/dto';
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
} from '@packages/agent/items-generator';
import {
    DirectoryGenerationService,
    DirectoryLifecycleService,
    DirectoryOwnershipService,
    DirectoryQueryService,
} from '@packages/agent/services';
import { UpdateWebsiteRepositoryResponseDto } from '@packages/agent/generators';

@Controller('api')
export class DirectoriesController {
    constructor(
        private readonly directoryQueryService: DirectoryQueryService,
        private readonly directoryLifecycleService: DirectoryLifecycleService,
        private readonly directoryGenerationService: DirectoryGenerationService,
        private readonly ownershipService: DirectoryOwnershipService,
        private readonly vercelService: VercelService,
        private readonly userRepository: UserRepository,
    ) {}

    @Get('directories')
    @HttpCode(HttpStatus.OK)
    async getDirectories(@Query('limit') limit?: string, @Query('offset') offset?: string) {
        const parsedLimit = limit !== undefined ? Number(limit) : undefined;
        const parsedOffset = offset !== undefined ? Number(offset) : undefined;

        const user = await this.userRepository.createOrGetLocalUser();

        return this.directoryQueryService.getDirectories(
            {
                limit: parsedLimit && !isNaN(parsedLimit) ? parsedLimit : undefined,
                offset: parsedOffset && !isNaN(parsedOffset) ? parsedOffset : undefined,
            },
            user,
        );
    }

    @Post('directories')
    @HttpCode(HttpStatus.OK)
    async createDirectory(@Body() createDirectoryDto: CreateDirectoryDto) {
        const user = await this.userRepository.createOrGetLocalUser();
        return this.directoryLifecycleService.createDirectory(createDirectoryDto, user);
    }

    @Post('directories/:id/generate')
    @HttpCode(HttpStatus.ACCEPTED)
    async generateItems(
        @Param('id') id: string,
        @Body() createItemsGeneratorDto: CreateItemsGeneratorDto,
    ): Promise<ItemsGeneratorResponseDto> {
        const user = await this.userRepository.createOrGetLocalUser();
        // We don't await completion here, as the request can take a long time
        return this.directoryGenerationService.generateItems(
            id,
            createItemsGeneratorDto,
            user,
            false,
        );
    }

    @Post('directories/:id/update')
    @HttpCode(HttpStatus.ACCEPTED)
    async updateItemsGenerator(
        @Param('id') id: string,
        @Body() updateItemsGeneratorDto: UpdateItemsGeneratorDto,
    ): Promise<ItemsGeneratorResponseDto> {
        const user = await this.userRepository.createOrGetLocalUser();

        // We don't await completion here, as the request can take a long time
        return this.directoryGenerationService.updateItemsGenerator({
            directoryId: id,
            updateDto: updateItemsGeneratorDto,
            user,
            awaitCompletion: false,
        });
    }

    @Post('directories/:id/submit-item')
    @HttpCode(HttpStatus.OK)
    async submitItem(
        @Param('id') id: string,
        @Body() submitItemDto: SubmitItemDto,
    ): Promise<SubmitItemResponseDto> {
        const user = await this.userRepository.createOrGetLocalUser();

        return this.directoryGenerationService.submitItem(id, submitItemDto, user);
    }

    @Post('directories/:id/remove-item')
    @HttpCode(HttpStatus.OK)
    async removeItem(
        @Param('id') id: string,
        @Body() removeItemDto: RemoveItemDto,
    ): Promise<RemoveItemResponseDto> {
        const user = await this.userRepository.createOrGetLocalUser();

        return this.directoryGenerationService.removeItem(id, removeItemDto, user);
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
    async regenerateMarkdown(@Param('id') id: string) {
        const user = await this.userRepository.createOrGetLocalUser();

        return this.directoryGenerationService.regenerateMarkdown(id, user);
    }

    @Post('directories/:id/update-website')
    @HttpCode(HttpStatus.OK)
    async updateWebsiteRepository(
        @Param('id') id: string,
    ): Promise<UpdateWebsiteRepositoryResponseDto> {
        const user = await this.userRepository.createOrGetLocalUser();

        return this.directoryGenerationService.updateWebsiteRepository(id, user);
    }

    @Post('directories/:id/delete')
    @HttpCode(HttpStatus.OK)
    async deleteDirectory(
        @Param('id') id: string,
        @Body() deleteDirectoryDto: DeleteDirectoryDto,
    ): Promise<DeleteDirectoryResponseDto> {
        const user = await this.userRepository.createOrGetLocalUser();

        return this.directoryLifecycleService.deleteDirectory(id, deleteDirectoryDto, user);
    }

    @Post('deploy/directories/:id/vercel')
    async toVercel(@Body() deployVercel: DeployVercelDto, @Param('id') id: string) {
        const { VERCEL_TOKEN: vercelToken, GITHUB_TOKEN: ghToken } = deployVercel;

        const user = await this.userRepository.createOrGetLocalUser();

        // Verify user has edit access to the directory
        const { directory } = await this.ownershipService.ensureCanEdit(id, user.id);

        const vercel = vercelToken || process.env.VERCEL_TOKEN;
        if (!vercel) {
            throw new NotFoundException('Vercel token is required');
        }

        await this.vercelService.deploy(
            {
                owner: directory.getRepoOwner(),
                repo: directory.getWebsiteRepo(),
                provider: 'vercel',
                data: {
                    vercelToken: vercel,
                    ghToken: ghToken || process.env.GH_APIKEY,
                },
            },
            directory,
            user,
        );
    }
}
