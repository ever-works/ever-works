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
    DeleteItemsGeneratorDto,
    DeleteItemsGeneratorResponseDto,
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
export class AgentHttpController {
    constructor(
        private readonly agentService: AgentService,
        private readonly authService: AuthService,
    ) {}

    @Get('directories')
    @UseGuards(JwtAuthGuard)
    @HttpCode(HttpStatus.OK)
    async getDirectories(
        @CurrentUser() user: AuthenticatedUser,
        @Query('limit') limit?: string,
        @Query('offset') offset?: string,
    ) {
        const parsedLimit = limit !== undefined ? Number(limit) : undefined;
        const parsedOffset = offset !== undefined ? Number(offset) : undefined;

        return this.agentService.getDirectories({
            userId: user.userId,
            limit: parsedLimit && !isNaN(parsedLimit) ? parsedLimit : undefined,
            offset: parsedOffset && !isNaN(parsedOffset) ? parsedOffset : undefined,
        });
    }

    @Post('directories')
    @UseGuards(JwtAuthGuard)
    @HttpCode(HttpStatus.OK)
    async createDirectory(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() createDirectoryDto: CreateDirectoryDto,
    ) {
        const user = await this.authService.getUser(auth.userId);
        return this.agentService.createDirectory(createDirectoryDto, user);
    }

    @Post('generate')
    @UseGuards(JwtAuthGuard)
    @HttpCode(HttpStatus.ACCEPTED)
    async generateItemsGenerator(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() createItemsGeneratorDto: CreateItemsGeneratorDto,
    ): Promise<ItemsGeneratorResponseDto> {
        const user = await this.authService.getUser(auth.userId);

        // We don't await completion here, as the request can take a long time
        return this.agentService.generateItemsGenerator(createItemsGeneratorDto, user, false);
    }

    @Post('update/:slug')
    @UseGuards(JwtAuthGuard)
    @HttpCode(HttpStatus.ACCEPTED)
    async updateItemsGenerator(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('slug') slug: string,
        @Body() updateItemsGeneratorDto: UpdateItemsGeneratorDto,
    ): Promise<ItemsGeneratorResponseDto> {
        const user = await this.authService.getUser(auth.userId);

        // We don't await completion here, as the request can take a long time
        return this.agentService.updateItemsGenerator(slug, updateItemsGeneratorDto, user, false);
    }

    @Post('submit-item/:slug')
    @UseGuards(JwtAuthGuard)
    @HttpCode(HttpStatus.OK)
    async submitItem(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('slug') slug: string,
        @Body() submitItemDto: SubmitItemDto,
    ): Promise<SubmitItemResponseDto> {
        const user = await this.authService.getUser(auth.userId);

        return this.agentService.submitItem(slug, submitItemDto, user);
    }

    @Post('remove-item/:slug')
    @UseGuards(JwtAuthGuard)
    @HttpCode(HttpStatus.OK)
    async removeItem(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('slug') slug: string,
        @Body() removeItemDto: RemoveItemDto,
    ): Promise<RemoveItemResponseDto> {
        const user = await this.authService.getUser(auth.userId);

        return this.agentService.removeItem(slug, removeItemDto, user);
    }

    @Post('extract-item-details')
    @UseGuards(JwtAuthGuard)
    @HttpCode(HttpStatus.OK)
    async extractItemDetails(
        @Body() extractItemDetailsDto: ExtractItemDetailsDto,
    ): Promise<ExtractItemDetailsResponseDto> {
        return this.agentService.extractItemDetails(extractItemDetailsDto);
    }

    @Post('regenerate-markdown/:slug')
    @UseGuards(JwtAuthGuard)
    @HttpCode(HttpStatus.OK)
    async regenerateMarkdown(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('slug') slug: string,
    ): Promise<{ status: string; error_details?: string }> {
        const user = await this.authService.getUser(auth.userId);

        return this.agentService.regenerateMarkdown(slug, user);
    }

    @Post('update-website/:slug')
    @UseGuards(JwtAuthGuard)
    @HttpCode(HttpStatus.OK)
    async updateWebsiteRepository(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('slug') slug: string,
    ): Promise<UpdateWebsiteRepositoryResponseDto> {
        const user = await this.authService.getUser(auth.userId);

        return this.agentService.updateWebsiteRepository(slug, user);
    }

    @Post('delete/:slug')
    @UseGuards(JwtAuthGuard)
    @HttpCode(HttpStatus.OK)
    async deleteItemsGenerator(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('slug') slug: string,
        @Body() deleteItemsGeneratorDto: DeleteItemsGeneratorDto,
    ): Promise<DeleteItemsGeneratorResponseDto> {
        const user = await this.authService.getUser(auth.userId);

        return this.agentService.deleteItemsGenerator(slug, deleteItemsGeneratorDto, user);
    }
}
