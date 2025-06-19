import {
    Body,
    Controller,
    HttpCode,
    HttpStatus,
    NotFoundException,
    Param,
    Post,
    UsePipes,
    ValidationPipe,
} from '@nestjs/common';
import { DataGeneratorService } from './data-generator/data-generator.service';
import { MarkdownGeneratorService } from './markdown-generator/markdown-generator.service';
import { WebsiteGeneratorService } from './website-generator/website-generator.service';
import { WebsiteUpdateService } from './website-generator/website-update.service';
import { Directory } from './entities/directory.entity';
import { User } from './entities/user.entity';
import { GithubService } from './git/github.service';
import {
    CreateItemsGeneratorDto,
    UpdateItemsGeneratorDto,
} from './items-generator/dto/create-items-generator.dto';
import { ItemsGeneratorResponseDto } from './items-generator/dto/items-generator-response.dto';
import { SubmitItemDto, SubmitItemResponseDto } from './items-generator/dto';
import { CreateDirectoryDto } from './dto/create-directory.dto';
import { UpdateWebsiteRepositoryResponseDto } from './website-generator/dto/update-website-repository.dto';
import { ItemSubmissionService } from './items-generator/item-submission.service';

@Controller()
export class AppController {
    constructor(
        private readonly dataGenerator: DataGeneratorService,
        private readonly markdownGenerator: MarkdownGeneratorService,
        private readonly websiteGenerator: WebsiteGeneratorService,
        private readonly websiteUpdateService: WebsiteUpdateService,
        private readonly githubService: GithubService,
        private readonly itemSubmissionService: ItemSubmissionService,
    ) {}

    @Post('directories')
    @UsePipes(new ValidationPipe({ transform: true }))
    async createDirectory(@Body() createDirectoryDto: CreateDirectoryDto) {
        const { slug, name, description, owner } = createDirectoryDto;
        const user = await User.sessionMock();

        const dir = new Directory();

        dir.slug = slug;
        dir.name = name;
        dir.description = description;

        const ghOwner = await this.githubService.getUser(user.getGitToken());
        dir.owner = owner || ghOwner.login;
        dir.organization = !!owner && owner !== ghOwner.login;

        Directory.createMock(dir);

        return dir;
    }

    @Post('generate')
    @HttpCode(HttpStatus.ACCEPTED)
    @UsePipes(
        new ValidationPipe({
            transform: true,
            whitelist: true,
            forbidNonWhitelisted: true,
        }),
    )
    async generateItemsGenerator(
        @Body() createItemsGeneratorDto: CreateItemsGeneratorDto,
    ): Promise<ItemsGeneratorResponseDto> {
        const user = await User.sessionMock();
        const directory = await Directory.findMock(createItemsGeneratorDto.slug);
        if (!directory) {
            throw new NotFoundException('Directory not found');
        }

        // TODO: Intentionally not awaiting this to allow for an immediate response
        // The actual processing will happen in the background.
        // A more robust solution might involve job queues, webhooks, or websockets for status updates.
        void this.processGeneration(directory, user, createItemsGeneratorDto);

        return {
            status: 'pending',
            slug: createItemsGeneratorDto.slug,
            parameters: createItemsGeneratorDto,
            message: `Processing request for '${createItemsGeneratorDto.name}'. Check logs or data directory for updates.`,
        };
    }

    @Post('update/:slug')
    @HttpCode(HttpStatus.ACCEPTED)
    async updateItemsGenerator(
        @Param('slug') slug: string,
        @Body() updateItemsGeneratorDto: UpdateItemsGeneratorDto,
    ): Promise<ItemsGeneratorResponseDto> {
        const user = await User.sessionMock();
        const directory = await Directory.findMock(slug);
        if (!directory) {
            throw new NotFoundException('Directory not found');
        }

        let lastRequestData = await this.dataGenerator
            .getLastRequestData(directory, user)
            .catch(() => null);

        if (!lastRequestData) {
            throw new NotFoundException('No last request data found');
        }

        lastRequestData = {
            ...lastRequestData,
            ...updateItemsGeneratorDto,
        };

        // TODO: Intentionally not awaiting this to allow for an immediate response
        // The actual processing will happen in the background.
        // A more robust solution might involve job queues, webhooks, or websockets for status updates.
        void this.processGeneration(directory, user, lastRequestData);

        return {
            slug,
            status: 'pending',
            parameters: lastRequestData,
            message: `Processing update for '${directory.name}'. Check logs or data directory for updates.`,
        };
    }

    @Post('submit-item/:slug')
    @HttpCode(HttpStatus.OK)
    @UsePipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
    async submitItem(
        @Param('slug') slug: string,
        @Body() submitItemDto: SubmitItemDto,
    ): Promise<SubmitItemResponseDto> {
        try {
            const user = await User.sessionMock();

            // Check if directory exists for the given slug
            const directory = await Directory.findMock(slug);
            if (!directory) {
                throw new NotFoundException(`Directory with slug '${slug}' not found`);
            }

            const result = await this.itemSubmissionService.submitItem(
                directory,
                user,
                submitItemDto,
            );
            return result;
        } catch (error) {
            console.error('Error submitting item:', error);

            return {
                status: 'error',
                slug,
                item_name: submitItemDto.name,
                message: 'Failed to submit item',
                error_details: error.message,
            };
        }
    }

    @Post('update-website/:slug')
    @HttpCode(HttpStatus.OK)
    @UsePipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
    async updateWebsiteRepository(
        @Param('slug') slug: string,
    ): Promise<UpdateWebsiteRepositoryResponseDto> {
        try {
            const user = await User.sessionMock();

            // Check if directory exists for the given slug
            const directory = await Directory.findMock(slug);
            if (!directory) {
                throw new NotFoundException(`Directory with slug '${slug}' not found`);
            }

            const result = await this.websiteUpdateService.updateRepository(directory, user);

            return {
                status: 'success',
                slug: directory.slug,
                owner: directory.owner,
                repository: `${directory.owner}/${directory.slug}-website`,
                message: result.message,
                method_used: result.method,
            };
        } catch (error) {
            console.error('Error updating website repository:', error);

            return {
                status: 'error',
                slug,
                owner: '',
                repository: `/${slug}-website`,
                message: 'Failed to update website repository',
                error_details: error.message,
            };
        }
    }

    private async processGeneration(
        directory: Directory,
        user: User,
        dto: CreateItemsGeneratorDto,
    ) {
        const startTime = new Date();
        console.log(`Generation started at: ${startTime.toISOString()}`);

        try {
            const generated = await this.dataGenerator.initialize(directory, user, dto);

            if (generated) {
                await Promise.all([
                    this.markdownGenerator.initialize(directory, user, dto.repository_description),
                    this.websiteGenerator.initialize(
                        directory,
                        user,
                        dto.website_repository_creation_method,
                    ),
                ]);
            }
        } catch (error) {
            console.error('Error during generation:', error);
        }

        const endTime = new Date();
        console.log(`Generation finished at: ${endTime.toISOString()}`);
        const duration = (endTime.getTime() - startTime.getTime()) / 1000;
        console.log(`Total time taken: ${duration} seconds`);
    }
}
