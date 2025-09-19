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
import { DirectoryRepository, UserRepository } from '@packages/agent/database';
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
import { AgentService } from '@packages/agent/services';
import { UpdateWebsiteRepositoryResponseDto } from '@packages/agent/website-generator';

@Controller('api')
export class DirectoriesController {
    constructor(
        private readonly agentService: AgentService,
        private readonly vercelService: VercelService,
        private readonly directoryRepository: DirectoryRepository,
        private readonly userRepository: UserRepository,
    ) {}

    @Get('directories')
    @HttpCode(HttpStatus.OK)
    async getDirectories(@Query('limit') limit?: string, @Query('offset') offset?: string) {
        const parsedLimit = limit !== undefined ? Number(limit) : undefined;
        const parsedOffset = offset !== undefined ? Number(offset) : undefined;

        const user = await this.userRepository.createOrGetLocalUser();

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
        const user = await this.userRepository.createOrGetLocalUser();
        return this.agentService.createDirectory(createDirectoryDto, user);
    }

    @Post('directories/:id/generate')
    @HttpCode(HttpStatus.ACCEPTED)
    async generateItemsGenerator(
        @Param('id') id: string,
        @Body() createItemsGeneratorDto: CreateItemsGeneratorDto,
    ): Promise<ItemsGeneratorResponseDto> {
        const user = await this.userRepository.createOrGetLocalUser();
        // We don't await completion here, as the request can take a long time
        return this.agentService.generateItemsGenerator(id, createItemsGeneratorDto, user, false);
    }

    @Post('directories/:id/update')
    @HttpCode(HttpStatus.ACCEPTED)
    async updateItemsGenerator(
        @Param('id') id: string,
        @Body() updateItemsGeneratorDto: UpdateItemsGeneratorDto,
    ): Promise<ItemsGeneratorResponseDto> {
        const user = await this.userRepository.createOrGetLocalUser();

        // We don't await completion here, as the request can take a long time
        return this.agentService.updateItemsGenerator(id, updateItemsGeneratorDto, user, false);
    }

    @Post('directories/:id/submit-item')
    @HttpCode(HttpStatus.OK)
    async submitItem(
        @Param('id') id: string,
        @Body() submitItemDto: SubmitItemDto,
    ): Promise<SubmitItemResponseDto> {
        const user = await this.userRepository.createOrGetLocalUser();

        return this.agentService.submitItem(id, submitItemDto, user);
    }

    @Post('directories/:id/remove-item')
    @HttpCode(HttpStatus.OK)
    async removeItem(
        @Param('id') id: string,
        @Body() removeItemDto: RemoveItemDto,
    ): Promise<RemoveItemResponseDto> {
        const user = await this.userRepository.createOrGetLocalUser();

        return this.agentService.removeItem(id, removeItemDto, user);
    }

    @Post('extract-item-details')
    @HttpCode(HttpStatus.OK)
    async extractItemDetails(
        @Body() extractItemDetailsDto: ExtractItemDetailsDto,
    ): Promise<ExtractItemDetailsResponseDto> {
        return this.agentService.extractItemDetails(extractItemDetailsDto);
    }

    @Post('directories/:id/regenerate-markdown')
    @HttpCode(HttpStatus.OK)
    async regenerateMarkdown(@Param('id') id: string) {
        const user = await this.userRepository.createOrGetLocalUser();

        return this.agentService.regenerateMarkdown(id, user);
    }

    @Post('directories/:id/update-website')
    @HttpCode(HttpStatus.OK)
    async updateWebsiteRepository(
        @Param('id') id: string,
    ): Promise<UpdateWebsiteRepositoryResponseDto> {
        const user = await this.userRepository.createOrGetLocalUser();

        return this.agentService.updateWebsiteRepository(id, user);
    }

    @Post('directories/:id/delete')
    @HttpCode(HttpStatus.OK)
    async deleteDirectory(
        @Param('id') id: string,
        @Body() deleteDirectoryDto: DeleteDirectoryDto,
    ): Promise<DeleteDirectoryResponseDto> {
        const user = await this.userRepository.createOrGetLocalUser();

        return this.agentService.deleteDirectory(id, deleteDirectoryDto, user);
    }

    @Post('deploy/directories/:id/vercel')
    async toVercel(@Body() deployVercel: DeployVercelDto, @Param('id') id: string) {
        const { VERCEL_TOKEN: vercelToken, GITHUB_TOKEN: ghToken } = deployVercel;

        const user = await this.userRepository.createOrGetLocalUser();

        // some db query result:
        const directory = await this.directoryRepository.findById(id);
        if (!directory) {
            throw new NotFoundException('Directory not found');
        }

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
