import {
    BadRequestException,
    HttpException,
    Injectable,
    Logger,
    NotFoundException,
} from '@nestjs/common';
import { DataGeneratorService } from '../data-generator/data-generator.service';
import { MarkdownGeneratorService } from '../markdown-generator/markdown-generator.service';
import { WebsiteGeneratorService } from '../website-generator/website-generator.service';
import { WebsiteUpdateService } from '../website-generator/website-update.service';
import { Directory } from '../entities/directory.entity';
import { User } from '../entities/user.entity';
import { DirectoryRepository } from '../database/repositories/directory.repository';
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
    DeleteDirectoryDto,
    DeleteDirectoryResponseDto,
} from '../items-generator/dto';
import { CreateDirectoryDto } from '../dto/create-directory.dto';
import { UpdateWebsiteRepositoryResponseDto } from '../website-generator/dto/update-website-repository.dto';
import { ItemSubmissionService } from '../items-generator/item-submission.service';
import { ItemsGeneratorService } from '../items-generator/items-generator.service';
import { GenerateStatusType } from '../entities/types';
import { UpdateDirectoryDto } from '../dto';

@Injectable()
export class AgentService {
    private readonly logger = new Logger(AgentService.name);

    constructor(
        private readonly dataGenerator: DataGeneratorService,
        private readonly markdownGenerator: MarkdownGeneratorService,
        private readonly websiteGenerator: WebsiteGeneratorService,
        private readonly websiteUpdateService: WebsiteUpdateService,
        private readonly itemSubmissionService: ItemSubmissionService,
        private readonly itemsGeneratorService: ItemsGeneratorService,
        private readonly directoryRepository: DirectoryRepository,
    ) {}

    async getDirectories(
        options: {
            limit?: number;
            offset?: number;
            search?: string;
        } = {},
        user: User,
    ) {
        const { limit = 20, offset = 0, search } = options;

        // Validate and sanitize search input
        let sanitizedSearch: string | undefined;
        if (search) {
            // Trim and limit search length
            sanitizedSearch = search.trim().slice(0, 100);

            // If search is empty after trimming, treat as no search
            if (!sanitizedSearch) {
                sanitizedSearch = undefined;
            }
        }

        try {
            let directories = await this.directoryRepository.findAll({
                userId: user.id,
                limit,
                offset,
                search: sanitizedSearch,
            });

            directories = directories.map((dir) => {
                dir.owner = dir.getRepoOwner();
                return dir;
            });

            // Get the total count of directories for proper pagination
            const total = await this.directoryRepository.countAll({
                userId: user.id,
                search: sanitizedSearch,
            });

            return {
                status: 'success',
                directories,
                total,
                limit,
                offset,
            };
        } catch (error) {
            if (error instanceof HttpException) {
                throw error;
            }

            this.logger.error('Failed to get directories:', error);

            throw new BadRequestException({
                status: 'error',
                message: this.clearMessageError(error),
            });
        }
    }

    async getDirectory(id: string, user: User) {
        try {
            const directory = await this.validateDirectoryOwnership(id, user.id);
            directory.owner = directory.getRepoOwner();

            return {
                status: 'success',
                directory,
            };
        } catch (error) {
            if (error instanceof HttpException) {
                throw error;
            }

            this.logger.error('Failed to get directory:', error);

            throw new BadRequestException({
                status: 'error',
                message: this.clearMessageError(error),
            });
        }
    }

    async createDirectory(createDirectoryDto: CreateDirectoryDto, user: User) {
        const { slug, name, description, owner, readmeConfig, organization, repoProvider } =
            createDirectoryDto;

        const directoryData: Partial<Directory> = {
            slug,
            name,
            description,
            userId: user.id,
            owner: owner,
            repoProvider: repoProvider,
            readmeConfig: readmeConfig,
            organization: organization,
        };

        try {
            const dir = await this.directoryRepository.create(directoryData, user);
            dir.owner = dir.getRepoOwner();

            // Update generate status if repository is already existing
            const items = await this.dataGenerator.getItems(dir, user).catch(() => []);
            if (items.length > 0) {
                await this.directoryRepository.updateGenerateStatus(dir.id, {
                    status: GenerateStatusType.GENERATED,
                });
            }

            return {
                status: 'success',
                directory: dir,
            };
        } catch (error) {
            if (error instanceof HttpException) {
                throw error;
            }

            this.logger.error('Failed to create directory:', error);

            throw new BadRequestException({
                status: 'error',
                message: this.clearMessageError(error),
            });
        }
    }

