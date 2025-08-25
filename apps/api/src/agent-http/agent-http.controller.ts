import {
    Body,
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    Post,
    Query,
    UseGuards,
} from '@nestjs/common';
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
import { AuthService, CurrentUser, JwtAuthGuard } from '../auth';
import { AuthenticatedUser } from '@src/auth/types/jwt.types';

@Controller('api')
@UseGuards(JwtAuthGuard)
export class AgentHttpController {
    constructor(
        private readonly agentService: AgentService,
        private readonly authService: AuthService,
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

        return this.agentService.getDirectories(
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
        return this.agentService.createDirectory(createDirectoryDto, user);
    }

    @Get('directories/:id')
    @HttpCode(HttpStatus.OK)
    async getDirectory(@CurrentUser() auth: AuthenticatedUser, @Param('id') id: string) {
        const user = await this.authService.getUser(auth.userId);
        return this.agentService.getDirectory(id, user);
    }

    @Post('directories/:id/generate')
    @HttpCode(HttpStatus.ACCEPTED)
    async generateItemsGenerator(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Body() createItemsGeneratorDto: CreateItemsGeneratorDto,
    ): Promise<ItemsGeneratorResponseDto> {
        const user = await this.authService.getUser(auth.userId);

        // We don't await completion here, as the request can take a long time
        return this.agentService.generateItemsGenerator(id, createItemsGeneratorDto, user, false);
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
        return this.agentService.updateItemsGenerator(id, updateItemsGeneratorDto, user, false);
    }

    @Post('directories/:id/submit-item')
    @HttpCode(HttpStatus.OK)
    async submitItem(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Body() submitItemDto: SubmitItemDto,
    ): Promise<SubmitItemResponseDto> {
        const user = await this.authService.getUser(auth.userId);

        return this.agentService.submitItem(id, submitItemDto, user);
    }

    @Post('directories/:id/remove-item')
    @HttpCode(HttpStatus.OK)
    async removeItem(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Body() removeItemDto: RemoveItemDto,
    ): Promise<RemoveItemResponseDto> {
        const user = await this.authService.getUser(auth.userId);

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
    async regenerateMarkdown(@CurrentUser() auth: AuthenticatedUser, @Param('id') id: string) {
        const user = await this.authService.getUser(auth.userId);

        return this.agentService.regenerateMarkdown(id, user);
    }

    @Post('directories/:id/update-website')
    @HttpCode(HttpStatus.OK)
    async updateWebsiteRepository(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
    ): Promise<UpdateWebsiteRepositoryResponseDto> {
        const user = await this.authService.getUser(auth.userId);

        return this.agentService.updateWebsiteRepository(id, user);
    }

    @Post('directories/:id/delete')
    @HttpCode(HttpStatus.OK)
    async deleteDirectory(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Body() deleteDirectoryDto: DeleteDirectoryDto,
    ): Promise<DeleteDirectoryResponseDto> {
        const user = await this.authService.getUser(auth.userId);

        return this.agentService.deleteDirectory(id, deleteDirectoryDto, user);
    }
}
