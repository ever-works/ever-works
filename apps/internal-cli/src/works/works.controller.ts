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
import { UserRepository } from '@ever-works/agent/database';
import { CreateWorkDto } from '@ever-works/agent/dto';
import {
    CreateItemsGeneratorDto,
    DeleteWorkDto,
    DeleteWorkResponseDto,
    ExtractItemDetailsDto,
    ExtractItemDetailsResponseDto,
    ItemsGeneratorResponseDto,
    RemoveItemDto,
    RemoveItemResponseDto,
    SubmitItemDto,
    SubmitItemResponseDto,
    UpdateItemsGeneratorDto,
} from '@ever-works/agent/items-generator';
import {
    WorkGenerationService,
    WorkLifecycleService,
    WorkOwnershipService,
    WorkQueryService,
} from '@ever-works/agent/services';
import { UpdateWebsiteRepositoryResponseDto } from '@ever-works/agent/generators';

interface DeployDto {
    DEPLOY_TOKEN?: string;
    teamScope?: string;
}

@Controller('api')
export class WorksController {
    constructor(
        private readonly workQueryService: WorkQueryService,
        private readonly workLifecycleService: WorkLifecycleService,
        private readonly workGenerationService: WorkGenerationService,
        private readonly ownershipService: WorkOwnershipService,
        private readonly userRepository: UserRepository,
    ) {}

    @Get('works')
    @HttpCode(HttpStatus.OK)
    async getWorks(@Query('limit') limit?: string, @Query('offset') offset?: string) {
        const parsedLimit = limit !== undefined ? Number(limit) : undefined;
        const parsedOffset = offset !== undefined ? Number(offset) : undefined;

        const user = await this.userRepository.createOrGetLocalUser();

        return this.workQueryService.getWorks(
            {
                limit: parsedLimit && !isNaN(parsedLimit) ? parsedLimit : undefined,
                offset: parsedOffset && !isNaN(parsedOffset) ? parsedOffset : undefined,
            },
            user,
        );
    }

    @Post('works')
    @HttpCode(HttpStatus.OK)
    async createWork(@Body() createWorkDto: CreateWorkDto) {
        const user = await this.userRepository.createOrGetLocalUser();
        return this.workLifecycleService.createWork(createWorkDto, user);
    }

    @Post('works/:id/generate')
    @HttpCode(HttpStatus.ACCEPTED)
    async generateItems(
        @Param('id') id: string,
        @Body() createItemsGeneratorDto: CreateItemsGeneratorDto,
    ): Promise<ItemsGeneratorResponseDto> {
        const user = await this.userRepository.createOrGetLocalUser();
        // We don't await completion here, as the request can take a long time
        return this.workGenerationService.generateItems(
            id,
            createItemsGeneratorDto,
            user,
            false,
        );
    }

    @Post('works/:id/update')
    @HttpCode(HttpStatus.ACCEPTED)
    async updateItemsGenerator(
        @Param('id') id: string,
        @Body() updateItemsGeneratorDto: UpdateItemsGeneratorDto,
    ): Promise<ItemsGeneratorResponseDto> {
        const user = await this.userRepository.createOrGetLocalUser();

        // We don't await completion here, as the request can take a long time
        return this.workGenerationService.updateItemsGenerator({
            workId: id,
            updateDto: updateItemsGeneratorDto,
            user,
            awaitCompletion: false,
        });
    }

    @Post('works/:id/submit-item')
    @HttpCode(HttpStatus.OK)
    async submitItem(
        @Param('id') id: string,
        @Body() submitItemDto: SubmitItemDto,
    ): Promise<SubmitItemResponseDto> {
        const user = await this.userRepository.createOrGetLocalUser();

        return this.workGenerationService.submitItem(id, submitItemDto, user);
    }

    @Post('works/:id/remove-item')
    @HttpCode(HttpStatus.OK)
    async removeItem(
        @Param('id') id: string,
        @Body() removeItemDto: RemoveItemDto,
    ): Promise<RemoveItemResponseDto> {
        const user = await this.userRepository.createOrGetLocalUser();

        return this.workGenerationService.removeItem(id, removeItemDto, user);
    }

    @Post('extract-item-details')
    @HttpCode(HttpStatus.OK)
    async extractItemDetails(
        @Body() extractItemDetailsDto: ExtractItemDetailsDto,
    ): Promise<ExtractItemDetailsResponseDto> {
        const user = await this.userRepository.createOrGetLocalUser();
        return this.workGenerationService.extractItemDetails(extractItemDetailsDto, user);
    }

    @Post('works/:id/regenerate-markdown')
    @HttpCode(HttpStatus.OK)
    async regenerateMarkdown(@Param('id') id: string) {
        const user = await this.userRepository.createOrGetLocalUser();

        return this.workGenerationService.regenerateMarkdown(id, user);
    }

    @Post('works/:id/update-website')
    @HttpCode(HttpStatus.OK)
    async updateWebsiteRepository(
        @Param('id') id: string,
    ): Promise<UpdateWebsiteRepositoryResponseDto> {
        const user = await this.userRepository.createOrGetLocalUser();

        return this.workGenerationService.updateWebsiteRepository(id, user);
    }

    @Post('works/:id/delete')
    @HttpCode(HttpStatus.OK)
    async deleteWork(
        @Param('id') id: string,
        @Body() deleteWorkDto: DeleteWorkDto,
    ): Promise<DeleteWorkResponseDto> {
        const user = await this.userRepository.createOrGetLocalUser();

        return this.workLifecycleService.deleteWork(id, deleteWorkDto, user);
    }

    @Post('deploy/works/:id')
    async deploy(@Body() deployDto: DeployDto, @Param('id') id: string) {
        throw new NotFoundException(
            'Deploy functionality via CLI has been deprecated. Please use the web dashboard.',
        );
    }
}