    async updateDirectory(id: string, updateDto: UpdateDirectoryDto, user: User) {
        try {
            const directory = await this.validateDirectoryOwnership(id, user.id);

            const updatedDirectory = await this.directoryRepository.update(id, {
                name: updateDto.name || directory.name,
                description: updateDto.description || directory.description,
                // If we haven't generated the directory yet, we can update the owner and organization
                ...(!directory.generateStatus
                    ? { owner: updateDto.owner, organization: updateDto.organization }
                    : {}),
                readmeConfig: {
                    ...directory.readmeConfig,
                    ...updateDto.readmeConfig,
                },
            });

            updatedDirectory.owner = updatedDirectory.getRepoOwner();

            return {
                status: 'success',
                directory: updatedDirectory,
            };
        } catch (error) {
            if (error instanceof HttpException) {
                throw error;
            }

            this.logger.error('Failed to update directory:', error);

            throw new BadRequestException({
                status: 'error',
                message: this.clearMessageError(error),
            });
        }
    }

    async directoryExists(slug: string, user: User) {
        return this.directoryRepository.existsByUserAndSlug(user.id, slug);
    }

    async directoryItems(directoryId: string, user: User) {
        const directory = await this.validateDirectoryOwnership(directoryId, user.id);

        try {
            const items = await this.dataGenerator.getItems(directory, user);
            return {
                status: 'success',
                items,
            };
        } catch (error) {
            if (error instanceof HttpException) {
                throw error;
            }

            this.logger.error('Failed to get directory items:', error);

            const errMessage = this.clearMessageError(error);
            if (errMessage.includes('Repository not found')) {
                return {
                    status: 'success',
                    items: [],
                };
            }

            throw new BadRequestException({
                status: 'error',
                message: errMessage,
            });
        }
    }

    async directoryConfig(directoryId: string, user: User) {
        const directory = await this.validateDirectoryOwnership(directoryId, user.id);

        try {
            const config = await this.dataGenerator.config(directory, user);
            return {
                status: 'success',
                config,
            };
        } catch (error) {
            if (error instanceof HttpException) {
                throw error;
            }

            const errMessage = this.clearMessageError(error);
            if (errMessage.includes('Repository not found')) {
                return {
                    status: 'success',
                    config: null,
                };
            }

            this.logger.error('Failed to get directory config:', error);

            throw new BadRequestException({
                status: 'error',
                message: errMessage,
            });
        }
    }

    async directoryCount(directoryId: string, user: User) {
        const directory = await this.validateDirectoryOwnership(directoryId, user.id);

        try {
            const count = await this.dataGenerator.count(directory, user);
            return {
                status: 'success',
                ...count,
            };
        } catch (error) {
            if (error instanceof HttpException) {
                throw error;
            }

            const errMessage = this.clearMessageError(error);
            if (errMessage.includes('Repository not found')) {
                return {
                    status: 'success',
                    count: {
                        items: 0,
                        categories: 0,
                        tags: 0,
                    },
                };
            }

            this.logger.error('Failed to get directory count:', error);

            throw new BadRequestException({
                status: 'error',
                message: errMessage,
            });
        }
    }

    async directoryCategoriesTags(directoryId: string, user: User) {
        const directory = await this.validateDirectoryOwnership(directoryId, user.id);

        try {
            const { categories, tags } = await this.dataGenerator.getCategoriesTags(
                directory,
                user,
            );
            return {
                status: 'success',
                categories,
                tags,
            };
        } catch (error) {
            if (error instanceof HttpException) {
                throw error;
            }

            if (error.message.includes('Repository not found')) {
                return {
                    status: 'success',
                    categories: [],
                    tags: [],
                };
            }

            this.logger.error('Failed to get directory categories and tags:', error);

            throw new BadRequestException({
                status: 'error',
                message: this.clearMessageError(error),
            });
        }
    }

