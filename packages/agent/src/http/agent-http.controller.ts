import { Body, Controller, HttpCode, HttpStatus, Logger, Param, Post } from '@nestjs/common';
import {
    CreateItemsGeneratorDto,
    UpdateItemsGeneratorDto,
} from '../items-generator/dto/create-items-generator.dto';
import { ItemsGeneratorResponseDto } from '../items-generator/dto/items-generator-response.dto';
import {
    SubmitItemDto,
    SubmitItemResponseDto,
    RemoveItemDto,
    RemoveItemResponseDto,
    ExtractItemDetailsDto,
    ExtractItemDetailsResponseDto,
    DeleteItemsGeneratorDto,
    DeleteItemsGeneratorResponseDto,
} from '../items-generator/dto';
import { CreateDirectoryDto } from '../dto/create-directory.dto';
import { UpdateWebsiteRepositoryResponseDto } from '../website-generator/dto/update-website-repository.dto';
import { AgentService } from './agent.service';

@Controller()
export class AgentHTTPController {
    constructor(private readonly agentService: AgentService) {}

    @Post('directories')
    @HttpCode(HttpStatus.OK)
    async createDirectory(@Body() createDirectoryDto: CreateDirectoryDto) {
        return this.agentService.createDirectory(createDirectoryDto);
    }

    @Post('generate')
    @HttpCode(HttpStatus.ACCEPTED)
    async generateItemsGenerator(
        @Body() createItemsGeneratorDto: CreateItemsGeneratorDto,
    ): Promise<ItemsGeneratorResponseDto> {
        return this.agentService.generateItemsGenerator(createItemsGeneratorDto);
    }

    @Post('update/:slug')
    @HttpCode(HttpStatus.ACCEPTED)
    async updateItemsGenerator(
        @Param('slug') slug: string,
        @Body() updateItemsGeneratorDto: UpdateItemsGeneratorDto,
    ): Promise<ItemsGeneratorResponseDto> {
        return this.agentService.updateItemsGenerator(slug, updateItemsGeneratorDto);
    }

    @Post('submit-item/:slug')
    @HttpCode(HttpStatus.OK)
    async submitItem(
        @Param('slug') slug: string,
        @Body() submitItemDto: SubmitItemDto,
    ): Promise<SubmitItemResponseDto> {
        return this.agentService.submitItem(slug, submitItemDto);
    }

    @Post('remove-item/:slug')
    @HttpCode(HttpStatus.OK)
    async removeItem(
        @Param('slug') slug: string,
        @Body() removeItemDto: RemoveItemDto,
    ): Promise<RemoveItemResponseDto> {
        return this.agentService.removeItem(slug, removeItemDto);
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
        return this.agentService.regenerateMarkdown(slug);
    }

    @Post('update-website/:slug')
    @HttpCode(HttpStatus.OK)
    async updateWebsiteRepository(
        @Param('slug') slug: string,
    ): Promise<UpdateWebsiteRepositoryResponseDto> {
        return this.agentService.updateWebsiteRepository(slug);
    }

    @Post('delete/:slug')
    @HttpCode(HttpStatus.OK)
    async deleteItemsGenerator(
        @Param('slug') slug: string,
        @Body() deleteItemsGeneratorDto: DeleteItemsGeneratorDto,
    ): Promise<DeleteItemsGeneratorResponseDto> {
        return this.agentService.deleteItemsGenerator(slug, deleteItemsGeneratorDto);
    }
}
