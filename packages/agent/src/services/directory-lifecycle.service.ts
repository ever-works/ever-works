import {
    BadRequestException,
    HttpException,
    Injectable,
    Logger,
    NotFoundException,
} from '@nestjs/common';
import { DirectoryRepository } from '@src/database/repositories/directory.repository';
import { DataGeneratorService } from '@src/data-generator/data-generator.service';
import { MarkdownGeneratorService } from '@src/markdown-generator/markdown-generator.service';
import { WebsiteGeneratorService } from '@src/website-generator/website-generator.service';
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
                await Promise.all([
                    this.directoryRepository.updateGenerateStatus(dir.id, {
                        status: GenerateStatusType.GENERATED,
                    }),
                    this.directoryRepository.update(dir.id, {
                        itemsCount: items.length,
                    }),
                ]);
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
        const directory = await this.ownershipService.ensure(id, user.id);

        try {
            const updatedDirectory = await this.directoryRepository.update(id, {
                name: updateDto.name || directory.name,
                description: updateDto.description || directory.description,
                owner: updateDto.owner ?? directory.owner,
                organization:
                    updateDto.organization !== undefined
                        ? updateDto.organization
                        : directory.organization,
                readmeConfig: updateDto.readmeConfig ?? directory.readmeConfig,
            });

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

    async updateDirectoryItemsCount(id: string, count: number, user: User) {
        const directory = await this.ownershipService.ensure(id, user.id);
        try {
            await this.directoryRepository.update(directory.id, { itemsCount: count });
        } catch (error) {
            this.logger.error('Failed to update directory items count:', error);

            throw new BadRequestException({
                status: 'error',
                message: normalizeGeneratorError(error),
            });
        }
    }

    async resetDirectoryGenerationStatus(id: string, user: User) {
        const directory = await this.ownershipService.ensure(id, user.id);
        try {
            await this.directoryRepository.update(directory.id, {
                generateStatus: null,
            });
        } catch (error) {
            this.logger.error('Failed to update directory generation status:', error);

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
        const directory = await this.ownershipService.ensure(directoryId, user.id);

        try {
            if (directory.userId !== user.id) {
                throw new BadRequestException({
                    status: 'error',
                    directoryId,
                    message: 'You do not have permission to delete this directory',
                });
            }

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