    async generateItems(
        directoryId: string,
        createItemsGeneratorDto: CreateItemsGeneratorDto,
        user: User,
        awaitCompletion = true,
    ): Promise<ItemsGeneratorResponseDto> {
        const directory = await this.validateDirectoryOwnership(directoryId, user.id);

        if (awaitCompletion) {
            try {
                await this.processGeneration(directory, user, createItemsGeneratorDto);
            } catch (error) {
                if (error instanceof HttpException) {
                    throw error;
                }

                throw new BadRequestException({
                    status: 'error',
                    slug: directory.slug,
                    message: this.clearMessageError(error),
                });
            }
        } else {
            void this.processGeneration(directory, user, createItemsGeneratorDto);
        }

        return {
            status: 'pending',
            slug: directory.slug,
            parameters: createItemsGeneratorDto,
            message: `Processing request for '${createItemsGeneratorDto.name}'. Check logs or data directory for updates.`,
        };
    }

    async updateItemsGenerator(
        directoryId: string,
        updateItemsGeneratorDto: UpdateItemsGeneratorDto,
        user: User,
        awaitCompletion = true,
    ): Promise<ItemsGeneratorResponseDto> {
        const directory = await this.validateDirectoryOwnership(directoryId, user.id);

        let lastRequestData = await this.dataGenerator
            .getLastRequestData(directory, user)
            .catch(() => null);

        if (!lastRequestData) {
            throw new BadRequestException({
                status: 'error',
                slug: directory.slug,
                message: 'No previous request data found',
            });
        }

        lastRequestData = {
            ...lastRequestData,
            ...updateItemsGeneratorDto,
        };

        if (awaitCompletion) {
            try {
                await this.processGeneration(directory, user, lastRequestData);
            } catch (error) {
                if (error instanceof HttpException) {
                    throw error;
                }

                throw new BadRequestException({
                    status: 'error',
                    slug: directory.slug,
                    message: this.clearMessageError(error),
                });
            }
        } else {
            void this.processGeneration(directory, user, lastRequestData);
        }

        return {
            slug: directory.slug,
            status: 'pending',
            parameters: lastRequestData,
            message: `Processing update for '${directory.name}'. Check logs or data directory for updates.`,
        };
    }

    async submitItem(
        directoryId: string,
        submitItemDto: SubmitItemDto,
        user: User,
    ): Promise<SubmitItemResponseDto> {
        try {
            // Validate directory ownership
            const directory = await this.validateDirectoryOwnership(directoryId, user.id);

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

            if (result.status === 'error') {
                result.message = this.clearMessageError(result.message);
                throw new BadRequestException(result);
            }

            return result;
        } catch (error) {
            if (error instanceof HttpException) {
                throw error;
            }

            this.logger.error('Error submitting item:', error);

            throw new BadRequestException({
                status: 'error',
                slug: directoryId,
                item_name: submitItemDto.name,
                message: this.clearMessageError(error),
            });
        }
    }

