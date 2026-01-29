import {
    BadRequestException,
    HttpException,
    Injectable,
    Logger,
    NotFoundException,
} from '@nestjs/common';
import { DirectoryRepository } from '@src/database/repositories/directory.repository';
import { DataGeneratorService } from '@src/generators/data-generator/data-generator.service';
import { MarkdownGeneratorService } from '@src/generators/markdown-generator/markdown-generator.service';
import { WebsiteGeneratorService } from '@src/generators/website-generator/website-generator.service';
import { CreateDirectoryDto } from '@src/dto/create-directory.dto';
import { UpdateDirectoryDto } from '@src/dto';
import { DeleteDirectoryDto, DeleteDirectoryResponseDto } from '@src/items-generator/dto';
import { User } from '@src/entities/user.entity';
import { DirectoryOwnershipService } from './directory-ownership.service';
import { normalizeGeneratorError } from './utils/error.utils';
import { GenerateStatusType } from '@src/entities/types';

@Injectable()
export class DirectoryLifecycleService {
    private readonly logger = new Logger(DirectoryLifecycleService.name);

    constructor(
        private readonly directoryRepository: DirectoryRepository,
        private readonly dataGenerator: DataGeneratorService,
        private readonly markdownGenerator: MarkdownGeneratorService,
        private readonly websiteGenerator: WebsiteGeneratorService,
        private readonly ownershipService: DirectoryOwnershipService,
    ) {}

    async createDirectory(createDirectoryDto: CreateDirectoryDto, user: User) {
        const { slug, name, description, owner, readmeConfig, organization, repoProvider } =
            createDirectoryDto;

        const directoryData: Partial<CreateDirectoryDto & { userId: string }> = {
            slug,
            name,
            description,
            userId: user.id,
            owner,
            repoProvider,
            readmeConfig,
            organization,
        };

        try {
            const dir = await this.directoryRepository.create(directoryData, user);
            dir.owner = dir.getRepoOwner();

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
                message: normalizeGeneratorError(error),
            });
        }
    }

    async updateDirectory(id: string, updateDto: UpdateDirectoryDto, user: User) {
        // Require at least editor role to update directory
        const { directory } = await this.ownershipService.ensureCanEdit(id, user.id);

        try {
            // Build update data object
            const updateData: Record<string, any> = {
                name: updateDto.name || directory.name,
                description: updateDto.description || directory.description,
                owner: updateDto.owner ?? directory.owner,
                organization:
                    updateDto.organization !== undefined
                        ? updateDto.organization
                        : directory.organization,
                readmeConfig: updateDto.readmeConfig ?? directory.readmeConfig,
            };

            // Handle website template auto-update settings
            if (updateDto.websiteTemplateAutoUpdate !== undefined) {
                updateData.websiteTemplateAutoUpdate = updateDto.websiteTemplateAutoUpdate;
            }

            if (updateDto.websiteTemplateUseBeta !== undefined) {
                updateData.websiteTemplateUseBeta = updateDto.websiteTemplateUseBeta;
                // Clear last commit when switching branches to force re-check
                if (updateDto.websiteTemplateUseBeta !== directory.websiteTemplateUseBeta) {
                    updateData.websiteTemplateLastCommit = null;
                }
            }

            const updatedDirectory = await this.directoryRepository.update(id, updateData);

            if (!updatedDirectory) {
                throw new NotFoundException({ status: 'error', message: 'Directory not found' });
            }

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
                message: normalizeGeneratorError(error),
            });
        }
    }

    async syncFromDataRepository(directoryId: string, user: User) {
        // Require at least editor role to sync
        const { directory } = await this.ownershipService.ensureCanEdit(directoryId, user.id);
        const updates: Record<string, any> = {};

        try {
            const snapshot = await this.dataGenerator.getDataSyncSnapshot(directory, user);

            if (
                typeof snapshot.itemsCount === 'number' &&
                directory.itemsCount !== snapshot.itemsCount
            ) {
                updates.itemsCount = snapshot.itemsCount;

                if (snapshot.itemsCount <= 0) {
                    updates.generateStatus = null;
                }
            }

            const prUpdate = snapshot.prUpdate;
            if (prUpdate && (!directory.lastPullRequest || !directory.lastPullRequest.data)) {
                updates.lastPullRequest = {
                    ...(directory.lastPullRequest || {}),
                    data: prUpdate,
                };
            }

            updates.readmeConfig = directory.readmeConfig || {};

            // Sync readme config from markdown templates
            const markdownTemplate = snapshot.readmeTemplate;
            if (markdownTemplate?.header && !directory.readmeConfig?.header) {
                updates.readmeConfig.header = markdownTemplate.header;
                updates.readmeConfig.overwriteDefaultHeader = true;
            }

            if (markdownTemplate?.footer && !directory.readmeConfig?.footer) {
                updates.readmeConfig.footer = markdownTemplate.footer;
                updates.readmeConfig.overwriteDefaultFooter = true;
            }

            if (Object.keys(updates).length > 0) {
                await this.directoryRepository.update(directory.id, updates);
            }

            return {
                status: 'success',
                updated: Object.keys(updates),
                message:
                    Object.keys(updates).length > 0
                        ? 'Directory synced from data repository.'
                        : 'Directory already up to date.',
            };
        } catch (error) {
            this.logger.error('Failed to sync directory from data repository', error);
            throw new BadRequestException({
                status: 'error',
                message: normalizeGeneratorError(error),
            });
        }
    }

    async deleteDirectory(
        directoryId: string,
        deleteDirectoryDto: DeleteDirectoryDto,
        user: User,
    ): Promise<DeleteDirectoryResponseDto> {
        // Only owners can delete directories
        const { directory } = await this.ownershipService.ensureIsOwner(directoryId, user.id);

        try {
            const deletedRepositories: string[] = [];

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

            await this.directoryRepository.delete(directory.id);

            await Promise.all([
                this.dataGenerator.cleanup(directory),
                this.markdownGenerator.cleanup(directory),
                this.websiteGenerator.cleanup(directory),
            ]).catch((error) => this.logger.error('Failed to cleanup repositories:', error));

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
                message: normalizeGeneratorError(error),
            });
        }
    }
}
