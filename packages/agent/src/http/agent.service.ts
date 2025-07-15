import { Body, Injectable, Logger, NotFoundException, Param } from '@nestjs/common';
import { DataGeneratorService } from '../data-generator/data-generator.service';
import { MarkdownGeneratorService } from '../markdown-generator/markdown-generator.service';
import { WebsiteGeneratorService } from '../website-generator/website-generator.service';
import { WebsiteUpdateService } from '../website-generator/website-update.service';
import { Directory } from '../entities/directory.entity';
import { User } from '../entities/user.entity';
import { GithubService } from '../git/github.service';
import { DirectoryRepository } from '../database/directory.repository';
import {
    CreateItemsGeneratorDto,
    GenerationMethod,
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
import { ItemSubmissionService } from '../items-generator/item-submission.service';
import { ItemsGeneratorService } from '../items-generator/items-generator.service';

@Injectable()
export class AgentService {
    private readonly logger = new Logger(AgentService.name);

    constructor(
        private readonly dataGenerator: DataGeneratorService,
        private readonly markdownGenerator: MarkdownGeneratorService,
        private readonly websiteGenerator: WebsiteGeneratorService,
        private readonly websiteUpdateService: WebsiteUpdateService,
        private readonly githubService: GithubService,
        private readonly itemSubmissionService: ItemSubmissionService,
        private readonly itemsGeneratorService: ItemsGeneratorService,
        private readonly directoryRepository: DirectoryRepository,
    ) {}

    async createDirectory(createDirectoryDto: CreateDirectoryDto) {
        const { slug, name, description, owner } = createDirectoryDto;
        const user = await User.sessionMock();

        const ghOwner = await this.githubService.getUser(user.getGitToken());

        const directoryData = {
            slug,
            name,
            description,
            readmeConfig: createDirectoryDto.readme_config,
            owner: owner || ghOwner.login,
            organization: !!owner && owner !== ghOwner.login,
        };

        const dir = await this.directoryRepository.create(directoryData);

        return {
            status: 'success',
            directory: dir,
        };
    }

    async generateItemsGenerator(
        createItemsGeneratorDto: CreateItemsGeneratorDto,
        awaitCompletion = true,
    ): Promise<ItemsGeneratorResponseDto> {
        const user = await User.sessionMock();
        const directory = await this.directoryRepository.findBySlug(createItemsGeneratorDto.slug);
        if (!directory) {
            throw new NotFoundException('Directory not found');
        }

        if (awaitCompletion) {
            await this.processGeneration(directory, user, createItemsGeneratorDto);
        } else {
            void this.processGeneration(directory, user, createItemsGeneratorDto);
        }

        return {
            status: 'pending',
            slug: createItemsGeneratorDto.slug,
            parameters: createItemsGeneratorDto,
            message: `Processing request for '${createItemsGeneratorDto.name}'. Check logs or data directory for updates.`,
        };
    }

    async updateItemsGenerator(
        slug: string,
        updateItemsGeneratorDto: UpdateItemsGeneratorDto,
        awaitCompletion = true,
    ): Promise<ItemsGeneratorResponseDto> {
        const user = await User.sessionMock();
        const directory = await this.directoryRepository.findBySlug(slug);
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

        if (awaitCompletion) {
            await this.processGeneration(directory, user, lastRequestData);
        } else {
            void this.processGeneration(directory, user, lastRequestData);
        }

        return {
            slug,
            status: 'pending',
            parameters: lastRequestData,
            message: `Processing update for '${directory.name}'. Check logs or data directory for updates.`,
        };
    }

    async submitItem(slug: string, submitItemDto: SubmitItemDto): Promise<SubmitItemResponseDto> {
        try {
            const user = await User.sessionMock();

            // Check if directory exists for the given slug
            const directory = await this.directoryRepository.findBySlug(slug);
            if (!directory) {
                throw new NotFoundException(`Directory with slug '${slug}' not found`);
            }

            const result = await this.itemSubmissionService.submitItem(
                directory,
                user,
                submitItemDto,
            );

            // Regenerate markdown for all items
            if (result.status === 'success') {
                await this.markdownGenerator.initialize(directory, user, {
                    generation_method: result.auto_merged
                        ? GenerationMethod.RECREATE
                        : GenerationMethod.CREATE_UPDATE,
                    pr_update: {
                        branch: result.pr_branch_name,
                        title: result.pr_title,
                        body: result.pr_body,
                    },
                });
            }

            return result;
        } catch (error) {
            this.logger.error('Error submitting item:', error);

            return {
                status: 'error',
                slug,
                item_name: submitItemDto.name,
                message: 'Failed to submit item',
                error_details: error.message,
            };
        }
    }

    async removeItem(slug: string, removeItemDto: RemoveItemDto): Promise<RemoveItemResponseDto> {
        try {
            const user = await User.sessionMock();

            // Check if directory exists for the given slug
            const directory = await this.directoryRepository.findBySlug(slug);
            if (!directory) {
                throw new NotFoundException(`Directory with slug '${slug}' not found`);
            }

            const result = await this.itemSubmissionService.removeItem(
                directory,
                user,
                removeItemDto,
            );

            // Regenerate markdown for all items (Always create PR for removal)
            if (result.status === 'success') {
                await this.markdownGenerator.initialize(directory, user, {
                    generation_method: GenerationMethod.CREATE_UPDATE,
                    remove_details: [removeItemDto.item_slug],
                    pr_update: {
                        branch: result.pr_branch_name,
                        title: result.pr_title,
                        body: result.pr_body,
                    },
                });
            }

            return result;
        } catch (error) {
            console.error('Error removing item:', error);

            return {
                status: 'error',
                slug,
                item_name: 'Unknown',
                item_slug: removeItemDto.item_slug,
                message: 'Failed to remove item',
                error_details: error.message,
            };
        }
    }

    async extractItemDetails(
        extractItemDetailsDto: ExtractItemDetailsDto,
    ): Promise<ExtractItemDetailsResponseDto> {
        try {
            this.logger.log(
                `Extracting item details from URL: ${extractItemDetailsDto.source_url}`,
            );

            const item = await this.itemsGeneratorService.extractItemDetailsFromUrl(
                extractItemDetailsDto.source_url,
                extractItemDetailsDto.existing_categories || [],
            );

            if (!item) {
                return {
                    status: 'error',
                    source_url: extractItemDetailsDto.source_url,
                    message: 'Failed to extract item details from the provided URL',
                    error_details: 'No item data could be extracted from the URL content',
                };
            }

            return {
                status: 'success',
                source_url: extractItemDetailsDto.source_url,
                item,
                message: `Successfully extracted item details: "${item.name}"`,
            };
        } catch (error) {
            console.error('Error extracting item details:', error);

            return {
                status: 'error',
                source_url: extractItemDetailsDto.source_url,
                message: 'Failed to extract item details',
                error_details: error.message,
            };
        }
    }

    async regenerateMarkdown(slug: string): Promise<{ status: string; error_details?: string }> {
        try {
            const user = await User.sessionMock();

            // Check if directory exists for the given slug
            const directory = await this.directoryRepository.findBySlug(slug);
            if (!directory) {
                throw new NotFoundException(`Directory with slug '${slug}' not found`);
            }

            // Regenerate markdown for all items
            await this.markdownGenerator.initialize(directory, user, {
                generation_method: GenerationMethod.RECREATE,
            });

            return {
                status: 'success',
            };
        } catch (error) {
            console.error('Error regenerating markdown:', error);

            return {
                status: 'error',
                error_details: error.message,
            };
        }
    }

    async updateWebsiteRepository(slug: string): Promise<UpdateWebsiteRepositoryResponseDto> {
        try {
            const user = await User.sessionMock();

            // Check if directory exists for the given slug
            const directory = await this.directoryRepository.findBySlug(slug);
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

    async deleteItemsGenerator(
        slug: string,
        deleteItemsGeneratorDto: DeleteItemsGeneratorDto,
    ): Promise<DeleteItemsGeneratorResponseDto> {
        try {
            const user = await User.sessionMock();

            // Check if directory exists for the given slug
            const directory = await this.directoryRepository.findBySlug(slug);
            if (!directory) {
                throw new NotFoundException(`Directory with slug '${slug}' not found`);
            }

            const deletedRepositories: string[] = [];

            // Delete data repository if requested
            if (deleteItemsGeneratorDto.delete_data_repository !== false) {
                try {
                    await this.dataGenerator.removeRepository(directory, user);
                    deletedRepositories.push(`${directory.owner}/${directory.getDataRepo()}`);
                } catch (error) {
                    this.logger.error('Failed to delete data repository:', error);
                }
            }

            // Delete markdown repository if requested
            if (deleteItemsGeneratorDto.delete_markdown_repository !== false) {
                try {
                    await this.markdownGenerator.removeRepository(directory, user);
                    deletedRepositories.push(`${directory.owner}/${directory.slug}`);
                } catch (error) {
                    this.logger.error('Failed to delete markdown repository:', error);
                }
            }

            // Delete website repository if requested
            if (deleteItemsGeneratorDto.delete_website_repository !== false) {
                try {
                    await this.websiteGenerator.removeRepository(directory, user);
                    deletedRepositories.push(`${directory.owner}/${directory.getWebsiteRepo()}`);
                } catch (error) {
                    this.logger.error('Failed to delete website repository:', error);
                }
            }

            // Remove directory from database
            await this.directoryRepository.delete(directory.id);

            return {
                status: 'success',
                slug: directory.slug,
                message: `Directory '${directory.slug}' and associated repositories have been deleted`,
                deleted_repositories: deletedRepositories,
            };
        } catch (error) {
            this.logger.error('Error deleting directory:', error);

            return {
                status: 'error',
                slug,
                message: 'Failed to delete directory',
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
                    this.markdownGenerator.initialize(directory, user, {
                        repository_description: dto.repository_description,
                    }),
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