    async removeItem(
        directoryId: string,
        removeItemDto: RemoveItemDto,
        user: User,
    ): Promise<RemoveItemResponseDto> {
        try {
            // Validate directory ownership
            const directory = await this.validateDirectoryOwnership(directoryId, user.id);

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

            if (result.status === 'error') {
                result.message = this.clearMessageError(result.message);
                throw new BadRequestException(result);
            }

            return result;
        } catch (error) {
            if (error instanceof HttpException) {
                throw error;
            }

            console.error('Error removing item:', error);
            throw new BadRequestException({
                status: 'error',
                slug: directoryId,
                item_name: 'Unknown',
                item_slug: removeItemDto.item_slug,
                message: this.clearMessageError(error),
            });
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
                throw new BadRequestException({
                    status: 'error',
                    source_url: extractItemDetailsDto.source_url,
                    message: 'No item data could be extracted from the URL content',
                });
            }

            return {
                status: 'success',
                item,
                source_url: extractItemDetailsDto.source_url,
                message: `Successfully extracted item details: "${item.name}"`,
            };
        } catch (error) {
            if (error instanceof HttpException) {
                throw error;
            }

            console.error('Error extracting item details:', error);

            throw new BadRequestException({
                status: 'error',
                source_url: extractItemDetailsDto.source_url,
                message: this.clearMessageError(error),
            });
        }
    }

    async regenerateMarkdown(
        directoryId: string,
        user: User,
    ): Promise<{ status: string; message?: string }> {
        try {
            // Validate directory ownership
            const directory = await this.validateDirectoryOwnership(directoryId, user.id);

            // Regenerate markdown for all items
            await this.markdownGenerator.initialize(directory, user, {
                generation_method: GenerationMethod.RECREATE,
            });

            return {
                status: 'success',
            };
        } catch (error) {
            if (error instanceof HttpException) {
                throw error;
            }

            console.error('Error regenerating markdown:', error);

            throw new BadRequestException({
                status: 'error',
                id: directoryId,
                message: this.clearMessageError(error),
            });
        }
    }

    async updateWebsiteRepository(
        directoryId: string,
        user: User,
    ): Promise<UpdateWebsiteRepositoryResponseDto> {
        try {
            // Validate directory ownership
            const directory = await this.validateDirectoryOwnership(directoryId, user.id);

            const result = await this.websiteUpdateService.updateRepository(directory, user);

            return {
                status: 'success',
                slug: directory.slug,
                owner: directory.getRepoOwner(),
                repository: `${directory.getRepoOwner()}/${directory.slug}-website`,
                message: result.message,
                method_used: result.method,
            };
        } catch (error) {
            if (error instanceof HttpException) {
                throw error;
            }

            console.error('Error updating website repository:', error);

            throw new BadRequestException({
                status: 'error',
                directoryId,
                message: this.clearMessageError(error),
            });
        }
    }

    async deleteDirectory(
        directoryId: string,
        deleteDirectoryDto: DeleteDirectoryDto,
        user: User,
    ): Promise<DeleteDirectoryResponseDto> {
        const directory = await this.validateDirectoryOwnership(directoryId, user.id);

        try {
            // Verify the directory belongs to the user
            if (directory.userId !== user.id) {
                throw new BadRequestException({
                    status: 'error',
                    directoryId,
                    message: 'You do not have permission to delete this directory',
                });
            }

            const deletedRepositories: string[] = [];

            // Delete data repository if requested
            if (deleteDirectoryDto.delete_data_repository !== false) {
                try {
                    await this.dataGenerator.removeRepository(directory, user);
                    deletedRepositories.push(
                        `${directory.getRepoOwner()}/${directory.getDataRepo()}`,
                    );
                } catch (error) {
                    if (error instanceof HttpException) {
                        throw error;
                    }

                    this.logger.error('Failed to delete data repository:', error);
                }
            }

            // Delete markdown repository if requested
            if (deleteDirectoryDto.delete_markdown_repository !== false) {
                try {
                    await this.markdownGenerator.removeRepository(directory, user);
                    deletedRepositories.push(`${directory.getRepoOwner()}/${directory.slug}`);
                } catch (error) {
                    if (error instanceof HttpException) {
                        throw error;
                    }

                    this.logger.error('Failed to delete markdown repository:', error);
                }
            }

            // Delete website repository if requested
            if (deleteDirectoryDto.delete_website_repository !== false) {
                try {
                    await this.websiteGenerator.removeRepository(directory, user);
                    deletedRepositories.push(
                        `${directory.getRepoOwner()}/${directory.getWebsiteRepo()}`,
                    );
                } catch (error) {
                    if (error instanceof HttpException) {
                        throw error;
                    }

                    this.logger.error('Failed to delete website repository:', error);
                }
            }

            // Remove directory from database
            await this.directoryRepository.delete(directory.id);

            await Promise.all([
                this.dataGenerator.cleanup(directory),
                this.markdownGenerator.cleanup(directory),
                this.websiteGenerator.cleanup(directory),
            ]).catch((error) => {
                this.logger.error('Failed to cleanup repositories:', error);
            });

            return {
                status: 'success',
                slug: directory.slug,
                message: `Directory '${directory.slug}' and associated repositories have been deleted`,
                deleted_repositories: deletedRepositories,
            };
        } catch (error) {
            if (error instanceof HttpException) {
                throw error;
            }

            this.logger.error('Error deleting directory:', error);

            throw new BadRequestException({
                status: 'error',
                slug: directory?.slug || '',
                message: this.clearMessageError(error),
            });
        }
    }

    private clearMessageError(error: any): string {
        if (!error) {
            return 'Unknown error';
        }

        let message: string = String(error);

        if (typeof error === 'object') {
            message = error.message || error.error || error;
        }

        const lowerMessage = message.toLowerCase();

        // Repository not found
        if (lowerMessage.includes('404') || lowerMessage.includes('not found')) {
            return 'Repository not found. Please verify the repository exists and try again.';
        }

        // Authentication errors
        if (lowerMessage.includes('401') || lowerMessage.includes('unauthorized')) {
            return 'Authentication expired. Please reconnect your account.';
        }

        if (lowerMessage.includes('403') || lowerMessage.includes('forbidden')) {
            return "You don't have access to this repository. Please check permissions.";
        }

        // Network errors
        if (lowerMessage.includes('enotfound') || lowerMessage.includes('getaddrinfo')) {
            return 'Connection failed. Please check your network and try again.';
        }

        if (lowerMessage.includes('timeout') || lowerMessage.includes('timedout')) {
            return 'Request timed out. Please try again.';
        }

        // OAuth/Auth specific
        if (
            lowerMessage.includes('could not read username') ||
            lowerMessage.includes('could not read password')
        ) {
            return 'Please reconnect your Git account to continue.';
        }

        if (lowerMessage.includes('token') || lowerMessage.includes('oauth')) {
            return 'Access token invalid. Please reconnect your account.';
        }

        // Git operation errors
        if (lowerMessage.includes('merge conflict') || lowerMessage.includes('conflict')) {
            return 'Sync conflict detected. Please resolve conflicts to continue.';
        }

        if (lowerMessage.includes('already exists') && lowerMessage.includes('empty')) {
            return 'Workspace already initialized. Please refresh the page.';
        }

        if (lowerMessage.includes('no such ref') || lowerMessage.includes("couldn't find ref")) {
            return 'Branch not found. Please select a valid branch.';
        }

        if (lowerMessage.includes('shallow') && lowerMessage.includes('unrelated')) {
            return 'Cannot sync unrelated repositories.';
        }

        if (lowerMessage.includes('lock') || lowerMessage.includes('locked')) {
            return 'Another operation in progress. Please wait and try again.';
        }

        // Certificate/SSL errors
        if (lowerMessage.includes('certificate') || lowerMessage.includes('ssl')) {
            return 'Secure connection failed. Please contact support.';
        }

        // Rate limiting
        if (lowerMessage.includes('rate limit') || lowerMessage.includes('429')) {
            return 'Too many requests. Please wait a moment and try again.';
        }

        // Empty repository
        if (lowerMessage.includes('empty repository') || lowerMessage.includes('no commits')) {
            return 'Repository is empty. Please add content first.';
        }

        // Return original message if no pattern matches
        return message;
    }

    private async processGeneration(
        directory: Directory,
        user: User,
        dto: CreateItemsGeneratorDto,
    ) {
        const startTime = new Date();
        console.log(`Generation started at: ${startTime.toISOString()}`);

        await this.directoryRepository.updateGenerateStatus(directory.id, {
            status: GenerateStatusType.GENERATING,
        });

        let hasError = false;

        try {
            const generated = await this.dataGenerator.initialize(directory, user, dto);

            if (generated) {
                await this.markdownGenerator.initialize(directory, user, {
                    repository_description: dto.repository_description,
                    generation_method: generated.generation_method,
                    pr_update: generated.prUpdate,
                });
            }

            await this.websiteGenerator.initialize(
                directory,
                user,
                dto.website_repository_creation_method,
            );
        } catch (error) {
            await this.directoryRepository.updateGenerateStatus(directory.id, {
                status: GenerateStatusType.ERROR,
                error: this.clearMessageError(error),
            });

            if (error instanceof HttpException) {
                throw error;
            }

            hasError = true;

            console.error('Error during generation:', error);
        }

        if (!hasError) {
            await this.directoryRepository.updateGenerateStatus(directory.id, {
                status: GenerateStatusType.GENERATED,
                step: null,
            });
        }

        const endTime = new Date();
        console.log(`Generation finished at: ${endTime.toISOString()}`);
        const duration = (endTime.getTime() - startTime.getTime()) / 1000;
        console.log(`Total time taken: ${duration} seconds`);
    }

    /**
     * Validates that the current authenticated user owns the directory
     * @param directoryId - The ID of the directory to validate
     * @param userId - The ID of the authenticated user
     * @returns The directory if validation passes
     * @throws NotFoundException if directory doesn't exist
     * @throws BadRequestException if user doesn't own the directory
     */
    private async validateDirectoryOwnership(
        directoryId: string,
        userId: string,
    ): Promise<Directory> {
        const directory = await this.directoryRepository.findById(directoryId);

        if (!directory) {
            throw new NotFoundException({
                status: 'error',
                message: `Directory with id '${directoryId}' not found`,
            });
        }

        if (directory.userId !== userId) {
            throw new BadRequestException({
                status: 'error',
                message: 'You do not have permission to access this directory',
            });
        }

        return directory;
    }
}
