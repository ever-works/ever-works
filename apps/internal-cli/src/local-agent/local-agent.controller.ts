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
import { DirectoryRepository } from '@packages/agent/database';
import { DeployVercelDto, VercelService } from '@packages/agent/deploy';
import { CreateDirectoryDto } from '@packages/agent/dto';
import { User } from '@packages/agent/entities';
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
import { AgentService } from '@packages/agent/services';
import { UpdateWebsiteRepositoryResponseDto } from '@packages/agent/website-generator';

@Controller('api')
export class LocalAgentController {
    constructor(
        private readonly agentService: AgentService,
        private readonly vercelService: VercelService,
        private readonly directoryRepository: DirectoryRepository,
    ) {}

    @Get('directories')
    @HttpCode(HttpStatus.OK)
    async getDirectories(@Query('limit') limit?: string, @Query('offset') offset?: string) {
        const parsedLimit = limit !== undefined ? Number(limit) : undefined;
        const parsedOffset = offset !== undefined ? Number(offset) : undefined;

        const user = await User.createLocalUser();

        return this.agentService.getDirectories(
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
        const user = await User.createLocalUser();
        return this.agentService.createDirectory(createDirectoryDto, user);
    }

    @Post('generate')
    @HttpCode(HttpStatus.ACCEPTED)
    async generateItemsGenerator(
        @Body() createItemsGeneratorDto: CreateItemsGeneratorDto,
    ): Promise<ItemsGeneratorResponseDto> {
        const user = await User.createLocalUser();
        // We don't await completion here, as the request can take a long time
        return this.agentService.generateItemsGenerator(createItemsGeneratorDto, user, false);
    }

    @Post('update/:slug')
    @HttpCode(HttpStatus.ACCEPTED)
    async updateItemsGenerator(
        @Param('slug') slug: string,
        @Body() updateItemsGeneratorDto: UpdateItemsGeneratorDto,
    ): Promise<ItemsGeneratorResponseDto> {
        const user = await User.createLocalUser();

        // We don't await completion here, as the request can take a long time
        return this.agentService.updateItemsGenerator(slug, updateItemsGeneratorDto, user, false);
    }

    @Post('submit-item/:slug')
    @HttpCode(HttpStatus.OK)
    async submitItem(
        @Param('slug') slug: string,
        @Body() submitItemDto: SubmitItemDto,
    ): Promise<SubmitItemResponseDto> {
        const user = await User.createLocalUser();

        return this.agentService.submitItem(slug, submitItemDto, user);
    }

    @Post('remove-item/:slug')
    @HttpCode(HttpStatus.OK)
    async removeItem(
        @Param('slug') slug: string,
        @Body() removeItemDto: RemoveItemDto,
    ): Promise<RemoveItemResponseDto> {
        const user = await User.createLocalUser();

        return this.agentService.removeItem(slug, removeItemDto, user);
    }

    @Post('extract-item-details')
    @HttpCode(HttpStatus.OK)
    async extractItemDetails(
        @Body() extractItemDetailsDto: ExtractItemDetailsDto,
    ): Promise<ExtractItemDetailsResponseDto> {
        return this.agentService.extractItemDetails(extractItemDetailsDto);
    }

    @Post('regenerate-markdown/:slug')
    @HttpCode(HttpStatus.OK)
    async regenerateMarkdown(
        @Param('slug') slug: string,
    ): Promise<{ status: string; error_details?: string }> {
        const user = await User.createLocalUser();

        return this.agentService.regenerateMarkdown(slug, user);
    }

    @Post('update-website/:slug')
    @HttpCode(HttpStatus.OK)
    async updateWebsiteRepository(
        @Param('slug') slug: string,
    ): Promise<UpdateWebsiteRepositoryResponseDto> {
        const user = await User.createLocalUser();

        return this.agentService.updateWebsiteRepository(slug, user);
    }

    @Post('directories/delete/:slug')
    @HttpCode(HttpStatus.OK)
    async deleteDirectory(
        @Param('slug') slug: string,
        @Body() deleteDirectoryDto: DeleteDirectoryDto,
    ): Promise<DeleteDirectoryResponseDto> {
        const user = await User.createLocalUser();

        return this.agentService.deleteDirectory(slug, deleteDirectoryDto, user);
    }

    @Post('deploy/:dirname/vercel')
    async toVercel(@Body() deployVercel: DeployVercelDto, @Param('dirname') slug: string) {
        const { VERCEL_TOKEN: vercelToken, GITHUB_TOKEN: ghToken } = deployVercel;

        // some db query result:
        const directory = await this.directoryRepository.findBySlug(slug);
        if (!directory) {
            throw new NotFoundException('Directory not found');
        }

        const vercel = vercelToken || process.env.VERCEL_TOKEN;
        if (!vercel) {
            throw new NotFoundException('Vercel token is required');
        }

        const user = await User.createLocalUser();

        await this.vercelService.deploy(
            {
                owner: directory.getRepoOwner(),
                repo: directory.getWebsiteRepo(),
                provider: 'vercel',
                data: {
                    vercelToken: vercel,
                    ghToken: ghToken || process.env.GITHUB_APIKEY,
                },
            },
            directory,
            user,
        );
    }
}
